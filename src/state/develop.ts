import { create } from "zustand";

import type {
  Crop,
  DevelopFrame,
  DevelopParams,
  DevelopSettings,
  DevelopState,
  Overlay,
  Preset,
  RegionArg,
} from "../ipc";
import {
  developAutoExposure,
  developFocusPoint,
  developPickWhiteBalance,
  developPresets,
  developRender,
  developReset,
  developSave,
  developState,
  FULL_REGION,
} from "../ipc";

/**
 * The develop session: one image open for editing at a time.
 *
 * Kept out of the application store because it has its own lifecycle — open,
 * adjust, render, close — driven by the selection rather than mirroring it,
 * and because rendering is asynchronous in a way nothing else in the app is.
 *
 * The rendering contract here is coalescing, not queueing. A slider drag
 * emits changes far faster than a 20 ms render can absorb, so at most one
 * render is ever in flight; changes arriving during one set a dirty flag and
 * a single follow-up render runs when it lands. That converges on the
 * settings the user actually stopped at, and never builds a backlog of
 * frames nobody will see.
 */

/** Sliders that make up an edit, in the order the panel shows them. */
export const PARAM_KEYS = [
  "exposure",
  "contrast",
  "highlights",
  "shadows",
  "whites",
  "blacks",
  "rolloff",
  "vibrance",
  "saturation",
] as const;

export type ParamKey = (typeof PARAM_KEYS)[number];

export interface ParamSpec {
  key: ParamKey;
  label: string;
  min: number;
  max: number;
  step: number;
  /** How the value reads next to the label. */
  format: (value: number) => string;
}

const signed = (digits: number) => (value: number) =>
  `${value > 0 ? "+" : ""}${value.toFixed(digits)}`;

export const PARAM_SPECS: ParamSpec[] = [
  { key: "exposure", label: "exposure", min: -5, max: 5, step: 0.01, format: (v) => `${signed(2)(v)} EV` },
  { key: "contrast", label: "contrast", min: -100, max: 100, step: 1, format: signed(0) },
  { key: "highlights", label: "highlights", min: -100, max: 100, step: 1, format: signed(0) },
  { key: "shadows", label: "shadows", min: -100, max: 100, step: 1, format: signed(0) },
  { key: "whites", label: "whites", min: -100, max: 100, step: 1, format: signed(0) },
  { key: "blacks", label: "blacks", min: -100, max: 100, step: 1, format: signed(0) },
  // One-sided: zero is clipping, and nothing lies on the other side of it.
  { key: "rolloff", label: "roll-off", min: 0, max: 100, step: 1, format: (v) => v.toFixed(0) },
  { key: "vibrance", label: "vibrance", min: -100, max: 100, step: 1, format: signed(0) },
  { key: "saturation", label: "saturation", min: -100, max: 100, step: 1, format: signed(0) },
];

/**
 * The pixel overlays, in the order one control cycles through them.
 *
 * Each replaces what the photograph looks like, so they are mutually
 * exclusive and share a single button. Derived from one list so adding one
 * means adding it here and in the Rust enum, and nowhere else.
 */
export const OVERLAY_CYCLE: Overlay[] = ["none", "sharpness", "clipping"];

export const OVERLAY_LABELS: Record<Overlay, string> = {
  none: "off",
  sharpness: "focus map",
  clipping: "clipping",
};

export const OVERLAY_NOTES: Record<Overlay, string> = {
  none: "The photograph, unmarked.",
  sharpness:
    "Marks the regions that resolve fine detail. Smooth surfaces read as unsharp because there is no detail there to resolve.",
  clipping:
    "Red where a channel has hit white and lost its texture, blue where nothing at all was recorded.",
};

export function nextOverlay(current: Overlay): Overlay {
  const at = OVERLAY_CYCLE.indexOf(current);
  return OVERLAY_CYCLE[(at + 1) % OVERLAY_CYCLE.length] ?? "none";
}

/**
 * How the facts about a photograph sit over it.
 *
 * Three states, because two would be wrong in both directions. Left on
 * permanently, a caption over a photograph stops being information and
 * becomes part of the picture you are trying to judge. Turned off, you have
 * to go looking for what you are looking at every time you step to the next
 * frame. "Briefly" is what every viewer that has thought about this settles
 * on — Lightroom's Info overlay has a Show Briefly mode, macOS Quick Look
 * captions on open and fades, and video players show the title on a seek.
 * The rule is the same everywhere: say it when something changed, then get
 * out of the way.
 */
export const CAPTION_CYCLE = ["briefly", "always", "off"] as const;
export type CaptionMode = (typeof CAPTION_CYCLE)[number];

