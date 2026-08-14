"""Predictor bake-off on top of a joint-fit global model.

Loads a joint_*.npz, freezes the global pieces, fits per-image oracle
latents for ALL images (gradient, on all pixels), then compares predictors
features -> latents, each evaluated through the pixel model on held-out
pixels (the real metric, not latent MSE):

  ridge31        image features only (shipped feature set)
  ridge+maker    + per-shot maker-note decisions
  knn            distance-weighted k-NN in whitened feature space
  lgbm           LightGBM per latent dim
  mlp            2-layer MLP trained on latents, then end-to-end fine-tune

Usage: fitenv/bin/python fit_predictors.py joint_c3l17lin.npz
"""

import json
import sys
from pathlib import Path

import numpy as np
import torch

import fit_joint as fj

HERE = Path(__file__).parent


def rebuild(npz, data, ship):
    cfg = json.loads(str(npz["config"]))
    dual = cfg.get("dual_matrix", False)
    temp_w = None
    if dual:
        temp_w = np.clip(
            (np.log2([max(e["temp"], 1500.0) for e in data["entries"]])
             - np.log2(3000.0)) / (np.log2(6500.0) - np.log2(3000.0)),
            0.0, 1.0)
    model = fj.Look(ship, data["n_img"], data["feats_np"], curves=cfg["curves"],
                    lut_n=cfg["lut"], predictor=cfg["predictor"],
                    init="shipped", seed=cfg["seed"],
                    latent_extra=cfg.get("latent_extra", 0),
                    clip_scene=cfg.get("clip_scene", 0.0),
                    clip_cross=cfg.get("clip_cross", False),
                    dual_matrix=dual, temp_w=temp_w,
                    basis_luts=cfg.get("basis_luts", 1),
                    hidden=cfg.get("hidden", 16))
    sd = {k: torch.tensor(npz[k]) for k in npz.files
          if k not in ("err", "oracle", "config")}
    model.load_state_dict(sd, strict=False)
    return model, cfg


@torch.no_grad()
def eval_through(model, data, px_sel, tun):
    return fj.evaluate(model, data, px_sel, tun)


def main():
    path = sys.argv[1] if len(sys.argv) > 1 else "joint_c3l17lin.npz"
    dev = "mps" if torch.backends.mps.is_available() else "cpu"
    ship = fj.load_shipped()
    npz = np.load(HERE / path, allow_pickle=True)
    cfg0 = json.loads(str(npz["config"]))
    data = fj.load_data(dev, maker=cfg0.get("maker", "none"))
    model, cfg = rebuild(npz, data, ship)
    model = model.to(dev)
    img_np = data["img"].cpu().numpy()
    test_px = (~data["is_train"])[img_np] & (~data["bad"])[img_np]
    rows_tr = data["is_train"] & ~data["bad"]
    rows_te = ~data["is_train"] & ~data["bad"]

    lat_file = HERE / (path.replace(".npz", "_latents.npy"))
    if lat_file.exists():
        lat = torch.tensor(np.load(lat_file)).to(dev)
    else:
        lat = fj.fit_test_latents(model, data, steps=500).to(dev)
        np.save(lat_file, lat.cpu().numpy())
    print("oracle through model:", round(eval_through(model, data, test_px, lat), 3))
    Y = lat.cpu().numpy()

    # feats_np already carries the maker columns when the model used them;
    # the base-31 slice is the pixel-only feature set.
    XM = data["feats_np"]
    X31 = XM[:, :31]

    results = {}

    def eval_pred(name, Yhat):
        tun = torch.tensor(Yhat, dtype=torch.float32).to(dev)
        err = eval_through(model, data, test_px, tun)
        results[name] = err
        print(f"{name:<14} held-out {err:.3f}", flush=True)

    def ridge(X, lam=3e-2):
        A = X[rows_tr]
        W = np.linalg.solve(A.T @ A + lam * np.eye(X.shape[1]), A.T @ Y[rows_tr])
        return X @ W

    eval_pred("ridge31", ridge(X31))
    eval_pred("ridge+maker", ridge(XM))

    # k-NN, whitened, distance-weighted
    from sklearn.neighbors import KNeighborsRegressor
    for tag, X in (("knn31", X31), ("knn+maker", XM)):
        mu, sd_ = X[rows_tr].mean(0), X[rows_tr].std(0) + 1e-6
        Xw = (X - mu) / sd_
        kn = KNeighborsRegressor(n_neighbors=8, weights="distance").fit(
            Xw[rows_tr], Y[rows_tr])
        eval_pred(tag, kn.predict(Xw))

    # LightGBM per dim
    import lightgbm as lgb
    for tag, X in (("lgbm31", X31), ("lgbm+maker", XM)):
        Yhat = np.zeros_like(Y)
        for d in range(Y.shape[1]):
            m = lgb.LGBMRegressor(n_estimators=300, learning_rate=0.05,
                                  num_leaves=15, min_child_samples=10,
                                  subsample=0.8, colsample_bytree=0.8,
                                  random_state=0, verbose=-1)
            m.fit(X[rows_tr], Y[rows_tr, d])
            Yhat[:, d] = m.predict(X)
        eval_pred(tag, Yhat)

    # MLP on maker features, latent-MSE trained then end-to-end fine-tuned
    def mlp_fit(X, tag, steps_lat=3000, steps_e2e=800):
        mu, sd_ = X[rows_tr].mean(0), X[rows_tr].std(0) + 1e-6
        Xw = torch.tensor((X - mu) / sd_, dtype=torch.float32).to(dev)
        net = torch.nn.Sequential(
            torch.nn.Linear(X.shape[1], 24), torch.nn.Tanh(),
            torch.nn.Linear(24, Y.shape[1])).to(dev)
        Yt = torch.tensor(Y, dtype=torch.float32).to(dev)
        rt = torch.tensor(np.where(rows_tr)[0]).to(dev)
        opt = torch.optim.Adam(net.parameters(), lr=3e-3, weight_decay=1e-4)
        for s in range(steps_lat):
            loss = (net(Xw[rt]) - Yt[rt]).pow(2).mean()
            opt.zero_grad(); loss.backward(); opt.step()
        # end-to-end: pixels, through the frozen global model
        img_t = data["img"]
        train_px = data["is_train"][img_np] & (~data["bad"])[img_np]
        idx = torch.tensor(np.where(train_px)[0]).to(dev)
        opt = torch.optim.Adam(net.parameters(), lr=5e-4)
        g = torch.Generator().manual_seed(7)
        for s in range(steps_e2e):
            b = idx[torch.randint(len(idx), (262144,), generator=g).to(dev)]
            tun = net(Xw)[img_t[b]]
            out = model(data["scene"][b], tun)
            loss = fj.huber(255.0 * (out - data["cam_enc"][b])).mean()
            opt.zero_grad(); loss.backward(); opt.step()
        with torch.no_grad():
            eval_pred(tag, net(Xw).cpu().numpy())
        return net

    mlp_fit(X31, "mlp31-e2e")
    mlp_fit(XM, "mlp+maker-e2e")

    json.dump(results, open(HERE / "predictor_results.json", "w"), indent=1)


if __name__ == "__main__":
    main()
