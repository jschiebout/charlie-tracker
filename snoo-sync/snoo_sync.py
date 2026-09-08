#!/usr/bin/env python3
"""
Snoo -> Charlie Tracker sync
=============================================================================
Pulls sleep sessions from the Snoo Smart Bassinet and pushes them into the
Google Sheet behind Charlie Tracker.

Runs on a schedule in GitHub Actions. Needs four repository secrets:

    SNOO_USERNAME     Happiest Baby account email
    SNOO_PASSWORD     Happiest Baby account password
    TRACKER_URL       Apps Script web app /exec URL
    TRACKER_KEY       the api_key from the Config sheet

Optional:
    NTFY_TOPIC        if set, a failure sends a push so you find out the
                      Snoo link broke rather than silently losing data
    LOOKBACK_DAYS     how many days back to reconcile (default 2)
    TRACKER_TZ        IANA timezone for day boundaries (default America/Chicago)
    INCLUDE_SOOTHING  count Snoo 'soothing' as sleep (default false)

IMPORTANT
---------
Happiest Baby publishes no public API. This talks to the same private
endpoints their phone app uses, discovered by inspecting community clients,
so it can break without warning when they change their backend. That is why
every failure is reported loudly rather than swallowed. If it breaks, sleep
logging falls back to voice and the buttons -- nothing else in the system
depends on this job.

The community `pysnoo` package is NOT used: its login endpoint
(snoo-api.happiestbaby.com/us/login/) now returns 404. Auth moved to AWS
Cognito, which is what this script does directly.
=============================================================================
"""

import json
import os
import sys
import traceback
import urllib.request
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

import requests

EXIT_OK = 0
EXIT_CONFIG = 2
EXIT_AUTH = 3
EXIT_API = 4
EXIT_PUSH = 5

COGNITO_URL = "https://cognito-idp.us-east-1.amazonaws.com/"
COGNITO_CLIENT_ID = "6kqofhc8hm394ielqdkvli0oea"
HB_API = "https://api-us-east-1-prod.happiestbaby.com"

COGNITO_HEADERS = {
    "x-amz-target": "AWSCognitoIdentityProviderService.InitiateAuth",
    "accept-language": "US",
    "content-type": "application/x-amz-json-1.1",
    "user-agent": "okhttp/4.12.0",
    "accept": "application/json",
}


# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------

def env(name, required=True, default=None):
    val = os.environ.get(name, default)
    if required and not val:
        die(EXIT_CONFIG, f"Missing required environment variable: {name}")
    return val


def log(msg):
    print(f"[snoo-sync] {msg}", flush=True)


def notify_failure(stage, detail):
    """Best-effort push so a silent breakage doesn't go unnoticed for weeks."""
    topic = os.environ.get("NTFY_TOPIC")
    if not topic:
        return
    body = (
        f"Snoo sync failed at: {stage}\n\n{str(detail)[:400]}\n\n"
        "Sleep data is not flowing into the tracker. Voice and button logging "
        "are unaffected. This usually means Happiest Baby changed their API."
    ).encode("utf-8")
    req = urllib.request.Request(
        f"https://ntfy.sh/{topic}",
        data=body,
        headers={
            "Title": "Snoo sync broken",
            "Priority": "high",
            "Tags": "warning",
        },
    )
    try:
        urllib.request.urlopen(req, timeout=15).read()
    except Exception as exc:                                     # noqa: BLE001
        log(f"could not send failure notification: {exc}")


def die(code, msg, detail=None, stage=None):
    log(f"ERROR: {msg}")
    if detail:
        log(str(detail)[:2000])
    notify_failure(stage or msg, detail or msg)
    sys.exit(code)


def preview(resp, limit=900):
    """Short, safe body preview for the log. Never includes request headers."""
    try:
        text = resp.text
    except Exception:                                            # noqa: BLE001
        return "<unreadable body>"
    text = " ".join(text.split())
    return text[:limit]


# ---------------------------------------------------------------------------
# auth
# ---------------------------------------------------------------------------