export const CAPTION_LABELS: Record<CaptionMode, string> = {
  briefly: "on change",
  always: "always",
  off: "off",
};

export const CAPTION_NOTES: Record<CaptionMode, string> = {
  briefly: "Says which photograph this is when you arrive at it, then fades.",
  always: "Stays over the photograph.",
  off: "Nothing over the photograph; the panels still say everything.",
};

/** How long "briefly" lasts. Long enough to read a filename and an exposure
 * without hurrying, short enough not to sit over the frame while you judge it. */
export const CAPTION_LINGER_MS = 3500;

export function nextCaption(current: CaptionMode): CaptionMode {
  const at = CAPTION_CYCLE.indexOf(current);
  return CAPTION_CYCLE[(at + 1) % CAPTION_CYCLE.length] ?? "briefly";
}

export const TEMPERATURE_RANGE = { min: 2000, max: 12000, step: 10 };
export const TINT_RANGE = { min: -150, max: 150, step: 1 };

export interface Session {
  path: string;
  /** What the file itself reports: size, camera white balance, stored edit. */
  info: DevelopState;
  /** Live settings — what the sliders show right now. */
  settings: DevelopSettings;
  /** Most recent rendered frame; kept while a new one is computing so the
   * viewer never flashes empty mid-drag. */
  frame: DevelopFrame | null;
  /**
   * A crop of the image developed at full sensor resolution, covering what
   * is on screen while zoomed in past the preview's own resolution.
   *
   * Separate from `frame` because it is a different question. The preview
   * answers "what does this photograph look like"; the detail answers "is
   * this actually sharp" — and it would be ruinous to develop 24 megapixels
   * on every slider drag just so the answer is available when zoomed.
   */
  detail: DevelopFrame | null;
  /** True while a detail crop is being developed. */
  detailing: boolean;
  /**
   * The loupe's pixels, and the region of the image they cover.
   *
   * A third render slot rather than a reuse of `detail`, because the two ask
   * different questions of the same image at the same time: the detail crop
   * replaces what the main view is magnifying, and the loupe sits beside a
   * view that has not been magnified at all.
   *
   * The region travels with the pixels because the loupe moves faster than it
   * can be rendered. Knowing where these pixels *are* is what lets the window
   * slide across them while the next render is still coming — and what keeps
   * that honest, since the pixels under the crosshair are then always the
   * pixels of the place the crosshair is on.
   */
  loupeFrame: { frame: DevelopFrame; region: RegionArg } | null;
  louping: boolean;
  /** The eyedropper is armed: the next click on the image sets the balance. */
  picking: boolean;
  overlay: Overlay;
  rendering: boolean;
  /** Settings changed while a render was in flight. */
  dirty: boolean;
  error: string | null;
}

/**
 * An image opened ahead of time.
 *
 * The frame is null for a file the viewer will show directly — an unedited
 * JPEG needs no developed pixels, and rendering some would be work nobody
 * ever looks at. Opening it was still worth doing: that is the slow part.
 */
export interface Warm {
  info: DevelopState;
  frame: DevelopFrame | null;
}

export interface DevelopStore {
  session: Session | null;
  /** The preset catalog, fetched once. Empty until it arrives. */
  presets: Preset[];
  /** Show each slider's distance from its preset rather than its own value. */
  showDeviation: boolean;
  toggleDeviation: () => void;
  /**
   * Thirds guides over the image.
   *
   * Not an `Overlay`: those are pixel overlays, computed by the renderer and
   * mutually exclusive because each one replaces what the photograph looks
   * like. Guides are geometry drawn on top, so they cost no render, cannot
   * conflict with a focus map or a clipping warning, and stay put while a
   * slider drag re-renders underneath them.
   */
  gridlines: boolean;
  toggleGridlines: () => void;
  /**
   * The loupe: true 100% pixels of one small region, shown beside the fitted
   * photograph rather than instead of it.
   *
   * The question it answers is "did this frame come out sharp", and answering
   * it by zooming means leaving the view you were judging the picture in,
   * checking, and coming back — for every frame of a shoot. Both at once
   * costs a corner of the canvas and no mode changes at all.
   */
  loupe: boolean;
  toggleLoupe: () => void;
  /**
   * Where the loupe is pointed, in the cropped image's coordinates, or null
   * to mean "wherever this frame is sharpest".
   *
   * Null rather than a remembered point, because the useful default moves
   * with the photograph: the eyes are not in the same place in the next take,
   * and a loupe pinned to absolute coordinates would be showing a cheek.
   * Cleared on navigation for exactly that reason.
   */
  loupeAt: { x: number; y: number } | null;
  aimLoupe: (at: { x: number; y: number } | null) => void;
  /**
   * Whether the user aimed it, as opposed to the measurement having.
   *
   * Both end up in `loupeAt` — the point is a point either way, and the
   * measured one is cached there so the next render need not measure again —
   * but the loupe says which it is showing, and "1:1" over a spot nobody
   * chose would be claiming a decision the user never made.
   */
  loupeAimedByUser: boolean;

