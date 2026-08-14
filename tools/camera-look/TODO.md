# TODO: NEF / Nikon processing

Where the match stands (held-out, mean |Δ| 8-bit sRGB vs the camera JPEG):
shipped model **3.86**, per-image oracle ~3.6, ISO>12800 tail 5.5, eclipse
folder ~4.1 excluding degenerate pairs. Every number below is measurable
against `verify_look`; nothing ships without beating the baseline held-out.

## 1. Joint optimization (replace stage-wise greedy fitting)

The shipped model was fitted stage by stage, each stage frozen before the
next: a local-minimum machine. Untried and overdue:

- [ ] **End-to-end differentiable fit (PyTorch, MPS)**: matrix, predictor
      weights, contrast, curve knots (monotone via cumulative softplus),
      LUT cells, trained jointly on train images with Huber loss in display
      space. Init from the shipped model AND from random; **dozens of
      restarts**; Adam, then L-BFGS polish. (Env + samples already prepped
      in the session scratchpad; `samples2.npz` = current decoder.)
- [ ] **Free the arbitrary constraints** inside the joint fit: three
      independent per-channel curves instead of one shared; 11³/17³ LUT
      with a stronger identity prior; predictor as a 2-layer MLP (31→16→4,
      trivially portable to Rust consts).
- [ ] **Per-image latents + distillation**: fit free per-image tunings
      jointly with the global model, then train the predictor to imitate
      them, then fine-tune end to end. Separates "what the camera did" from
      "what we can predict" cleanly.
- [ ] **CMA-ES / basin hopping** over the low-dimensional non-differentiable
      pieces (decoder detail knobs, curve grid geometry, loss weights).
- [ ] Optimize **ΔE00 directly** as an alternative objective; compare which
      objective users actually prefer on A/Bs.

## 2. Different model families (not just deeper fitting of the same one)

- [ ] **Dual-illuminant matrix** (DNG-style): two matrices interpolated by
      as-shot temperature, instead of one global. The night folders pull the
      matrix one way, daylight the other.
- [ ] **Hue/sat/val lattice in IPT or Oklab** instead of the RGB display
      cube: hue twists are axis-aligned there, so a smaller table with less
      leakage between lightness and hue.
- [ ] **Root-polynomial colour correction** (Finlayson) as the matrix
      replacement: exposure-invariant by construction, degree 2/3.
- [ ] **Tiny per-pixel MLP** (log-RGB in, RGB out) trained jointly, then
      distilled into a LUT for shipping: measures how much any fixed-size
      table leaves on the floor.
- [ ] **Functional tone regression**: predict a whole per-image curve
      (few PCA coefficients over oracle per-image display LUTs) instead of
      just gain+contrast. The oracle-vs-model gap says ~0.3 lives here.

## 3. Per-image adaptation (Auto Picture Control emulation)

- [ ] **Use the maker notes we already parse past**: metering mode, focus
      distance, subject-detection flags, flash state, FlickerReduction. The
      camera writes down hints about its own decisions; the predictor reads
      none of them yet.
- [ ] **Faces**: imgvwr-embed already detects faces for the People view.
      Nikon Auto softens and protects skin; a face-area feature (and later a
      skin-tone-region weight in the loss) targets exactly the portrait
      shots people care most about.
- [ ] **k-NN in feature space** over the training pairs as the tuning
      predictor (weighted neighbour average): often beats linear, trivially
      portable (the corpus features are small), and its failures are
      inspectable.
- [ ] **Proper gradient-boosted trees** (LightGBM, then distill or port the
      handful of trees) instead of the hand-rolled stumps that were tried
      and undersold.

## 4. Data and evaluation

- [ ] **Leave-one-folder-out CV**: the honest number for "a future shoot
      unlike the five we have". Currently unknown.
- [ ] **Controlled anchor shoot**: ColorChecker under daylight/tungsten/LED
      at an ISO ladder, RAW+JPEG. Chart patches give per-hue ground truth
      that 1062 uncontrolled frames cannot.
- [ ] **NX Studio as a second oracle**: batch-export Nikon's own TIFF
      renders for a sample; separates "Apple's decode differs" from "our
      transform differs". Free, and bounds the decoder's share of the error.
- [ ] **Sub-pixel + distortion-aware alignment** (fit a radial term): makes
      full-frame 1:1 comparisons valid, which unlocks fitting texture and
      vignetting on the whole frame instead of centre patches.
- [ ] **Localized-error sweep** over all pairs (block-max, not mean) to
      catch categorical bugs like the UV black holes; review flagged frames.
- [ ] Weight the loss by perceptual importance: faces and midtones up,
      JPEG block noise excluded.

## 5. Texture and noise beyond the decoder's knobs

- [ ] **Own sharpening stage** fitted on aligned full-res patches
      (unsharp radius+amount per ISO, differentiable), since CIRAW sharpness
      at 1.0 still reaches only ~0.6 of the camera's edge energy.
- [ ] **Chroma NR pass** (guided filter on ab channels) for ISO ≥ 12800,
      where the camera is 8-20× smoother than our decode even at max knobs.
- [ ] Measure `moireReductionAmount` and sharpness×NR interactions.
- [ ] Later, consistent with the HDRNet decision: a tiny ort-run denoiser,
      transform-constrained, if classical NR cannot close the gap.

## 6. Decode fidelity questions (Nikon-specific)

- [ ] Compare CIRAW's neutralTemperature/Tint against the NEF's recorded
      `WB_RBLevels`/AsShotNeutral: part of the per-image WB correction may
      be Apple misreading HE* white balance, not the camera adapting.
- [ ] Does CIRAW apply the lens distortion/vignetting the JPEG has
      (AutoDistortionControl On)? Measure geometry against the JPEG; if not
      matched, edges disagree for a reason no colour model can fix.
- [ ] If Picture Controls other than Auto ever appear in the corpus, fit
      per-PC looks keyed by the maker-note PC name.

## 7. Plumbing

- [ ] Cache `LookTuning` in develop.db (skip the 384px measure on reopen).
- [ ] Make a refit one command: dump → fit → look_data.rs → test vectors
      patched into look.rs automatically.
- [ ] SIMD the per-pixel look loop and f16 the LUT if profiles ever show it.
