import { describe, expect, it } from "vitest";

import { commonsRequestUrl, parseCommonsResponse, type CommonsResponse } from "./commons";
import { parseRedditFeed, subredditOf } from "./reddit";
import { urlExtension } from "./shared";

describe("urlExtension", () => {
  it("lowercases and ignores query and fragment", () => {
    expect(urlExtension("https://i.redd.it/abc.JPG?width=100#x")).toBe("jpg");
    expect(urlExtension("https://example.com/no-extension")).toBe("");
  });
});

describe("subredditOf", () => {
  it("accepts bare, r/-prefixed, and slashed forms", () => {
    expect(subredditOf("EarthPorn")).toBe("EarthPorn");
    expect(subredditOf("r/EarthPorn")).toBe("EarthPorn");
    expect(subredditOf("/r/EarthPorn/")).toBe("EarthPorn");
  });
});

describe("parseRedditFeed", () => {
  const entry = (title: string, content: string) => `<entry>
    <content type="html">${content}</content>
    <media:thumbnail url="https://preview.redd.it/abc123.jpeg?width=640&amp;crop=smart" />
    <published>2026-07-08T01:50:36+00:00</published>
    <title>${title}</title>
  </entry>`;
  const imageContent =
    "&lt;a href=&quot;https://i.redd.it/abc123.jpeg&quot;&gt;[link]&lt;/a&gt;";

  it("maps direct-image entries, with dimensions read from the title", () => {
    const xml = `<feed>${entry("Tetons at dawn [OC] (7542 x 4867)", imageContent)}</feed>`;
    const [item] = parseRedditFeed(xml);
    expect(item?.entry).toEqual({
      path: "https://i.redd.it/abc123.jpeg",
      name: "Tetons at dawn [OC] (7542 x 4867)",
      size: 0,
      modifiedMs: Date.parse("2026-07-08T01:50:36+00:00"),
      formatHint: "jpeg",
    });
    // The escaped &amp; in the thumbnail URL is restored.
    expect(item?.thumbUrl).toBe("https://preview.redd.it/abc123.jpeg?width=640&crop=smart");
    expect(item?.meta).toMatchObject({ width: 7542, height: 4867, format: "jpeg" });
  });

  it("leaves dimensions null when the title has none, unescapes entities", () => {
    const xml = `<feed>${entry("Sunset &amp; storm", imageContent)}</feed>`;
    const [item] = parseRedditFeed(xml);
    expect(item?.entry.name).toBe("Sunset & storm");
    expect(item?.meta.width).toBeNull();
  });

  it("skips entries without a direct i.redd.it image (galleries, text posts)", () => {
    const xml = `<feed>${entry("Discussion thread", "no image links here")}</feed>`;
    expect(parseRedditFeed(xml)).toEqual([]);
  });
});

describe("commonsRequestUrl", () => {
  it("searches bitmap files by default", () => {
    const url = new URL(commonsRequestUrl("aurora borealis"));
    expect(url.searchParams.get("generator")).toBe("search");
    expect(url.searchParams.get("gsrsearch")).toBe("filetype:bitmap aurora borealis");
  });

  it("lists files of a Category: argument", () => {
    const url = new URL(commonsRequestUrl("Category:Cats in art"));
    expect(url.searchParams.get("generator")).toBe("categorymembers");
    expect(url.searchParams.get("gcmtitle")).toBe("Category:Cats in art");
  });
});

describe("parseCommonsResponse", () => {
  const response: CommonsResponse = {
    query: {
      pages: [
        {
          title: "File:Aurora.jpg",
          imageinfo: [
            {
              url: "https://upload.wikimedia.org/x/Aurora.jpg",
              thumburl: "https://upload.wikimedia.org/x/640px-Aurora.jpg",
              width: 5000,
              height: 3000,
              size: 2_400_000,
              timestamp: "2021-03-04T10:20:30Z",
              extmetadata: { DateTimeOriginal: { value: "2021-03-03 22:11:05" } },
            },
          ],
        },
        { title: "File:NoInfo.jpg" }, // no imageinfo → skipped
      ],
    },
  };

  it("maps pages to entries, stripping the File: prefix", () => {
    const items = parseCommonsResponse(response);
    expect(items).toHaveLength(1);
    expect(items[0]?.entry).toMatchObject({
      path: "https://upload.wikimedia.org/x/Aurora.jpg",
      name: "Aurora.jpg",
      size: 2_400_000,
      formatHint: "jpg",
    });
    expect(items[0]?.entry.modifiedMs).toBe(Date.parse("2021-03-04T10:20:30Z"));
    expect(items[0]?.thumbUrl).toContain("640px");
    expect(items[0]?.meta.exif?.dateTime).toBe("2021-03-03 22:11:05");
  });

  it("survives an empty response", () => {
    expect(parseCommonsResponse({})).toEqual([]);
  });
});
