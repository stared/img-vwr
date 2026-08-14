# Fitting the camera look

The camera look (`imgvwr-develop/src/look.rs` + generated `look_data.rs`)
renders a neutral raw decode the way the camera's own JPEG engine would.
It is fitted, not designed — this directory holds the fitting pipeline.

## Regenerating

1. Dump matched pairs onto a small shared grid (any folder where the camera
   wrote a JPEG beside every NEF):

   ```sh
   cargo run --release -p imgvwr-develop --example dump_pairs -- /tmp/pairs \
       ~/Pictures/Nikon_RAW/<shoot> ...
   ```

2. Fit and emit the Rust constants:

   ```sh
   uv venv env && uv pip install --python env/bin/python numpy
   env/bin/python fit_look.py /tmp/pairs
   ```

3. Move `look_data.rs` into `src-tauri/crates/imgvwr-develop/src/` and
   refresh the verification vectors in `look.rs`'s tests (the script prints
   pixel and feature vectors; the unit tests must be updated to the new
   expected values, or they will rightly fail).

4. Measure end to end:

   ```sh
   cargo run --release -p imgvwr-develop --example verify_look -- <shoots>...
   ```

## What was measured (2026-08-14, 1052 usable Z6 III pairs, five shoots)

Held-out error against the camera's JPEG, mean |Δ| in 8-bit sRGB units:

| model | error |
|---|---|
| neutral decode | 16.6 |
| old slider preset (best any sliders can do: 7.8) | 7.1 |
| best single luminance-gain curve — the old pipeline's ceiling | 8.0 |
| one per-channel curve | 6.4 |
| + matrix | 6.3 |
| + per-image gain/contrast/WB predicted from the frame | 4.7 |
| + display-cube LUT (shipped model) | **3.9** |
| per-image oracle (what no fixed-per-frame transform beats) | 3.9 |

Findings that shaped the model:

- The camera curves **per channel**; a hue-preserving luminance gain (the
  old pipeline) can never desaturate highlights the way the camera does, and
  its measured ceiling (8.0) is *worse* than a per-channel curve fitted with
  no other freedom at all (6.4).
- Every frame here is Picture Control **Auto**: the camera decides exposure,
  contrast and Auto-WB cast removal per shot (spread over a third of a
  stop). A ridge predictor from the frame's own histogram (log-luma
  percentiles, centre-weighted ones, clipping fractions, channel casts, ISO,
  as-shot illuminant) recovers most of it and is what `LookTuning::measure`
  computes.
- The remaining hue-dependent residue (greens pushed yellower, reds warmer)
  fits a small 3D lattice over the display cube — identity-regularised and
  clamped to ±0.15 so colours the corpus never saw pass through untouched.
- Active D-Lighting was off everywhere, so no local tone mapping is modelled;
  if a future shoot has it on, a global model will visibly under-fit it.
- A pair dump can contain broken pairs (eclipse-totality frames where the
  NEF decodes black against a lit JPEG); `fit_look.py` excludes them.