  /** How the facts about this photograph sit over it. */
  caption: CaptionMode;
  setCaption: (mode: CaptionMode) => void;

  /** Set while `open` is awaiting a slow first decode of a raw file. */
  opening: string | null;
  open: (path: string) => Promise<void>;
  close: () => void;
  /**
   * Open and develop these images ahead of being asked for, nearest first.
   *
   * Opening a raw file is ~2 s (parse plus demosaic setup) against ~20 ms to
   * re-render one already open, so stepping along a shoot spends nearly all
   * its time on work that could have happened while the user was looking at
   * the previous frame. Warming both neighbours turns arrow-key navigation
   * from "developing…" into an image that is simply there.
   *
   * Strictly second in line: nothing is warmed while the image in front of
   * the user is still being rendered, because trading their wait for a
   * stranger's would be worse than not doing this at all.
   */
  prefetch: (paths: string[]) => void;
  /** Neighbours already opened and developed, by path. */
  warm: Record<string, Warm>;
  setParam: (key: ParamKey, value: number) => void;
  setTemperature: (kelvin: number) => void;
  setTint: (tint: number) => void;
  setOverlay: (overlay: Overlay) => void;
  reset: () => Promise<void>;
  /** Re-render at a new size (viewport resize). */
  requestRender: (maxEdge: number) => void;
  /** Develop `region` at up to `maxEdge` px for a 1:1 look. */
  requestDetail: (region: RegionArg, maxEdge: number) => void;
  /** Drop the detail crop — zoomed back out, or it went stale. */
  clearDetail: () => void;
  /** Develop the loupe's region at 1:1, `edge` device pixels across. */
  requestLoupe: (edge: number) => void;
  /**
   * The pixels behind a frame we were showing are gone; develop it again.
   *
   * Frames live in a bounded cache in Rust, so a token can in principle be
   * evicted while its `<img>` is still on screen. That shows as a load
   * failure and a black canvas that nothing would ever repair — the app
   * believes it has a frame, and it does, just not one anybody can fetch. One
   * render is a far better answer than a photograph that never comes back.
   */
  frameLost: () => void;
  /** Arm or disarm the eyedropper. */
  setPicking: (picking: boolean) => void;
  /** Set the white balance from a point in the image (normalised coords). */
  pickWhiteBalanceAt: (x: number, y: number) => Promise<void>;
  /** Set every tone and colour slider to a named preset, leaving the white
   * balance alone — that is the camera's measurement, not a matter of look. */
  applyPreset: (id: string) => void;

  /**
   * Settings copied from one image, waiting to be pasted onto another.
   *
   * Tone and colour only, exactly as a preset is: white balance describes the
   * light a photograph was taken in, and carrying it to a frame shot under
   * different light would be carrying a mistake.
   */
  copied: DevelopSettings | null;
  copySettings: () => void;
  pasteSettings: () => void;

  /**
   * Showing the image as it opened, for comparison.
   *
   * A toggle rather than a held key, so it survives letting go of the mouse
   * to look properly — and the panel says so, because an edit that appears to
   * have vanished is alarming.
   */
  comparing: boolean;
  toggleComparing: () => void;

  /** Set exposure from the light this frame recorded. */
  autoTone: () => Promise<void>;

  /**
   * Dragging out a new crop rectangle on the image.
   *
   * A mode, unavoidably: the same drag means "pan" the rest of the time, and
   * there is nowhere else for it to live. It says so on the button, and any
   * click outside a drag leaves it.
   */
  cropping: boolean;
  setCropping: (cropping: boolean) => void;
  setCrop: (crop: Crop) => void;
}

/** The whole frame, unturned — what "no crop" is. */
export const FULL_CROP: Crop = { x: 0, y: 0, width: 1, height: 1, angle: 0 };

/**
 * The size in real pixels of what the viewer is showing.
 *
 * Not the sensor's size once a crop is applied: zoom is "screen pixels per
 * image pixel", and measuring it against a frame most of which was thrown
 * away would report the wrong percentage and fit the wrong rectangle.
 */
export function displayedSize(
  native: { width: number; height: number },
  crop: Crop,
): { width: number; height: number } {
  return {
    width: Math.max(1, Math.round(native.width * crop.width)),
    height: Math.max(1, Math.round(native.height * crop.height)),
  };
}

