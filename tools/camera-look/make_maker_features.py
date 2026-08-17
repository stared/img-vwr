"""Regenerate maker_features.json without exiftool: the portable columns.

The predictor's PORTABLE_MAKER subset needs only the XMP-crd packet (plain
XML at the head of the NEF) and standard EXIF - both readable in pure
Python. The encrypted-maker-note fields (ColorTemperatureAuto, WB_RBLevels,
FocusDistance) stay None and fall back to their defaults in
fit_joint.maker_features, exactly as `--maker portable` ignores them.

Usage: uv run --with exifread python make_maker_features.py
"""
import json
import math
import re
from pathlib import Path

import exifread

HERE = Path(__file__).parent
ROOT = Path("/Users/pmigdal/Pictures/Nikon_RAW")

XMP_FIELDS = {
    "Contrast2012": "Contrast2012",
    "Saturation": "Saturation",
    "Clarity2012": "Clarity2012",
    "Texture": "Texture",
    "Sharpness": "Sharpness",
    "LuminanceSmoothing": "LuminanceSmoothing",
    "ColorNoiseReduction": "ColorNoiseReduction",
}


def xmp_numbers(path):
    head = open(path, "rb").read(256 * 1024)
    out = {}
    for key, name in XMP_FIELDS.items():
        m = re.search(rf"<crd:{name}>([-\d.]+)</crd:{name}>".encode(), head)
        out[key] = float(m.group(1)) if m else None
    return out


def ratio(tag):
    if tag is None:
        return None
    v = tag.values[0]
    try:
        return float(v.num) / float(v.den) if v.den else None
    except AttributeError:
        return float(v)


def exif_numbers(path):
    t = exifread.process_file(open(path, "rb"), details=False)
    ec = ratio(t.get("EXIF ExposureBiasValue"))
    gain = t.get("EXIF GainControl")
    prog = t.get("EXIF ExposureProgram")
    tv = ratio(t.get("EXIF ExposureTime"))
    n = ratio(t.get("EXIF FNumber"))
    iso_tag = t.get("EXIF ISOSpeedRatings")
    iso = float(iso_tag.values[0]) if iso_tag else None
    lv = None
    if tv and n and iso and tv > 0 and iso > 0:
        lv = math.log2(n * n / tv * 100.0 / iso)
    return {
        "ExposureCompensation": ec,
        "GainControl": float(gain.values[0]) if gain else None,
        "ExposureProgram": float(prog.values[0]) if prog else None,
        "LightValue": lv,
    }


def main():
    out = {}
    for nef in sorted(ROOT.rglob("*.NEF")):
        folder = nef.parent.name
        if folder.endswith("PICKS") or folder in ("first_session", "test"):
            continue
        tag = folder.replace(" ", "-") + "_" + nef.stem
        row = xmp_numbers(nef)
        row.update(exif_numbers(nef))
        # Encrypted-maker-note fields: honest Nones, defaults apply downstream.
        row.update({"ColorTemperatureAuto": None, "WB_R": None, "WB_B": None,
                    "FocusDistance": None})
        out[tag] = row
    json.dump(out, open(HERE / "maker_features.json", "w"))
    print("wrote", len(out), "rows")


if __name__ == "__main__":
    main()
