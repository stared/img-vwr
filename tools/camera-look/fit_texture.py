"""Fit an unsharp stage per ISO band on 1:1 patch pairs.

For each pair: align the camera crop to ours (integer shift, low-passed
luma correlation), then grid-search unsharp (sigma, amount) applied to our
patch to minimize mean |delta| on the aligned luma. Also reports the edge
energy ratio before/after, per ISO band.
"""

import json
from pathlib import Path

import numpy as np
from PIL import Image
from scipy.ndimage import gaussian_filter

HERE = Path(__file__).parent
P = HERE / "patches"
PATCH, MARGIN = 768, 32


def luma(a):
    return a @ np.array([0.2126, 0.7152, 0.0722])


def align(ours_y, cam_y):
    """Best integer shift of the 768 window inside the 832 camera crop."""
    ol = gaussian_filter(ours_y, 4)[64:-64, 64:-64]
    ol = ol - ol.mean()
    best, arg = -1e18, (MARGIN, MARGIN)
    for dy in range(0, 2 * MARGIN + 1, 2):
        for dx in range(0, 2 * MARGIN + 1, 2):
            c = gaussian_filter(cam_y[dy : dy + PATCH, dx : dx + PATCH], 4)[64:-64, 64:-64]
            c = c - c.mean()
            s = (ol * c).sum() / (np.sqrt((ol**2).sum() * (c**2).sum()) + 1e-9)
            if s > best:
                best, arg = s, (dy, dx)
    # refine +-1
    dy0, dx0 = arg
    for dy in range(max(0, dy0 - 1), min(2 * MARGIN, dy0 + 1) + 1):
        for dx in range(max(0, dx0 - 1), min(2 * MARGIN, dx0 + 1) + 1):
            c = gaussian_filter(cam_y[dy : dy + PATCH, dx : dx + PATCH], 4)[64:-64, 64:-64]
            c = c - c.mean()
            s = (ol * c).sum() / (np.sqrt((ol**2).sum() * (c**2).sum()) + 1e-9)
            if s > best:
                best, arg = s, (dy, dx)
    return arg, best


def edge_energy(y):
    gx = np.diff(y, axis=1)
    gy = np.diff(y, axis=0)
    return np.sqrt((gx**2).mean() + (gy**2).mean())


def main():
    entries = [json.loads(l) for l in open(P / "patches.jsonl")]
    bands = {0: (0, 250), 1: (251, 1000), 2: (1001, 4000), 3: (4001, 16000), 4: (16001, 10**9)}
    per_band = {b: [] for b in bands}

    for e in entries:
        tag, iso = e["tag"], e.get("iso") or 100
        ours = np.asarray(Image.open(P / f"{tag}_ours.png").convert("RGB"), np.float32) / 255
        cam = np.asarray(Image.open(P / f"{tag}_cam.png").convert("RGB"), np.float32) / 255
        oy, cy_full = luma(ours), luma(cam)
        (dy, dx), corr = align(oy, cy_full)
        if corr < 0.85:
            print(f"skip {tag}: corr {corr:.2f}")
            continue
        cy = cy_full[dy : dy + PATCH, dx : dx + PATCH]
        b = next(k for k, (lo, hi) in bands.items() if lo <= iso <= hi)
        per_band[b].append((tag, oy, cy))

    print("\nband  n   edge(cam)/edge(ours)   best (sigma, amount)   err0 -> err*")
    results = {}
    for b, rows in per_band.items():
        if not rows:
            continue
        ratios = [edge_energy(cy) / max(edge_energy(oy), 1e-9) for _, oy, cy in rows]
        # grid search shared over the band
        grid_s = [0.7, 1.0, 1.4, 2.0]
        grid_a = [0.0, 0.25, 0.5, 0.75, 1.0, 1.5, 2.0]
        def band_err(sig, amt):
            tot = 0.0
            for _, oy, cy in rows:
                sharp = oy + amt * (oy - gaussian_filter(oy, sig)) if amt > 0 else oy
                m = 16
                tot += np.abs(sharp[m:-m, m:-m] - cy[m:-m, m:-m]).mean()
            return tot / len(rows) * 255
        err0 = band_err(1.0, 0.0)
        best = (1e9, None)
        for s in grid_s:
            for a in grid_a:
                e_ = band_err(s, a)
                if e_ < best[0]:
                    best = (e_, (s, a))
        results[b] = dict(n=len(rows), ratio=float(np.median(ratios)),
                          sigma=best[1][0], amount=best[1][1],
                          err0=err0, err=best[0])
        print(f"{b:4d} {len(rows):3d}   {np.median(ratios):8.3f}          "
              f"({best[1][0]}, {best[1][1]})   {err0:.2f} -> {best[0]:.2f}")
    json.dump(results, open(HERE / "texture_fit.json", "w"), indent=1)


if __name__ == "__main__":
    main()
