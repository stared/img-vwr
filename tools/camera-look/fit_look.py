"""Fit the camera look from a pair dump, end to end, and emit look_data.rs.

Usage:
    cargo run --release -p imgvwr-develop --example dump_pairs -- <dump-dir> <photo-dirs>...
    uv venv env && uv pip install --python env/bin/python numpy
    env/bin/python fit_look.py <dump-dir>

The model, in application order (see imgvwr-develop/src/look.rs):
  matrix → per-image tuning (gain, contrast, WB r/b from image features) →
  per-channel tone curve → 3D display-cube LUT.

The stages below re-derive every piece from scratch:
  1. per-channel curve on raw pixels (median per log2 bin, monotone)
  2. colour matrix (rows sum to 1), alternated with the curve
  3. per-image 4-dof oracle (coordinate descent per image)
  4. ridge predictors from image features to the oracle values
  5. identity-regularised, clamped 9^3 LUT over the display cube
  6. Rust const emission plus verification vectors for the unit tests

Held-out评ation uses an even/odd file split per folder throughout. Numbers
from 2026-08-14 (1052 usable pairs): shipped slider preset 7.06 |Δ|sRGB →
this model 3.86 on held-out images.
"""

import json
import sys
from pathlib import Path

import numpy as np

MID_GREY = 0.18
BORDER = 0.06
PER_IMAGE = 3000
SEED = 42
LUT_N = 9
LUT_CLAMP = 0.15


# ---------------------------------------------------------------- colour

def srgb_encode(v):
    v = np.clip(v, 0.0, 1.0)
    return np.where(v <= 0.0031308, v * 12.92, 1.055 * np.power(v, 1 / 2.4) - 0.055)


def luma(rgb):
    return 0.2126 * rgb[..., 0] + 0.7152 * rgb[..., 1] + 0.0722 * rgb[..., 2]


# ---------------------------------------------------------------- loading

def load_pairs(pairs_dir):
    entries = [json.loads(l) for l in open(pairs_dir / "manifest.jsonl")]
    seen, unique = set(), []
    for e in entries:
        if e["tag"] not in seen:
            seen.add(e["tag"])
            unique.append(e)
    rng = np.random.default_rng(SEED)
    scenes, cams, imgs, feats = [], [], [], []
    for idx, e in enumerate(unique):
        w, h = e["w"], e["h"]
        scene = np.fromfile(pairs_dir / f'{e["tag"]}_scene.f32', dtype=np.float32).reshape(h, w, 3)
        cam = np.fromfile(pairs_dir / f'{e["tag"]}_cam.f32', dtype=np.float32).reshape(h, w, 3)
        mx, my = int(w * BORDER), int(h * BORDER)
        inner = scene[my : h - my, mx : w - mx]
        cam_i = cam[my : h - my, mx : w - mx]
        feats.append(image_features(inner, e))
        flat_s = inner.reshape(-1, 3)
        flat_c = cam_i.reshape(-1, 3)
        pick = rng.choice(len(flat_s), size=min(PER_IMAGE, len(flat_s)), replace=False)
        scenes.append(flat_s[pick].astype(np.float64))
        cams.append(flat_c[pick].astype(np.float64))
        imgs.append(np.full(len(pick), idx, dtype=np.int32))
    return (
        np.concatenate(scenes),
        np.concatenate(cams),
        np.concatenate(imgs),
        unique,
        np.array(feats),
    )


def image_features(inner, entry):
    """Must mirror imgvwr-develop/src/look.rs::features exactly."""
    y = luma(inner)
    ylog = np.log2(np.maximum(y, 1e-8))
    gq = np.percentile(ylog, [1, 5, 25, 50, 75, 90, 95, 99, 99.9])
    ch, cw = inner.shape[0] // 5, inner.shape[1] // 5
    centre = luma(inner[2 * ch : -2 * ch or None, 2 * cw : -2 * cw or None])
    cq = np.percentile(np.log2(np.maximum(centre, 1e-8)), [25, 50, 75, 95])
    clip_hi = float((y > 0.95).mean())
    clip_lo = float((y < 0.001).mean())
    med = [float(np.log2(max(np.median(inner[..., c]), 1e-8))) for c in range(3)]
    cast_r, cast_b = med[0] - med[1], med[2] - med[1]
    spread = gq[8] - gq[0]
    mid = gq[3]
    iso = np.log2(entry["iso"]) if entry.get("iso") else 7.0
    t = np.log2(max(entry["temp"], 1500.0)) - np.log2(5000.0)
    ti = entry["tint"] / 100.0
    return list(gq) + list(cq) + [
        clip_hi, clip_lo, spread, iso, mid * spread, mid * mid,
        cast_r, cast_b, cast_r * cast_r, cast_b * cast_b,
        t, ti, t * t, t * cast_r, t * cast_b, iso * mid, clip_hi * spread, 1.0,
    ]


