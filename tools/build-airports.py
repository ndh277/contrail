#!/usr/bin/env python3
"""Build data/airports.json from OurAirports (public domain).

Usage: python3 tools/build-airports.py [airports.csv countries.csv]
Without arguments the CSVs are downloaded from the OurAirports data mirror.
Keeps large + medium airports with scheduled service and an IATA code.
"""
import csv, io, json, re, sys, urllib.request
from pathlib import Path

BASE = "https://raw.githubusercontent.com/davidmegginson/ourairports-data/main/"

# Cleaner city names for a few airports whose `municipality` field is messy.
CITY_OVERRIDES = {
    "HAN": "Hà Nội", "SGN": "Hồ Chí Minh City", "DAD": "Đà Nẵng", "HPH": "Hải Phòng",
    "CXR": "Nha Trang", "HUI": "Huế", "PQC": "Phú Quốc", "VCA": "Cần Thơ",
    "DLI": "Đà Lạt", "UIH": "Quy Nhơn", "VII": "Vinh", "VDO": "Vân Đồn",
    "BMV": "Buôn Ma Thuột", "VDH": "Đồng Hới", "DIN": "Điện Biên Phủ", "PXU": "Pleiku",
    "TBB": "Tuy Hòa", "VKG": "Rạch Giá", "VCS": "Côn Đảo", "CAH": "Cà Mau", "THD": "Thanh Hóa",
}
NAME_OVERRIDES = {"HAN": "Nội Bài International Airport", "SGN": "Tân Sơn Nhất International Airport",
                  "CXR": "Cam Ranh International Airport"}


def read(arg_index, name):
    if len(sys.argv) > arg_index:
        return Path(sys.argv[arg_index]).read_text(encoding="utf-8")
    with urllib.request.urlopen(BASE + name) as r:
        return r.read().decode("utf-8")


def clean_city(s):
    s = re.sub(r"\s*\(.*?\)\s*", " ", s or "").strip()
    s = s.split("/")[0].strip()
    return s


def main():
    airports = csv.DictReader(io.StringIO(read(1, "airports.csv")))
    countries = {r["code"]: r["name"] for r in csv.DictReader(io.StringIO(read(2, "countries.csv")))}
    rows, used = [], set()
    for r in airports:
        iata = r["iata_code"].strip().upper()
        if r["type"] not in ("large_airport", "medium_airport") or r["scheduled_service"] != "yes":
            continue
        if not re.fullmatch(r"[A-Z]{3}", iata) or iata in used:
            continue
        used.add(iata)
        city = CITY_OVERRIDES.get(iata) or clean_city(r["municipality"]) or r["name"]
        rows.append([
            iata,
            NAME_OVERRIDES.get(iata, r["name"].strip()),
            city,
            r["iso_country"],
            round(float(r["latitude_deg"]), 4),
            round(float(r["longitude_deg"]), 4),
            1 if r["type"] == "large_airport" else 0,
        ])
    rows.sort(key=lambda x: x[0])
    used_cc = {x[3] for x in rows}
    out = {
        "source": "OurAirports (public domain) - ourairports.com",
        "fields": ["iata", "name", "city", "country", "lat", "lon", "large"],
        "countries": {k: v for k, v in sorted(countries.items()) if k in used_cc},
        "rows": rows,
    }
    dest = Path(__file__).resolve().parent.parent / "data" / "airports.json"
    dest.write_text(json.dumps(out, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"{len(rows)} airports -> {dest} ({dest.stat().st_size // 1024} KB)")


if __name__ == "__main__":
    main()
