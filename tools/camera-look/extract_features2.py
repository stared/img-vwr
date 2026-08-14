"""Per-image metering features from the full grids: global and center-weighted
log-luma percentiles, per-channel percentiles, clipped fractions. The camera
meters the frame it sees, so the predictor gets to see the same frame."""

import json
from pathlib import Path

import numpy as np

PAIRS = Path(__file__).parent / "pairs2"
BORDER = 0.06


def luma(rgb):
    return 0.2126 * rgb[..., 0] + 0.7152 * rgb[..., 1] + 0.0722 * rgb[..., 2]


def main():
    entries = [json.loads(l) for l in open(PAIRS / "manifest.jsonl")]
    seen, unique = set(), []
    for e in entries:
        if e["tag"] not in seen:
            seen.add(e["tag"])
            unique.append(e)

    out = []
    for e in unique:
        w, h = e["w"], e["h"]
        scene = np.fromfile(PAIRS / f'{e["tag"]}_scene.f32', dtype=np.float32).reshape(h, w, 3)
        mx, my = int(w * BORDER), int(h * BORDER)
        inner = scene[my : h - my, mx : w - mx]
        y = luma(inner)
        ylog = np.log2(np.maximum(y, 1e-8))
        gq = np.percentile(ylog, [1, 5, 25, 50, 75, 90, 95, 99, 99.9])
        # centre-weighted: middle 40% of the frame
        ch, cw = inner.shape[0] // 5, inner.shape[1] // 5
        centre = luma(inner[2 * ch : -2 * ch or None, 2 * cw : -2 * cw or None])
        cq = np.percentile(np.log2(np.maximum(centre, 1e-8)), [25, 50, 75, 95])
        clip_hi = float((y > 0.95).mean())
        clip_lo = float((y < 0.001).mean())
        # per-channel medians for cast features
        chan = [float(np.log2(max(np.median(inner[..., c]), 1e-8))) for c in range(3)]
        out.append(
            dict(
                tag=e["tag"],
                gq=[float(v) for v in gq],
                cq=[float(v) for v in cq],
                clip_hi=clip_hi,
                clip_lo=clip_lo,
                chan=chan,
            )
        )
    json.dump(out, open(Path(__file__).parent / "features2.json", "w"))
    print("features for", len(out), "images")


if __name__ == "__main__":
    main()