# ---------------------------------------------------------------- curve

def monotone_bins(x_log, target, lo=-14.0, hi=5.0, step=0.25, min_count=200):
    grid = np.arange(lo, hi + step, step)
    idx = np.clip(((x_log - lo) / step).astype(int), 0, len(grid) - 1)
    knots = np.full(len(grid), np.nan)
    for b in range(len(grid)):
        sel = idx == b
        if sel.sum() >= min_count:
            knots[b] = np.median(target[sel])
    valid = ~np.isnan(knots)
    first = np.argmax(valid)
    knots[:first] = knots[first]
    for b in range(first + 1, len(grid)):
        if np.isnan(knots[b]):
            knots[b] = knots[b - 1]
    return grid, np.maximum.accumulate(knots)


def fit_channel_curve(x, t, mask, grid_kw=None):
    xlog = np.log2(np.maximum(x.reshape(-1), 1e-8))
    m = np.repeat(mask, 3)
    return monotone_bins(xlog[m], t.reshape(-1)[m], **(grid_kw or {}))


def apply_channel_curve(x, grid, knots):
    xlog = np.log2(np.maximum(x.reshape(-1), 1e-8))
    return np.clip(np.interp(xlog, grid, knots).reshape(-1, 3), 0, 1)


def main():
    pairs_dir = Path(sys.argv[1] if len(sys.argv) > 1 else "pairs")
    scene, cam, img, entries, X = load_pairs(pairs_dir)
    n_img = len(entries)
    print(f"{n_img} pairs, {len(scene)} samples")

    # train/test: even/odd file order within each folder
    counters, is_train = {}, np.zeros(n_img, bool)
    for i, e in enumerate(entries):
        f = e["folder"]
        is_train[i] = counters.get(f, 0) % 2 == 0
        counters[f] = counters.get(f, 0) + 1

    # broken pairs: black decode against a lit JPEG
    p99 = np.array([np.percentile(luma(scene[img == i]), 99) for i in range(n_img)])
    c50 = np.array([np.median(luma(cam[img == i])) for i in range(n_img)])
    bad = (p99 < 0.001) | ((c50 > 0.98) & (p99 < 0.05))
    print(f"excluding {bad.sum()} broken pairs")
    train_px = is_train[img] & (~bad)[img]

    # 1+2. curve and matrix, alternated
    grid, knots = fit_channel_curve(scene, cam, train_px)
    M = np.eye(3)
    for _ in range(3):
        mixed = scene @ M.T
        grid, knots = fit_channel_curve(mixed, cam, train_px)
        v = np.clip(cam, knots[0], knots[-1]).reshape(-1)
        target_lin = (2.0 ** np.interp(v, knots, grid)).reshape(-1, 3)
        y = luma(scene)
        ok = train_px & (cam.max(axis=1) < 0.98) & (y > 0.002) & (y < 0.7)
        for c in range(3):
            b_ = scene[ok, 2]
            A = np.stack([scene[ok, 0] - b_, scene[ok, 1] - b_], axis=1)
            coef, *_ = np.linalg.lstsq(A, target_lin[ok, c] - b_, rcond=None)
            M[c] = [coef[0], coef[1], 1 - coef[0] - coef[1]]
    mixed = scene @ M.T
    grid, knots = fit_channel_curve(mixed, cam, train_px)

    # 3. per-image oracle: gain, contrast, wb_r, wb_b
    cam8 = srgb_encode(cam) * 255

    def transform(s, p):
        g, c, wr, wb = p
        x = s * (2.0 ** np.array([g + wr, g, g + wb]))
        if c != 0.0:
            x = MID_GREY * np.power(np.maximum(x, 1e-9) / MID_GREY, 2.0**c)
        return apply_channel_curve(x, grid, knots)

    def image_fit(s, c8):
        p = np.zeros(4)

        def err(q):
            return np.abs(srgb_encode(transform(s, q)) * 255 - c8).mean()

        best = err(p)
        for g in np.arange(-0.9, 0.91, 0.15):
            e = err([g, 0, 0, 0])
            if e < best:
                best, p = e, np.array([g, 0.0, 0.0, 0.0])
        for step in (0.12, 0.05, 0.02):
            improved = True
            while improved:
                improved = False
                for k in range(4):
                    for d in (-step, step):
                        q = p.copy()
                        q[k] += d
                        e = err(q)
                        if e < best - 1e-4:
                            best, p, improved = e, q, True
        return p

    oracle = np.zeros((n_img, 4))
    for i in range(n_img):
        if not bad[i]:
            oracle[i] = image_fit(mixed[img == i], cam8[img == i])
        if i % 200 == 0:
            print("oracle", i)

    # 4. Huber-ridge predictors
    rows = is_train & ~bad

    def huber_ridge(y, lam=3e-2, delta=0.1, iters=8):
        w = np.linalg.solve(X[rows].T @ X[rows] + lam * np.eye(X.shape[1]), X[rows].T @ y[rows])
        for _ in range(iters):
            r = X[rows] @ w - y[rows]
            wt = np.where(np.abs(r) <= delta, 1.0, delta / np.abs(r))
            w = np.linalg.solve(
                (X[rows] * wt[:, None]).T @ X[rows] + lam * np.eye(X.shape[1]),
                (X[rows] * wt[:, None]).T @ y[rows],
            )
        return w

    W = {k: huber_ridge(oracle[:, i]) for i, k in enumerate(["gain", "contrast", "wb_r", "wb_b"])}
    P = {k: X @ w for k, w in W.items()}

    base = np.empty_like(scene)
    for i in range(n_img):
        sel = img == i
        base[sel] = transform(mixed[sel], [P["gain"][i], P["contrast"][i], P["wb_r"][i], P["wb_b"][i]])

    # 5. LUT over the display cube, identity-regularised, clamped
    base_disp = srgb_encode(base)
    cam_disp = srgb_encode(np.clip(cam, 0, 1))
    N = LUT_N
    idx3 = lambda a, b, c: (a * N + b) * N + c
    u = np.clip(base_disp, 0, 1) * (N - 1)
    i0 = np.minimum(np.floor(u).astype(int), N - 2)
    t = u - i0
    AtA = np.zeros((N**3, N**3))
    Atb = np.zeros((N**3, 3))
    sel_rows = np.where(train_px)[0]
    sel_rows = sel_rows[:: max(1, len(sel_rows) // 500000)]
    for r0 in np.array_split(sel_rows, 50):
        w8, cols8 = [], []
        for dz in (0, 1):
            for dy in (0, 1):
                for dx in (0, 1):
                    wgt = ((t[r0, 0] if dx else 1 - t[r0, 0])
                           * (t[r0, 1] if dy else 1 - t[r0, 1])
                           * (t[r0, 2] if dz else 1 - t[r0, 2]))
                    w8.append(wgt)
                    cols8.append(idx3(i0[r0, 0] + dx, i0[r0, 1] + dy, i0[r0, 2] + dz))
        w8 = np.stack(w8, 1)
        cols8 = np.stack(cols8, 1)
        for k in range(len(r0)):
            AtA[np.ix_(cols8[k], cols8[k])] += np.outer(w8[k], w8[k])
            Atb[cols8[k]] += np.outer(w8[k], cam_disp[r0[k]])
    g = np.linspace(0, 1, N)
    R, G, B = np.meshgrid(g, g, g, indexing="ij")
    ident = np.stack([R.ravel(), G.ravel(), B.ravel()], axis=1)
    lam = 0.03
    lut = np.linalg.solve(AtA + lam * np.eye(N**3), Atb + lam * ident)
    lut = ident + np.clip(lut - ident, -LUT_CLAMP, LUT_CLAMP)

    # held-out error through the whole model
    out = np.zeros_like(base_disp)
    for dz in (0, 1):
        for dy in (0, 1):
            for dx in (0, 1):
                wgt = ((t[:, 0] if dx else 1 - t[:, 0])
                       * (t[:, 1] if dy else 1 - t[:, 1])
                       * (t[:, 2] if dz else 1 - t[:, 2]))
                out += wgt[:, None] * lut[idx3(i0[:, 0] + dx, i0[:, 1] + dy, i0[:, 2] + dz)]
    test_px = ~is_train[img] & (~bad)[img]
    err = np.abs(out[test_px] * 255 - cam_disp[test_px] * 255).mean()
    print(f"held-out mean |Δ| through the full model: {err:.2f} sRGB units")

    # 6. emit Rust
    def fmt(arr, per_line=8):
        vals = [f"{v:.6}f32" for v in np.asarray(arr).ravel()]
        return ",\n    ".join(
            ", ".join(vals[i : i + per_line]) for i in range(0, len(vals), per_line)
        )

    NF = X.shape[1]
    x0, dx_ = float(grid[0]), float(grid[1] - grid[0])
    rust = f"""//! GENERATED by tools/camera-look/fit_look.py — the fitted camera look.
#![allow(clippy::excessive_precision)]

pub const MATRIX: [[f32; 3]; 3] = [
    [{M[0][0]:.6}, {M[0][1]:.6}, {M[0][2]:.6}],
    [{M[1][0]:.6}, {M[1][1]:.6}, {M[1][2]:.6}],
    [{M[2][0]:.6}, {M[2][1]:.6}, {M[2][2]:.6}],
];
pub const CURVE_X0: f32 = {x0:.6};
pub const CURVE_DX: f32 = {dx_:.6};
pub const CURVE_KNOTS: [f32; {len(knots)}] = [
    {fmt(knots)}
];
pub const LUT_N: usize = {N};
pub const LUT: [f32; {N**3 * 3}] = [
    {fmt(lut)}
];
pub const N_FEATURES: usize = {NF};
pub const W_GAIN: [f32; {NF}] = [
    {fmt(W['gain'])}
];
pub const W_CONTRAST: [f32; {NF}] = [
    {fmt(W['contrast'])}
];
pub const W_WB_R: [f32; {NF}] = [
    {fmt(W['wb_r'])}
];
pub const W_WB_B: [f32; {NF}] = [
    {fmt(W['wb_b'])}
];
"""
    Path("look_data.rs").write_text(rust)
    print("wrote look_data.rs — move it into imgvwr-develop/src/ and refresh the"
          " verification vectors in look.rs with the values below\n")

    # verification vectors for look.rs's tests: pixels through the fitted
    # chain with a fixed tuning, in the exact shape the unit test wants.
    tuning = dict(gain=-0.31, contrast=0.07, wb_r=-0.05, wb_b=0.03)
    pix = np.array([
        [0.005, 0.004, 0.003], [0.18, 0.18, 0.18], [0.6, 0.3, 0.1],
        [1.4, 1.1, 0.9], [0.02, 0.30, 0.05], [3.5, 3.2, 2.8],
        [0.0, 0.0, 0.0], [0.09, 0.12, 0.35],
    ])
    x = pix @ M.T
    gg = np.array([tuning["gain"] + tuning["wb_r"], tuning["gain"], tuning["gain"] + tuning["wb_b"]])
    x = x * 2.0**gg
    x = MID_GREY * np.power(np.maximum(x, 1e-9) / MID_GREY, 2.0 ** tuning["contrast"])
    disp = apply_channel_curve(x, grid, knots)
    e = srgb_encode(disp)
    ue = np.clip(e, 0, 1) * (N - 1)
    i0e = np.minimum(np.floor(ue).astype(int), N - 2)
    te = ue - i0e
    out = np.zeros_like(e)
    for dz in (0, 1):
        for dy in (0, 1):
            for dxk in (0, 1):
                wgt = ((te[:, 0] if dxk else 1 - te[:, 0])
                       * (te[:, 1] if dy else 1 - te[:, 1])
                       * (te[:, 2] if dz else 1 - te[:, 2]))
                out += wgt[:, None] * lut[
                    [idx3(i0e[k, 0] + dxk, i0e[k, 1] + dy, i0e[k, 2] + dz) for k in range(len(e))]
                ]
    out = np.clip(out, 0, 1)
    print("pixel test cases (tuning gain -0.31, contrast 0.07, wb_r -0.05, wb_b 0.03):")
    for a, b in zip(pix, out):
        print(f"    ([{a[0]:.6}, {a[1]:.6}, {a[2]:.6}], [{b[0]:.6}, {b[1]:.6}, {b[2]:.6}]),")

    ref = next(i for i in range(n_img) if not bad[i])
    print("\nfeature test case (tag", entries[ref]["tag"], "):")
    print("    " + ", ".join(f"{v:.7}" for v in X[ref]))
    for i, k in enumerate(["gain", "contrast", "wb_r", "wb_b"]):
        print(f"    {k}: {float(X[ref] @ W[k]):.5f}")


if __name__ == "__main__":
    main()
