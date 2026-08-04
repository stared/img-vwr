import { registerFact } from "../registry/facts";
import { formatBytes } from "../state/stats";

/**
 * The facts a camera records, worded the way a photographer says them.
 *
 * These are formatters, not readers: the EXIF arrives as numbers precisely so
 * it can be compared and sorted, and "1/200" is a rendering of 0.005 rather
 * than a fact about the photograph. Doing the wording here means one place
 * decides that 0.005 reads as 1/200 and 1.6 reads as 1.6", and every panel
 * and overlay agrees.
 */

/**
 * Shutter speed as it is marked on a dial.
 *
 * Under a second, photographers say the reciprocal — 1/200, not 0.005 — and
 * round it to the nearest whole denominator, because 1/199.8 is a number no
 * camera has ever claimed. At and above a second the seconds are said
 * directly, with the inch mark the convention uses.
 */
export function formatShutter(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return "";
  if (seconds >= 1) return `${Number(seconds.toFixed(1))}"`;
  return `1/${Math.round(1 / seconds)}`;
}

/** Aperture, dropping the decimal point nobody says out loud: f/8, f/1.8. */
export function formatAperture(fNumber: number): string {
  if (!Number.isFinite(fNumber) || fNumber <= 0) return "";
  return `f/${Number(fNumber.toFixed(1))}`;
}

export function registerBuiltinFacts(): void {
  registerFact({
    id: "name",
    label: "file",
    group: "identity",
    value: ({ entry }) => entry.name,
  });

  registerFact({
    id: "camera",
    label: "camera",
    group: "camera",
    value: ({ meta }) => meta?.exif?.camera ?? null,
  });

  registerFact({
    id: "lens",
    label: "lens",
    group: "camera",
    value: ({ meta }) => meta?.exif?.lens ?? null,
  });

  registerFact({
    id: "focalLength",
    label: "focal length",
    group: "exposure",
    value: ({ meta }) => {
      const mm = meta?.exif?.focalLength;
      return mm === undefined || mm === null ? null : `${Math.round(mm)} mm`;
    },
  });

  registerFact({
    id: "shutter",
    label: "shutter",
    group: "exposure",
    value: ({ meta }) => {
      const seconds = meta?.exif?.exposureTime;
      return seconds === undefined || seconds === null ? null : formatShutter(seconds);
    },
  });

  registerFact({
    id: "aperture",
    label: "aperture",
    group: "exposure",
    value: ({ meta }) => {
      const f = meta?.exif?.fNumber;
      return f === undefined || f === null ? null : formatAperture(f);
    },
  });

  registerFact({
    id: "iso",
    label: "ISO",
    group: "exposure",
    value: ({ meta }) => {
      const iso = meta?.exif?.iso;
      return iso === undefined || iso === null ? null : `ISO ${iso}`;
    },
  });

  registerFact({
    id: "taken",
    label: "taken",
    group: "file",
    value: ({ meta }) => meta?.exif?.dateTime ?? null,
  });

  registerFact({
    id: "dimensions",
    label: "dimensions",
    group: "file",
    value: ({ meta }) =>
      meta?.width && meta.height ? `${meta.width} × ${meta.height}` : null,
  });

  registerFact({
    id: "size",
    label: "size",
    group: "file",
    value: ({ entry }) => formatBytes(entry.size),
  });
}

/**
 * What the overlay says unless told otherwise: which photograph this is, what
 * took it, and how it was exposed.
 *
 * Not everything registered. An overlay lies over the picture, so its default
 * is the shortest set that answers "what am I looking at and how was it
 * shot" — file size and pixel dimensions are questions you go to the panel
 * for, not ones worth covering the photograph to answer.
 */
export const DEFAULT_OVERLAY_FACTS = [
  "name",
  "camera",
  "lens",
  "focalLength",
  "shutter",
  "aperture",
  "iso",
] as const;
