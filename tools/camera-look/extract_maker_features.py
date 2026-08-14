"""Per-shot maker-note / XMP features for the tuning predictor.

The camera writes its Auto Picture Control decisions into the NEF both as
XMP-crd (ACR terms: Contrast2012, Saturation, Clarity2012, Texture...) and
as Nikon tags (ColorTemperatureAuto, WB_RBLevels). Extract the ones that
vary per shot, keyed by the pair-dump tag.
"""

import json
import re
from pathlib import Path

HERE = Path(__file__).parent

NUMERIC = [
    "XMP-crd:Contrast2012", "XMP-crd:Saturation", "XMP-crd:Clarity2012",
    "XMP-crd:Texture", "XMP-crd:Sharpness", "XMP-crd:LuminanceSmoothing",
    "XMP-crd:ColorNoiseReduction",
    "XMP-crd:HueAdjustmentRed", "XMP-crd:HueAdjustmentOrange",
    "XMP-crd:HueAdjustmentYellow",
    "XMP-crd:SaturationAdjustmentRed", "XMP-crd:SaturationAdjustmentOrange",
    "XMP-crd:SaturationAdjustmentYellow",
    "XMP-crd:LuminanceAdjustmentRed", "XMP-crd:LuminanceAdjustmentOrange",
    "XMP-crd:LuminanceAdjustmentYellow",
    "Nikon:ColorTemperatureAuto", "Nikon:FocusDistance",
    "Nikon:ISO", "Nikon:ISO2",
    "ExifIFD:ExposureCompensation", "ExifIFD:GainControl",
    "ExifIFD:ExposureProgram", "Composite:LightValue",
    "Nikon:AFAreaXPosition", "Nikon:AFAreaYPosition",
    "Composite:ContrastDetectAF",
]


def main():
    d = json.load(open(HERE / "makernotes_all.json"))
    out = {}
    for e in d:
        src = e.get("SourceFile", "")
        m = re.match(r".*/Nikon_RAW/([^/]+)/([^/]+)\.NEF", src)
        if not m:
            continue
        tag = m.group(1).replace(" ", "-") + "_" + m.group(2)
        row = {}
        for k in NUMERIC:
            v = e.get(k)
            try:
                row[k.split(":")[1]] = float(v)
            except (TypeError, ValueError):
                row[k.split(":")[1]] = None
        wb = str(e.get("Nikon:WB_RBLevels", "")).split()
        row["WB_R"] = float(wb[0]) if len(wb) >= 2 else None
        row["WB_B"] = float(wb[1]) if len(wb) >= 2 else None
        out[tag] = row
    # the eclipse folder was renamed on disk after the dump (date digit fix);
    # fall back to matching on (folder-minus-date, file stem)
    def datefree(tag):
        folder, stem = tag.rsplit("_DSC_", 1)
        return re.sub(r"^\d+-", "", folder) + "_DSC_" + stem

    alias = {datefree(t): t for t in out}
    entries = json.load(open(HERE / "images2.json"))
    for e in entries:
        t = e["tag"]
        if t not in out and datefree(t) in alias:
            out[t] = out[alias[datefree(t)]]
    json.dump(out, open(HERE / "maker_features.json", "w"))
    print("wrote", len(out), "rows")
    missing = [e["tag"] for e in entries if e["tag"] not in out]
    print("pairs without maker row:", len(missing), missing[:5])


if __name__ == "__main__":
    main()