export function isCropped(crop: Crop): boolean {
  return (
    crop.x !== 0 || crop.y !== 0 || crop.width !== 1 || crop.height !== 1 || crop.angle !== 0
  );
}

/**
 * A crop rectangle from a drag across the image, in normalised coordinates.
 *
 * Either corner may be dragged to, so the rectangle is built from the extremes
 * rather than from start-to-end, and it is clamped to the frame — a drag that
 * runs off the edge should stop at the edge, not produce a crop that is partly
 * nowhere.
 */
export function cropFromDrag(
  from: { x: number; y: number },
  to: { x: number; y: number },
  angle: number,
): Crop {
  const clamp = (v: number) => Math.min(1, Math.max(0, v));
  const x0 = clamp(Math.min(from.x, to.x));
  const x1 = clamp(Math.max(from.x, to.x));
  const y0 = clamp(Math.min(from.y, to.y));
  const y1 = clamp(Math.max(from.y, to.y));
  // A stray click is not a crop; below this it is a mis-drag.
  const MIN = 0.02;
  return {
    x: x0,
    y: y0,
    width: Math.max(MIN, x1 - x0),
    height: Math.max(MIN, y1 - y0),
    angle,
  };
}

/** Largest detail crop we will develop, in pixels of the longest edge. */
const DETAIL_MAX_EDGE = 4000;

/**
 * The region the loupe should develop to fill `edge` device pixels at 1:1.
 *
 * "1:1" means one image pixel per device pixel, so the region is however
 * much of the image that many pixels covers — a small square of a 24 MP
 * frame, a large one of a small JPEG. Clamped to the frame so a point near an
 * edge shows the corner rather than half a box of nothing.
 */
export function loupeRegion(
  at: { x: number; y: number },
  image: { width: number; height: number },
  edge: number,
): RegionArg {
  const width = Math.min(1, edge / Math.max(1, image.width));
  const height = Math.min(1, edge / Math.max(1, image.height));
  const inside = (v: number, span: number) => Math.min(1 - span, Math.max(0, v - span / 2));
  return { x: inside(at.x, width), y: inside(at.y, height), width, height };
}

/**
 * How much wider than the window the loupe's pixels are developed.
 *
 * Dragging the loupe is a continuous gesture and a render is a round trip, so
 * rendering exactly what fits the window would mean the pixels never catching
 * up with the pointer. A margin turns most of that movement into no work at
 * all: the window slides across pixels already in hand, at once, and a new
 * render is only owed when it reaches the edge of them.
 *
 * The cost is quadratic and paid on every loupe render, so it is a margin and
 * not a canvas — enough to swallow the small adjustments that make up most of
 * aiming, not enough to make each render noticeably slower.
 */
export const LOUPE_MARGIN = 1.8;

/** Whether pixels covering `have` can still fill a window over `want`. */
export function loupeCovers(have: RegionArg, want: RegionArg): boolean {
  // A pixel of slack: the regions are computed in floats from different sizes.
  const EPS = 1e-6;
  return (
    want.x >= have.x - EPS &&
    want.y >= have.y - EPS &&
    want.x + want.width <= have.x + have.width + EPS &&
    want.y + want.height <= have.y + have.height + EPS
  );
}

/** How much two regions must differ before the crop is worth re-developing. */
const REGION_EPSILON = 0.01;

export function regionsDiffer(a: RegionArg, b: RegionArg): boolean {
  return (
    Math.abs(a.x - b.x) > REGION_EPSILON ||
    Math.abs(a.y - b.y) > REGION_EPSILON ||
    Math.abs(a.width - b.width) > REGION_EPSILON ||
    Math.abs(a.height - b.height) > REGION_EPSILON
  );
}

/**
 * The part of the image on screen, in normalised image coordinates.
 *
 * `scale` is screen pixels per image pixel and `tx`/`ty` place the image's
 * top-left corner, matching the viewport's own convention.
 */
export function visibleRegion(
  view: { scale: number; tx: number; ty: number },
  image: { width: number; height: number },
  canvas: { width: number; height: number },
): RegionArg {
  const spanX = view.scale * image.width;
  const spanY = view.scale * image.height;
  if (spanX <= 0 || spanY <= 0) return FULL_REGION;
  const x = Math.max(0, -view.tx / spanX);
  const y = Math.max(0, -view.ty / spanY);
  return {
    x,
    y,
    width: Math.min(1 - x, canvas.width / spanX),
    height: Math.min(1 - y, canvas.height / spanY),
  };
}

/**
 * True when the preview is being magnified past its own resolution, so what
 * the user is looking at is interpolation rather than detail.
 */
