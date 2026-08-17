"""Fit the camera look with Adobe's DCP structures fixed in place.

The NEF's own XMP recipe names Adobe's "Camera Standard" camera-matching
profile, whose look table (a 90x16x16 HSV lattice) and 125-point tone curve
are Adobe's measured reverse-engineering of this body's rendering. This fit
keeps those FIXED and learns only what our decode makes unknowable: the 3x3
input matrix (Apple's decode is not camera-native space) and the per-image
tuning (gain, contrast, wb_r, wb_b, saturation) with its MLP predictor.

A/B against the free model (fitted curves + free 9-cube lattice) on the same
samples answers: does Adobe's measured structure beat our fitted one?

  uv run --python 3.12 --with numpy,torch python fit_dcp.py --model dcp
  uv run --python 3.12 --with numpy,torch python fit_dcp.py --model free
"""
import argparse
import json
import time
from pathlib import Path

import numpy as np
import torch

import fit_joint
from fit_joint import (
    MID, evaluate, fit_test_latents, load_data, run_phase, srgb_encode,
)

HERE = Path(__file__).parent
CLIP_SCENE = 2.0


def rgb_to_xyz(primaries, white):
    """Columns matrix for an RGB space from xy primaries + white."""
    def xyz(xy):
        x, y = xy
        return np.array([x / y, 1.0, (1 - x - y) / y])
    P = np.stack([xyz(p) for p in primaries], axis=1)
    s = np.linalg.solve(P, xyz(white))
    return P * s


BRADFORD = np.array([[0.8951, 0.2664, -0.1614],
                     [-0.7502, 1.7135, 0.0367],
                     [0.0389, -0.0685, 1.0296]])


def adapt(src_white, dst_white):
    def xyz(xy):
        x, y = xy
        return np.array([x / y, 1.0, (1 - x - y) / y])
    cs, cd = BRADFORD @ xyz(src_white), BRADFORD @ xyz(dst_white)
    return np.linalg.inv(BRADFORD) @ np.diag(cd / cs) @ BRADFORD


D65, D50 = (0.3127, 0.3290), (0.3457, 0.3585)
SRGB2XYZ = rgb_to_xyz([(0.64, 0.33), (0.30, 0.60), (0.15, 0.06)], D65)
PP2XYZ = rgb_to_xyz([(0.7347, 0.2653), (0.1596, 0.8404), (0.0366, 0.0001)], D50)
SRGB2PP = np.linalg.inv(PP2XYZ) @ adapt(D65, D50) @ SRGB2XYZ
PP2SRGB = np.linalg.inv(SRGB2PP)


def srgb_decode_t(e):
    return torch.where(e <= 0.04045, e / 12.92, ((e + 0.055) / 1.055) ** 2.4)


def rgb_to_hsv(e):
    """Encoded RGB (B,3) in [0,1] -> h in degrees [0,360), s, v."""
    r, g, b = e[:, 0], e[:, 1], e[:, 2]
    mx, _ = e.max(1)
    mn, _ = e.min(1)
    c = mx - mn
    safe = c.clamp_min(1e-8)
    hr = ((g - b) / safe) % 6.0
    hg = (b - r) / safe + 2.0
    hb = (r - g) / safe + 4.0
    is_r = (mx == r)
    is_g = (mx == g) & ~is_r
    h = torch.where(is_r, hr, torch.where(is_g, hg, hb)) * 60.0
    h = torch.where(c < 1e-8, torch.zeros_like(h), h)
    s = c / mx.clamp_min(1e-8)
    return h, s, mx


def hsv_to_rgb(h, s, v):
    hp = (h % 360.0) / 60.0
    c = v * s
    x = c * (1.0 - (hp % 2.0 - 1.0).abs())
    m = v - c
    z = torch.zeros_like(c)
    i = hp.floor().long().clamp(0, 5)
    rgb = torch.stack([
        torch.stack([c, x, z], 1), torch.stack([x, c, z], 1),
        torch.stack([z, c, x], 1), torch.stack([z, x, c], 1),
        torch.stack([x, z, c], 1), torch.stack([c, z, x], 1),
    ], 0)
    out = rgb[i, torch.arange(len(i), device=h.device)]
    return out + m.unsqueeze(1)


