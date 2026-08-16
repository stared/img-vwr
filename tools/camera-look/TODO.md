# TODO: NEF / Nikon processing

Where the match stands (held-out, mean |Δ| 8-bit sRGB vs the camera JPEG)
after the 2026-08-14 joint-fit session: shipped model **3.26** held-out
(**3.41** end-to-end over all 1115 pairs incl. degenerates; was 3.86/4.26),
per-image oracle 2.81, oracle + coarse spatial field 2.68, LOFO ≈4.4. Every number is
measurable against `verify_look`; nothing ships without beating the
baseline held-out.

**Default rendering is now EXACT, not fitted** (2026-08-16): at the
camera default (nikon look, sliders at zero, as-shot balance, full frame)
the app serves the camera's own JPEG — the paired .JPG beside the NEF
(EXIF capture time must agree), else the full-size JpgFromRaw embedded in
the NEF (same rendering, ~1 MB codec quality, mean |Δ| 1.0–1.7 to the
FINE pair). `is_camera_default` in presets.rs is the gate;
`OpenScene::resolved` in services/develop.rs the switch; render and
export both go through it. A finished picture passes the identity develop
byte-for-byte (unit-tested), so a PNG export at default is Nikon's exact
pixels. The fitted 3.26/3.40 numbers now describe the FIRST KNOB TOUCH
handoff, not the default view. The handoff jump (~3.4/255 + camera CA
correction, see below) is the number to shrink next.

## 1. Joint optimization (replace stage-wise greedy fitting)

- [x] **End-to-end differentiable fit (PyTorch, MPS)** — `fit_joint.py`;
      multi-restart, shipped+random inits. 3.86 → 3.69 same architecture,
      3.49 with freed constraints.
- [x] **Free the arbitrary constraints**: three per-channel curves, 17³
      LUT, MLP predictor. Shipped.
- [x] **Per-image latents + distillation** — phase A latents, ridge
      distill, end-to-end fine-tune. The gradient oracle (2.82) beat the
      old coordinate-descent oracle (~3.6) by a wide margin.
- [ ] **CMA-ES / basin hopping** over the non-differentiable pieces
      (decoder detail knobs, curve grid geometry, loss weights).
- [x] **Lab/ΔE objective** — measured: ΔE00 1.86 vs 1.89 for +0.15 sRGB;
      the sRGB Huber is already nearly perceptually optimal. Closed.
- [x] Also measured-out in the same night: latent weight-decay (hurts),
      8k-step phase A (overfits), LUT clamp 0.25 (restart noise),
      speckle/glint features (no separation), longer chroma-NR radii
      (worse). The 512-grid full-frame refit is the floor of this corpus.
- [x] **Per-shot camera decisions as features** (found mid-session): the
      NEF's XMP packet carries Auto PC's Contrast/Saturation/Clarity/
      Texture per shot; feeding them to the predictor was worth −0.19,
      and the portable subset (no maker-note decryption) carries all of it.
- [x] k-NN ensemble: shipped as a residual k-NN over the corpus (fixes
      the Contrast2012-extreme tail; fades out off-corpus). Fine-tuning
      the globals AROUND the k-NN measured WORSE (3.23 → 3.26) — the
      bolted-on correction is already optimal.
- [ ] Predictor still has the biggest headroom: 3.26 predicted vs 2.81
      oracle. Faces/subject-detection features are the untried signal —
      the failures that remain are "who is the subject" decisions.
- [ ] The eclipse sun disk: near-monochromatic deep red stays saturated
      where the camera desaturates. Thin-data LUT corner; needs either
      anchor data (ColorChecker + deep-red patches) or a wider clamp
      there specifically.
- [ ] User-confirmed by eye (2026-08-16, now only on the edited path):
      per-image brightness/saturation offsets (the predictor→oracle gap),
      backlit-fountain brightness, and residual UV-violet green leak —
      the cross-channel clip is a symptom clamp; a hue-preserving gamut
      mapping for out-of-range blue/violet is the honest fix.

## 2. Different model families (not just deeper fitting of the same one)

- [x] **Dual-illuminant matrix** — tried in the joint fit (2026-08-14):
      3.275 vs 3.279 single-matrix, within restart noise; did not stack
      with the other wins. Not shipped.
- [ ] **Hue/sat/val lattice in IPT or Oklab** instead of the RGB display
      cube: hue twists are axis-aligned there, so a smaller table with less
      leakage between lightness and hue.
- [ ] **Root-polynomial colour correction** (Finlayson) as the matrix
      replacement: exposure-invariant by construction, degree 2/3.
- [ ] **Tiny per-pixel MLP** (log-RGB in, RGB out) trained jointly, then
      distilled into a LUT for shipping: measures how much any fixed-size
      table leaves on the floor.
