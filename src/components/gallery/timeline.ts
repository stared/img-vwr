/* All time is UNIX ms, all lengths px. The view is a window over time, not a scrolled canvas: at deep zoom a year is millions of pixels, past what a DOM element can be. */

export interface TimeWindow {
  /** Time at the viewport's main-axis start. */
  t0: number;
  msPerPx: number;
}

export const MINUTE_MS = 60_000;
export const HOUR_MS = 60 * MINUTE_MS;
export const DAY_MS = 24 * HOUR_MS;
const YEAR_MS = Math.round(365.25 * DAY_MS);

export const MIN_MS_PER_PX = MINUTE_MS / 240;

const MIN_SPAN_MS = HOUR_MS;

const RANGE_MARGIN = 0.05;

function rangeBounds(tMin: number, tMax: number): { lo: number; hi: number } {
  const span = Math.max(tMax - tMin, MIN_SPAN_MS);
  return { lo: tMin - span * RANGE_MARGIN, hi: tMin + span * (1 + RANGE_MARGIN) };
}

function clampWindow(win: TimeWindow, tMin: number, tMax: number, viewPx: number): TimeWindow {
  const { lo, hi } = rangeBounds(tMin, tMax);
  const viewSpan = Math.max(viewPx, 1) * win.msPerPx;
  const t0 =
    viewSpan >= hi - lo
      ? lo - (viewSpan - (hi - lo)) / 2
      : Math.min(Math.max(win.t0, lo), hi - viewSpan);
  return { t0, msPerPx: win.msPerPx };
}

export function fitWindow(tMin: number, tMax: number, viewPx: number): TimeWindow {
  const { lo, hi } = rangeBounds(tMin, tMax);
  return { t0: lo, msPerPx: (hi - lo) / Math.max(viewPx, 1) };
}

/** Zoom by `factor` keeping the time under `anchorPx` fixed; clamped between fit and MIN_MS_PER_PX. */
export function zoomedWindow(
  win: TimeWindow,
  factor: number,
  anchorPx: number,
  tMin: number,
  tMax: number,
  viewPx: number,
): TimeWindow {
  const fit = fitWindow(tMin, tMax, viewPx);
  const msPerPx = Math.min(Math.max(win.msPerPx * factor, MIN_MS_PER_PX), fit.msPerPx);
  const anchorT = win.t0 + anchorPx * win.msPerPx;
  return clampWindow({ t0: anchorT - anchorPx * msPerPx, msPerPx }, tMin, tMax, viewPx);
}

export function pannedWindow(
  win: TimeWindow,
  deltaPx: number,
  tMin: number,
  tMax: number,
  viewPx: number,
): TimeWindow {
  return clampWindow(
    { t0: win.t0 + deltaPx * win.msPerPx, msPerPx: win.msPerPx },
    tMin,
    tMax,
    viewPx,
  );
}

export const PACK_STEP = 1.25;

/** Snaps UP onto a log grid: lanes re-pack only at grid steps, and snapping up keeps items non-overlapping. */
export function packSpan(spanMs: number): number {
  let out = PACK_STEP ** Math.ceil(Math.log(spanMs) / Math.log(PACK_STEP));
  while (out < spanMs) out *= PACK_STEP; // float-edge guard
  return out;
}

/** Non-overlapping lanes for time-sorted items, each occupying `spanMs`; collisions take the lowest free lane. */
export function packLanes(ts: number[], spanMs: number): { lanes: number[]; laneCount: number } {
  const lanes = new Array<number>(ts.length);
  const busy = new MinHeap<{ end: number; lane: number }>((a, b) => a.end - b.end);
  const free = new MinHeap<number>((a, b) => a - b);
  let laneCount = 0;
  for (let i = 0; i < ts.length; i += 1) {
    const t = ts[i] ?? 0;
    for (let top = busy.peek(); top !== undefined && top.end <= t; top = busy.peek()) {
      busy.pop();
      free.push(top.lane);
    }
    let lane = free.pop();
    if (lane === undefined) {
      lane = laneCount;
      laneCount += 1;
    }
    lanes[i] = lane;
    busy.push({ end: t + spanMs, lane });
  }
  return { lanes, laneCount };
}

class MinHeap<T> {
  private items: T[] = [];
  constructor(private readonly cmp: (a: T, b: T) => number) {}

  peek(): T | undefined {
    return this.items[0];
  }

  push(item: T): void {
    const a = this.items;
    a.push(item);
    for (let i = a.length - 1; i > 0; ) {
      const parent = (i - 1) >> 1;
      const [child, up] = [a[i] as T, a[parent] as T];
      if (this.cmp(child, up) >= 0) break;
      a[i] = up;
      a[parent] = child;
      i = parent;
    }
  }

