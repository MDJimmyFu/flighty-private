#!/usr/bin/env python3
"""
Flighty Private — GitHub Actions data fetcher.
Workflow runs every 5 minutes, but this script uses adaptive throttling:
  - No upcoming flights (>30 days away): fetch monthly
  - Within 30 days:                      fetch weekly
  - Within 3 days:                       fetch daily
  - Within 12 hours:                     fetch hourly
  - Within 3 hours of departure:         fetch every 5 minutes
"""
import json
import os
import sys
import requests
from datetime import datetime, timezone, timedelta


# ── Helpers ────────────────────────────────────────────────────────────────

def load_json(path, default=None):
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return default if default is not None else {}


def save_json(path, data):
    os.makedirs(os.path.dirname(path) if os.path.dirname(path) else ".", exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)
    print(f"  Saved {path}")


def parse_dt(s):
    if not s:
        return None
    try:
        return datetime.fromisoformat(s.replace("Z", "+00:00"))
    except Exception:
        return None


def delay_min(scheduled, actual):
    s, a = parse_dt(scheduled), parse_dt(actual)
    if s and a:
        return int((a - s).total_seconds() / 60)
    return None


# ── Adaptive throttle ──────────────────────────────────────────────────────

# Phase name → minimum minutes between fetches
PHASES = [
    ("every-5min",  3,         5),       # departure within 3h   → every 5 min
    ("hourly",      12,        60),      # departure within 12h  → every hour
    ("daily",       3 * 24,    24 * 60), # departure within 3d   → every day
    ("weekly",      30 * 24,   7 * 24 * 60), # within 30 days   → every week
    ("monthly",     float("inf"), 30 * 24 * 60), # farther       → every month
]


def nearest_flight_hours(tracked, old_map=None):
    """
    Returns the minimum hours until (or since) any tracked flight's departure.
    Considers flights up to 24h after departure (in case still airborne/landing).
    Also treats unresolved old flights (status still "scheduled") as urgent (0h)
    so they are never skipped by the throttle.
    Returns None if there are no tracked flights.
    """
    now = datetime.now(timezone.utc)
    best = None
    for t in tracked:
        # If this old flight was never resolved, force an immediate fetch
        if old_map is not None:
            existing = old_map.get(t["id"], {})
            if (existing.get("status") or "scheduled") == "scheduled":
                date_str = t.get("date", "")
                try:
                    flight_day = datetime.strptime(date_str, "%Y-%m-%d").replace(tzinfo=timezone.utc)
                    if (now - flight_day).days > 0:
                        # Old unresolved flight — treat as highest-priority
                        return 0
                except Exception:
                    pass

        dep_str = t.get("scheduled_departure") or ""
        dt = parse_dt(dep_str)
        if not dt:
            date_str = t.get("date", "")
            if not date_str:
                continue
            try:
                dt = datetime.strptime(date_str, "%Y-%m-%d").replace(
                    hour=0, minute=0, tzinfo=timezone.utc
                )
            except ValueError:
                continue

        hours = (dt - now).total_seconds() / 3600
        # Still relevant if flight was < 24h ago (might still be in the air)
        if hours < -24:
            continue
        dist = abs(hours) if hours < 0 else hours
        if best is None or dist < best:
            best = dist
    return best


def get_fetch_interval(tracked, old_map=None):
    """Return (phase_name, interval_minutes) based on nearest flight."""
    hours = nearest_flight_hours(tracked, old_map)
    if hours is None:
        return "no-flights", 30 * 24 * 60  # monthly if nothing tracked
    for phase_name, threshold_hours, interval_min in PHASES:
        if hours <= threshold_hours:
            return phase_name, interval_min
    return "monthly", 30 * 24 * 60


def should_fetch(meta, interval_min):
    """Return True if enough time has elapsed since the last successful fetch."""
    last = parse_dt(meta.get("last_fetch_at", ""))
    if not last:
        return True
    elapsed = (datetime.now(timezone.utc) - last).total_seconds() / 60
    return elapsed >= interval_min


# ── Push notification ───────────────────────────────────────────────────────

def notify(topic, title, body, priority="default", tags=None):
    if not topic:
        return
    headers = {"Title": title, "Priority": priority}
    if tags:
        headers["Tags"] = ",".join(tags)
    try:
        requests.post(
            f"https://ntfy.sh/{topic}",
            data=body.encode("utf-8"),
            headers=headers,
            timeout=10,
        )
        print(f"  Notified: {title}")
    except Exception as e:
        print(f"  ntfy error: {e}")