- [x] **Functional tone regression** — probed as two per-image curve-shape
      latents (shadow-lift / highlight-shift with the sliders' cubic masks):
      held-out −0.02 in the fit, but END-TO-END it measured WORSE (3.43 vs
      3.40) — the wilder 7-dof oracle latents make the k-NN residuals
      poisonous through the real pipeline's clamps and the 384-vs-512
      feature shift. Rust keeps the axes (inactive at N_TUNING=5); only
      revisit with latent regularisation in phase A.

## 3. Per-image adaptation (Auto Picture Control emulation)

- [ ] **Use the maker notes we already parse past**: metering mode, focus
      distance, subject-detection flags, flash state, FlickerReduction. The
      camera writes down hints about its own decisions; the predictor reads
      none of them yet.
- [ ] **Faces**: imgvwr-embed already detects faces for the People view.
      Nikon Auto softens and protects skin; a face-area feature (and later a
      skin-tone-region weight in the loss) targets exactly the portrait
      shots people care most about.
- [x] **k-NN in feature space** — shipped as the residual layer on the
      MLP (bake-off: ridge 3.95, k-NN 3.32, in-loop MLP 3.28, hybrid 3.25).
- [x] **Gradient-boosted trees** — measured (LightGBM): adds nothing over
      k-NN on this corpus size. Not shipped.

## 4. Data and evaluation

- [x] **Leave-one-folder-out CV** — measured: shoot-a 5.0, shoot-b 3.3,
      shoot-c 4.5, eclipse 4.6 → a genuinely new shoot lands ≈4.4.
- [ ] **Controlled anchor shoot**: ColorChecker under daylight/tungsten/LED
      at an ISO ladder, RAW+JPEG. Chart patches give per-hue ground truth
      that 1062 uncontrolled frames cannot.
- [ ] **NX Studio as a second oracle**: batch-export Nikon's own TIFF
      renders for a sample; separates "Apple's decode differs" from "our
      transform differs". Free, and bounds the decoder's share of the error.
- [ ] **Sub-pixel + distortion-aware alignment** (fit a radial term): makes
      full-frame 1:1 comparisons valid, which unlocks fitting texture and
      vignetting on the whole frame instead of centre patches.
- [x] **Localized-error sweep** — `localized_sweep.py`, ran twice; caught
      the UV green blobs (fixed via cross-channel clip) and the sun-disk
      saturation miss (open, see §1).
- [ ] Weight the loss by perceptual importance: faces and midtones up,
      JPEG block noise excluded.

## 5. Texture and noise beyond the decoder's knobs

- [x] **Own sharpening stage** — shipped (imgvwr-develop/src/nr.rs): wide
      unsharp on luminance below ISO ~250, fitted on 1:1 patches; edge
      ratio to camera 1.27 → 1.01.
- [x] **Guided-filter NR** — shipped: chroma from ISO ~5000, luminance
      above ~13k, run in GAMMA-ENCODED light (in linear light one eps
      cannot serve shadows and highlights; the linear version measured
      worse than nothing). ISO-57600 patch error 5.11 → 4.52, edge ratio
      1.016. Gated to scale ≥ 0.5; previews untouched.
- [ ] Full-res export runs ~25 box-filter passes — parallelise the SAT
      build or tile if export latency ever matters.
- [ ] Measure `moireReductionAmount` and sharpness×NR interactions.
- [ ] Later, consistent with the HDRNet decision: a tiny ort-run denoiser,
      transform-constrained, if classical NR cannot close the gap.

## 6. Decode fidelity questions (Nikon-specific)

- [x] CIRAW WB vs the NEF's recorded values — audited: r=0.993 with a
      2.5% systematic offset; Apple reads HE* WB correctly. The per-image
      WB nudges model the camera's rendering, not a decode bug.
- [ ] **CIRAW fails outright on pixel-shift + big-bracket frames**: the
      two "degenerate" eclipse pairs (DSC_1189/1194 — PixelShiftActive,
      ExposureBracketValue +6) decode as a FLAT constant (−0.004
      everywhere) while their JPEGs are normal sunsets. Not an exposure
      problem — the decode returns nothing. Detect a flat SceneReferred
      decode and fall back to the embedded JPEG for display.
- [x] CIRAW lens geometry vs the JPEG — measured on corner patches
      (dump_patches --at): corners align to ~1 native px, spread <1 px.
      Distortion correction matches; full-frame 1:1 fitting is NOT
      geometry-blocked (the old ±14 px was the active-area offset).
- [x] **Lateral CA — measured, matched** (2026-08-16): per-channel phase
      correlation on 768² corner patches (shoot-a + shoot-b, 4 corners + centre):
      R−G and B−G offsets < 0.01 px in BOTH our decode and the camera
      JPEG. CIRAW corrects lateral CA. The "fringes" seen by eye are the
      edited path's chroma-noise/violet-tail speckle on speculars, not
      optics.
- [ ] **The NEF carries an ACR recipe** (found 2026-08-16): the XMP
      packet is namespace `crd = camera-raw-defaults` — Nikon writes the
      Adobe Camera Raw defaults that reproduce its JPEG, including
      `CameraProfile = "Camera Standard"` (Adobe's camera-matching DCP
      for the Z6 III: dual-illuminant matrices + HueSatDelta lattice +
      look table + tone curve) plus per-shot 2012-process slider values.
      Extracting that DCP (ships free inside Adobe DNG Converter;
      `dcamprof dcp2json` reads it) would replace our fitted matrix+LUT
      with Adobe's measured reverse-engineering of Nikon's colour.
      Blocked locally: downloading the DNG Converter needs the user
      (permission classifier denied it); NX Studio as Nikon's own oracle
      likewise needs a user install.
- [ ] If Picture Controls other than Auto ever appear in the corpus, fit
      per-PC looks keyed by the maker-note PC name.

## 7. Plumbing

- [ ] Cache `LookTuning` in develop.db (skip the 384px measure on reopen).
- [ ] Make a refit one command: dump → fit → look_data.rs → test vectors
      patched into look.rs automatically.
- [ ] SIMD the per-pixel look loop and f16 the LUT if profiles ever show it.
