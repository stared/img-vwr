"""Does an edge-preserving NR pass close the high-ISO texture gap?

On the aligned 1:1 patches: split error into luma vs chroma, then try a
guided filter (luma-guided, on each channel's difference from luma) at a
few radii/strengths, per ISO band. Pure measurement — nothing ships from
here directly.
"""

import json
from pathlib import Path

import numpy as np
from PIL import Image
from scipy.ndimage import uniform_filter, gaussian_filter

HERE = Path(__file__).parent
P = HERE / "patches"
PATCH, MARGIN = 768, 32


def luma(a):
    return a @ np.array([0.2126, 0.7152, 0.0722])


def guided(guide, src, r, eps):
    """Grey-guide guided filter (He et al.), box radius r."""
    mg = uniform_filter(guide, 2 * r + 1)
    ms = uniform_filter(src, 2 * r + 1)
    corr = uniform_filter(guide * src, 2 * r + 1)
    var = uniform_filter(guide * guide, 2 * r + 1) - mg * mg
    a = (corr - mg * ms) / (var + eps)
    b = ms - a * mg
    return uniform_filter(a, 2 * r + 1) * guide + uniform_filter(b, 2 * r + 1)


def main():
    import fit_texture as ft
    entries = [json.loads(l) for l in open(P / "patches.jsonl")]
    bands = {3: (4001, 16000), 4: (16001, 10**9)}
    rows = {b: [] for b in bands}
    for e in entries:
        iso = e.get("iso") or 100
        b = next((k for k, (lo, hi) in bands.items() if lo <= iso <= hi), None)
        if b is None:
            continue
        tag = e["tag"]
        ours = np.asarray(Image.open(P / f"{tag}_ours.png").convert("RGB"), np.float32) / 255
        cam = np.asarray(Image.open(P / f"{tag}_cam.png").convert("RGB"), np.float32) / 255
        oy, cy_full = luma(ours), luma(cam)
        (dy, dx), corr = ft.align(oy, cy_full)
        if corr < 0.85:
            continue
        camc = cam[dy : dy + PATCH, dx : dx + PATCH]
        rows[b].append((ours, camc))

    m = 16
    for b, prs in rows.items():
        if not prs:
            continue
        el = ec = 0.0
        for ours, cam in prs:
            oy, cy = luma(ours), luma(cam)
            el += np.abs(oy - cy)[m:-m, m:-m].mean()
            oc = ours - oy[..., None]
            cc = cam - cy[..., None]
            ec += np.abs(oc - cc)[m:-m, m:-m].mean()
        n = len(prs)
        print(f"band {b} (n={n}): luma err {el/n*255:.2f}  chroma err {ec/n*255:.2f}")

        for r, eps, mode in [(2, 1e-3, "chroma"), (4, 1e-3, "chroma"),
                             (8, 4e-3, "chroma"), (2, 4e-4, "luma"),
                             (4, 1e-3, "luma"), (4, 1e-3, "both")]:
            tot = 0.0
            for ours, cam in prs:
                oy = luma(ours)
                proc = ours.copy()
                if mode in ("chroma", "both"):
                    for c in range(3):
                        diff = ours[..., c] - oy
                        proc[..., c] = oy + guided(oy, diff, r, eps)
                if mode in ("luma", "both"):
                    ys = guided(oy, oy, r, eps)
                    py = luma(proc)
                    gain = (ys + 1e-5) / (py + 1e-5)
                    proc = proc * gain[..., None]
                tot += np.abs(np.clip(proc, 0, 1) - cam)[m:-m, m:-m].mean()
            print(f"   guided {mode} r={r} eps={eps}: rgb err {tot/n*255:.2f}")
        base = 0.0
        for ours, cam in prs:
            base += np.abs(ours - cam)[m:-m, m:-m].mean()
        print(f"   baseline rgb err {base/n*255:.2f}")


if __name__ == "__main__":
    main()
