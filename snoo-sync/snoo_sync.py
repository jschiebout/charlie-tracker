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
    TRACKER_TZ        IANA timezone for timestamps (default America/Chicago)
    MIN_BLOCK_MIN     ignore sleep blocks shorter than this (default 5)

HOW THIS WORKS
--------------
Happiest Baby publishes no publicly documented API, and the shape of the
private one has changed twice:

  1. pysnoo / pysnoo2 log in at snoo-api.happiestbaby.com/us/login/ and read
     /ss/v2/sessions/aggregated. Both are dead -- login 404s, and every /ss/
     path 404s on the current host.
  2. Auth is now AWS Cognito (USER_PASSWORD_AUTH), and the API lives at
     api-us-east-1-prod.happiestbaby.com. The journal service there
     (/cs/me/v11/babies/{id}/journals/grouped-tracking?group=activity) holds
     diapers and feeds *typed into the Happiest Baby app* -- it is empty for
     us, because we log those in Charlie Tracker instead.
  3. The bassinet's own session history is not in that journal. The Snoo
     streams its state machine to a PubNub channel, ActivityState.{serial},
     and PubNub keeps that history. That is what we read here: each message
     carries a session_id, whether the session is active, and how long it has
     been running, which is enough to reconstruct every stretch she spent
     asleep in the Snoo.