def cognito_login(session, username, password):
    """Returns the Cognito IdToken, which the Happiest Baby API accepts as a
    bearer token."""
    payload = {
        "AuthParameters": {"USERNAME": username, "PASSWORD": password},
        "AuthFlow": "USER_PASSWORD_AUTH",
        "ClientId": COGNITO_CLIENT_ID,
    }
    try:
        resp = session.post(COGNITO_URL, headers=COGNITO_HEADERS,
                            data=json.dumps(payload), timeout=45)
    except Exception as exc:                                     # noqa: BLE001
        die(EXIT_AUTH, "could not reach AWS Cognito",
            f"{type(exc).__name__}: {exc}", "authentication")

    if resp.status_code != 200:
        # Cognito error bodies name the failure type but not the password.
        die(EXIT_AUTH, f"Snoo authentication failed (HTTP {resp.status_code})",
            preview(resp), "authentication")

    try:
        result = resp.json().get("AuthenticationResult") or {}
    except ValueError:
        die(EXIT_AUTH, "Cognito returned a non-JSON response",
            preview(resp), "authentication")

    token = result.get("IdToken")
    if not token:
        die(EXIT_AUTH, "Cognito response had no IdToken",
            "keys: " + ", ".join(sorted(result.keys())), "authentication")

    log("authenticated with Happiest Baby")
    return token


def hb_headers(id_token):
    return {
        "authorization": f"Bearer {id_token}",
        "accept": "application/json",
        "accept-language": "US",
        "content-type": "application/json; charset=UTF-8",
        "user-agent": "okhttp/4.12.0",
    }


# ---------------------------------------------------------------------------
# discovery
# ---------------------------------------------------------------------------

def get_baby_id(session, hdrs):
    url = f"{HB_API}/us/me/v10/babies"
    try:
        resp = session.get(url, headers=hdrs, timeout=45)
    except Exception as exc:                                     # noqa: BLE001
        die(EXIT_API, "could not reach the Happiest Baby API",
            f"{type(exc).__name__}: {exc}", "get_babies")

    if resp.status_code != 200:
        die(EXIT_API, f"could not list babies (HTTP {resp.status_code})",
            preview(resp), "get_babies")

    data = resp.json()
    babies = data if isinstance(data, list) else data.get("data") or []
    if not babies:
        die(EXIT_CONFIG, "No babies on this Happiest Baby account.",
            "Check that SNOO_USERNAME is the account the Snoo is registered to.",
            "get_babies")

    baby = babies[0]
    baby_id = baby.get("_id") or baby.get("id") or baby.get("babyId")
    log(f"baby: {baby.get('babyName') or baby.get('name') or '(unnamed)'} "
        f"id={baby_id}")
    if not baby_id:
        die(EXIT_API, "could not find a baby id in the response",
            "keys: " + ", ".join(sorted(baby.keys())), "get_babies")
    return baby_id


def sleep_candidates(baby_id, start_local, end_local):
    """Endpoint shapes to try, most likely first.

    Happiest Baby versions each service independently (/us/me/v10/,
    /hds/me/v11/, /cs/me/v11/), and the sleep-session service has moved at
    least once, so we try the plausible spellings and log what each returns.
    """
    day = start_local.strftime("%Y-%m-%d")
    naive = start_local.replace(tzinfo=None).isoformat()
    frm = start_local.isoformat(timespec="milliseconds")
    to = end_local.isoformat(timespec="milliseconds")

    return [
        (f"{HB_API}/ss/me/v11/babies/{baby_id}/sessions/aggregated",
         {"startTime": naive}),
        (f"{HB_API}/ss/me/v10/babies/{baby_id}/sessions/aggregated",
         {"startTime": naive}),
        (f"{HB_API}/ss/v2/babies/{baby_id}/sessions/aggregated/daily",
         {"startTime": naive}),
        (f"{HB_API}/ss/me/v11/sessions/aggregated", {"startTime": naive}),
        (f"{HB_API}/ss/v2/sessions/aggregated", {"startTime": naive}),
        (f"{HB_API}/cs/me/v11/babies/{baby_id}/journals/grouped-tracking",
         {"group": "sleep", "fromDateTime": frm, "toDateTime": to}),
        (f"{HB_API}/cs/me/v11/babies/{baby_id}/journals/grouped-tracking",
         {"group": "sleeping", "fromDateTime": frm, "toDateTime": to}),
        (f"{HB_API}/ss/me/v11/babies/{baby_id}/sessions", {"date": day}),
    ]


