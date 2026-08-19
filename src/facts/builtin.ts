import { registerFact } from "../registry/facts";
import { formatBytes } from "../state/stats";

/** Under a second: the reciprocal, denominator rounded whole ("1/200"); at and above: seconds with the inch mark. */
export function formatShutter(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return "";
  if (seconds >= 1) return `${Number(seconds.toFixed(1))}"`;
  return `1/${Math.round(1 / seconds)}`;
}

export function formatAperture(fNumber: number): string {
  if (!Number.isFinite(fNumber) || fNumber <= 0) return "";
  return `f/${Number(fNumber.toFixed(1))}`;
}

/** Sign always present; the minus is U+2212, not ASCII. */
export function formatSigned(value: number): string {
  const rounded = Number(value.toFixed(1));
  return rounded < 0 ? `−${Math.abs(rounded)}` : `+${rounded}`;
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
    id: "ev",
    label: "EV",
    group: "exposure",
    value: ({ meta }) => {
      const ev = meta?.exif?.exposureBias;
      if (ev === undefined || ev === null || ev === 0) return null;
      return `${formatSigned(ev)} EV`;
    },
  });

  registerFact({
    id: "whiteBalance",
    label: "white balance",
    group: "grade",
    value: ({ asShot }) =>
      asShot === null
        ? null
        : `${Math.round(asShot.temperature)} K ${formatSigned(asShot.tint)}`,
  });

  registerFact({
    id: "grade",
    label: "camera grade",
    group: "grade",
    value: ({ meta }) => {
      const g = meta?.grade;
      if (g === undefined || g === null) return null;
      const parts = [
        g.contrast !== 0 ? `contrast ${formatSigned(g.contrast)}` : "",
        g.saturation !== 0 ? `sat ${formatSigned(g.saturation)}` : "",
        g.clarity !== 0 ? `clarity ${formatSigned(g.clarity)}` : "",
        g.texture !== 0 ? `texture ${formatSigned(g.texture)}` : "",
      ].filter((p) => p !== "");
      return parts.length > 0 ? parts.join(" ") : null;
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

export const DEFAULT_OVERLAY_FACTS = [
  "name",
  "camera",
  "lens",
  "focalLength",
  "shutter",
  "aperture",
  "iso",
  "ev",
  "whiteBalance",
  "grade",
] as const;
