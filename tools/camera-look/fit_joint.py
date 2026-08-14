"""Joint end-to-end fit of the camera look in PyTorch.

Pipeline (mirrors imgvwr-develop/src/look.rs):
  scene RGB -> matrix (rows sum 1) -> per-image gains 2^(g+wr),2^g,2^(g+wb)
  -> contrast around MID_GREY -> monotone per-channel curve (log2 grid)
  -> sRGB encode -> 3D LUT (identity +/- clamp) -> compare vs encoded cam.

Phases per restart:
  A: global params + free per-image latents, train images only.
  B: ridge predictor features->latents (closed form).
  C: end-to-end fine-tune of global + predictor (linear or MLP).
Eval: held-out mean |delta| * 255 with predicted tunings; plus test-latent
oracle (global frozen, latents fit on test pixels) as the ceiling.

Usage: fitenv/bin/python fit_joint.py --restarts 8 --curves 3 --lut 9 ...
"""

import argparse
import json
import re
import sys
import time
from pathlib import Path

import numpy as np
import torch

HERE = Path(__file__).parent
MID = 0.18
LUT_CLAMP = 0.15
REPO = Path("/Users/pmigdal/my_repos/vibe_coding/img-vwr-fable")


def load_shipped():
    """Parse the pre-joint look_data.rs (git snapshot) for init values.

    Pinned to a snapshot rather than the repo file: the repo file gets
    regenerated in the NEW format when a joint fit ships, and the old-format
    parse below would break mid-sweep.
    """
    txt = (HERE / "look_data_shipped.rs").read_text()

    def arr(name):
        m = re.search(rf"pub const {name}[^=]*= \[(.*?)\];", txt, re.S)
        return np.array([float(v) for v in
                         re.findall(r"(-?\d+\.?\d*(?:e-?\d+)?)(?:f32)?", m.group(1))
                         if v not in ("3", "9", "77", "31")])  # array-size ints

    def scalar(name):
        return float(re.search(rf"pub const {name}: f32 = (-?[\d.]+);", txt).group(1))

    M = arr("MATRIX").reshape(3, 3)
    return dict(
        M=M, x0=scalar("CURVE_X0"), dx=scalar("CURVE_DX"),
        knots=arr("CURVE_KNOTS"), lut=arr("LUT").reshape(-1, 3),
        W=np.stack([arr("W_GAIN"), arr("W_CONTRAST"), arr("W_WB_R"), arr("W_WB_B")]),
    )


def srgb_encode(v):
    v = v.clamp(0.0, 1.0)
    return torch.where(v <= 0.0031308, v * 12.92, 1.055 * v.clamp_min(1e-8) ** (1 / 2.4) - 0.055)


def inv_softplus(x):
    x = np.maximum(x, 1e-6)
    return np.where(x > 20, x, np.log(np.expm1(x)))


