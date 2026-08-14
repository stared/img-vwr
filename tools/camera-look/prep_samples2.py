"""Sample pixels from every dumped pair into one compact npz for fitting.

Reads pairs/<tag>_scene.f32 and pairs/<tag>_cam.f32 (RGB f32, row-major),
crops the border, draws a stratified random sample of pixels per image, and
stores scene RGB, camera RGB (both linear) plus the image index of every
sample. Also stores per-image summary statistics for exposure modelling.
"""

import json
import sys
from pathlib import Path

import numpy as np

PAIRS = Path(__file__).parent / "pairs2"
BORDER = 0.06
PER_IMAGE = 3000
SEED = 42


def luma(rgb):
    return 0.2126 * rgb[..., 0] + 0.7152 * rgb[..., 1] + 0.0722 * rgb[..., 2]


def main():
    entries = [json.loads(l) for l in open(PAIRS / "manifest.jsonl")]
    # The manifest can hold duplicates if the dump ran twice; keep the first.
    seen, unique = set(), []
    for e in entries:
        if e["tag"] not in seen:
            seen.add(e["tag"])
            unique.append(e)
    entries = unique
    print(f"{len(entries)} pairs")

    rng = np.random.default_rng(SEED)
    all_scene, all_cam, all_img = [], [], []
    stats = []

    for idx, e in enumerate(entries):
        w, h = e["w"], e["h"]
        scene = np.fromfile(PAIRS / f'{e["tag"]}_scene.f32', dtype=np.float32).reshape(h, w, 3)
        cam = np.fromfile(PAIRS / f'{e["tag"]}_cam.f32', dtype=np.float32).reshape(h, w, 3)
        mx, my = int(w * BORDER), int(h * BORDER)
        scene = scene[my : h - my, mx : w - mx].reshape(-1, 3)
        cam = cam[my : h - my, mx : w - mx].reshape(-1, 3)

        n = scene.shape[0]
        take = min(PER_IMAGE, n)
        pick = rng.choice(n, size=take, replace=False)
        all_scene.append(scene[pick])
        all_cam.append(cam[pick])
        all_img.append(np.full(take, idx, dtype=np.int32))

        y = luma(scene)
        ylog = np.log2(np.maximum(y, 1e-8))
        qs = np.percentile(ylog, [1, 5, 25, 50, 75, 95, 99, 99.9])
        ycam = luma(cam)
        cam_qs = np.percentile(ycam, [50, 95])
        stats.append(
            dict(
                tag=e["tag"],
                folder=e["folder"],
                iso=e.get("iso"),
                temp=e["temp"],
                tint=e["tint"],
                scene_logq=[float(v) for v in qs],
                cam_q=[float(v) for v in cam_qs],
            )
        )
        if idx % 200 == 0:
            print(idx, e["tag"])

    np.savez_compressed(
        Path(__file__).parent / "samples2.npz",
        scene=np.concatenate(all_scene),
        cam=np.concatenate(all_cam),
        img=np.concatenate(all_img),
    )
    json.dump(stats, open(Path(__file__).parent / "images2.json", "w"))
    print("saved", sum(len(a) for a in all_scene), "samples")


if __name__ == "__main__":
    sys.exit(main())
