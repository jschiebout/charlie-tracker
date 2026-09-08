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

IMPORTANT
---------
Happiest Baby publishes no public API. pysnoo is community-maintained and
reverse-engineered, so this integration can break without warning when they
change their backend. That is why every failure is reported loudly rather
than swallowed. If it breaks, sleep logging falls back to voice and the
buttons — nothing else in the system depends on this job.
=============================================================================
"""

import asyncio
import json
import os
import sys
import traceback
import urllib.error
import urllib.request
from datetime import datetime, timedelta

EXIT_OK = 0
EXIT_CONFIG = 2
EXIT_AUTH = 3
EXIT_API = 4
EXIT_PUSH = 5


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
        f"Snoo sync failed at: {stage}\n\n{detail[:400]}\n\n"
        "Sleep data is not flowing into the tracker. Voice and button logging "
        "are unaffected. This usually means Happiest Baby changed their API — "
        "check for a pysnoo update."
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
    except Exception as exc:                     # noqa: BLE001
        log(f"could not send failure notification: {exc}")


def die(code, msg, detail=None, stage=None):
    log(f"ERROR: {msg}")
    if detail:
        log(detail)
    notify_failure(stage or msg, detail or msg)
    sys.exit(code)


# ---------------------------------------------------------------------------
# Snoo
# ---------------------------------------------------------------------------

async def fetch_sessions(username, password, lookback_days):
    """Returns a list of AggregatedSession objects, oldest day first."""
    try:
        from pysnoo import Snoo, SnooAuthSession
    except ImportError as exc:
        die(EXIT_CONFIG, "pysnoo is not installed", str(exc), "import pysnoo")

    collected = []

    async with SnooAuthSession() as auth:
        try:
            token = await auth.fetch_token(username, password)
            if not token:
                raise RuntimeError("auth returned an empty token")
        except Exception as exc:                 # noqa: BLE001
            die(EXIT_AUTH,
                "Snoo authentication failed",
                f"{type(exc).__name__}: {exc}",
                "authentication")

        snoo = Snoo(auth)

        try:
            devices = await snoo.get_devices()
        except Exception as exc:                 # noqa: BLE001
            die(EXIT_API, "could not list Snoo devices",
                f"{type(exc).__name__}: {exc}", "get_devices")

        if not devices:
            die(EXIT_CONFIG, "No Snoo devices on this account.",
                "Check that SNOO_USERNAME is the account the bassinet is "
                "registered to.", "get_devices")

        log(f"found Snoo serial {devices[0].serial_number}")

        # The aggregated-session endpoint returns a 24h block starting at the
        # supplied naive local time. Snoo's "day" starts at 07:00 by default.
        today = datetime.now().replace(hour=7, minute=0, second=0, microsecond=0)
        for back in range(lookback_days, -1, -1):
            start = today - timedelta(days=back)
            try:
                session = await snoo.get_aggregated_session(start)
                collected.append((start, session))
                log(f"{start.date()}: {len(session.levels)} level entries, "
                    f"total sleep {session.total_sleep}")
            except Exception as exc:             # noqa: BLE001
                die(EXIT_API,
                    f"could not fetch sessions for {start.date()}",
                    f"{type(exc).__name__}: {exc}",
                    "get_aggregated_session")

    return collected


def to_events(collected, include_soothing=False):
    """
    Flattens Snoo session levels into sleep start/end events.

    Snoo reports contiguous blocks typed asleep / soothing / awake. We treat
    'asleep' as sleep, and optionally fold 'soothing' in with it (soothing is
    the Snoo actively rocking, which usually means she is settling, not awake).
    Adjacent blocks are merged so a single night does not become twenty rows.
    """
    events = []

    for day_start, session in collected:
        sleep_types = {"asleep"} | ({"soothing"} if include_soothing else set())

        blocks = []
        for item in session.levels:
            if item.start_time is None:
                continue
            type_val = item.type.value if hasattr(item.type, "value") else str(item.type)
            if type_val not in sleep_types:
                continue
            start = item.start_time
            end = start + item.state_duration
            if blocks and (start - blocks[-1][1]).total_seconds() <= 60:
                blocks[-1] = (blocks[-1][0], end, blocks[-1][2])   # merge
            else:
                blocks.append((start, end, item.session_id))

        for start, end, session_id in blocks:
            minutes = (end - start).total_seconds() / 60.0
            if minutes < 5:
                continue                      # ignore momentary blips
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
    serves the response body there. requests follows that correctly; plain
    urllib would turn the redirect into a GET and lose the response. doPost
    has already run by the time the redirect is issued either way.
    """
    if not events:
        log("no new sleep events to send")
        return {"written": 0, "skipped": 0}

    import requests

    try:
        resp = requests.post(
            url,
            json={"k": key, "events": events},
            timeout=90,
            allow_redirects=True,
        )
    except Exception as exc:                     # noqa: BLE001
        die(EXIT_PUSH, "could not reach the tracker",
            f"{type(exc).__name__}: {exc}", "push to tracker")

    if resp.status_code != 200:
        die(EXIT_PUSH, f"tracker rejected the push (HTTP {resp.status_code})",
            resp.text[:500], "push to tracker")

    try:
        result = resp.json()
    except ValueError:
        die(EXIT_PUSH,
            "tracker returned a non-JSON response — the web app is probably "
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
    url      = env("TRACKER_URL")
    key      = env("TRACKER_KEY")
    lookback = int(env("LOOKBACK_DAYS", required=False, default="2"))
    soothing = env("INCLUDE_SOOTHING", required=False,
                   default="false").lower() in ("1", "true", "yes")

    log(f"starting — lookback {lookback}d, soothing counted as sleep: {soothing}")

    collected = asyncio.run(fetch_sessions(username, password, lookback))
    events = to_events(collected, include_soothing=soothing)
    log(f"built {len(events)} events")

    result = push(url, key, events)
    log(f"done — written {result.get('written', 0)}, "
        f"skipped as duplicate {result.get('skipped', 0)}")
    return EXIT_OK


if __name__ == "__main__":
    try:
        sys.exit(main())
    except SystemExit:
        raise
    except Exception:                            # noqa: BLE001
        detail = traceback.format_exc()
        die(EXIT_API, "unexpected failure", detail, "unexpected")