class Look(torch.nn.Module):
    def __init__(self, ship, n_img, feats, curves=3, lut_n=9, predictor="linear",
                 init="shipped", seed=0, latent_extra=0, clip_scene=0.0,
                 clip_cross=False, dual_matrix=False, temp_w=None, basis_luts=1):
        super().__init__()
        self.clip_scene = clip_scene
        self.clip_cross = clip_cross
        self.dual_matrix = dual_matrix
        self.basis_luts = basis_luts
        if dual_matrix:
            # per-image blend weight in [0,1] from as-shot temperature
            self.register_buffer("temp_w", torch.tensor(temp_w, dtype=torch.float32))
            self.dm_free = torch.nn.Parameter(torch.zeros(3, 2))
        g = torch.Generator().manual_seed(seed)
        self.x0, self.dx = ship["x0"], ship["dx"]
        K = len(ship["knots"])
        self.K = K
        self.lut_n = lut_n
        self.curves = curves
        self.latent_dim = 4 + latent_extra

        if init == "shipped":
            M = ship["M"]
            base = float(ship["knots"][0])
            deltas = inv_softplus(np.diff(ship["knots"]) + 1e-5)
            lut = ship["lut"].copy()
        else:  # random-ish but sane
            rng = np.random.default_rng(seed)
            M = np.eye(3) + rng.normal(0, 0.05, (3, 3))
            M = M / M.sum(1, keepdims=True)
            # a generic filmic-ish start: sigmoid over log2 range
            xs = ship["x0"] + ship["dx"] * np.arange(K)
            k0 = 1.0 / (1.0 + np.exp(-(xs + 2.5) * (0.9 + 0.2 * rng.random())))
            base = float(k0[0])
            deltas = inv_softplus(np.diff(k0) + 1e-5)
            lut = None

        self.m_free = torch.nn.Parameter(torch.tensor(M[:, :2], dtype=torch.float32))
        self.curve_base = torch.nn.Parameter(torch.full((curves,), base))
        self.curve_d = torch.nn.Parameter(
            torch.tensor(np.tile(deltas, (curves, 1)), dtype=torch.float32))

        n = lut_n
        gl = torch.linspace(0, 1, n)
        R, G, B = torch.meshgrid(gl, gl, gl, indexing="ij")
        self.register_buffer("ident", torch.stack([R.reshape(-1), G.reshape(-1), B.reshape(-1)], 1))
        if lut is not None and lut_n == 9 and len(lut) == n**3:
            d = np.clip((lut - self.ident.numpy()) / LUT_CLAMP, -0.999, 0.999)
            free = np.arctanh(d)
        else:
            free = np.zeros((n**3, 3))
        self.sat_dim = 4 if latent_extra > 0 else None
        self.blend_start = 4 + latent_extra
        if basis_luts > 1:
            # basis 0 is the shared LUT; the rest are deltas whose per-image
            # weights ride in the latents (init 0 = exactly the shared LUT)
            free = np.stack([free] + [np.zeros_like(free)] * (basis_luts - 1))
            self.latent_dim += basis_luts - 1
        self.lut_free = torch.nn.Parameter(torch.tensor(free, dtype=torch.float32))

        self.latents = torch.nn.Parameter(torch.zeros(n_img, self.latent_dim))
        nf = feats.shape[1]
        self.predictor_kind = predictor
        if predictor == "linear":
            W0 = np.zeros((nf, self.latent_dim))
            if init == "shipped":
                W0[: ship["W"].shape[1], :4] = ship["W"].T
            self.pred = torch.nn.Parameter(torch.tensor(W0, dtype=torch.float32))
        else:
            h = 16
            self.mlp1 = torch.nn.Linear(nf, h)
            self.mlp2 = torch.nn.Linear(h, self.latent_dim)
            torch.nn.init.normal_(self.mlp1.weight, 0, 0.05, generator=g)
            torch.nn.init.zeros_(self.mlp1.bias)
            torch.nn.init.zeros_(self.mlp2.weight)
            torch.nn.init.zeros_(self.mlp2.bias)

    def matrix(self):
        a = self.m_free
        return torch.cat([a, 1.0 - a.sum(1, keepdim=True)], 1)

    def knots(self):
        # (curves, K) monotone nondecreasing
        return self.curve_base[:, None] + torch.cat(
            [torch.zeros_like(self.curve_base)[:, None],
             torch.cumsum(torch.nn.functional.softplus(self.curve_d), 1)], 1)

    def lut(self):
        if self.basis_luts > 1:
            base = self.ident + LUT_CLAMP * torch.tanh(self.lut_free[0])
            deltas = LUT_CLAMP * torch.tanh(self.lut_free[1:])
            return torch.cat([base.unsqueeze(0), deltas], 0)
        return self.ident + LUT_CLAMP * torch.tanh(self.lut_free)

    def predict(self, feats):
        if self.predictor_kind == "linear":
            return feats @ self.pred
        return self.mlp2(torch.tanh(self.mlp1(feats)))

    def forward(self, scene, tun, img_idx=None):
        """scene (B,3) linear; tun (B,latent_dim); -> encoded display (B,3)."""
        # the camera clips channels before its colour math; without this,
        # far-over-range chroma (UV lights) leaks through the matrix into
        # green. Values above the curve's white render white either way.
        if self.clip_scene > 0.0 and self.clip_cross:
            # clip only what crosses channels: the diagonal keeps the full
            # over-range value, the off-diagonal terms see the clamped one.
            sc = scene.clamp(max=self.clip_scene)
            M = self.matrix()
            x = sc @ M.T + (scene - sc) * torch.diagonal(M)
        else:
            if self.clip_scene > 0.0:
                scene = scene.clamp(max=self.clip_scene)
            x = scene @ self.matrix().T
        if self.dual_matrix and img_idx is not None:
            # second illuminant: rows sum to 0 so overall rows still sum to 1
            dm = torch.cat([self.dm_free, -self.dm_free.sum(1, keepdim=True)], 1)
            x = x + self.temp_w[img_idx][:, None] * (scene @ dm.T)
        gains = 2.0 ** torch.stack(
            [tun[:, 0] + tun[:, 2], tun[:, 0], tun[:, 0] + tun[:, 3]], 1)
        x = x * gains
        x = MID * (x.clamp_min(1e-9) / MID) ** (2.0 ** tun[:, 1:2])
        xlog = torch.log2(x.clamp_min(1e-8))
        u = ((xlog - self.x0) / self.dx).clamp(0, self.K - 1 - 1e-4)
        i0 = u.floor().long()
        fr = u - i0.float()
        kn = self.knots()
        if self.curves == 1:
            k = kn[0]
            disp = k[i0] * (1 - fr) + k[i0 + 1] * fr
        else:
            cols = []
            for c in range(3):
                k = kn[c]
                cols.append(k[i0[:, c]] * (1 - fr[:, c]) + k[i0[:, c] + 1] * fr[:, c])
            disp = torch.stack(cols, 1)
        if self.sat_dim is not None:
            # per-image saturation, around luma in display-linear space —
            # the camera's Auto PC varies saturation per shot and the 4-dof
            # tuning has no axis for it.
            y = (0.2126 * disp[:, 0] + 0.7152 * disp[:, 1]
                 + 0.0722 * disp[:, 2]).unsqueeze(1)
            disp = (y + (disp - y)
                    * 2.0 ** tun[:, self.sat_dim : self.sat_dim + 1]).clamp(0.0, 1.0)
        e = srgb_encode(disp)
        # trilinear through the lut (blended per image when basis_luts > 1)
        n = self.lut_n
        lut = self.lut()
        u = e.clamp(0, 1) * (n - 1)
        i0 = u.floor().long().clamp(max=n - 2)
        t = u - i0.float()
        out = torch.zeros_like(e)
        if self.basis_luts > 1:
            wk = tun[:, self.blend_start : self.blend_start + self.basis_luts - 1]
        for dz in (0, 1):
            for dy in (0, 1):
                for dx in (0, 1):
                    w = ((t[:, 0] if dx else 1 - t[:, 0])
                         * (t[:, 1] if dy else 1 - t[:, 1])
                         * (t[:, 2] if dz else 1 - t[:, 2]))
                    idx = ((i0[:, 0] + dx) * n + i0[:, 1] + dy) * n + i0[:, 2] + dz
                    if self.basis_luts > 1:
                        cell = lut[0][idx]
                        for k in range(self.basis_luts - 1):
                            cell = cell + wk[:, k : k + 1] * lut[k + 1][idx]
                        out = out + w[:, None] * cell
                    else:
                        out = out + w[:, None] * lut[idx]
        return out