# ── AeroDataBox ─────────────────────────────────────────────────────────────

def aerodatabox_flight(flight_iata, flight_date, api_key):
    """Fetch flight info from AeroDataBox via RapidAPI. Returns list of normalized flights."""
    try:
        r = requests.get(
            f"https://aerodatabox.p.rapidapi.com/flights/number/{flight_iata}/{flight_date}",
            headers={
                "X-RapidAPI-Key":  api_key,
                "X-RapidAPI-Host": "aerodatabox.p.rapidapi.com",
            },
            timeout=15,
        )
        if r.status_code == 404:
            return []
        r.raise_for_status()
        data = r.json()
        return data if isinstance(data, list) else []
    except Exception as e:
        print(f"  AeroDataBox error for {flight_iata}: {e}")
        return []


def _adb_time(t):
    """Convert AeroDataBox time '2024-01-15 02:00Z' → ISO 8601."""
    if not t:
        return None
    if isinstance(t, dict):
        # nested format: {"utc": "...", "local": "..."}
        t = t.get("utc") or t.get("local") or ""
    if not t:
        return None
    return t.replace(" ", "T").rstrip("Z") + "+00:00"


def _adb_get_time(obj, *flat_keys):
    """
    Read a time field from an AeroDataBox departure/arrival object.
    Handles both flat  (scheduledTimeUtc)
    and nested (scheduledTime.utc / scheduledTime.local) formats.
    Tries UTC first, then local.
    """
    # Flat keys supplied by caller (e.g. "scheduledTimeUtc", "actualTimeUtc")
    for key in flat_keys:
        v = obj.get(key)
        if v:
            return _adb_time(v)
    # Derive the nested key from the first flat key
    # "scheduledTimeUtc" → "scheduledTime", "actualTimeUtc" → "actualTime"
    for key in flat_keys:
        nested_key = key.replace("TimeUtc", "Time").replace("TimeLocal", "Time")
        nested = obj.get(nested_key)
        if nested and isinstance(nested, dict):
            v = nested.get("utc") or nested.get("local")
            if v:
                return _adb_time(v)
    return None


def apply_aerodatabox(current, adb_flights, flight_date):
    """Merge best-matching AeroDataBox flight into current dict."""
    if not adb_flights:
        return current

    def dep_sched_utc(candidate):
        dep = candidate.get("departure") or {}
        return _adb_get_time(dep, "scheduledTimeUtc", "scheduledTimeLocal") or ""

    # Pick the flight whose departure date matches
    f = None
    for candidate in adb_flights:
        sched = dep_sched_utc(candidate)
        if flight_date and sched.startswith(flight_date[:10]):
            f = candidate
            break
    if f is None:
        f = adb_flights[0]

    dep = f.get("departure") or {}
    arr = f.get("arrival")   or {}
    dep_apt = dep.get("airport") or {}
    arr_apt = arr.get("airport") or {}

    def setif(key, value):
        if value:
            current[key] = value

    airline  = f.get("airline")  or {}
    aircraft = f.get("aircraft") or {}
    setif("airline",               airline.get("name"))
    setif("airline_iata",          airline.get("iata"))
    setif("aircraft_type",         aircraft.get("model"))
    setif("aircraft_registration", aircraft.get("reg"))

    if dep_apt.get("iata"):  current.setdefault("origin", {})["iata"]      = dep_apt["iata"]
    if dep_apt.get("name"):  current.setdefault("origin", {})["name"]      = dep_apt["name"]
    if arr_apt.get("iata"):  current.setdefault("destination", {})["iata"] = arr_apt["iata"]
    if arr_apt.get("name"):  current.setdefault("destination", {})["name"] = arr_apt["name"]

    # Times — try both flat and nested field formats
    sched_dep = _adb_get_time(dep, "scheduledTimeUtc", "scheduledTimeLocal")
    sched_arr = _adb_get_time(arr, "scheduledTimeUtc", "scheduledTimeLocal")
    act_dep   = _adb_get_time(dep, "actualTimeUtc",    "actualTimeLocal")
    act_arr   = _adb_get_time(arr, "actualTimeUtc",    "actualTimeLocal")

    setif("scheduled_departure", sched_dep)
    setif("scheduled_arrival",   sched_arr)
    if act_dep: current["actual_departure"] = act_dep
    if act_arr: current["actual_arrival"]   = act_arr

    # Status mapping
    status_map = {
        "EnRoute": "active", "Landed": "landed", "Cancelled": "cancelled",
        "Diverted": "diverted", "Departed": "active", "Expected": "scheduled",
    }
    if f.get("status"):
        current["status"] = status_map.get(f["status"], "scheduled")

    # Delays: prefer computed from actual vs scheduled; fall back to API delay field
    if current.get("actual_departure") and current.get("scheduled_departure"):
        d = delay_min(current["scheduled_departure"], current["actual_departure"])
        if d is not None:
            current["delay_departure"] = max(0, d)
    elif dep.get("delay") is not None:
        current["delay_departure"] = int(dep["delay"])

    if current.get("actual_arrival") and current.get("scheduled_arrival"):
        d = delay_min(current["scheduled_arrival"], current["actual_arrival"])
        if d is not None:
            current["delay_arrival"] = max(0, d)
    elif arr.get("delay") is not None:
        current["delay_arrival"] = int(arr["delay"])

    return current


