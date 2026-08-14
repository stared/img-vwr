"""Block-max localized error sweep over every pair (CPU, shipped model).

Mean error hides categorical bugs (the UV black holes averaged fine).
For each image: render the full 384px scene grid through the shipped-init
torch model with the shipped predictor tunings, then score 16x16 blocks by
mean |delta| and record each image's worst block. Report the tail.
"""

import json
from pathlib import Path

import numpy as np
import torch

import fit_joint as fj

HERE = Path(__file__).parent
BLOCK = 16


def main():
    import sys
    torch.set_num_threads(6)
    ship = fj.load_shipped()
    entries = json.load(open(HERE / "images2.json"))
    dims = {}
    for line in open(HERE / "pairs2/manifest.jsonl"):
        m = json.loads(line)
        dims[m["tag"]] = (m["w"], m["h"])
    for e in entries:
        e["w"], e["h"] = dims[e["tag"]]
    if len(sys.argv) > 1:  # a joint-fit npz: use its model and predictor
        import fit_predictors as fp
        npz = np.load(HERE / sys.argv[1], allow_pickle=True)
        cfg = json.loads(str(npz["config"]))
        data = fj.load_data("cpu", maker=cfg.get("maker", "none"))
        model, _ = fp.rebuild(npz, data, ship)
        with torch.no_grad():
            tun_all = model.predict(torch.tensor(data["feats_np"]))
    else:
        feats = fj.assemble_features(entries)
        model = fj.Look(ship, len(entries), feats, curves=1, lut_n=9,
                        predictor="linear", init="shipped", seed=0)
        with torch.no_grad():
            tun_all = torch.tensor(feats) @ torch.tensor(ship["W"].T, dtype=torch.float32)

    out = []
    with torch.no_grad():
        for i, e in enumerate(entries):
            w, h = e["w"], e["h"]
            scene = np.fromfile(HERE / f'pairs2/{e["tag"]}_scene.f32',
                                dtype=np.float32).reshape(h, w, 3)
            cam = np.fromfile(HERE / f'pairs2/{e["tag"]}_cam.f32',
                              dtype=np.float32).reshape(h, w, 3)
            s = torch.tensor(scene.reshape(-1, 3))
            tun = tun_all[i].expand(len(s), -1)
            pred = model(s, tun).numpy().reshape(h, w, 3)
            cam_enc = np.where(cam <= 0.0031308, cam * 12.92,
                               1.055 * np.clip(cam, 1e-8, 1) ** (1 / 2.4) - 0.055)
            err = np.abs(pred - np.clip(cam_enc, 0, 1)).mean(axis=2) * 255
            hb, wb = h // BLOCK, w // BLOCK
            blocks = err[: hb * BLOCK, : wb * BLOCK].reshape(hb, BLOCK, wb, BLOCK)
            bm = blocks.mean(axis=(1, 3))
            k = int(np.argmax(bm))
            by, bx = divmod(k, wb)
            out.append(dict(tag=e["tag"], mean=float(err.mean()),
                            block_max=float(bm.max()),
                            by=int(by * BLOCK), bx=int(bx * BLOCK)))
            if i % 200 == 0:
                print(i, flush=True)

    out.sort(key=lambda r: -r["block_max"])
    json.dump(out, open(HERE / "localized_errors.json", "w"), indent=1)
    print("\nworst 40 by block-max (mean err in worst 16x16 block, sRGB units):")
    for r in out[:40]:
        print(f'{r["block_max"]:7.1f}  mean {r["mean"]:5.2f}  ({r["by"]},{r["bx"]})  {r["tag"]}')


if __name__ == "__main__":
    main()
