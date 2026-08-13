# Design notes

Why things work the way they do. The README says what the app does; this file
records the reasoning behind the less obvious decisions, so it does not have to
be reconstructed from commits. The fuller version of each argument lives as a
doc comment next to the code it explains — pointers below.

## Crop (`src/state/crop.ts`)

Lightroom's model, adopted after comparing it with the draw-a-tilted-rectangle
alternative: the crop rectangle stays axis-aligned on screen and the
photograph rotates underneath it. A horizon is judged against the fixed frame
rather than by tilting your head, which is the whole point of a straighten
tool.

The invariant is `fitted()`: whatever a drag or an angle change asks for, the
crop is shrunk (proportionally, preserving a locked aspect) and slid until all
four corners lie inside the rotated image. That single function is what stops
a straighten from dragging in corners that were never photographed, and it
runs on every mutation rather than being each gesture's responsibility.

Rotation happens in an isotropic space — normalized coordinates scaled by the
frame's aspect before the trig — because rotating in stretched normalized
coordinates shears the rectangle.

## Export (`src/state/export.ts`, `src-tauri/src/services/export.rs`)

The plan is computed as pure data before anything is written, and the dialog
states it ("2 photographs: 1 developed, 1 copied from the camera's JPG").
Finding out what an export did from a folder of files is finding out too late.

What happens to an unedited photograph is the interesting option. A raw + JPEG
shoot is mostly frames nobody edited; rendering those from the sensor is slow
(seconds against a file copy) and produces this app's rendering of the raw,
not the picture the camera made and the photographer judged the frame by. So
by default an untouched frame exports as the JPG beside the raw, copied byte
for byte when the size and format allow. The other reading — a set that must
look consistent — is the "developed like the rest" toggle.

Rendered frames get their sibling JPG's EXIF spliced in (APP1 segment moved
verbatim; there is no EXIF writer in the dependency tree), so a developed
export still says when and how it was taken. Existing files are never
overwritten: a taken name gets `-1` appended.

## HDR (`src/state/hdr.ts`, `src-tauri/crates/imgvwr-hdr/`, `services/hdr.rs`)

An HDR set is detected, not declared: frames seconds apart whose exposure
sweeps ≥1.5 EV at one focal length (both facts required — a burst without the
sweep is continuous shooting, a sweep without the burst is somebody changing
settings). Detection is pure TS over EXIF the app already reads, and runs for
every folder as its metadata streams in; no view owns it.

A detected set is *one photograph*, and the app already has the machinery for
"several files, one photograph": stacking. The set collapses like a raw+JPEG
pair wherever stacks collapse, fronted by its middle exposure — the face —
and the grid badges the face `HDR ×5`. The merge is virtual, Lightroom-style:
the face's path is registered with the develop service as "open this as the
fusion of these frames" (`develop_set_fusions`), so the viewer shows the
fusion, edits store against the face path in `develop.db` like any other
edit, and export renders it (named `-HDR`) through the ordinary export
dialog. Nothing is ever written beside the originals; no button merges
anything. The frames stay real files — visible in the grid, one keypress
away behind the face.

The fusion itself (Rust, `imgvwr-hdr`) is exposure fusion (Mertens), not
radiance recovery — the result is a blend of the input pixels that showed
each region best, so it looks like the camera's photographs rather than a
tone-mapper's. Alignment is a verified rigid motion (rotation + translation,
subpixel): nine tiles per frame vote with median-threshold-bitmap
translations, votes are weighted by evidence and texture (smooth sky scores
its own iso-line beautifully and knows nothing), a motion is fitted per
exposure-neighbour link and composed out from the middle exposure — and
every candidate is *measured*, by warping and correlating edges against the
reference where both frames resolved the scene. MTB proposes; photometry
disposes. The contract is align or refuse, per frame: a frame that cannot
be verified is left out of the fusion, a set with nothing verifiable shows
its face frame plain — the honest renderings are the merge or the frame,
never a ghost. Either way the develop panel states the outcome ("fused",
or "won't align — showing this frame alone", with the measured reason):
a silent refusal would be indistinguishable from the feature not working.
The output is cropped to the pixels every frame saw, turned upright before
fusing (a virtual photograph has no EXIF to carry an orientation tag), and
handed to the develop pipeline as a scene — from there it is anybody
else's JPEG.

## Sliders (`src/components/shell/Slider.tsx`)

One component for every continuous quantity in the app — quality, size, all
twelve develop controls, thumbnails per row. One track height, one thumb, one
place the number sits, which is what keeps a column of them aligned.

Three ways to give a number, because each is the only good way sometimes:

- **Drag** for "a bit more than that"; shift makes the gesture 5× finer.
- **Click a mark** for the value you were going to pick anyway. Marks sit on
  the track, explain themselves on hover, and a press on one can still become
  a drag — which is why the track owns the pointer instead of wrapping a
  native `<input type="range">`, where a clickable mark and a draggable track
  cannot coexist.
- **Type** into the readout for an exact number ("1600"), with lenient
  parsing ("2048 px", "1,5") since the text being edited contains units.

Marks wear the colour of the line they sit on — the rail's outside the filled
span, the fill's inside it, the accent when the value is exactly there. A grey
dot on a lit bar reads as a hole in the bar.

The export size track is logarithmic (512 → largest photograph selected):
the step 512→1024 is the same kind of step as 4096→8192, and a linear track
spends most of its length on sizes nobody picks. It ends at the largest
photograph because exports never upscale — positions past that point would all
mean the same thing. The top of the track is "full size", kept distinct from
the same number of pixels: one bakes today's dimensions in, the other says
"whatever the photograph is". "full size" always states the number it means
("full size · 6048 px", "up to" when the selection is mixed).

## Raw decoding (`src-tauri/crates/imgvwr-raw/`)

Core Image on macOS, not an open-source decoder: recent Nikon bodies write
High Efficiency / HE\* NEFs, a licensed compression that rawler rejects and
LibRaw (so darktable and RawTherapee too) cannot read. The system decoder is
used for demosaicing and sensor-space white balance only; every tonal control
lives in `imgvwr-develop` and behaves identically for every format. Same
precedent as AVIF, which is likewise left to the platform decoder.