# ── AviationStack ───────────────────────────────────────────────────────────

def aviationstack_flight(flight_iata, flight_date, api_key):
    """Fetch flight info from AviationStack. Returns first matching flight or None."""
    try:
        params = {"access_key": api_key, "flight_iata": flight_iata}
        if flight_date:
            params["flight_date"] = flight_date
        r = requests.get(
            "http://api.aviationstack.com/v1/flights",
            params=params,
            timeout=15,
        )
        r.raise_for_status()
        data = r.json()
        flights = data.get("data") or []
        # Prefer flight whose date matches
        for f in flights:
            dep = f.get("departure", {})
            sched = dep.get("scheduled", "") or ""
            if flight_date and sched.startswith(flight_date):
                return f
        return flights[0] if flights else None
    except Exception as e:
        print(f"  AviationStack error for {flight_iata}: {e}")
        return None


def apply_aviationstack(current, as_data):
    """Merge AviationStack data into current flight dict."""
    if not as_data:
        return current
    dep = as_data.get("departure") or {}
    arr = as_data.get("arrival") or {}
    airline = as_data.get("airline") or {}
    aircraft = as_data.get("aircraft") or {}

    def setif(key, value):
        if value:
            current[key] = value

    setif("airline", airline.get("name"))
    setif("airline_iata", airline.get("iata"))
    setif("aircraft_type", aircraft.get("iata"))
    setif("aircraft_registration", aircraft.get("registration"))

    if dep.get("iata"):
        current.setdefault("origin", {})["iata"] = dep["iata"]
    if dep.get("airport"):
        current.setdefault("origin", {})["name"] = dep["airport"]
    if arr.get("iata"):
        current.setdefault("destination", {})["iata"] = arr["iata"]
    if arr.get("airport"):
        current.setdefault("destination", {})["name"] = arr["airport"]

    setif("scheduled_departure", dep.get("scheduled"))
    setif("scheduled_arrival",   arr.get("scheduled"))
    if dep.get("actual"):
        current["actual_departure"] = dep["actual"]
    if arr.get("actual"):
        current["actual_arrival"] = arr["actual"]

    status = as_data.get("flight_status")
    if status:
        current["status"] = status

    # Delays
    if current.get("actual_departure") and current.get("scheduled_departure"):
        d = delay_min(current["scheduled_departure"], current["actual_departure"])
        if d is not None:
            current["delay_departure"] = max(0, d)
    elif dep.get("delay"):
        current["delay_departure"] = int(dep["delay"])

    if current.get("actual_arrival") and current.get("scheduled_arrival"):
        d = delay_min(current["scheduled_arrival"], current["actual_arrival"])
        if d is not None:
            current["delay_arrival"] = max(0, d)
    elif arr.get("delay"):
        current["delay_arrival"] = int(arr["delay"])

    return current


# ── OpenSky Network ─────────────────────────────────────────────────────────

