import { fetch } from "@tauri-apps/plugin-http";

import type { ImageSource, SourceItem } from "../registry/sources";
import { sourceScope } from "../registry/sources";
import { urlExtension } from "./shared";

/**
 * Reddit blocks its unauthenticated JSON API for non-browser clients
 * (HTTP 403), but the Atom feed stays open — and carries everything we
 * need: title, publish time, a 640px thumbnail, and the i.redd.it link.
 */
const LIMIT = 100;

/** Reddit rejects unknown user agents; we are a WebKit shell, say so. */
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) imgvwr";

/** Accepts "EarthPorn", "r/EarthPorn", "/r/EarthPorn/", … */
export function subredditOf(arg: string): string {
  return arg
    .trim()
    .replace(/^\/?(r\/)?/i, "")
    .replace(/\/+$/, "");
}

function unescapeXml(text: string): string {
  return text
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCharCode(Number(code)))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&");
}

/** Image subreddits conventionally put dimensions in the title: "… (7542 x 4867)". */
function dimsFromTitle(title: string): { width: number; height: number } | null {
  const match = /(\d{3,5})\s*[x×]\s*(\d{3,5})/i.exec(title);
  if (!match) return null;
  return { width: Number(match[1]), height: Number(match[2]) };
}

/** Direct-image posts link to i.redd.it; galleries and text posts don't, and are skipped. */
const IMAGE_LINK = /https:\/\/i\.redd\.it\/[A-Za-z0-9]+\.(?:jpe?g|png|gif|webp)/;

export function parseRedditFeed(xml: string): SourceItem[] {
  const items: SourceItem[] = [];
  for (const entry of xml.split("<entry>").slice(1)) {
    const url = IMAGE_LINK.exec(entry)?.[0];
    const title = /<title>([^<]*)<\/title>/.exec(entry)?.[1];
    const published = /<published>([^<]+)<\/published>/.exec(entry)?.[1];
    const thumb = /<media:thumbnail url="([^"]+)"/.exec(entry)?.[1];
    if (!url || !title || !published) continue;
    const name = unescapeXml(title);
    const modifiedMs = Date.parse(published);
    const format = urlExtension(url);
    const dims = dimsFromTitle(name);
    items.push({
      entry: {
        path: url,
        name,
        size: 0, // the feed does not report file sizes
        modifiedMs,
        formatHint: format,
      },
      thumbUrl: thumb ? unescapeXml(thumb) : url,
      meta: {
        width: dims?.width ?? null,
        height: dims?.height ?? null,
        format,
        fileSize: 0,
        modifiedMs,
        exif: null,
      },
    });
  }
  return items;
}

export const redditSource: ImageSource = {
  id: "reddit",
  title: "Open Reddit Subreddit…",
  sidebarTitle: "Reddit",
  glyph: "r/",
  placeholder: "subreddit, e.g. EarthPorn",
  label: (arg) => `r/${subredditOf(arg)}`,
  // The feed is /hot — its order IS the front-page rank, worth sorting by.
  sorts: [
    {
      id: "reddit.hot",
      label: "hot",
      hints: { asc: "front page", desc: "reversed" },
      defaultDir: "asc",
      appliesTo: sourceScope("reddit"),
      reads: "entry",
      missing: "last",
      param: null,
      value: (_entry, ctx) => ctx.sourceIndex,
    },
  ],
  defaultSort: { key: "reddit.hot", dir: "asc" },
  filters: [],
  fetch: async (arg) => {
    const sub = subredditOf(arg);
    if (!sub) throw new Error("no subreddit given");
    const response = await fetch(
      `https://www.reddit.com/r/${encodeURIComponent(sub)}/hot/.rss?limit=${LIMIT}`,
      { headers: { "User-Agent": USER_AGENT } },
    );
    if (!response.ok) throw new Error(`r/${sub}: HTTP ${response.status}`);
    return parseRedditFeed(await response.text());
  },
};