def assemble_features(entries):
    """Mirror fit_look.py image_features / look.rs features exactly."""
    raw = {f["tag"]: f for f in json.load(open(HERE / "features2.json"))}
    out = []
    for e in entries:
        f = raw[e["tag"]]
        gq, cq = f["gq"], f["cq"]
        clip_hi, clip_lo = f["clip_hi"], f["clip_lo"]
        chan = f["chan"]
        cast_r, cast_b = chan[0] - chan[1], chan[2] - chan[1]
        spread = gq[8] - gq[0]
        mid = gq[3]
        iso = np.log2(e["iso"]) if e.get("iso") else 7.0
        t = np.log2(max(e["temp"], 1500.0)) - np.log2(5000.0)
        ti = e["tint"] / 100.0
        out.append(list(gq) + list(cq) + [
            clip_hi, clip_lo, spread, iso, mid * spread, mid * mid,
            cast_r, cast_b, cast_r * cast_r, cast_b * cast_b,
            t, ti, t * t, t * cast_r, t * cast_b, iso * mid,
            clip_hi * spread, 1.0,
        ])
    return np.array(out, dtype=np.float32)


def maker_features(entries):
    """Per-shot camera decisions from maker notes / XMP, normalized."""
    mk = json.load(open(HERE / "maker_features.json"))
    out = []
    for e in entries:
        m = mk[e["tag"]]
        g = lambda k, d=0.0: m[k] if m.get(k) is not None else d
        out.append([
            g("Contrast2012") / 25.0,
            g("Saturation") / 10.0,
            g("Clarity2012") / 5.0,
            g("Texture") / 10.0,
            (g("Sharpness", 40.0) - 40.0) / 20.0,
            (g("LuminanceSmoothing", 50.0) - 50.0) / 25.0,
            np.log2(max(g("ColorTemperatureAuto", 5000.0), 1500.0) / 5000.0),
            np.log2(max(g("WB_R", 1.8), 0.5)),
            np.log2(max(g("WB_B", 1.5), 0.5)),
            g("ExposureCompensation"),
            g("GainControl"),
            g("LightValue", 8.0) / 10.0,
            np.log2(max(g("FocusDistance", 3.0), 0.05)),
            g("ExposureProgram") / 3.0,
        ])
    return np.array(out, dtype=np.float32)