# IATA → ICAO callsign prefix mapping (most common airlines in Taiwan / Asia)
IATA_TO_ICAO = {
    "CI": "CAL", "BR": "EVA", "AE": "MDA", "B7": "UIA",
    "IT": "TTW", "JX": "SJX", "GE": "TNA",
    "CX": "CPA", "KA": "HDA",
    "SQ": "SIA", "MI": "SLK", "TR": "TGW",
    "TG": "THA", "PG": "BKP",
    "JL": "JAL", "NH": "ANA", "MM": "APJ", "JW": "WAJ",
    "KE": "KAL", "OZ": "AAR", "LJ": "JNA",
    "CZ": "CSN", "CA": "CCA", "MU": "CES", "HU": "CHH",
    "MF": "CXA", "3U": "CSC", "ZH": "CSZ",
    "AA": "AAL", "UA": "UAL", "DL": "DAL",
    "LH": "DLH", "AF": "AFR", "BA": "BAW",
    "EK": "UAE", "QR": "QTR", "EY": "ETD",
    "TK": "THY", "KL": "KLM",
}


def iata_to_callsign(flight_iata):
    prefix = flight_iata[:2].upper()
    number = flight_iata[2:]
    icao = IATA_TO_ICAO.get(prefix, prefix)
    return f"{icao}{number}"


def fetch_opensky_states():
    """Fetch ALL live aircraft states from OpenSky — one call shared across all flights."""
    try:
        r = requests.get("https://opensky-network.org/api/states/all", timeout=20)
        r.raise_for_status()
        return r.json().get("states") or []
    except Exception as e:
        print(f"  OpenSky error: {e}")
        return []


def fetch_opensky_flight_info(icao24, flight_date):
    """
    Fallback (no AviationStack): query OpenSky historical flights API for
    actual departure/arrival timestamps using the aircraft's icao24 address.
    Returns the first matching flight record or None.
    """
    try:
        day   = datetime.strptime(flight_date, "%Y-%m-%d").replace(tzinfo=timezone.utc)
        begin = int((day - timedelta(hours=3)).timestamp())
        end   = int((day + timedelta(hours=30)).timestamp())
        r = requests.get(
            "https://opensky-network.org/api/flights/aircraft",
            params={"icao24": icao24.lower(), "begin": begin, "end": end},
            timeout=15,
        )
        if r.status_code == 404:
            return None
        r.raise_for_status()
        flights = r.json() or []
        return flights[0] if flights else None
    except Exception as e:
        print(f"  OpenSky flights/aircraft error: {e}")
        return None


def apply_opensky_flight_info(current, osk):
    """
    Merge OpenSky historical flight data into current flight dict.
    Provides actual departure/arrival times and infers status/delays.
    """
    if not osk:
        return current
    first = osk.get("firstSeen")   # unix timestamp of wheels-up
    last  = osk.get("lastSeen")    # unix timestamp of wheels-down
    if first:
        current["actual_departure"] = datetime.fromtimestamp(first, tz=timezone.utc).isoformat()
        if (current.get("status") or "scheduled") == "scheduled":
            current["status"] = "active"
    if last and first and (last - first) > 600:   # at least 10-min flight
        current["actual_arrival"] = datetime.fromtimestamp(last, tz=timezone.utc).isoformat()
        current["status"] = "landed"
    # Recompute delays from actual vs scheduled times
    if current.get("actual_departure") and current.get("scheduled_departure"):
        d = delay_min(current["scheduled_departure"], current["actual_departure"])
        if d is not None:
            current["delay_departure"] = max(0, d)
    if current.get("actual_arrival") and current.get("scheduled_arrival"):
        d = delay_min(current["scheduled_arrival"], current["actual_arrival"])
        if d is not None:
            current["delay_arrival"] = max(0, d)
    return current


def find_in_states(states, callsign):
    """Search pre-fetched OpenSky states for a specific callsign."""
    target = callsign.strip().upper()
    now_iso = datetime.now(timezone.utc).isoformat()
    for s in states:
        cs = (s[1] or "").strip().upper()
        if cs == target:
            return {
                "icao24":        s[0],
                "callsign":      cs,
                "latitude":      s[6],
                "longitude":     s[5],
                "altitude_m":    s[7],
                "altitude_ft":   int((s[7] or 0) * 3.28084),
                "on_ground":     s[8],
                "velocity_ms":   s[9],
                "speed_kt":      int((s[9] or 0) * 1.94384),
                "heading":       s[10],
                "vertical_rate": s[11],
                "updated_at":    now_iso,
            }
    return None


# ── Main logic ──────────────────────────────────────────────────────────────

