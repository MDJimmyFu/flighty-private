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


def nearest_flight_hours(tracked):
    """
    Returns the minimum hours until (or since) any tracked flight's departure.
    Considers flights up to 24h after departure (in case still airborne/landing).
    Returns None if there are no tracked flights.
    """
    now = datetime.now(timezone.utc)
    best = None
    for t in tracked:
        # Use scheduled_departure if available, otherwise midnight of flight date
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


def get_fetch_interval(tracked):
    """Return (phase_name, interval_minutes) based on nearest flight."""
    hours = nearest_flight_hours(tracked)
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
    api_key    = os.environ.get("AVIATIONSTACK_KEY", "").strip()
    ntfy_topic = os.environ.get("NTFY_TOPIC", "").strip()

    flights_cfg = load_json("flights.json",   {"tracked": []})
    meta        = load_json("data/meta.json", {})

    tracked = flights_cfg.get("tracked", [])

    # ── Global phase: determines if we run at all ──
    global_phase, global_interval = get_fetch_interval(tracked)
    nearest_hours = nearest_flight_hours(tracked)
    hours_str = f"{nearest_hours:.1f}h away" if nearest_hours is not None else "none"
    print(f"Global phase: {global_phase} | Nearest: {hours_str} | Global interval: {global_interval}min")

    if not should_fetch(meta, global_interval):
        last = meta.get("last_fetch_at", "never")
        print(f"Skipping — last fetch: {last}. Next due in {global_interval}min.")
        sys.exit(0)

    print("Proceeding with fetch run...")

    old_status = load_json("data/status.json",  {"flights": []})
    history    = load_json("data/history.json", {"flights": []})

    old_map  = {f["id"]: f for f in old_status.get("flights", [])}
    hist_ids = {f["id"] for f in history.get("flights", [])}

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
            print(f"\n{flight_iata}: {days_ago} days old, archiving")
            current = old_map.get(flight_id, _default_flight(t))
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

        # ── AviationStack: only in weekly/daily phase (schedule still may change) ──
        # During hourly/5-min phase, the schedule is fixed — OpenSky handles live data.
        # Free plan: 100 req/month. We conserve by skipping AS when airborne/near departure.
        AS_USEFUL_PHASES = {"weekly", "daily", "monthly"}
        if api_key and f_phase in AS_USEFUL_PHASES and should_fetch_as(f_meta, f_as_interval):
            print(f"  → AviationStack call (phase={f_phase}, interval={f_as_interval}min)")
            as_data = aviationstack_flight(flight_iata, flight_date, api_key)
            if as_data:
                current = apply_aviationstack(current, as_data)
                print(f"    status={current.get('status')} delay_arr={current.get('delay_arrival')}min")
            else:
                print(f"    No data returned")
            flight_meta[flight_id] = {
                "last_as_fetch_at": now.isoformat(),
                "phase": f_phase,
                "as_interval_min": f_as_interval,
            }
        elif f_phase not in AS_USEFUL_PHASES:
            print(f"  → Skipping AviationStack (phase={f_phase}, using OpenSky only)")
        else:
            next_as = parse_dt(f_meta.get("last_as_fetch_at", ""))
            next_due = ""
            if next_as:
                due = next_as + timedelta(minutes=f_as_interval)
                next_due = f" (next AS due {due.strftime('%H:%M')} UTC)"
            print(f"  → Skipping AviationStack{next_due}")

        # ── OpenSky: one global call shared across all flights ──
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
