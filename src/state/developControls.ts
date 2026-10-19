import type { Overlay } from "../ipc";

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

/** Mutually exclusive pixel overlays; adding one means adding it here and in the Rust enum. */
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

/** How long "briefly" lasts: enough to read a filename and an exposure without hurrying. */
export const CAPTION_LINGER_MS = 3500;

export function nextCaption(current: CaptionMode): CaptionMode {
  const at = CAPTION_CYCLE.indexOf(current);
  return CAPTION_CYCLE[(at + 1) % CAPTION_CYCLE.length] ?? "briefly";
}

export const TEMPERATURE_RANGE = { min: 2000, max: 12000, step: 10 };
export const TINT_RANGE = { min: -150, max: 150, step: 1 };
