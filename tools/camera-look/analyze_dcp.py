"""Where does the DCP-fixed model's error live: tone or colour, and which shoots?"""
import json
import numpy as np
import torch

import fit_dcp
from fit_joint import load_data

dev = "mps" if torch.backends.mps.is_available() else "cpu"
data = load_data(dev, maker="portable")
img_np = data["img"].cpu().numpy()
test_px = (~data["is_train"])[img_np] & (~data["bad"])[img_np]

dcp = json.load(open("dcp_standard.json"))
table = np.array(dcp["ProfileLookTableData"], dtype=np.float32).reshape(16, 90, 16, 3)
tone = np.array(dcp["ProfileToneCurve"], dtype=np.float32).reshape(-1, 2)

results = {}
for name, path in [("dcp", "joint_dcp.npz"), ("free", "joint_free.npz")]:
    d = np.load(path, allow_pickle=True)
    if name == "dcp":
        model = fit_dcp.DcpLook(data["n_img"], data["feats_np"].shape[1], table, tone).to(dev)
    else:
        import fit_joint
        model = fit_joint.Look(fit_dcp.fake_ship(), data["n_img"], data["feats_np"],
                               curves=3, lut_n=9, predictor="mlp", init="random",
                               seed=0, latent_extra=1, clip_scene=2.0, clip_cross=True).to(dev)
    sd = {k: torch.tensor(d[k]) for k in d.files if k not in ("err", "oracle", "config")}
    model.load_state_dict(sd)
    with torch.no_grad():
        tun = model.predict(data["feats"])
        idx = torch.tensor(np.where(test_px)[0]).to(dev)
        lum_err, chr_err, tot, n = 0.0, 0.0, 0.0, 0
        per_img_err = np.zeros(data["n_img"]); per_img_n = np.zeros(data["n_img"])
        for chunk in idx.split(1_000_000):
            im = data["img"][chunk]
            out = model(data["scene"][chunk], tun[im], im)
            diff = 255.0 * (out - data["cam_enc"][chunk])
            w = torch.tensor([0.2126, 0.7152, 0.0722], device=dev)
            dl = (diff * w).sum(1)             # luma error (signed)
            dc = diff - dl.unsqueeze(1) * w / (w * w).sum()  # chroma remainder
            lum_err += dl.abs().sum().item()
            chr_err += dc.abs().sum().item()
            tot += diff.abs().sum().item(); n += len(chunk)
            e = diff.abs().mean(1)
            np.add.at(per_img_err, im.cpu().numpy(), e.cpu().numpy())
            np.add.at(per_img_n, im.cpu().numpy(), 1)
        print(f"\n== {name}: mean|d| {tot/(3*n):.3f}  luma {lum_err/n:.3f}  chroma {chr_err/(3*n):.3f}")
        pi = np.divide(per_img_err, per_img_n, out=np.zeros_like(per_img_err), where=per_img_n>0)
        folders = {}
        for i, e in enumerate(data["entries"]):
            if per_img_n[i]:
                folders.setdefault(e["folder"].split("_DSC")[0], []).append(pi[i])
        for f, v in sorted(folders.items()):
            print(f"   {f}: {np.mean(v):.2f}")
        results[name] = pi
d = results["dcp"] - results["free"]
worst = np.argsort(d)[-5:]
print("\nimages where DCP loses hardest vs free:")
for i in worst[::-1]:
    print("  ", data["entries"][i]["tag"], f"dcp-free {d[i]:+.2f}")