This can break again without warning, so every failure is reported loudly
rather than swallowed. If it breaks, sleep logging falls back to voice and
the buttons -- nothing else in the system depends on this job.
=============================================================================
"""

import json
import math
import os
import secrets
import sys
import traceback
import urllib.request
import uuid
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
PUBNUB_HOST = "https://happiestbaby.pubnubapi.com"
PUBNUB_SUB_KEY = "sub-c-97bade2a-483d-11e6-8b3b-02ee2ddab7fe"

COGNITO_HEADERS = {
    "x-amz-target": "AWSCognitoIdentityProviderService.InitiateAuth",
    "accept-language": "US",
    "content-type": "application/x-amz-json-1.1",
    "user-agent": "okhttp/4.12.0",
    "accept": "application/json",
}

# The phone app sends this alongside the bearer token when it asks for a
# PubNub grant. The values are cosmetic but the endpoint wants the shape.
SNOO_AUTH_BODY = {
    "advertiserId": "",
    "appVersion": "1.8.7",
    "device": "panther",
    "deviceHasGSM": True,
    "locale": "en",
    "os": "Android",
    "osVersion": "14",
    "platform": "Android",
    "timeZone": "America/Chicago",
    "userCountry": "US",
    "vendorId": "eyqurgwYQSqmnExnzyiLO5",
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
        headers={"Title": "Snoo sync broken", "Priority": "high",
                 "Tags": "warning"},
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


def preview(resp, limit=500):
    """Short, safe body preview for the log."""
    try:
        text = " ".join(resp.text.split())
    except Exception:                                            # noqa: BLE001
        return "<unreadable body>"
    return text[:limit]


def to_timetoken(moment):
    """PubNub timetokens are 100-nanosecond ticks since the epoch."""
    return str(int(moment.timestamp() * 10_000_000))


def from_timetoken(token, tz):
    return datetime.fromtimestamp(int(token) / 10_000_000, tz=timezone.utc) \
                   .astimezone(tz)


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
        # Cognito error bodies name the failure type but never echo secrets.
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


def pubnub_token(session, hdrs):
    """Exchanges the bearer token for the PubNub auth key the app uses."""
    url = f"{HB_API}/us/me/v10/pubnub/authorize"
    try:
        resp = session.post(url, headers=hdrs,
                            data=json.dumps(SNOO_AUTH_BODY), timeout=45)
    except Exception as exc:                                     # noqa: BLE001
        die(EXIT_API, "could not reach the PubNub authorize endpoint",
            f"{type(exc).__name__}: {exc}", "pubnub authorize")

    if resp.status_code != 200:
        die(EXIT_API, f"PubNub authorize failed (HTTP {resp.status_code})",
            preview(resp), "pubnub authorize")

    try:
        token = (resp.json().get("snoo") or {}).get("token")
    except ValueError:
        token = None

    if not token:
        die(EXIT_API, "PubNub authorize returned no token",
            preview(resp), "pubnub authorize")
    return token


def get_devices(session, hdrs):
    url = f"{HB_API}/hds/me/v11/devices"
    try:
        resp = session.get(url, headers=hdrs, timeout=45)
    except Exception as exc:                                     # noqa: BLE001
        die(EXIT_API, "could not reach the Happiest Baby API",
            f"{type(exc).__name__}: {exc}", "get_devices")

    if resp.status_code != 200:
        die(EXIT_API, f"could not list devices (HTTP {resp.status_code})",
            preview(resp), "get_devices")

    data = resp.json()

    # The payload is {"snoo": [...]} today; it has been a bare list before.
    devices = []
    if isinstance(data, list):
        devices = data
    elif isinstance(data, dict):
        for key in ("snoo", "devices", "data", "results"):
            if isinstance(data.get(key), list):
                devices = data[key]
                break

    serials = [d.get("serialNumber") for d in devices
               if isinstance(d, dict) and d.get("serialNumber")]
    if not serials:
        shape = ", ".join(sorted(data.keys())) if isinstance(data, dict) \
            else f"list of {len(data)}"
        die(EXIT_CONFIG, "No Snoo devices on this Happiest Baby account.",
            f"Response shape: {shape}. Body: {preview(resp)}. Check that "
            "SNOO_USERNAME is the account the bassinet is registered to.",
            "get_devices")

    log(f"found {len(serials)} Snoo: {', '.join(serials)}")
    return serials


# ---------------------------------------------------------------------------
# the Snoo's own session history, via PubNub
# ---------------------------------------------------------------------------

def pubnub_history(session, serial, token, start_utc, end_utc):
    """Every ActivityState message the Snoo published in the window.

    PubNub v2 history returns [messages, startTimetoken, endTimetoken] and
    caps a page at 100, so we walk forward until a short page comes back.
    """
    url = f"{PUBNUB_HOST}/v2/history/sub-key/{PUBNUB_SUB_KEY}/channel/" \
          f"ActivityState.{serial}"
    uuid_str = f"android_{secrets.token_urlsafe(18)}_{uuid.uuid1()}"

    collected = []
    cursor = to_timetoken(start_utc)
    end_tt = to_timetoken(end_utc)

    for page in range(40):                       # hard stop; ~4000 messages
        params = {
            "auth": token,
            "count": 100,
            "include_token": "true",
            "include_meta": "false",
            "reverse": "true",                   # oldest first
            "start": cursor,
            "end": end_tt,
            "uuid": uuid_str,
            "pnsdk": "PubNub-Kotlin/7.4.0",
            "requestid": str(uuid.uuid1()),
        }
        try:
            resp = session.get(url, params=params, timeout=45)
        except Exception as exc:                                 # noqa: BLE001
            die(EXIT_API, "could not reach PubNub history",
                f"{type(exc).__name__}: {exc}", "pubnub history")

        if resp.status_code != 200:
            die(EXIT_API, f"PubNub history failed (HTTP {resp.status_code})",
                preview(resp), "pubnub history")

        try:
            body = resp.json()
        except ValueError:
            die(EXIT_API, "PubNub history returned a non-JSON response",
                preview(resp), "pubnub history")

        if isinstance(body, dict) and body.get("error"):
            die(EXIT_API, "PubNub rejected the history request",
                json.dumps(body)[:500], "pubnub history")

        if not isinstance(body, list) or not body:
            break

        messages = body[0] or []
        if not messages:
            break

        for entry in messages:
            if isinstance(entry, dict) and "message" in entry:
                collected.append((entry.get("timetoken"), entry["message"]))
            else:
                collected.append((None, entry))

        if page == 0 and collected:
            log("  received bassinet state data")

        if len(messages) < 100:
            break
        cursor = str(body[2])                    # newest timetoken this page

    log(f"  {len(collected)} state messages from PubNub")
    return collected


def blocks_from_messages(messages, tz):
    """Import completed bassinet sessions only; an active sighting is not a wake.

    These are bassinet activity intervals, not measured infant sleep. Require
    an explicit inactive state and a valid elapsed duration before publishing.
    """
    sessions = {}
    for token, msg in messages:
        if token is None or not isinstance(msg, dict):
            continue
        state = msg.get("state_machine")
        if not isinstance(state, dict):
            continue
        sid = str(state.get("session_id") or "").strip()
        if not sid or sid.lower() in ("0", "none"):
            continue
        active = str(state.get("is_active_session", "")).lower()
        if active not in ("true", "false"):
            continue
        try:
            elapsed = float(state["since_session_start_ms"])
            if not math.isfinite(elapsed) or elapsed < 0:
                continue
            seen = from_timetoken(token, tz)
            started = seen - timedelta(milliseconds=elapsed)
        except (KeyError, ValueError, TypeError, OverflowError):
            continue
        prior = sessions.get(sid)
        if prior is None or seen > prior[1]:
            sessions[sid] = (started, seen, active)
    return sorted((start, end, sid) for sid, (start, end, active)
                  in sessions.items() if active == "false")


def to_events(blocks, min_minutes):
    """Sleep blocks -> tracker events. Brief blips are dropped."""
    events = []
    for start, end, session_id in blocks:
        minutes = (end - start).total_seconds() / 60.0
        if minutes < min_minutes:
            continue
        key = f"snoo-session:{session_id}"
        events.append({
            "event": "sleep", "detail": "start",
            "at": start.isoformat(),
            "caregiver": "Snoo", "source": "snoo",
            "dedupe_key": key + ":s",
            "notes": "Snoo bassinet session; sleep not independently measured",
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
    min_minutes = float(env("MIN_BLOCK_MIN", required=False, default="5"))

    tz = ZoneInfo(tz_name)
    log(f"starting - lookback {lookback}d, tz {tz_name}, "
        f"min block {min_minutes} min")

    session = requests.Session()
    id_token = cognito_login(session, username, password)
    hdrs = hb_headers(id_token)

    serials = get_devices(session, hdrs)
    token = pubnub_token(session, hdrs)

    end_utc = datetime.now(timezone.utc)
    start_utc = end_utc - timedelta(days=lookback + 1)

    all_blocks = []
    for serial in serials:
        log(f"{serial}:")
        messages = pubnub_history(session, serial, token, start_utc, end_utc)
        blocks = blocks_from_messages(messages, tz)
        log(f"  => {len(blocks)} sleep blocks")
        all_blocks.extend(blocks)

    events = to_events(sorted(all_blocks, key=lambda b: b[0]), min_minutes)
    log(f"built {len(events)} events from {len(all_blocks)} blocks")

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
