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
  /** The eyedropper is armed: the next click on the image sets the balance. */
  picking: boolean;
  overlay: Overlay;
  rendering: boolean;
  /** Settings changed while a render was in flight. */
  dirty: boolean;
  error: string | null;
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
  /** Set while `open` is awaiting a slow first decode of a raw file. */
  opening: string | null;
  open: (path: string) => Promise<void>;
  close: () => void;
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
        session: { ...now, frame: result.frame, detail: null, rendering: false, error: null },
      });
    } else {
      set({ session: { ...now, rendering: false, error: result.error } });
    }

    if (get().session?.dirty) void pump();
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

    open: async (path) => {
      if (get().session?.path === path) return;
      set({ opening: path, session: null });
      try {
        const info = await developState(path);
        // A slower open for an image the user has already navigated past
        // must not install itself over their current one.
        if (get().opening !== path) return;
        set({
          opening: null,
          session: {
            path,
            info,
            settings: info.settings,
            frame: null,
            detail: null,
            detailing: false,
            picking: false,
            overlay: "none",
            rendering: false,
            dirty: false,
            error: null,
          },
        });
        void pump();
      } catch (error) {
        if (get().opening !== path) return;
        set({ opening: null, session: null });
        // Not every file has a develop plugin (AVIF); that is not an error
        // worth surfacing, the viewer simply shows the file directly.
        void error;
      }
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

    requestRender: (maxEdge) => {
      if (maxEdge === currentEdge) return;
      currentEdge = maxEdge;
      const session = get().session;
      if (!session) return;
      set({ session: { ...session, dirty: true } });
      void pump();
    },
  };
});
