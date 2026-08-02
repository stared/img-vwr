import { create } from "zustand";

import type { DevelopFrame, DevelopSettings, DevelopState, Overlay } from "../ipc";
import { developRender, developReset, developSave, developState } from "../ipc";

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
  overlay: Overlay;
  rendering: boolean;
  /** Settings changed while a render was in flight. */
  dirty: boolean;
  error: string | null;
}

export interface DevelopStore {
  session: Session | null;
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

/** True when the live settings still match the camera's own starting point. */
export function isNeutral(session: Session): boolean {
  const { settings, info } = session;
  const p = settings.params;
  return (
    settings.whiteBalance.temperature === info.asShot.temperature &&
    settings.whiteBalance.tint === info.asShot.tint &&
    p.exposure === 0 &&
    p.contrast === 0 &&
    p.highlights === 0 &&
    p.shadows === 0 &&
    p.whites === 0 &&
    p.blacks === 0 &&
    p.vibrance === 0 &&
    p.saturation === 0
  );
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

    const result = await developRender(path, settings, currentEdge, overlay).then(
      (frame) => ({ ok: true as const, frame }),
      (error: unknown) => ({ ok: false as const, error: String(error) }),
    );

    const now = get().session;
    if (!now || now.path !== path) return; // navigated away mid-render

    if (result.ok) {
      set({ session: { ...now, frame: result.frame, rendering: false, error: null } });
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
