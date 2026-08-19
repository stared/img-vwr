import { describe, expect, it } from "vitest";

import { zoomLabel } from "../viewer/viewport";

describe("zoomLabel", () => {
  it("names the two magnifications a photographer asks for", () => {
    // "fit" is a name, not a number.
    expect(zoomLabel({ scale: 0.14 }, true)).toBe("fit");
    expect(zoomLabel({ scale: 1 }, false)).toBe("100%");
  });

  it("reports anything else you pinched your way to", () => {
    expect(zoomLabel({ scale: 0.43 }, false)).toBe("43%");
    expect(zoomLabel({ scale: 2.5 }, false)).toBe("250%");
  });

  it("says fit before an image has loaded", () => {
    expect(zoomLabel(null, true)).toBe("fit");
    expect(zoomLabel(null, false)).toBe("fit");
  });
});
