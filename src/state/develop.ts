import { create } from "zustand";

import type {
  DevelopFrame,
  DevelopParams,
  DevelopSettings,
  DevelopState,
  Overlay,
  Preset,
  RegionArg,
} from "../ipc";
import {
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
    const { path, settings, overlay } = start;

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
      const balance = await developPickWhiteBalance(
        session.path,
        x,
        y,
        session.settings.whiteBalance,
      );
      const now = get().session;
      if (!now || now.path !== session.path) return;
      // Disarm on use: the eyedropper is a single action, not a mode you
      // have to remember to leave.
      set({ session: { ...now, picking: false } });
      change({ ...now.settings, whiteBalance: balance });
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