def flight_hours_until(t, now):
    """Hours until this specific flight departs (negative = already departed)."""
    dep_str = t.get("scheduled_departure") or ""
    dt = parse_dt(dep_str)
    if not dt:
        date_str = t.get("date", "")
        try:
            dt = datetime.strptime(date_str, "%Y-%m-%d").replace(hour=0, minute=0, tzinfo=timezone.utc)
        except ValueError:
            return None
    return (dt - now).total_seconds() / 3600


def flight_phase(hours):
    """Return (phase_name, as_interval_min) for a single flight based on hours until departure."""
    if hours is None:
        return "unknown", 30 * 24 * 60
    abs_h = abs(hours)
    for phase_name, threshold_hours, interval_min in PHASES:
        if abs_h <= threshold_hours:
            return phase_name, interval_min
    return "monthly", 30 * 24 * 60


def should_fetch_as(flight_meta, interval_min):
    """Check if AviationStack should be called for this specific flight."""
    last = parse_dt(flight_meta.get("last_as_fetch_at", ""))
    if not last:
        return True
    elapsed = (datetime.now(timezone.utc) - last).total_seconds() / 60
    return elapsed >= interval_min


def main():
    adb_key    = os.environ.get("AERODATABOX_KEY", "").strip()
    as_key     = os.environ.get("AVIATIONSTACK_KEY", "").strip()
    ntfy_topic = os.environ.get("NTFY_TOPIC", "").strip()
    # Alias for legacy references below
    api_key = as_key

    flights_cfg = load_json("flights.json",   {"tracked": []})
    meta        = load_json("data/meta.json", {})

    tracked = flights_cfg.get("tracked", [])

    # Load current state early so we can detect unresolved old flights
    old_status = load_json("data/status.json",  {"flights": []})
    history    = load_json("data/history.json", {"flights": []})
    old_map    = {f["id"]: f for f in old_status.get("flights", [])}
    hist_ids   = {f["id"] for f in history.get("flights", [])}

    # ── Global phase: determines if we run at all ──
    # Pass old_map so unresolved past flights are treated as urgent (0h)
    global_phase, global_interval = get_fetch_interval(tracked, old_map)
    nearest_hours = nearest_flight_hours(tracked, old_map)
    hours_str = f"{nearest_hours:.1f}h away" if nearest_hours is not None else "none"
    print(f"Global phase: {global_phase} | Nearest: {hours_str} | Global interval: {global_interval}min")

    if not should_fetch(meta, global_interval):
        last = meta.get("last_fetch_at", "never")
        print(f"Skipping — last fetch: {last}. Next due in {global_interval}min.")
        sys.exit(0)

    print("Proceeding with fetch run...")

    # Per-flight AS metadata (last call time per flight)
    flight_meta = meta.get("flights", {})

    now = datetime.now(timezone.utc)
    active_flights = []
    opensky_states = None  # Lazy-loaded once if any flight needs it

    for t in tracked:
        flight_id   = t["id"]
        flight_iata = t["flight_number"].upper().replace(" ", "")
        flight_date = t.get("date", "")

        if flight_id in hist_ids:
            print(f"\n{flight_iata}: already in history, skipping")
            continue

        # Archive if too old
        try:
            flight_day = datetime.strptime(flight_date, "%Y-%m-%d").replace(tzinfo=timezone.utc)
            days_ago = (now - flight_day).days
        except Exception:
            days_ago = 0

        if days_ago > 3:
            print(f"\n{flight_iata}: {days_ago} days old — fetching final status then archiving")
            current = dict(old_map.get(flight_id, _default_flight(t)))
            # Always fetch actual status/delay before archiving if still unresolved
            if (current.get("status") or "scheduled") in ("scheduled", ""):
                fetched = False
                if adb_key:
                    print(f"  → AeroDataBox (final lookup)")
                    adb_flights = aerodatabox_flight(flight_iata, flight_date, adb_key)
                    if adb_flights:
                        current = apply_aerodatabox(current, adb_flights, flight_date)
                        print(f"    status={current.get('status')} delay_arr={current.get('delay_arrival')}min [ADB]")
                        fetched = True
                if not fetched and as_key:
                    print(f"  → AviationStack (final lookup)")
                    as_data = aviationstack_flight(flight_iata, flight_date, as_key)
                    if as_data:
                        current = apply_aviationstack(current, as_data)
                        print(f"    status={current.get('status')} delay_arr={current.get('delay_arrival')}min [AS]")
                        fetched = True
                # If APIs still return no resolved status, infer landed (flight date is past)
                if (current.get("status") or "scheduled") == "scheduled":
                    current["status"] = "landed"
                    print(f"    No API data — inferred status=landed (flight date is {days_ago}d ago)")
            current.pop("live", None)
            history["flights"].append(current)
            continue

        current = dict(old_map.get(flight_id, _default_flight(t)))

        # ── Per-flight phase: controls AviationStack call frequency ──
        f_hours = flight_hours_until(t, now)
        f_phase, f_as_interval = flight_phase(f_hours)
        f_meta = flight_meta.get(flight_id, {})

        f_hours_str = f"{f_hours:.1f}h" if f_hours is not None else "?"
        print(f"\n{flight_iata} ({flight_date}): phase={f_phase}, {f_hours_str} until dep")

        # ── Schedule enrichment: AeroDataBox → AviationStack fallback ──
        # Only in weekly/daily/monthly phase — schedule is still subject to change.
        # During hourly/5-min phase, schedule is locked; OpenSky handles live data.
        SCHED_USEFUL_PHASES = {"weekly", "daily", "monthly"}
        if f_phase in SCHED_USEFUL_PHASES and should_fetch_as(f_meta, f_as_interval):
            fetched = False
            # Try AeroDataBox first (100 req/day free — much better quota)
            if adb_key:
                print(f"  → AeroDataBox call (phase={f_phase})")
                adb_flights = aerodatabox_flight(flight_iata, flight_date, adb_key)
                if adb_flights:
                    current = apply_aerodatabox(current, adb_flights, flight_date)
                    print(f"    status={current.get('status')} delay_arr={current.get('delay_arrival')}min [ADB]")
                    fetched = True
                else:
                    print(f"    AeroDataBox: no data, trying AviationStack fallback")
            # Fall back to AviationStack (100 req/month)
            if not fetched and api_key:
                print(f"  → AviationStack call (phase={f_phase})")
                as_data = aviationstack_flight(flight_iata, flight_date, api_key)
                if as_data:
                    current = apply_aviationstack(current, as_data)
                    print(f"    status={current.get('status')} delay_arr={current.get('delay_arrival')}min [AS]")
                else:
                    print(f"    AviationStack: no data returned")
            if adb_key or api_key:
                flight_meta[flight_id] = {
                    "last_as_fetch_at": now.isoformat(),
                    "phase": f_phase,
                    "as_interval_min": f_as_interval,
                }
        elif f_phase not in SCHED_USEFUL_PHASES:
            print(f"  → Skipping schedule fetch (phase={f_phase}, using OpenSky only)")
        else:
            next_as = parse_dt(f_meta.get("last_as_fetch_at", ""))
            next_due = ""
            if next_as:
                due = next_as + timedelta(minutes=f_as_interval)
                next_due = f" (next due {due.strftime('%H:%M')} UTC)"
            print(f"  → Skipping schedule fetch{next_due}")

        # ── OpenSky live: one global call shared across all flights ──
        status = (current.get("status") or "").lower()
        if status not in ("landed", "cancelled", "diverted"):
            # Load OpenSky states once for all flights
            if opensky_states is None:
                print(f"  → Fetching OpenSky states (shared)")
                opensky_states = fetch_opensky_states()

            callsign = iata_to_callsign(flight_iata)
            live = find_in_states(opensky_states, callsign)
            if live:
                current["live"] = live
                print(f"    Live: alt={live['altitude_ft']}ft spd={live['speed_kt']}kt")
                if live["on_ground"] and status == "active":
                    current["status"] = "landed"
                elif not live["on_ground"]:
                    current["status"] = "active"
            else:
                print(f"    Not found in OpenSky (callsign: {callsign})")
                current["live"] = None
        else:
            current["live"] = None

        # ── OpenSky fallback: get actual dep/arr times when no AviationStack ──
        # OpenSky /flights/aircraft returns firstSeen/lastSeen timestamps for a
        # given icao24 address — enough to compute actual times and delays.
        if not api_key and flight_date:
            # icao24 is available from current live state, or stored from a prior run
            icao24 = (current.get("live") or {}).get("icao24") or \
                     (old_map.get(flight_id, {}).get("live") or {}).get("icao24")
            if icao24:
                print(f"  → OpenSky flight-info fallback (icao24={icao24})")
                osk_info = fetch_opensky_flight_info(icao24, flight_date)
                if osk_info:
                    current = apply_opensky_flight_info(current, osk_info)
                    print(f"    status={current.get('status')} "
                          f"dep_delay={current.get('delay_departure', 0)}min "
                          f"arr_delay={current.get('delay_arrival', 0)}min")
                else:
                    print(f"    No historical data yet (flight may not have departed)")

        # ── Notifications ──
        old       = old_map.get(flight_id, {})
        old_delay = old.get("delay_arrival", 0) or 0
        new_delay = current.get("delay_arrival", 0) or 0
        old_st    = (old.get("status") or "").lower()
        new_st    = (current.get("status") or "").lower()
        orig = current.get("origin", {}).get("iata", "???")
        dest = current.get("destination", {}).get("iata", "???")
        fn   = current.get("flight_number", flight_iata)

        if ntfy_topic:
            if abs(new_delay - old_delay) >= 5 and old_delay != 0:
                direction = "increased" if new_delay > old_delay else "decreased"
                notify(ntfy_topic,
                    f"✈️ {fn} Delay {'+' if new_delay > old_delay else '-'}{abs(new_delay-old_delay)}min",
                    f"Arrival delay {direction} to {new_delay}min\n{orig} → {dest}",
                    priority="high" if new_delay > 60 else "default", tags=["airplane"])
            elif new_delay >= 15 and old_delay < 15:
                notify(ntfy_topic, f"⏰ {fn} Delayed +{new_delay}min",
                    f"{orig} → {dest}\nArrival delayed {new_delay} minutes",
                    priority="high" if new_delay > 60 else "default", tags=["warning", "airplane"])
            if new_st != old_st:
                if new_st == "landed":
                    notify(ntfy_topic, f"✅ {fn} Landed",
                        f"{orig} → {dest}\n{'On time ✓' if new_delay <= 15 else f'+{new_delay}min late'}",
                        tags=["white_check_mark"])
                elif new_st == "cancelled":
                    notify(ntfy_topic, f"❌ {fn} CANCELLED",
                        f"Flight {fn} ({orig}→{dest}) cancelled!", priority="urgent", tags=["x"])
                elif new_st == "active" and old_st == "scheduled":
                    notify(ntfy_topic, f"🛫 {fn} Departed", f"{orig} → {dest}", tags=["airplane"])

        # Move to history if completed
        if new_st in ("landed", "cancelled") and days_ago >= 1:
            entry = dict(current)
            entry.pop("live", None)
            history["flights"].append(entry)
            hist_ids.add(flight_id)
            print(f"  Moved to history")
            continue

        active_flights.append(current)

    # Save
    save_json("data/status.json", {
        "updated_at": now.isoformat(),
        "flights": active_flights,
    })
    save_json("data/history.json", history)
    save_json("data/meta.json", {
        "last_fetch_at":        now.isoformat(),
        "phase":                global_phase,
        "interval_min":         global_interval,
        "next_fetch_at":        (now + timedelta(minutes=global_interval)).isoformat(),
        "nearest_flight_hours": round(nearest_hours, 2) if nearest_hours is not None else None,
        "flights":              flight_meta,
    })
    as_calls = sum(1 for fid, fm in flight_meta.items()
                   if fm.get("last_as_fetch_at", "").startswith(now.strftime("%Y-%m-%d")))
    opensky_calls = 1 if opensky_states is not None else 0
    print(f"\nDone. Active: {len(active_flights)} | History: {len(history['flights'])}")
    print(f"API calls this run → AviationStack: {as_calls} | OpenSky: {opensky_calls}")
    print(f"Next global fetch in {global_interval}min")


def _default_flight(t):
    """Build a default flight dict from a tracked entry."""
    return {
        "id":                 t["id"],
        "flight_number":      t["flight_number"].upper(),
        "date":               t.get("date", ""),
        "airline":            t.get("airline", ""),
        "airline_iata":       t["flight_number"][:2].upper(),
        "aircraft_type":      t.get("aircraft_type", ""),
        "origin":             {"iata": t.get("origin", ""), "name": ""},
        "destination":        {"iata": t.get("destination", ""), "name": ""},
        "scheduled_departure": t.get("scheduled_departure", ""),
        "scheduled_arrival":   t.get("scheduled_arrival", ""),
        "actual_departure":    None,
        "actual_arrival":      None,
        "status":              "scheduled",
        "delay_departure":     0,
        "delay_arrival":       0,
        "live":                None,
    }


if __name__ == "__main__":
    main()