export function needsDetail(
  view: { scale: number },
  frame: { width: number },
  image: { width: number },
): boolean {
  if (image.width <= 0 || frame.width <= 0) return false;
  const previewPixelsPerImagePixel = frame.width / image.width;
  // A little slack so sitting exactly at the preview's resolution does not
  // flap between wanting and not wanting a detail render.
  return view.scale > previewPixelsPerImagePixel * 1.05;
}

/** Longest preview edge, from the viewport. Bounded so a huge window does
 * not turn every drag into a full-resolution render. */
export function previewEdge(viewportLongestPx: number, dpr: number): number {
  const wanted = Math.round(viewportLongestPx * dpr);
  return Math.min(3000, Math.max(1200, wanted));
}

/** True when the viewer must show a developed frame rather than the file
 * itself: either the webview cannot decode the format at all, or the user
 * has edited it. */
export function needsDevelopedFrame(session: Session | null): boolean {
  if (!session) return false;
  return session.info.needsRender || !isNeutral(session);
}

/**
 * True when the live settings are the identity edit at the camera's own
 * balance — nothing applied at all, so the original file is a faithful
 * rendering of the current state.
 *
 * Derived from `PARAM_KEYS` rather than listing the fields, because a listing
 * silently stops being true the moment a slider is added.
 */
export function isNeutral(session: Session): boolean {
  const { settings, info } = session;
  return (
    settings.whiteBalance.temperature === info.asShot.temperature &&
    settings.whiteBalance.tint === info.asShot.tint &&
    PARAM_KEYS.every((key) => settings.params[key] === 0)
  );
}

/**
 * True when nothing has moved since the image opened.
 *
 * Not the same as `isNeutral`: sensor data opens with a look already applied,
 * so an untouched raw file is emphatically not the identity edit — but there
 * is still nothing to undo.
 */
export function isAtOpening(session: Session): boolean {
  const { settings, info } = session;
  return (
    settings.whiteBalance.temperature === info.settings.whiteBalance.temperature &&
    settings.whiteBalance.tint === info.settings.whiteBalance.tint &&
    PARAM_KEYS.every((key) => settings.params[key] === info.settings.params[key])
  );
}

/**
 * Which preset the current settings are, or null once they are nobody's.
 *
 * Compared rather than remembered, so the control can only ever name a look
 * the sliders are actually sitting on.
 */
export function presetOf(params: DevelopParams, presets: Preset[]): Preset | null {
  return presets.find((p) => PARAM_KEYS.every((key) => p.params[key] === params[key])) ?? null;
}

/**
 * A copied edit landed on another image.
 *
 * The look travels — tone, colour, and the basis they are a variation of, so
 * the sliders measure from where they did on the image it came from. The white
 * balance stays behind: it describes the light this frame was shot in, and
 * carrying one image's reading onto another shot under different light would
 * be carrying a mistake.
 */
export function pastedSettings(
  target: DevelopSettings,
  copied: DevelopSettings,
): DevelopSettings {
  return { ...target, params: copied.params, basis: copied.basis };
}

/**
 * The preset a slider measures its deviation from — its zero level.
 *
 * The stored basis, except that sitting exactly on some preset makes that one
 * the baseline instead: otherwise the bars would show a deviation from one
 * look while the panel named another.
 */
export function baselineOf(settings: DevelopSettings, presets: Preset[]): Preset | null {
  return (
    presetOf(settings.params, presets) ?? presets.find((p) => p.id === settings.basis) ?? null
  );
}

/**
 * The preset a control should move to.
 *
 * From a preset, the next one along. From an edited state, back to the look
 * the edit was built on — the useful move is undoing your tweaks, not
 * jumping to whichever preset happens to be first.
 */
export function nextPreset(
  active: Preset | null,
  basis: Preset | null,
  presets: Preset[],
): Preset | null {
  if (presets.length === 0) return null;
  if (!active) return basis ?? presets[0] ?? null;
  const at = presets.findIndex((p) => p.id === active.id);
  return presets[at < 0 ? 0 : (at + 1) % presets.length] ?? null;
}

/** Current preview edge; module state rather than store state because it is
 * a rendering detail the UI never displays. */
let currentEdge = 1600;

/**
 * How many neighbours to keep developed ahead.
 *
 * Two — the next and the previous — which is what the backend holds open
 * alongside the current image. Warming more would evict the ones actually
 * about to be needed, and the third image away is not one keystroke from
 * being on screen anyway.
 */
const WARM_LIMIT = 2;

/** A fresh session for a just-opened image. One place, so an image installed
 * from the warm cache is in exactly the state one opened the slow way is. */
function sessionFor(path: string, info: DevelopState, frame: DevelopFrame | null): Session {
  return {
    path,
    info,
    settings: info.settings,
    frame,
    detail: null,
    detailing: false,
    loupeFrame: null,
    louping: false,
    picking: false,
    overlay: "none",
    rendering: false,
    dirty: false,
    error: null,
  };
}