# maker feature columns readable without exiftool at runtime: the XMP packet
# (plain XML in TIFF tag 700) and standard EXIF. Excludes ColorTemperatureAuto,
# WB_RBLevels and FocusDistance, which live in Nikon's encrypted maker blocks.
PORTABLE_MAKER = [0, 1, 2, 3, 4, 5, 9, 10, 11, 13]


def load_data(dev, maker="none"):
    d = np.load(HERE / "samples2.npz")
    scene, cam, img = d["scene"], d["cam"], d["img"]
    entries = json.load(open(HERE / "images2.json"))
    feats = assemble_features(entries)
    if maker != "none":
        mk = maker_features(entries)
        if maker == "portable":
            mk = mk[:, PORTABLE_MAKER]
        feats = np.concatenate([feats, mk], axis=1)
    n_img = len(entries)

    def luma(a):
        return 0.2126 * a[:, 0] + 0.7152 * a[:, 1] + 0.0722 * a[:, 2]

    ys, yc = luma(scene), luma(cam)
    p99 = np.zeros(n_img)
    c50 = np.zeros(n_img)
    for i in range(n_img):
        s = img == i
        p99[i] = np.percentile(ys[s], 99)
        c50[i] = np.median(yc[s])
    bad = (p99 < 0.001) | ((c50 > 0.98) & (p99 < 0.05))

    counters, is_train = {}, np.zeros(n_img, bool)
    for i, e in enumerate(entries):
        f = e["folder"]
        is_train[i] = counters.get(f, 0) % 2 == 0
        counters[f] = counters.get(f, 0) + 1

    cam_t = torch.tensor(cam, dtype=torch.float32)
    cam_enc = srgb_encode(cam_t.clamp(0, 1))
    return dict(
        scene=torch.tensor(scene, dtype=torch.float32).to(dev),
        cam_enc=cam_enc.to(dev),
        img=torch.tensor(img.astype(np.int64)).to(dev),
        feats=torch.tensor(feats).to(dev),
        is_train=is_train, bad=bad, entries=entries, n_img=n_img,
        feats_np=feats,
    )


def huber(x, delta=3.0):
    a = x.abs()
    return torch.where(a <= delta, 0.5 * a * a / delta, a - 0.5 * delta)