def fetch_day(session, hdrs, baby_id, start_local, end_local, remembered):
    """Returns (endpoint_key, json) for the first candidate that answers 200,
    preferring the endpoint that already worked earlier in this run."""
    cands = sleep_candidates(baby_id, start_local, end_local)
    if remembered is not None:
        cands = [c for c in cands if c[0] == remembered] + \
                [c for c in cands if c[0] != remembered]

    for url, params in cands:
        try:
            resp = session.get(url, headers=hdrs, params=params, timeout=45)
        except Exception as exc:                                 # noqa: BLE001
            log(f"  {url} -> {type(exc).__name__}: {exc}")
            continue

        short = url.replace(HB_API, "")
        if resp.status_code == 200:
            try:
                body = resp.json()
            except ValueError:
                log(f"  {short} -> 200 but not JSON: {preview(resp, 200)}")
                continue
            log(f"  {short} -> 200 {preview(resp, 600)}")
            return url, body

        log(f"  {short} -> {resp.status_code} {preview(resp, 200)}")

    return None, None


# ---------------------------------------------------------------------------
# parsing
# ---------------------------------------------------------------------------

def parse_iso(value):
    """Snoo mixes naive local strings and offset-aware ISO strings."""
    if not value:
        return None
    text = str(value).replace("Z", "+00:00")
    try:
        return datetime.fromisoformat(text)
    except ValueError:
        for fmt in ("%Y-%m-%d %H:%M:%S.%f", "%Y-%m-%d %H:%M:%S",
                    "%Y-%m-%dT%H:%M:%S.%f", "%Y-%m-%dT%H:%M:%S"):
            try:
                return datetime.strptime(text, fmt)
            except ValueError:
                continue
    return None


def extract_blocks(body, tz, include_soothing):
    """Normalises whichever shape came back into [(start, end, session_id)].

    Handles the two shapes seen in the wild:
      A. aggregated session  {"levels": [{startTime, stateDuration, type, sessionId}]}
      B. journal list        [{"type": "sleep", "startTime", "endTime"|"data.duration"}]
    """
    sleep_types = {"asleep"} | ({"soothing"} if include_soothing else set())
    raw = []

    # -- shape A ------------------------------------------------------------
    levels = None
    if isinstance(body, dict):
        levels = body.get("levels")
        if levels is None and isinstance(body.get("data"), dict):
            levels = body["data"].get("levels")
    if isinstance(levels, list):
        for item in levels:
            if not isinstance(item, dict):
                continue
            kind = str(item.get("type", "")).lower()
            if kind not in sleep_types:
                continue
            start = parse_iso(item.get("startTime"))
            if start is None:
                continue
            seconds = item.get("stateDuration")
            if seconds is None:
                continue
            raw.append((start, start + timedelta(seconds=float(seconds)),
                        item.get("sessionId") or item.get("_id") or "level"))

    # -- shape B ------------------------------------------------------------
    entries = body if isinstance(body, list) else None
    if entries is None and isinstance(body, dict):
        for key in ("journals", "activities", "results", "data", "items"):
            if isinstance(body.get(key), list):
                entries = body[key]
                break
    if entries:
        for item in entries:
            if not isinstance(item, dict):
                continue
            kind = str(item.get("type", "")).lower()
            if kind and kind not in ("sleep", "sleeping", "asleep"):
                continue
            start = parse_iso(item.get("startTime") or item.get("start"))
            if start is None:
                continue
            end = parse_iso(item.get("endTime") or item.get("end"))
            if end is None:
                data = item.get("data") if isinstance(item.get("data"), dict) else {}
                secs = data.get("duration") or item.get("duration")
                if secs is None:
                    continue
                secs = float(secs)
                # some payloads report minutes, some seconds
                if secs < 1000:
                    secs *= 60
                end = start + timedelta(seconds=secs)
            raw.append((start, end, item.get("_id") or item.get("id") or "journal"))

    # -- normalise timezone, sort, merge ------------------------------------
    blocks = []
    for start, end, sid in raw:
        if start.tzinfo is None:
            start = start.replace(tzinfo=tz)
        if end.tzinfo is None:
            end = end.replace(tzinfo=tz)
        blocks.append((start.astimezone(tz), end.astimezone(tz), sid))

    blocks.sort(key=lambda b: b[0])

    merged = []
    for start, end, sid in blocks:
        if merged and (start - merged[-1][1]).total_seconds() <= 60:
            merged[-1] = (merged[-1][0], max(end, merged[-1][1]), merged[-1][2])
        else:
            merged.append((start, end, sid))
    return merged