export const useDevelopStore = create<DevelopStore>((set, get) => {
  /**
   * Render the session's current settings, coalescing concurrent requests.
   * Every result is checked against the live session before being applied:
   * the user may have navigated away, and a frame for the previous image
   * must never appear under the current one's name.
   */
  async function pump(): Promise<void> {
    const start = get().session;
    if (!start || start.rendering) return;

    set({ session: { ...start, rendering: true, dirty: false } });
    const { path, overlay } = start;
    // Comparing renders what the image opened with instead of the live
    // settings, so "before" means the same thing whether the edit is one
    // slider or a whole preset.
    //
    // Cropping renders the whole frame, because a crop is drawn on the
    // photograph as shot. Drawing it on an already-cropped image would mean
    // every rectangle was relative to the last one, and there would be no way
    // to grow a crop back.
    const live = get().cropping ? { ...start.settings, crop: FULL_CROP } : start.settings;
    const settings = get().comparing ? start.info.settings : live;

    const result = await developRender(path, settings, currentEdge, overlay, FULL_REGION).then(
      (frame) => ({ ok: true as const, frame }),
      (error: unknown) => ({ ok: false as const, error: String(error) }),
    );

    const now = get().session;
    if (!now || now.path !== path) return; // navigated away mid-render

    if (result.ok) {
      // The detail crop was developed from the previous settings, so it is
      // now a lie about the image; drop it and let the canvas ask again.
      set({
        session: {
          ...now,
          frame: result.frame,
          // Both crops were developed from the previous settings, so both are
          // now lies about the image; the canvas asks for them again.
          detail: null,
          loupeFrame: null,
          rendering: false,
          error: null,
        },
      });
    } else {
      set({ session: { ...now, rendering: false, error: result.error } });
    }

    if (get().session?.dirty) void pump();
  }

  /* The image whose frame has already been developed a second time after its
   * pixels went missing; see `frameLost`. */
  let refetched: string | null = null;

  /* Neighbours to develop ahead, nearest first, and whether the loop that
   * does it is running. Module state: it is a scheduling detail, and nothing
   * in the UI describes it. */
  let wanted: string[] = [];
  let warming = false;

  /**
   * Develop the wanted neighbours, one at a time, while nothing is waiting.
   *
   * One at a time because these renders share a thread pool with the one the
   * user is watching, and two speculative renders in flight would make the
   * next slider drag wait behind them.
   */
  async function warmUp(): Promise<void> {
    if (warming) return;
    warming = true;
    try {
      for (;;) {
        const session = get().session;
        // Never ahead of the image actually on screen — including mid-drag,
        // where a render has just landed and the next one is already owed.
        // Opening a neighbour in that gap would stall the drag for seconds.
        // The canvas asks again after every frame, so nothing is lost by
        // waiting.
        if (!session || session.rendering || session.dirty || session.frame === null) return;
        const path = wanted.find((p) => p !== session.path && !(p in get().warm));
        if (path === undefined) return;

        const warmed = await developState(path).then(
          async (info) => ({
            info,
            // Only pixels somebody will look at: a plain JPEG with no edit is
            // shown by the webview from the file itself.
            frame: needsDevelopedFrame(sessionFor(path, info, null))
              ? await developRender(path, info.settings, currentEdge, "none", FULL_REGION)
              : null,
          }),
          () => null,
        );
        if (warmed) set({ warm: { ...get().warm, [path]: warmed } });
        // A file with no develop plugin must not be retried on every step.
        else wanted = wanted.filter((p) => p !== path);
      }
    } finally {
      warming = false;
    }
  }

  /** Apply a settings change: the sliders move immediately, the pixels catch
   * up. Persisting is fire-and-forget — an edit that fails to save is worth
   * reporting, but never worth blocking the drag on. */
  function change(next: DevelopSettings): void {
    const session = get().session;
    if (!session) return;
    set({ session: { ...session, settings: next, dirty: true } });
    void developSave(session.path, next).catch(() => {
      const now = get().session;
      if (now && now.path === session.path) {
        set({ session: { ...now, error: "could not save this edit" } });
      }
    });
    void pump();
  }

  return {
    session: null,
    // Fetched once, on the way past: the catalog is fixed for the session and
    // the panel is the only thing that ever waits on it.
    presets: (() => {
      void developPresets().then(
        (presets) => set({ presets }),
        () => {},
      );
      return [];
    })(),
    showDeviation: false,
    toggleDeviation: () => set((s) => ({ showDeviation: !s.showDeviation })),
    gridlines: false,
    toggleGridlines: () => set((s) => ({ gridlines: !s.gridlines })),
    copied: null,
    comparing: false,
    cropping: false,
    opening: null,

    warm: {},

    open: async (path) => {
      if (get().session?.path === path) return;
      // Crop is about one photograph, and arriving at the next one already in
      // crop mode would mean a drag across it meant something unexpected.
      if (get().cropping) set({ cropping: false });
      // And where the sharpest place is moves with the photograph — the eyes
      // are not where they were in the previous take. Back to "wherever this
      // frame is sharpest" until the user aims it themselves.
      if (get().loupeAt !== null) set({ loupeAt: null, loupeAimedByUser: false });
      refetched = null;

      // Already developed while the user was looking at its neighbour: show
      // it now, with no round trip at all. Taken out of the cache on the way
      // past, so a later edit is never shadowed by a stale copy of it.
      const warmed = get().warm[path];
      if (warmed) {
        const rest = Object.fromEntries(Object.entries(get().warm).filter(([p]) => p !== path));
        set({ warm: rest, opening: null, session: sessionFor(path, warmed.info, warmed.frame) });
        // No pump: the warm frame is exactly what one would produce.
        return;
      }

      set({ opening: path, session: null });
      try {
        const info = await developState(path);
        // A slower open for an image the user has already navigated past
        // must not install itself over their current one.
        if (get().opening !== path) return;
        set({ opening: null, session: sessionFor(path, info, null) });
        void pump();
      } catch (error) {
        if (get().opening !== path) return;
        set({ opening: null, session: null });
        // Not every file has a develop plugin (AVIF); that is not an error
        // worth surfacing, the viewer simply shows the file directly.
        void error;
      }
    },

    prefetch: (paths) => {
      wanted = paths.slice(0, WARM_LIMIT);
      // Forget anything no longer nearby: the backend has probably evicted
      // its scene by now, and a frame token outlives its pixels.
      const warm = get().warm;
      const near = Object.fromEntries(Object.entries(warm).filter(([p]) => wanted.includes(p)));
      if (Object.keys(near).length !== Object.keys(warm).length) set({ warm: near });
      void warmUp();
    },

    close: () => set({ session: null, opening: null }),

    setParam: (key, value) => {
      const session = get().session;
      if (!session) return;
      change({
        ...session.settings,
        params: { ...session.settings.params, [key]: value },
      });
    },

    setTemperature: (kelvin) => {
      const session = get().session;
      if (!session) return;
      change({
        ...session.settings,
        whiteBalance: { ...session.settings.whiteBalance, temperature: kelvin },
      });
    },

    setTint: (tint) => {
      const session = get().session;
      if (!session) return;
      change({
        ...session.settings,
        whiteBalance: { ...session.settings.whiteBalance, tint },
      });
    },

    setOverlay: (overlay) => {
      const session = get().session;
      if (!session) return;
      set({ session: { ...session, overlay, dirty: true } });
      void pump();
    },

    reset: async () => {
      const session = get().session;
      if (!session) return;
      const info = await developReset(session.path);
      const now = get().session;
      if (!now || now.path !== session.path) return;
      set({
        session: { ...now, info, settings: info.settings, dirty: true },
      });
      void pump();
    },

    requestDetail: (region, maxEdge) => {
      const session = get().session;
      if (!session || session.detailing) return;
      const { path, settings, overlay } = session;
      set({ session: { ...session, detailing: true } });
      void developRender(path, settings, Math.min(maxEdge, DETAIL_MAX_EDGE), overlay, region).then(
        (detail) => {
          const now = get().session;
          // Only install it if it still describes the image on screen under
          // the settings that produced it.
          if (!now || now.path !== path || now.settings !== settings) {
            if (now) set({ session: { ...now, detailing: false } });
            return;
          }
          set({ session: { ...now, detail, detailing: false } });
        },
        () => {
          const now = get().session;
          if (now) set({ session: { ...now, detailing: false } });
        },
      );
    },

    setPicking: (picking) => {
      const session = get().session;
      if (!session) return;
      set({ session: { ...session, picking } });
    },

    pickWhiteBalanceAt: async (x, y) => {
      const session = get().session;
      if (!session) return;
      // The point is where the user clicked on the picture in front of them,
      // which is the crop; the backend maps it back onto the sensor.
      const balance = await developPickWhiteBalance(session.path, x, y, session.settings);
      const now = get().session;
      if (!now || now.path !== session.path) return;
      // Disarm on use: the eyedropper is a single action, not a mode you
      // have to remember to leave.
      set({ session: { ...now, picking: false } });
      change({ ...now.settings, whiteBalance: balance });
    },

    copySettings: () => {
      const session = get().session;
      if (session) set({ copied: session.settings });
    },

    pasteSettings: () => {
      const { session, copied } = get();
      if (!session || !copied) return;
      change(pastedSettings(session.settings, copied));
    },

    toggleComparing: () => {
      const session = get().session;
      if (!session) return;
      set({ comparing: !get().comparing });
      void pump();
    },

    autoTone: async () => {
      const session = get().session;
      if (!session) return;
      const exposure = await developAutoExposure(session.path, session.settings);
      const now = get().session;
      if (!now || now.path !== session.path) return;
      change({ ...now.settings, params: { ...now.settings.params, exposure } });
    },

    setCropping: (cropping) => {
      set({ cropping });
      // Entering shows the whole frame and leaving shows the crop again, so
      // both directions are a different picture and need a render.
      void pump();
    },

    setCrop: (crop) => {
      const session = get().session;
      if (!session) return;
      change({ ...session.settings, crop });
    },

    applyPreset: (id) => {
      const session = get().session;
      const preset = get().presets.find((p) => p.id === id);
      if (!session || !preset) return;
      // White balance is deliberately untouched. It is a measurement of the
      // light the photograph was taken in, not part of anybody's look, and a
      // preset that overwrote it would throw away the eyedropper's work.
      //
      // The basis moves with it: from here on, this is what the sliders
      // measure their deviation from.
      change({ ...session.settings, params: preset.params, basis: preset.id });
    },

    clearDetail: () => {
      const session = get().session;
      if (!session || session.detail === null) return;
      set({ session: { ...session, detail: null } });
    },

    loupe: false,
    loupeAt: null,
    loupeAimedByUser: false,

    toggleLoupe: () => set((s) => ({ loupe: !s.loupe })),

    // The pixels are kept, not dropped. They came with the region they cover,
    // so the window can be re-centred over them for nothing — which is what
    // makes dragging the loupe continuous instead of a series of blanks. It
    // stays honest because the pixels are placed by where they are, so what
    // is under the crosshair is always that place; when the aim leaves them
    // entirely the canvas asks for more.
    aimLoupe: (at) => set({ loupeAt: at, loupeAimedByUser: at !== null }),

    caption: "briefly",
    setCaption: (caption) => set({ caption }),

    requestLoupe: (edge) => {
      const session = get().session;
      if (!session || session.louping || !get().loupe) return;
      const { path, settings, overlay } = session;
      const image = displayedSize(session.info, settings.crop);
      set({ session: { ...session, louping: true } });

      // Where to point, when nobody has pointed it: the sharpest region,
      // measured for this frame. Asked once per aim rather than per render,
      // because it is a fact about the photograph, not about the settings.
      const aim =
        get().loupeAt !== null
          ? Promise.resolve(get().loupeAt as { x: number; y: number })
          : developFocusPoint(path, settings).then(
              ([x, y]) => ({ x, y }),
              () => ({ x: 0.5, y: 0.5 }),
            );

      void aim
        .then(async (at) => {
          // Wider than the window, so the next small movement costs nothing.
          const wide = Math.round(edge * LOUPE_MARGIN);
          const region = loupeRegion(at, image, wide);
          const frame = await developRender(path, settings, wide, overlay, region);
          return { at, frame, region };
        })
        .then(
          ({ at, frame, region }) => {
            const now = get().session;
            // Only install it if it still describes the image on screen under
            // the settings that produced it.
            if (!now || now.path !== path || now.settings !== settings) {
              if (now) set({ session: { ...now, louping: false } });
              return;
            }
            // Remember where the focus point put it, so the next render at
            // the same aim does not measure the frame again.
            if (get().loupeAt === null) set({ loupeAt: at });
            set({ session: { ...now, loupeFrame: { frame, region }, louping: false } });
          },
          () => {
            const now = get().session;
            if (now) set({ session: { ...now, louping: false } });
          },
        );
    },

    // Once per photograph, and no more. A second failure is not a lost frame,
    // it is a broken pipeline, and re-rendering forever would turn a blank
    // canvas into a blank canvas with the fans on.
    frameLost: () => {
      const session = get().session;
      if (!session || session.frame === null || refetched === session.path) return;
      refetched = session.path;
      set({ session: { ...session, frame: null, dirty: true } });
      void pump();
    },

    requestRender: (maxEdge) => {
      if (maxEdge === currentEdge) return;
      currentEdge = maxEdge;
      // Warm frames were developed for the old viewport, so they are the
      // wrong size now; dropping them has them warmed again at this one.
      if (Object.keys(get().warm).length > 0) set({ warm: {} });
      const session = get().session;
      if (!session) return;
      set({ session: { ...session, dirty: true } });
      void pump();
    },
  };
});