def run_phase(model, data, sel, steps, lr, use_predictor, log_every=200, tag=""):
    """Adam over pixel subset sel (bool np array over samples)."""
    dev = data["scene"].device
    idx = torch.tensor(np.where(sel)[0]).to(dev)
    params = [p for n, p in model.named_parameters() if n != "latents"]
    groups = [{"params": params, "lr": lr}]
    if not use_predictor:
        groups.append({"params": [model.latents], "lr": lr * 10})
    opt = torch.optim.Adam(groups)
    B = 262144
    g = torch.Generator(device="cpu").manual_seed(1234)
    for step in range(steps):
        b = idx[torch.randint(len(idx), (B,), generator=g).to(dev)]
        scene, cam, im = data["scene"][b], data["cam_enc"][b], data["img"][b]
        if use_predictor:
            tun = model.predict(data["feats"])[im]
        else:
            tun = model.latents[im]
        out = model(scene, tun, im)
        loss = huber(255.0 * (out - cam))
        loss = loss.mean() + 1e-3 * model.lut_free.pow(2).mean()
        opt.zero_grad(set_to_none=True)
        loss.backward()
        opt.step()
        if log_every and step % log_every == 0:
            print(f"  {tag} step {step} loss {loss.item():.3f}", flush=True)
    return model


@torch.no_grad()
def evaluate(model, data, px_sel, tunings):
    dev = data["scene"].device
    idx = torch.tensor(np.where(px_sel)[0]).to(dev)
    tot, n = 0.0, 0
    for chunk in idx.split(1_000_000):
        im = data["img"][chunk]
        out = model(data["scene"][chunk], tunings[im], im)
        tot += (255.0 * (out - data["cam_enc"][chunk])).abs().sum().item()
        n += len(chunk) * 3
    return tot / n