def to_events(blocks):
    """Sleep blocks -> tracker events. Blips under five minutes are dropped."""
    events = []
    for start, end, session_id in blocks:
        minutes = (end - start).total_seconds() / 60.0
        if minutes < 5:
            continue
        key = f"{session_id}:{start.isoformat()}"
        events.append({
            "event": "sleep", "detail": "start",
            "at": start.isoformat(),
            "caregiver": "Snoo", "source": "snoo",
            "dedupe_key": key + ":s",
            "notes": "",
        })
        events.append({
            "event": "sleep", "detail": "end",
            "at": end.isoformat(),
            "caregiver": "Snoo", "source": "snoo",
            "dedupe_key": key + ":e",
            "notes": f"{round(minutes)} min in Snoo",
        })
    events.sort(key=lambda e: e["at"])
    return events


# ---------------------------------------------------------------------------
# push
# ---------------------------------------------------------------------------

def push(url, key, events):
    """
    POSTs events to the Apps Script web app.

    Apps Script answers a POST with a 302 to script.googleusercontent.com and
    serves the response body there. requests follows that correctly.
    """
    if not events:
        log("no new sleep events to send")
        return {"written": 0, "skipped": 0}

    try:
        resp = requests.post(url, json={"k": key, "events": events},
                             timeout=90, allow_redirects=True)
    except Exception as exc:                                     # noqa: BLE001
        die(EXIT_PUSH, "could not reach the tracker",
            f"{type(exc).__name__}: {exc}", "push to tracker")

    if resp.status_code != 200:
        die(EXIT_PUSH, f"tracker rejected the push (HTTP {resp.status_code})",
            resp.text[:500], "push to tracker")

    try:
        result = resp.json()
    except ValueError:
        die(EXIT_PUSH,
            "tracker returned a non-JSON response - the web app is probably "
            "not deployed with access set to 'Anyone with the link'",
            resp.text[:500], "push to tracker")

    if not result.get("ok"):
        die(EXIT_PUSH, "tracker reported an error",
            json.dumps(result), "push to tracker")

    return result


# ---------------------------------------------------------------------------

def main():
    username = env("SNOO_USERNAME")
    password = env("SNOO_PASSWORD")
    url = env("TRACKER_URL")
    key = env("TRACKER_KEY")
    lookback = int(env("LOOKBACK_DAYS", required=False, default="2"))
    tz_name = env("TRACKER_TZ", required=False, default="America/Chicago")
    soothing = env("INCLUDE_SOOTHING", required=False,
                   default="false").lower() in ("1", "true", "yes")

    tz = ZoneInfo(tz_name)
    log(f"starting - lookback {lookback}d, tz {tz_name}, "
        f"soothing counted as sleep: {soothing}")

    session = requests.Session()
    id_token = cognito_login(session, username, password)
    hdrs = hb_headers(id_token)
    baby_id = get_baby_id(session, hdrs)

    # Snoo's "day" starts at 07:00 local.
    today = datetime.now(timezone.utc).astimezone(tz).replace(
        hour=7, minute=0, second=0, microsecond=0)

    all_blocks = []
    remembered = None
    for back in range(lookback, -1, -1):
        start_local = today - timedelta(days=back)
        end_local = start_local + timedelta(days=1)
        log(f"{start_local.date()}:")
        endpoint, body = fetch_day(session, hdrs, baby_id,
                                   start_local, end_local, remembered)
        if body is None:
            continue
        remembered = endpoint
        blocks = extract_blocks(body, tz, soothing)
        log(f"  -> {len(blocks)} sleep blocks")
        all_blocks.extend(blocks)

    if remembered is None:
        die(EXIT_API,
            "no sleep endpoint answered - Happiest Baby has moved the "
            "sessions API again",
            "See the per-URL status codes above; add the working path to "
            "sleep_candidates() in snoo-sync/snoo_sync.py.",
            "sleep endpoint discovery")

    # De-duplicate across overlapping day windows before sending.
    seen = set()
    unique = []
    for block in sorted(all_blocks, key=lambda b: b[0]):
        stamp = (block[0].isoformat(), block[1].isoformat())
        if stamp in seen:
            continue
        seen.add(stamp)
        unique.append(block)

    events = to_events(unique)
    log(f"built {len(events)} events from {len(unique)} sleep blocks")

    result = push(url, key, events)
    log(f"done - written {result.get('written', 0)}, "
        f"skipped as duplicate {result.get('skipped', 0)}")
    return EXIT_OK


if __name__ == "__main__":
    try:
        sys.exit(main())
    except SystemExit:
        raise
    except Exception:                                            # noqa: BLE001
        detail = traceback.format_exc()
        die(EXIT_API, "unexpected failure", detail, "unexpected")
