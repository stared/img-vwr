import { describe, expect, it } from "vitest";

import {
  DAY_MS,
  PACK_STEP,
  packSpan,
  fitWindow,
  HOUR_MS,
  MIN_MS_PER_PX,
  MINUTE_MS,
  packLanes,
  pannedWindow,
  timeTicks,
  zoomedWindow,
} from "./timeline";

describe("packLanes", () => {
  it("spread-out items all share lane 0", () => {
    const { lanes, laneCount } = packLanes([0, 100, 200, 300], 50);
    expect(lanes).toEqual([0, 0, 0, 0]);
    expect(laneCount).toBe(1);
  });

  it("overlapping items move one lane further, never overlapping", () => {
    // Three photos within one span: each next one is pushed outward.
    const { lanes, laneCount } = packLanes([0, 10, 20], 50);
    expect(lanes).toEqual([0, 1, 2]);
    expect(laneCount).toBe(3);
  });

  it("reuses the lowest freed lane", () => {
    // 0 and 10 overlap (lanes 0, 1); 60 clears both and takes lane 0 back.
    const { lanes, laneCount } = packLanes([0, 10, 60], 50);
    expect(lanes).toEqual([0, 1, 0]);
    expect(laneCount).toBe(2);
  });

  it("no two items in a lane are closer than the span", () => {
    const ts = Array.from({ length: 500 }, (_, i) => Math.floor(i * 7.3) % 400).sort(
      (a, b) => a - b,
    );
    const span = 25;
    const { lanes } = packLanes(ts, span);
    const lastInLane = new Map<number, number>();
    ts.forEach((t, i) => {
      const lane = lanes[i] ?? -1;
      const prev = lastInLane.get(lane);
      if (prev !== undefined) expect(t - prev).toBeGreaterThanOrEqual(span);
      lastInLane.set(lane, t);
    });
  });
});

describe("packSpan", () => {
  it("never returns less than the true span (no overlap, ever)", () => {
    for (let x = 1; x < 1e12; x *= 3.7) {
      expect(packSpan(x)).toBeGreaterThanOrEqual(x);
    }
  });

  it("stays within one grid step of the true span", () => {
    for (let x = 1; x < 1e12; x *= 3.7) {
      expect(packSpan(x)).toBeLessThanOrEqual(x * PACK_STEP * 1.0001);
    }
  });

  it("is constant between grid steps, so zooming re-packs only at crossings", () => {
    const base = packSpan(1000);
    // Nudging the span slightly must not change the snapped value.
    expect(packSpan(base * 0.99)).toBe(base);
    expect(packSpan(base)).toBe(base);
    const distinct = new Set<number>();
    for (let f = 1; f <= 10; f *= 1.02) distinct.add(packSpan(1000 * f));
    // A 10x zoom sweep at 2% steps (~116 events) crosses only ~11 grid steps.
    expect(distinct.size).toBeLessThanOrEqual(12);
  });
});

describe("time window", () => {
  it("fit covers the whole range with padding", () => {
    const win = fitWindow(0, 10 * DAY_MS, 1000);
    expect(win.t0).toBeLessThan(0);
    expect(win.t0 + 1000 * win.msPerPx).toBeGreaterThan(10 * DAY_MS);
  });

  it("a one-burst folder still spans at least an hour", () => {
    const win = fitWindow(5000, 5000, 1000);
    expect(1000 * win.msPerPx).toBeGreaterThanOrEqual(HOUR_MS);
  });

  it("zoom keeps the time under the anchor fixed", () => {
    const fit = fitWindow(0, DAY_MS, 1000);
    const anchorPx = 400;
    const before = fit.t0 + anchorPx * fit.msPerPx;
    const zoomed = zoomedWindow(fit, 0.5, anchorPx, 0, DAY_MS, 1000);
    const after = zoomed.t0 + anchorPx * zoomed.msPerPx;
    expect(after).toBeCloseTo(before, 6);
    expect(zoomed.msPerPx).toBeCloseTo(fit.msPerPx / 2, 6);
  });

  it("zoom clamps at the deepest level and cannot leave the fit range", () => {
    const fit = fitWindow(0, DAY_MS, 1000);
    expect(zoomedWindow(fit, 1e-12, 0, 0, DAY_MS, 1000).msPerPx).toBe(MIN_MS_PER_PX);
    // Zooming out stops AT fit: the range plus its margin, nothing beyond.
    const out = zoomedWindow(fit, 1e12, 0, 0, DAY_MS, 1000);
    expect(out.msPerPx).toBeCloseTo(fit.msPerPx, 6);
    expect(out.t0).toBeCloseTo(fit.t0, 6);
  });

  it("pan is capped to the data range plus the margin", () => {
    const margin = DAY_MS * 0.05;
    const win = zoomedWindow(fitWindow(0, DAY_MS, 1000), 0.1, 500, 0, DAY_MS, 1000);
    const viewSpan = 1000 * win.msPerPx;
    const far = pannedWindow(win, 1e9, 0, DAY_MS, 1000);
    expect(far.t0 + viewSpan).toBeCloseTo(DAY_MS + margin, 3);
    const back = pannedWindow(win, -1e9, 0, DAY_MS, 1000);
    expect(back.t0).toBeCloseTo(-margin, 3);
  });
});

describe("timeTicks", () => {
  const at = (y: number, mo = 0, d = 1, h = 0, mi = 0) => new Date(y, mo, d, h, mi).getTime();

  it("year-scale windows tick on January 1st with year labels", () => {
    const msPerPx = (8 * 365 * DAY_MS) / 1000; // eight years across 1000px
    const ticks = timeTicks(at(2019, 5), at(2023, 5), msPerPx);
    expect(ticks.map((t) => t.label)).toEqual(["2020", "2021", "2022", "2023"]);
    for (const tick of ticks) {
      const d = new Date(tick.t);
      expect([d.getMonth(), d.getDate(), d.getHours()]).toEqual([0, 1, 0]);
    }
  });

  it("month ticks land on true month boundaries", () => {
    const msPerPx = (180 * DAY_MS) / 1000; // half a year across 1000px
    const ticks = timeTicks(at(2021, 0, 15), at(2021, 6, 15), msPerPx);
    expect(ticks.map((t) => t.label)).toEqual([
      "2021-02",
      "2021-03",
      "2021-04",
      "2021-05",
      "2021-06",
      "2021-07",
    ]);
  });

  it("hour ticks label midnight as the date", () => {
    const msPerPx = DAY_MS / 1000; // a day across 1000px → 3h ticks
    const ticks = timeTicks(at(2021, 3, 5, 20), at(2021, 3, 6, 7), msPerPx);
    const labels = ticks.map((t) => t.label);
    expect(labels).toContain("2021-04-06"); // midnight
    expect(labels).toContain("21:00");
  });

  it("keeps at least the minimum pixel gap between ticks", () => {
    const msPerPx = MINUTE_MS / 10;
    const ticks = timeTicks(at(2021, 0, 1, 10), at(2021, 0, 1, 12), msPerPx, 90);
    for (let i = 1; i < ticks.length; i += 1) {
      const gapPx = ((ticks[i]?.t ?? 0) - (ticks[i - 1]?.t ?? 0)) / msPerPx;
      expect(gapPx).toBeGreaterThanOrEqual(90);
    }
    expect(ticks.length).toBeGreaterThan(0);
  });

  it("an empty or inverted window has no ticks", () => {
    expect(timeTicks(1000, 1000, 1)).toEqual([]);
    expect(timeTicks(2000, 1000, 1)).toEqual([]);
  });
});
