"""Held-out CIEDE2000 of a joint-fit model — the perceptual number."""

import json
import sys
from pathlib import Path

import numpy as np
import torch

import fit_joint as fj
import fit_predictors as fp

HERE = Path(__file__).parent


def srgb_to_lab(rgb):
    """encoded sRGB (0..1) -> CIELAB, D65."""
    v = np.clip(rgb, 0, 1)
    lin = np.where(v <= 0.04045, v / 12.92, ((v + 0.055) / 1.055) ** 2.4)
    M = np.array([[0.4124564, 0.3575761, 0.1804375],
                  [0.2126729, 0.7151522, 0.0721750],
                  [0.0193339, 0.1191920, 0.9503041]])
    xyz = lin @ M.T
    wp = np.array([0.95047, 1.0, 1.08883])
    t = xyz / wp
    f = np.where(t > (6 / 29) ** 3, np.cbrt(t), t / (3 * (6 / 29) ** 2) + 4 / 29)
    L = 116 * f[..., 1] - 16
    a = 500 * (f[..., 0] - f[..., 1])
    b = 200 * (f[..., 1] - f[..., 2])
    return np.stack([L, a, b], -1)


def de00(lab1, lab2):
    L1, a1, b1 = lab1[..., 0], lab1[..., 1], lab1[..., 2]
    L2, a2, b2 = lab2[..., 0], lab2[..., 1], lab2[..., 2]
    C1 = np.hypot(a1, b1)
    C2 = np.hypot(a2, b2)
    Cb = (C1 + C2) / 2
    G = 0.5 * (1 - np.sqrt(Cb**7 / (Cb**7 + 25.0**7)))
    a1p, a2p = (1 + G) * a1, (1 + G) * a2
    C1p, C2p = np.hypot(a1p, b1), np.hypot(a2p, b2)
    h1p = np.degrees(np.arctan2(b1, a1p)) % 360
    h2p = np.degrees(np.arctan2(b2, a2p)) % 360
    dLp = L2 - L1
    dCp = C2p - C1p
    dh = h2p - h1p
    dh = np.where(dh > 180, dh - 360, np.where(dh < -180, dh + 360, dh))
    dh = np.where(C1p * C2p == 0, 0, dh)
    dHp = 2 * np.sqrt(C1p * C2p) * np.sin(np.radians(dh) / 2)
    Lbp = (L1 + L2) / 2
    Cbp = (C1p + C2p) / 2
    hsum = h1p + h2p
    hbp = np.where(np.abs(h1p - h2p) <= 180, hsum / 2,
                   np.where(hsum < 360, hsum / 2 + 180, hsum / 2 - 180))
    hbp = np.where(C1p * C2p == 0, hsum, hbp)
    T = (1 - 0.17 * np.cos(np.radians(hbp - 30)) + 0.24 * np.cos(np.radians(2 * hbp))
         + 0.32 * np.cos(np.radians(3 * hbp + 6)) - 0.20 * np.cos(np.radians(4 * hbp - 63)))
    dtheta = 30 * np.exp(-(((hbp - 275) / 25) ** 2))
    Rc = 2 * np.sqrt(Cbp**7 / (Cbp**7 + 25.0**7))
    Sl = 1 + 0.015 * (Lbp - 50) ** 2 / np.sqrt(20 + (Lbp - 50) ** 2)
    Sc = 1 + 0.045 * Cbp
    Sh = 1 + 0.015 * Cbp * T
    Rt = -np.sin(np.radians(2 * dtheta)) * Rc
    return np.sqrt((dLp / Sl) ** 2 + (dCp / Sc) ** 2 + (dHp / Sh) ** 2
                   + Rt * (dCp / Sc) * (dHp / Sh))


def main():
    path = sys.argv[1]
    torch.backends.mps.is_available = lambda: False
    torch.set_num_threads(5)
    ship = fj.load_shipped()
    npz = np.load(HERE / path, allow_pickle=True)
    cfg = json.loads(str(npz["config"]))
    data = fj.load_data("cpu", maker=cfg.get("maker", "none"))
    model, _ = fp.rebuild(npz, data, ship)
    img_np = data["img"].numpy()
    test_px = (~data["is_train"])[img_np] & (~data["bad"])[img_np]
    with torch.no_grad():
        tun = model.predict(data["feats"])
        idx = torch.tensor(np.where(test_px)[0])
        outs, cams = [], []
        for chunk in idx.split(500_000):
            im = data["img"][chunk]
            outs.append(model(data["scene"][chunk], tun[im], im).numpy())
            cams.append(data["cam_enc"][chunk].numpy())
    out = np.concatenate(outs)
    cam = np.concatenate(cams)
    d = de00(srgb_to_lab(out), srgb_to_lab(cam))
    print(f"held-out CIEDE2000: mean {d.mean():.3f}  median {np.median(d):.3f}  "
          f"p95 {np.percentile(d, 95):.2f}")
    # neutral-decode reference for scale
    print("(<1 is imperceptible side by side; 1-2 needs A/B flipping to see)")


if __name__ == "__main__":
    main()