  pop(): T | undefined {
    const a = this.items;
    const top = a[0];
    const last = a.pop();
    if (a.length > 0 && last !== undefined) {
      a[0] = last;
      for (let i = 0; ; ) {
        const [l, r] = [2 * i + 1, 2 * i + 2];
        let min = i;
        if (l < a.length && this.cmp(a[l] as T, a[min] as T) < 0) min = l;
        if (r < a.length && this.cmp(a[r] as T, a[min] as T) < 0) min = r;
        if (min === i) break;
        const [x, y] = [a[i] as T, a[min] as T];
        a[i] = y;
        a[min] = x;
        i = min;
      }
    }
    return top;
  }
}

interface Tick {
  t: number;
  label: string;
}

const TICK_STEPS: { unit: "minute" | "hour" | "day" | "month" | "year"; count: number }[] = [
  { unit: "minute", count: 1 },
  { unit: "minute", count: 5 },
  { unit: "minute", count: 15 },
  { unit: "minute", count: 30 },
  { unit: "hour", count: 1 },
  { unit: "hour", count: 3 },
  { unit: "hour", count: 6 },
  { unit: "hour", count: 12 },
  { unit: "day", count: 1 },
  { unit: "day", count: 7 },
  { unit: "month", count: 1 },
  { unit: "month", count: 3 },
  { unit: "month", count: 6 },
  { unit: "year", count: 1 },
  { unit: "year", count: 2 },
  { unit: "year", count: 5 },
  { unit: "year", count: 10 },
  { unit: "year", count: 20 },
  { unit: "year", count: 50 },
  { unit: "year", count: 100 },
];

const APPROX_MS = { minute: MINUTE_MS, hour: HOUR_MS, day: DAY_MS, month: YEAR_MS / 12, year: YEAR_MS };

const pad2 = (n: number) => String(n).padStart(2, "0");

function tickLabel(date: Date, unit: (typeof TICK_STEPS)[number]["unit"]): string {
  const ymd = `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
  switch (unit) {
    case "year":
      return String(date.getFullYear());
    case "month":
      return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}`;
    case "day":
      return ymd;
    case "hour":
    case "minute":
      // Midnight reads as the date — otherwise hours float context-free.
      return date.getHours() === 0 && date.getMinutes() === 0
        ? ymd
        : `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
  }
}

/** Guard against a degenerate window producing an absurd tick list. */
const MAX_TICKS = 500;

/** Calendar-aligned ticks for [tA, tB] at least `minGapPx` apart; month/year ticks land on true calendar boundaries. */
export function timeTicks(tA: number, tB: number, msPerPx: number, minGapPx = 90): Tick[] {
  if (!(tB > tA)) return [];
  const step =
    TICK_STEPS.find(({ unit, count }) => (APPROX_MS[unit] * count) / msPerPx >= minGapPx) ??
    TICK_STEPS[TICK_STEPS.length - 1];
  if (!step) return [];

  const d = new Date(tA);
  d.setMilliseconds(0);
  d.setSeconds(0);
  switch (step.unit) {
    case "minute":
      d.setMinutes(Math.floor(d.getMinutes() / step.count) * step.count);
      break;
    case "hour":
      d.setMinutes(0);
      d.setHours(Math.floor(d.getHours() / step.count) * step.count);
      break;
    case "day":
      d.setHours(0, 0, 0, 0);
      break;
    case "month":
      d.setHours(0, 0, 0, 0);
      d.setDate(1);
      d.setMonth(Math.floor(d.getMonth() / step.count) * step.count);
      break;
    case "year":
      d.setHours(0, 0, 0, 0);
      d.setMonth(0, 1);
      d.setFullYear(Math.floor(d.getFullYear() / step.count) * step.count);
      break;
  }

  const ticks: Tick[] = [];
  while (d.getTime() <= tB && ticks.length < MAX_TICKS) {
    if (d.getTime() >= tA) {
      ticks.push({ t: d.getTime(), label: tickLabel(d, step.unit) });
    }
    switch (step.unit) {
      case "minute":
        d.setMinutes(d.getMinutes() + step.count);
        break;
      case "hour":
        d.setHours(d.getHours() + step.count);
        break;
      case "day":
        d.setDate(d.getDate() + step.count);
        break;
      case "month":
        d.setMonth(d.getMonth() + step.count);
        break;
      case "year":
        d.setFullYear(d.getFullYear() + step.count);
        break;
    }
  }
  return ticks;
}
