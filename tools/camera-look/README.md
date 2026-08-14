# Fitting the camera look

The camera look (`imgvwr-develop/src/look.rs` + generated `look_data.rs`)
renders a neutral raw decode the way the camera's own JPEG engine would.
It is fitted, not designed — this directory holds the fitting pipeline.

Two generations live here. `fit_look.py` is the original stage-wise fit
(curve, then matrix, then per-image oracle, then ridge predictors, then
LUT — each stage frozen before the next). `fit_joint.py` is its
replacement: the same pipeline expressed differentiably in PyTorch and
fitted **end to end** — matrix, three per-channel curves, 17³ lattice,
per-image latents and the tuning predictor all get gradients at once, with
multiple restarts from both the shipped model and random inits. The joint
fit beats the stage-wise one on every folder.

## Regenerating

1. Dump matched pairs onto a small shared grid (any folder where the camera
   wrote a JPEG beside every NEF):

   ```sh
   cargo run --release -p imgvwr-develop --example dump_pairs -- /tmp/pairs \
       ~/Pictures/Nikon_RAW/<shoot> ...
   ```

2. Prepare the environment and the side inputs:

   ```sh
   uv venv fitenv && uv pip install --python fitenv/bin/python numpy torch scikit-learn lightgbm pillow
   # per-shot camera decisions (XMP + EXIF) — needs exiftool on PATH or nearby:
   exiftool -j -q -n -G1 <every NEF> > makernotes_all.json
   fitenv/bin/python extract_maker_features.py
   # snapshot the previous look_data.rs for warm starts:
   git show HEAD:src-tauri/crates/imgvwr-develop/src/look_data.rs > look_data_shipped.rs
   ```

   The scripts expect `samples2.npz` / `images2.json` / `features2.json`
   built from the dump (see `prep_samples2.py` / `extract_features2.py`
   headers in the session scratchpad, or re-derive: 3000 random pixels per
   image plus per-image metering stats).

3. Fit (a sweep of restarts; ~30 s per restart on an M-series GPU):

   ```sh
   fitenv/bin/python fit_joint.py --curves 3 --lut 17 --predictor mlp \
       --maker portable --latent-extra 1 --restarts 8 --init mixed --out joint.npz
   ```

4. Emit the Rust constants and refresh the test vectors:

   ```sh
   fitenv/bin/python export_joint.py joint.npz > look_data.rs 2> vectors.txt
   ```

   Move `look_data.rs` into `src-tauri/crates/imgvwr-develop/src/`, paste
   the pixel/feature vectors from `vectors.txt` into `look.rs`'s tests.

5. Measure end to end:

   ```sh
   cargo run --release -p imgvwr-develop --example verify_look -- <shoots>...
   ```

Side analyses: `fit_predictors.py` (ridge/k-NN/LightGBM/MLP bake-off for
the tuning predictor), `localized_sweep.py` (block-max error over every
pair — catches categorical bugs mean error hides), `spatial_ceiling.py`
(how much of the residual a coarse spatial gain field would explain).

## The measured ladder (2026-08-14, 1052 usable Z6 III pairs, five shoots)

Held-out error against the camera's JPEG, mean |Δ| in 8-bit sRGB units,
even/odd split within each folder:

| model | error |
|---|---|
| neutral decode | 16.6 |
| old slider preset | 7.1 |
| stage-wise fit (one curve, ridge predictor, 9³ LUT) | 3.86 |
| joint fit, same architecture | 3.69 |
| + three per-channel curves + 17³ LUT + MLP predictor | 3.49 |
| + the camera's own per-shot decisions as features | 3.30 |
| + saturation latent + residual k-NN + cross-clip | 3.26 |
| refit full-frame at a 512 grid (shipped) | **3.26**, e2e 3.40 |
| per-image oracle under the shipped globals | 2.81 |
| oracle + 6×6 spatial gain field (ADL/clarity share) | 2.68 |

Perceptually (CIEDE2000, held-out): mean 1.89, **median 1.19** — half of
all pixels are inside the "flip A/B to notice" range. Twenty further
restarts of the ship config all land in [3.26, 3.28]: the architecture
is exhausted at this corpus. Also measured and closed: Lab-loss training
(ΔE00 1.86 vs 1.89 for +0.15 sRGB — not worth it), face features from
Vision boxes (−0.007 — the failing frames are faceless water), fine-tuning
around the k-NN (worse), lens geometry (corners align ~1 px) and
vignetting (±0.03 EV) — both match the camera, which is why the final
fit uses the full frame. What remains needs new data: a ColorChecker
anchor shoot for the thin colour corners, NX Studio as a second oracle,
and shoots unlike the five folders.

Findings that shaped the model:

- The camera curves **per channel**, and the three channels genuinely
  differ: freeing them (plus the bigger lattice) was worth 0.2. Grey through
  the look now takes the camera's own slight warm cast — that is measured,
  not a bug.
- **The camera writes its Auto Picture Control decisions into the NEF.**
  Every file carries an XMP packet (`crd:Contrast2012`, `crd:Saturation`,
  `crd:Clarity2012`, `crd:Texture`, sharpening and NR settings) that varies
  per shot, plus `ColorTemperatureAuto`/`WB_RBLevels` in the maker notes.
  Reading the camera's own decisions instead of guessing them from pixels
  was the single biggest improvement (−0.19). The portable subset (XMP +
  standard EXIF, no maker-note decryption) carries all of the value;
  `imgvwr_core::read_camera_decisions` byte-scans the packet at file head.
- Auto PC also varies **saturation** per shot; a fifth per-image latent
  (chroma scale around luma in display-linear space) captures it.
- The predictor is a 41→16→5 tanh MLP fine-tuned end to end through the
  pixel model. Bake-off on the same latents: ridge 3.95, k-NN 3.32,
  in-loop MLP 3.28. LightGBM adds nothing k-NN doesn't.
- CIRAW reads HE* white balance correctly (its temperature tracks the
  camera's recorded `ColorTemperatureAuto` at r=0.993 with a 2.5% offset);
  the per-image WB nudges model the camera's rendering, not a decode bug.
- Of the oracle residual (2.82), only ~0.19 is coarse-spatial (6×6 luma
  field): Nikon's clarity/texture processing is real but small with ADL
  off. The rest of the floor is demosaic/NR texture — per-pixel colour
  transforms cannot chase it.
- A pair dump can contain degenerate pairs (sun-disk frames shot at −10 EV
  where both files are essentially black); the fits exclude them.
- Far-over-range chroma (UV stage lights at 3–5× clip) used to leak
  through the matrix into green blobs; the shipped model clips the
  matrix's cross-channel input at two stops over white (0.005 of average
  error for the fix).
- The predictor's failures cluster: the frames where the camera's own
  Contrast2012 goes extreme (backlit fountains at +5, UV club at −42).
  A distance-weighted residual k-NN over the fitting corpus repairs the
  lookalike tail and fades out away from anything seen (LOFO says a
  genuinely new venue lands near 4.4 before it has any neighbours).
- Texture, measured on 1:1 patches: at base ISO the camera has 1.26× our
  edge energy (a wide unsharp would close a little); from ISO 1000 up the
  ratio inverts (0.72–0.80) and flat-area noise is 11–26× the camera's —
  CIRAW's luminance NR trades real edges for noise, so matching Nikon
  here needs an edge-preserving pass (guided filter), not a knob.
- Known limitation: near-monochromatic deep red (the eclipse sun disk)
  stays saturated where the camera desaturates it — that corner of the
  display cube has almost no training data and the LUT is clamped.
