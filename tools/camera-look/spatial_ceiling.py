"""How much of the residual is SPATIAL?

After the per-image oracle through the best global model, fit for each
image a coarse KxK grid of luminance gains (bilinearly interpolated over
the frame, applied in display-linear space) and measure the drop. That is
the share of error a clarity/ADL-style local tone map could explain —
and the ceiling any global (per-pixel-colour-only) model can reach.

Usage: fitenv/bin/python spatial_ceiling.py joint_XXX.npz [n_images]
"""

import json
import sys
from pathlib import Path

import numpy as np
import torch

import fit_joint as fj
import fit_predictors as fp

HERE = Path(__file__).parent
GRID = 6


def main():
    path = sys.argv[1]
    n_sample = int(sys.argv[2]) if len(sys.argv) > 2 else 120
    torch.set_num_threads(6)
    dev = "cpu"
    data = fj.load_data(dev, maker=json.loads(str(np.load(HERE / path, allow_pickle=True)["config"])).get("maker", "none"))
    ship = fj.load_shipped()
    npz = np.load(HERE / path, allow_pickle=True)
    model, cfg = fp.rebuild(npz, data, ship)

    lat_file = HERE / (path.replace(".npz", "_latents.npy"))
    lat = torch.tensor(np.load(lat_file))

    dims = {}
    for line in open(HERE / "pairs2/manifest.jsonl"):
        m = json.loads(line)
        dims[m["tag"]] = (m["w"], m["h"])

    rng = np.random.default_rng(0)
    entries = data["entries"]
    ok = [i for i in range(len(entries)) if not data["bad"][i]]
    pick = rng.choice(ok, size=min(n_sample, len(ok)), replace=False)

    tot_before, tot_after, tot_n = 0.0, 0.0, 0
    with torch.no_grad():
        for i in pick:
            e = entries[i]
            w, h = dims[e["tag"]]
            scene = np.fromfile(HERE / f'pairs2/{e["tag"]}_scene.f32',
                                dtype=np.float32).reshape(h, w, 3)
            cam = np.fromfile(HERE / f'pairs2/{e["tag"]}_cam.f32',
                              dtype=np.float32).reshape(h, w, 3)
            s = torch.tensor(scene.reshape(-1, 3))
            tun = lat[i : i + 1].expand(len(s), -1)
            im = torch.full((len(s),), i, dtype=torch.long)
            pred = model(s, tun, im).numpy().reshape(h, w, 3)
            cam_e = np.where(cam <= 0.0031308, cam * 12.92,
                             1.055 * np.clip(cam, 1e-8, 1) ** (1 / 2.4) - 0.055)
            cam_e = np.clip(cam_e, 0, 1)
            before = np.abs(pred - cam_e).mean() * 255
            # closed-ish form: per grid cell, the luminance ratio that best
            # matches, then bilinear field; iterate twice
            pl = pred.copy()
            for _ in range(2):
                yy = np.linspace(0, GRID - 1e-6, h)
                xx = np.linspace(0, GRID - 1e-6, w)
                iy, ix = np.floor(yy).astype(int), np.floor(xx).astype(int)
                gains = np.ones((GRID, GRID))
                py = pl.mean(2)
                cy = cam_e.mean(2)
                for gy in range(GRID):
                    for gx in range(GRID):
                        my = iy == gy
                        mx = ix == gx
                        pm = py[np.ix_(my, mx)]
                        cm = cy[np.ix_(my, mx)]
                        sel = (pm > 0.02) & (pm < 0.98)
                        if sel.sum() > 50:
                            gains[gy, gx] = np.clip(
                                np.median(cm[sel] / np.maximum(pm[sel], 1e-4)),
                                0.7, 1.4)
                # bilinear upsample of gains to full res
                gy = np.clip(yy - 0.5, 0, GRID - 1)
                gx = np.clip(xx - 0.5, 0, GRID - 1)
                y0 = np.floor(gy).astype(int)
                x0 = np.floor(gx).astype(int)
                y1 = np.minimum(y0 + 1, GRID - 1)
                x1 = np.minimum(x0 + 1, GRID - 1)
                ty = (gy - y0)[:, None]
                tx = (gx - x0)[None, :]
                field = (gains[np.ix_(y0, x0)] * (1 - ty) * (1 - tx)
                         + gains[np.ix_(y0, x1)] * (1 - ty) * tx
                         + gains[np.ix_(y1, x0)] * ty * (1 - tx)
                         + gains[np.ix_(y1, x1)] * ty * tx)
                pl = np.clip(pl * field[:, :, None], 0, 1)
            after = np.abs(pl - cam_e).mean() * 255
            tot_before += before * h * w
            tot_after += after * h * w
            tot_n += h * w

    print(f"n={len(pick)} images; oracle residual {tot_before/tot_n:.3f} -> "
          f"+{GRID}x{GRID} spatial luma field {tot_after/tot_n:.3f}")
    print("the difference is the ADL/clarity-style spatial share of the error")


if __name__ == "__main__":
    main()