class DcpLook(torch.nn.Module):
    """Fitted matrix + per-image tuning around Adobe's fixed look structures."""

    def __init__(self, n_img, n_feats, look_table, tone_curve, hidden=16, seed=0):
        super().__init__()
        g = torch.Generator().manual_seed(seed)
        M0 = SRGB2PP
        self.m_free = torch.nn.Parameter(torch.tensor(M0[:, :2], dtype=torch.float32))
        # [v][h][s] as the DNG SDK stores it; components (hueShift, satScale, valScale)
        self.register_buffer("table", torch.tensor(look_table, dtype=torch.float32))
        tc = torch.tensor(tone_curve, dtype=torch.float32)
        self.register_buffer("tc_x", tc[:, 0].contiguous())
        self.register_buffer("tc_y", tc[:, 1].contiguous())
        self.register_buffer("pp2srgb", torch.tensor(PP2SRGB, dtype=torch.float32))
        self.latent_dim = 5
        self.sat_dim = 4
        self.latents = torch.nn.Parameter(torch.zeros(n_img, self.latent_dim))
        self.mlp1 = torch.nn.Linear(n_feats, hidden)
        self.mlp2 = torch.nn.Linear(hidden, self.latent_dim)
        torch.nn.init.normal_(self.mlp1.weight, 0, 0.05, generator=g)
        torch.nn.init.zeros_(self.mlp1.bias)
        torch.nn.init.zeros_(self.mlp2.weight)
        torch.nn.init.zeros_(self.mlp2.bias)
        # run_phase regularizes model.lut_free; nothing free here, so a stub.
        self.lut_free = torch.nn.Parameter(torch.zeros(1))

    def matrix(self):
        a = self.m_free
        return torch.cat([a, 1.0 - a.sum(1, keepdim=True)], 1)

    def predict(self, feats):
        return self.mlp2(torch.tanh(self.mlp1(feats)))

    def curve(self, x):
        """Piecewise-linear tone curve, linear domain/range [0,1]."""
        x = x.clamp(0.0, 1.0)
        i = torch.searchsorted(self.tc_x, x.detach().contiguous()).clamp(1, len(self.tc_x) - 1)
        x0, x1 = self.tc_x[i - 1], self.tc_x[i]
        y0, y1 = self.tc_y[i - 1], self.tc_y[i]
        t = ((x - x0) / (x1 - x0).clamp_min(1e-9)).clamp(0, 1)
        return y0 + t * (y1 - y0)

    def rgb_tone(self, lin):
        """The DNG renderer's hue-preserving curve application: the curve
        moves the largest and smallest channel, the middle one keeps its
        relative position between them."""
        mx, imx = lin.max(1)
        mn, imn = lin.min(1)
        fmx, fmn = self.curve(mx), self.curve(mn)
        ratio = ((lin - mn.unsqueeze(1)) / (mx - mn).clamp_min(1e-8).unsqueeze(1)).clamp(0, 1)
        out = fmn.unsqueeze(1) + ratio * (fmx - fmn).unsqueeze(1)
        flat = (mx - mn) < 1e-8
        return torch.where(flat.unsqueeze(1), fmx.unsqueeze(1).expand_as(lin), out)

    def look_up(self, h, s, v):
        """Trilinear in Adobe's [val][hue][sat] lattice, hue wrapping."""
        nv, nh, ns = self.table.shape[:3]
        fv = (v.clamp(0, 1) * (nv - 1))
        fh = (h % 360.0) / 360.0 * nh
        fs = (s.clamp(0, 1) * (ns - 1))
        iv0 = fv.floor().long().clamp(max=nv - 2)
        ih0 = fh.floor().long() % nh
        is0 = fs.floor().long().clamp(max=ns - 2)
        tv = fv - iv0.float()
        th = fh - fh.floor()
        ts = fs - is0.float()
        out = torch.zeros(len(h), 3, device=h.device)
        for dv in (0, 1):
            for dh in (0, 1):
                for ds in (0, 1):
                    w = ((tv if dv else 1 - tv) * (th if dh else 1 - th)
                         * (ts if ds else 1 - ts))
                    cell = self.table[(iv0 + dv).clamp(max=nv - 1),
                                      (ih0 + dh) % nh,
                                      (is0 + ds).clamp(max=ns - 1)]
                    out = out + w.unsqueeze(1) * cell
        return out[:, 0], out[:, 1], out[:, 2]

    def forward(self, scene, tun, img_idx=None):
        # the same cross-channel clip the shipped model uses: over-range
        # chroma must not leak through the matrix off-diagonals.
        sc = scene.clamp(max=CLIP_SCENE)
        M = self.matrix()
        x = sc @ M.T + (scene - sc) * torch.diagonal(M)
        gains = 2.0 ** torch.stack(
            [tun[:, 0] + tun[:, 2], tun[:, 0], tun[:, 0] + tun[:, 3]], 1)
        x = x * gains
        x = MID * (x.clamp_min(1e-9) / MID) ** (2.0 ** tun[:, 1:2])
        # Adobe's look table, applied in sRGB encoding (LookTableEncoding 1)
        e = srgb_encode(x)
        h, s, v = rgb_to_hsv(e)
        hs, ss, vs = self.look_up(h, s, v)
        e2 = hsv_to_rgb(h + hs, (s * ss).clamp(0, 1), (v * vs).clamp(0, 1))
        lin = srgb_decode_t(e2.clamp(0, 1))
        # Adobe's fit of Nikon's tone curve, hue-preservingly per channel
        toned = self.rgb_tone(lin)
        disp = (toned @ self.pp2srgb.T).clamp(0.0, 1.0)
        y = (0.2126 * disp[:, 0] + 0.7152 * disp[:, 1]
             + 0.0722 * disp[:, 2]).unsqueeze(1)
        disp = (y + (disp - y) * 2.0 ** tun[:, self.sat_dim:self.sat_dim + 1]).clamp(0, 1)
        return srgb_encode(disp)