def fit_test_latents(model, data, steps=300):
    """Oracle: freeze globals, fit latents on all pixels (per image indep)."""
    for n_, p in model.named_parameters():
        p.requires_grad_(n_ == "latents")
    sel = (~data["bad"])[data["img"].cpu().numpy()]
    run_phase(model, data, sel, steps, 3e-3, use_predictor=False,
              log_every=0, tag="oracle")
    for p in model.parameters():
        p.requires_grad_(True)
    return model.latents.detach().clone()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--curves", type=int, default=3)
    ap.add_argument("--lut", type=int, default=9)
    ap.add_argument("--predictor", default="linear")
    ap.add_argument("--latent-extra", type=int, default=0)
    ap.add_argument("--restarts", type=int, default=1)
    ap.add_argument("--steps-a", type=int, default=2500)
    ap.add_argument("--steps-c", type=int, default=1500)
    ap.add_argument("--lr", type=float, default=1e-3)
    ap.add_argument("--init", default="mixed", help="shipped|random|mixed")
    ap.add_argument("--maker", default="none", choices=["none", "full", "portable"],
                    help="append per-shot maker-note features to the predictor")
    ap.add_argument("--clip-scene", type=float, default=0.0,
                    help="clamp scene channels at this value before the matrix")
    ap.add_argument("--dual-matrix", action="store_true",
                    help="second matrix blended by as-shot temperature")
    ap.add_argument("--basis-luts", type=int, default=1,
                    help="image-adaptive LUT: this many bases, weights predicted")
    ap.add_argument("--clip-cross", action="store_true",
                    help="clip only the cross-channel matrix input")
    ap.add_argument("--exclude-folder", default=None,
                    help="LOFO CV: hold this folder out entirely, eval on it")
    ap.add_argument("--out", default="joint_best.npz")
    args = ap.parse_args()

    dev = "mps" if torch.backends.mps.is_available() else "cpu"
    data = load_data(dev, maker=args.maker)
    ship = load_shipped()
    img_np = data["img"].cpu().numpy()
    if args.exclude_folder:
        held = np.array([args.exclude_folder in e["folder"]
                         for e in data["entries"]])
        print(f"LOFO: holding out {held.sum()} images of '{args.exclude_folder}'")
        data["is_train"] = ~held
    train_px = data["is_train"][img_np] & (~data["bad"])[img_np]
    test_px = (~data["is_train"])[img_np] & (~data["bad"])[img_np]
    rows = data["is_train"] & ~data["bad"]
    print(f"device {dev}; train px {train_px.sum()}, test px {test_px.sum()}")

    temp_w_all = np.clip(
        (np.log2([max(e["temp"], 1500.0) for e in data["entries"]])
         - np.log2(3000.0)) / (np.log2(6500.0) - np.log2(3000.0)),
        0.0, 1.0)
    best = (1e9, None, None)
    for r in range(args.restarts):
        init = args.init if args.init != "mixed" else ("shipped" if r % 2 == 0 else "random")
        seed = 100 + r
        t0 = time.time()
        temp_w = np.clip(
            (np.log2([max(e["temp"], 1500.0) for e in data["entries"]])
             - np.log2(3000.0)) / (np.log2(6500.0) - np.log2(3000.0)),
            0.0, 1.0)
        model = Look(ship, data["n_img"], data["feats_np"], curves=args.curves,
                     lut_n=args.lut, predictor=args.predictor, init=init,
                     seed=seed, latent_extra=args.latent_extra,
                     clip_scene=args.clip_scene, clip_cross=args.clip_cross,
                     dual_matrix=args.dual_matrix,
                     temp_w=temp_w if args.dual_matrix else None,
                     basis_luts=args.basis_luts).to(dev)
        # warm-start latents from shipped predictor where dims allow
        if init == "shipped":
            with torch.no_grad():
                W = torch.tensor(ship["W"].T, dtype=torch.float32).to(dev)
                model.latents[:, :4] = data["feats"][:, : W.shape[0]] @ W

        # A: global + latents on train pixels
        run_phase(model, data, train_px, args.steps_a, args.lr, False,
                  tag=f"r{r}({init})/A")

        # B: ridge predictor from latents (train rows), closed form
        X = data["feats_np"][rows]
        Y = model.latents.detach().cpu().numpy()[rows]
        lam = 3e-2
        Wr = np.linalg.solve(X.T @ X + lam * np.eye(X.shape[1]), X.T @ Y)
        with torch.no_grad():
            if model.predictor_kind == "linear":
                model.pred.copy_(torch.tensor(Wr, dtype=torch.float32))
            else:
                # leave MLP init; C will learn. Seed linear part into mlp2? skip.
                pass

        # C: end-to-end with predictor
        run_phase(model, data, train_px, args.steps_c, args.lr * 0.5, True,
                  tag=f"r{r}({init})/C")

        with torch.no_grad():
            tun = model.predict(data["feats"])
        err = evaluate(model, data, test_px, tun)
        err_tr = evaluate(model, data, train_px, tun)
        print(f"restart {r} init={init}: held-out {err:.3f} train {err_tr:.3f} "
              f"({time.time()-t0:.0f}s)", flush=True)
        if err < best[0]:
            sd = {k: v.detach().cpu().numpy() for k, v in model.state_dict().items()}
            best = (err, sd, dict(curves=args.curves, lut=args.lut,
                                  predictor=args.predictor, init=init, seed=seed,
                                  latent_extra=args.latent_extra,
                                  clip_scene=args.clip_scene, maker=args.maker,
                                  dual_matrix=args.dual_matrix,
                                  basis_luts=args.basis_luts,
                                  clip_cross=args.clip_cross))

    # oracle ceiling for the best model
    model = Look(ship, data["n_img"], data["feats_np"], curves=best[2]["curves"],
                 lut_n=best[2]["lut"], predictor=best[2]["predictor"],
                 init="shipped", seed=best[2]["seed"],
                 latent_extra=best[2]["latent_extra"],
                 clip_scene=best[2]["clip_scene"],
                 dual_matrix=best[2].get("dual_matrix", False),
                 temp_w=temp_w_all if best[2].get("dual_matrix") else None,
                 basis_luts=best[2].get("basis_luts", 1),
                 clip_cross=best[2].get("clip_cross", False)).to(dev)
    model.load_state_dict({k: torch.tensor(v) for k, v in best[1].items()})
    lat = fit_test_latents(model, data)
    oracle = evaluate(model, data, test_px, lat)
    print(f"\nBEST held-out {best[0]:.3f} (oracle {oracle:.3f}) config {best[2]}")
    np.savez(HERE / args.out, err=best[0], oracle=oracle,
             config=json.dumps(best[2]), **best[1])
    print("saved", args.out)


if __name__ == "__main__":
    main()
