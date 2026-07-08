import { fetch } from "@tauri-apps/plugin-http";

import type { ImageSource, SourceItem } from "../registry/sources";
import { urlExtension } from "./shared";

const API = "https://commons.wikimedia.org/w/api.php";
const LIMIT = 60;
const THUMB_WIDTH = 640;

interface CommonsImageInfo {
  url: string;
  thumburl?: string;
  width: number;
  height: number;
  size: number;
  /** Upload time, ISO 8601. */
  timestamp: string;
  extmetadata?: Record<string, { value: string } | undefined>;
}

interface CommonsPage {
  title: string;
  imageinfo?: CommonsImageInfo[];
}

export interface CommonsResponse {
  query?: { pages?: CommonsPage[] };
}

/**
 * A "Category:…" argument lists that category's files; anything else is a
 * full-text search over bitmap files.
 */
export function commonsRequestUrl(arg: string): string {
  const params = new URLSearchParams({
    action: "query",
    format: "json",
    formatversion: "2",
    origin: "*",
    prop: "imageinfo",
    iiprop: "url|size|timestamp|extmetadata",
    iiurlwidth: String(THUMB_WIDTH),
  });
  const category = /^category:/i.exec(arg.trim());
  if (category) {
    params.set("generator", "categorymembers");
    params.set("gcmtitle", `Category:${arg.trim().slice(category[0].length)}`);
    params.set("gcmtype", "file");
    params.set("gcmlimit", String(LIMIT));
  } else {
    params.set("generator", "search");
    params.set("gsrsearch", `filetype:bitmap ${arg.trim()}`);
    params.set("gsrnamespace", "6");
    params.set("gsrlimit", String(LIMIT));
  }
  return `${API}?${params.toString()}`;
}

/** extmetadata values may carry HTML markup; reduce to plain text. */
function plainText(value: string | undefined): string | null {
  const text = value?.replace(/<[^>]*>/g, "").trim();
  return text ? text : null;
}

/** extmetadata GPS values are decimal-degree strings. */
function coordinate(value: string | undefined, max: number): number | null {
  const degrees = Number(plainText(value));
  return Number.isFinite(degrees) && degrees !== 0 && Math.abs(degrees) <= max ? degrees : null;
}

export function parseCommonsResponse(response: CommonsResponse): SourceItem[] {
  const items: SourceItem[] = [];
  for (const page of response.query?.pages ?? []) {
    const info = page.imageinfo?.[0];
    if (!info?.thumburl) continue;
    const format = urlExtension(info.url);
    const modifiedMs = Date.parse(info.timestamp);
    const dateTime = plainText(info.extmetadata?.["DateTimeOriginal"]?.value);
    const gpsLat = coordinate(info.extmetadata?.["GPSLatitude"]?.value, 90);
    const gpsLon = coordinate(info.extmetadata?.["GPSLongitude"]?.value, 180);
    items.push({
      entry: {
        path: info.url,
        name: page.title.replace(/^File:/, ""),
        size: info.size,
        modifiedMs,
        formatHint: format,
      },
      thumbUrl: info.thumburl,
      meta: {
        width: info.width,
        height: info.height,
        format,
        fileSize: info.size,
        modifiedMs,
        exif:
          dateTime !== null || gpsLat !== null
            ? { orientation: 1, dateTime, camera: null, gpsLat, gpsLon }
            : null,
      },
    });
  }
  return items;
}

export const commonsSource: ImageSource = {
  id: "commons",
  title: "Open Wikimedia Commons…",
  placeholder: "search, or Category:…",
  label: (arg) => arg.trim(),
  fetch: async (arg) => {
    if (!arg.trim()) throw new Error("no search given");
    const response = await fetch(commonsRequestUrl(arg), {
      headers: { "User-Agent": "imgvwr (image viewer)" },
    });
    if (!response.ok) throw new Error(`commons: HTTP ${response.status}`);
    return parseCommonsResponse((await response.json()) as CommonsResponse);
  },
};