def fake_ship():
    """Grid geometry for the free model when no shipped snapshot exists."""
    K = 77
    x0, dx = -14.0, 0.25
    xs = x0 + dx * np.arange(K)
    knots = 1.0 / (1.0 + np.exp(-(xs + 2.5)))
    return dict(M=np.eye(3), x0=x0, dx=dx, knots=knots,
                lut=None, W=np.zeros((4, 31)))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", default="dcp", choices=["dcp", "free"])
    ap.add_argument("--restarts", type=int, default=2)
    ap.add_argument("--steps-a", type=int, default=2500)
    ap.add_argument("--steps-c", type=int, default=1500)
    ap.add_argument("--lr", type=float, default=1e-3)
    ap.add_argument("--out", default=None)
    args = ap.parse_args()

    dev = "mps" if torch.backends.mps.is_available() else "cpu"
    data = load_data(dev, maker="portable")
    img_np = data["img"].cpu().numpy()
    train_px = data["is_train"][img_np] & (~data["bad"])[img_np]
    test_px = (~data["is_train"])[img_np] & (~data["bad"])[img_np]
    rows = data["is_train"] & ~data["bad"]
    print(f"device {dev}; model {args.model}; "
          f"train px {train_px.sum()}, test px {test_px.sum()}")

    dcp = json.load(open(HERE / "dcp_standard.json"))
    table = np.array(dcp["ProfileLookTableData"], dtype=np.float32).reshape(16, 90, 16, 3)
    tone = np.array(dcp["ProfileToneCurve"], dtype=np.float32).reshape(-1, 2)

    def make(seed):
        if args.model == "dcp":
            return DcpLook(data["n_img"], data["feats_np"].shape[1],
                           table, tone, seed=seed).to(dev)
        m = fit_joint.Look(fake_ship(), data["n_img"], data["feats_np"],
                           curves=3, lut_n=9, predictor="mlp", init="random",
                           seed=seed, latent_extra=1, clip_scene=CLIP_SCENE,
                           clip_cross=True)
        return m.to(dev)

    best = (1e9, None)
    for r in range(args.restarts):
        t0 = time.time()
        model = make(100 + r)
        run_phase(model, data, train_px, args.steps_a, args.lr, False,
                  tag=f"r{r}/A")
        X = data["feats_np"][rows]
        Y = model.latents.detach().cpu().numpy()[rows]
        Wr = np.linalg.solve(X.T @ X + 3e-2 * np.eye(X.shape[1]), X.T @ Y)
        with torch.no_grad():
            # seed the MLP's linear part with the ridge solution
            model.mlp2.weight.zero_()
            model.mlp2.bias.zero_()
            model.mlp1.weight.copy_(torch.tensor(
                np.eye(model.mlp1.out_features, X.shape[1]), dtype=torch.float32))
            model.mlp1.bias.zero_()
            k = min(model.mlp1.out_features, X.shape[1])
            model.mlp2.weight[:, :k] = torch.tensor(Wr.T[:, :k], dtype=torch.float32)
        run_phase(model, data, train_px, args.steps_c, args.lr * 0.5, True,
                  tag=f"r{r}/C", delta=3.0)
        with torch.no_grad():
            tun = model.predict(data["feats"])
        err = evaluate(model, data, test_px, tun)
        err_tr = evaluate(model, data, train_px, tun)
        print(f"restart {r}: held-out {err:.3f} train {err_tr:.3f} "
              f"({time.time() - t0:.0f}s)", flush=True)
        if err < best[0]:
            best = (err, {k: v.detach().cpu().numpy()
                          for k, v in model.state_dict().items()})

    model = make(0)
    model.load_state_dict({k: torch.tensor(v) for k, v in best[1].items()})
    lat = fit_test_latents(model, data)
    oracle = evaluate(model, data, test_px, lat)
    print(f"\n{args.model.upper()} BEST held-out {best[0]:.3f} (oracle {oracle:.3f})")
    out = args.out or f"joint_{args.model}.npz"
    np.savez(HERE / out, err=best[0], oracle=oracle, **best[1])
    print("saved", out)


if __name__ == "__main__":
    main()
