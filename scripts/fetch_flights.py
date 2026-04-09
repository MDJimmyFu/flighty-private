#!/usr/bin/env python3
"""
Flighty Private — GitHub Actions data fetcher.
Runs every 5 minutes, fetches live flight data, sends ntfy notifications.
"""
import json
import os
import sys
import time
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


def opensky_live(callsign):
    """Search OpenSky for a live flight by callsign. Rate limit: ~10 req/min for anon."""
    target = callsign.strip().upper().ljust(8)  # OpenSky pads callsigns to 8 chars
    target_strip = callsign.strip().upper()
    try:
        r = requests.get(
            "https://opensky-network.org/api/states/all",
            timeout=20,
        )
        r.raise_for_status()
        states = r.json().get("states") or []
        for s in states:
            cs = (s[1] or "").strip().upper()
            if cs == target_strip:
                return {
                    "icao24":        s[0],
                    "callsign":      cs,
                    "latitude":      s[6],
                    "longitude":     s[5],
                    "altitude_m":    s[7],  # geometric altitude in metres
                    "altitude_ft":   int((s[7] or 0) * 3.28084),
                    "on_ground":     s[8],
                    "velocity_ms":   s[9],
                    "speed_kt":      int((s[9] or 0) * 1.94384),
                    "heading":       s[10],
                    "vertical_rate": s[11],
                    "updated_at":    datetime.now(timezone.utc).isoformat(),
                }
    except Exception as e:
        print(f"  OpenSky error: {e}")
    return None


# ── Main logic ──────────────────────────────────────────────────────────────

def main():
    api_key    = os.environ.get("AVIATIONSTACK_KEY", "").strip()
    ntfy_topic = os.environ.get("NTFY_TOPIC", "").strip()

    flights_cfg = load_json("flights.json",      {"tracked": []})
    old_status  = load_json("data/status.json",  {"flights": []})
    history     = load_json("data/history.json", {"flights": []})

    old_map = {f["id"]: f for f in old_status.get("flights", [])}
    hist_ids = {f["id"] for f in history.get("flights", [])}

    now = datetime.now(timezone.utc)
    active_flights = []

    for t in flights_cfg.get("tracked", []):
        flight_id   = t["id"]
        flight_iata = t["flight_number"].upper().replace(" ", "")
        flight_date = t.get("date", "")
        print(f"\nProcessing {flight_iata} ({flight_date})")

        # If already in history, skip
        if flight_id in hist_ids:
            print(f"  Already in history, skipping")
            continue

        # Determine if flight date is too far in the past
        try:
            flight_day = datetime.strptime(flight_date, "%Y-%m-%d").replace(tzinfo=timezone.utc)
            days_ago = (now - flight_day).days
        except Exception:
            days_ago = 0

        if days_ago > 3:
            print(f"  Flight was {days_ago} days ago, archiving")
            # Archive with whatever data we have
            current = old_map.get(flight_id, _default_flight(t))
            current.pop("live", None)
            history["flights"].append(current)
            continue

        # Build current from previous data or defaults
        current = dict(old_map.get(flight_id, _default_flight(t)))

        # Fetch from AviationStack if key available
        if api_key:
            print(f"  Fetching AviationStack...")
            as_data = aviationstack_flight(flight_iata, flight_date, api_key)
            if as_data:
                current = apply_aviationstack(current, as_data)
                print(f"  Status: {current.get('status')} | Delay arr: {current.get('delay_arrival')}min")
            else:
                print(f"  No AviationStack data")

        # Fetch live position from OpenSky (only if not landed/cancelled)
        status = (current.get("status") or "").lower()
        if status not in ("landed", "cancelled", "diverted"):
            callsign = iata_to_callsign(flight_iata)
            print(f"  Searching OpenSky for callsign: {callsign}")
            live = opensky_live(callsign)
            if live:
                current["live"] = live
                print(f"  Live! Alt: {live['altitude_ft']}ft, Spd: {live['speed_kt']}kt")
                if live["on_ground"] and status == "active":
                    current["status"] = "landed"
                elif not live["on_ground"]:
                    current["status"] = "active"
            else:
                print(f"  Not found in OpenSky")
                current["live"] = None
        else:
            current["live"] = None

        # ── Check for changes and notify ──
        old = old_map.get(flight_id, {})

        old_delay  = old.get("delay_arrival", 0) or 0
        new_delay  = current.get("delay_arrival", 0) or 0
        old_status = (old.get("status") or "").lower()
        new_status = (current.get("status") or "").lower()

        orig = current.get("origin", {}).get("iata", "???")
        dest = current.get("destination", {}).get("iata", "???")
        fn   = current.get("flight_number", flight_iata)

        if ntfy_topic:
            # Delay change (>= 5 min difference)
            if abs(new_delay - old_delay) >= 5 and old_delay != 0:
                direction = "increased" if new_delay > old_delay else "decreased"
                priority  = "high" if new_delay > 60 else "default"
                notify(
                    ntfy_topic,
                    f"✈️ {fn} Delay {'+' if new_delay > old_delay else '-'}{abs(new_delay - old_delay)}min",
                    f"Arrival delay {direction} to {new_delay}min\n"
                    f"{orig} → {dest}\n"
                    f"Scheduled: {current.get('scheduled_arrival', 'Unknown')}",
                    priority=priority, tags=["airplane"],
                )
            # First delay detected
            elif new_delay >= 15 and old_delay < 15:
                notify(
                    ntfy_topic,
                    f"⏰ {fn} Delayed +{new_delay}min",
                    f"{orig} → {dest}\n"
                    f"Arrival delayed by {new_delay} minutes",
                    priority="default" if new_delay < 60 else "high",
                    tags=["warning", "airplane"],
                )
            # Status changes
            if new_status != old_status:
                if new_status == "landed":
                    msg = f"On time ✓" if new_delay <= 15 else f"+{new_delay}min late"
                    notify(ntfy_topic, f"✅ {fn} Landed", f"{orig} → {dest}\n{msg}", tags=["white_check_mark"])
                elif new_status == "cancelled":
                    notify(ntfy_topic, f"❌ {fn} CANCELLED", f"Flight {fn} ({orig}→{dest}) cancelled!", priority="urgent", tags=["x"])
                elif new_status == "active" and old_status == "scheduled":
                    notify(ntfy_topic, f"🛫 {fn} Departed", f"{orig} → {dest}", tags=["airplane"])

        # Move to history if completed
        if (current.get("status") or "").lower() in ("landed", "cancelled") and days_ago >= 1:
            entry = dict(current)
            entry.pop("live", None)
            history["flights"].append(entry)
            hist_ids.add(flight_id)
            print(f"  Moved to history (status: {current['status']})")
            continue

        active_flights.append(current)

    # Save outputs
    save_json("data/status.json", {
        "updated_at": now.isoformat(),
        "flights": active_flights,
    })
    save_json("data/history.json", history)
    print(f"\nDone. Active: {len(active_flights)}, History: {len(history['flights'])}")


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
