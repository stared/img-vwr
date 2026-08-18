import { SelectMenuItems } from "../components/shell/filterMenus";
import type { FileEntry } from "../ipc";
import { labelsForPaths, labelsSetStars, labelsToggleTag } from "../ipc";
import { registerCommand, type CommandContext } from "../registry/commands";
import { registerFilterField } from "../registry/filters";
import { registerSort } from "../registry/sorts";
import { numberRangeSpec } from "../state/query";
import { chosenEntries, filesBehind, useAppStore } from "../state/store";

/**
 * Labels module — the first WRITE path: user-assigned stars and tags,
 * persisted app-locally in Rust (never touching the image files). Both
 * label kinds enter the query language purely by registering fields and a
 * sort; nothing here is special-cased in the engine.
 *
 * Keys (Lightroom-style): 1–5 rate, 0 clears, t tags — on the selected
 * grid cell and in the viewer.
 */

/**
 * What the keys act on: every selected photograph, in the query-applied view,
 * down to the files behind it — a stacked raw+JPEG pair is one photograph,
 * and its rating belongs to both files, not to whichever one the stack
 * happened to be showing.
 *
 * A label is exactly the kind of thing there is no reason to apply one at a
 * time — picking out the ten frames worth keeping and pressing 3 once is the
 * point of being able to select ten frames.
 */
function labelTargets(): { photographs: FileEntry[]; files: FileEntry[] } {
  const s = useAppStore.getState();
  const photographs = chosenEntries(s);
  return { photographs, files: filesBehind(s, photographs) };
}

async function rateSelected(stars: number | null): Promise<void> {
  const { photographs, files } = labelTargets();
  if (photographs.length === 0) return;
  const { labelsApplied } = useAppStore.getState();
  labelsApplied(await labelsSetStars(files.map((e) => e.path), stars));
}

async function tagSelected(tag: string): Promise<void> {
  const { photographs, files } = labelTargets();
  if (photographs.length === 0) return;
  const labels = await labelsToggleTag(files.map((e) => e.path), tag);
  useAppStore.getState().labelsApplied(labels);
}

/**
 * Ratings are six values, so every question worth asking fits in one menu —
 * a click is the whole filter, not an operator and then a typed number.
 */
const STAR_ROWS: { label: string; from: number; to: number }[] = [
  { label: "★ and up", from: 1, to: Infinity },
  { label: "★★ and up", from: 2, to: Infinity },
  { label: "★★★ and up", from: 3, to: Infinity },
  { label: "★★★★ and up", from: 4, to: Infinity },
  { label: "★★★★★", from: 5, to: Infinity },
  { label: "unrated", from: 0, to: 1 },
];

function StarsMenuItems({ close }: { close: () => void }) {
  const query = useAppStore((s) => s.query);
  const setRangeFilter = useAppStore((s) => s.setRangeFilter);
  const active = query.filters.find((f) => f.kind === "range" && f.field === "stars");
  return (
    <>
      {STAR_ROWS.map((row) => (
        <button
          key={row.label}
          onClick={() => {
            setRangeFilter("stars", row.from, row.to, row.label);
            close();
          }}
        >
          {row.label}
          <span className="menu-check">
            {active?.kind === "range" && active.from === row.from && active.to === row.to
              ? "✓"
              : ""}
          </span>
        </button>
      ))}
    </>
  );
}

/** Tags present in the current collection, most used first. */
function TagMenuItems({ close }: { close: () => void }) {
  const entries = useAppStore((s) => s.entries);
  const labels = useAppStore((s) => s.labels);
  const counts = new Map<string, number>();
  for (const entry of entries) {
    for (const tag of labels[entry.path]?.tags ?? []) {
      counts.set(tag, (counts.get(tag) ?? 0) + 1);
    }
  }
  const buckets = [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([tag]) => ({ label: tag, value: tag }));
  return (
    <SelectMenuItems field="tag" buckets={buckets} empty="nothing tagged (yet)" close={close} />
  );
}

const STAR_KEYWORDS = ["stars", "rating", "rate", "label", "cull"];

export function registerLabels(): void {
  registerFilterField({
    kind: "range",
    id: "stars",
    label: "stars",
    appliesTo: () => true,
    reads: "labels",
    Menu: StarsMenuItems,
    // Unrated is zero stars: "unrated" is the range [0, 1) and "★ and up"
    // genuinely means rated at all.
    spec: numberRangeSpec((_entry, { labels }) => labels.stars ?? 0, {
      unit: "★",
      scale: 1,
      integer: true,
      ops: [">="],
    }),
  });

  registerFilterField({
    kind: "flags",
    id: "tag",
    label: "tag",
    appliesTo: () => true,
    reads: "labels",
    Menu: TagMenuItems,
    values: (_entry, { labels }) => labels.tags,
  });

  registerSort({
    id: "stars",
    label: "stars",
    hints: { asc: "lowest rated", desc: "highest rated" },
    defaultDir: "desc",
    appliesTo: () => true,
    reads: "labels",
    // Unrated images stay visible, after the rated ones.
    missing: "last",
    param: null,
    value: (_entry, ctx) => ctx.labels.stars,
  });

  // Something to label. Offering "Rate ★★★" with nothing picked put a row in
  // the palette that quietly did nothing when chosen.
  const hasSelection = (ctx: CommandContext) => ctx.store.getState().selection.length > 0;

  for (let n = 0; n <= 5; n += 1) {
    registerCommand({
      id: `labels.stars.${n}`,
      title: n === 0 ? "Clear Rating" : `Rate ${"★".repeat(n)}`,
      keywords: STAR_KEYWORDS,
      // In the menu the rating is one submenu: Rating › nothing, ★, ★★ …
      menus: [{ menu: "image", section: "labels", submenu: "Rating", label: n === 0 ? "nothing" : "★".repeat(n) }],
      when: hasSelection,
      run: () => rateSelected(n === 0 ? null : n),
    });
  }

  registerCommand({
    id: "labels.tag",
    title: "Tag Image…",
    keywords: ["label", "keyword", "add tag", "remove tag"],
    input: { placeholder: "add or remove a tag, e.g. family" },
    menus: [{ menu: "image", section: "labels", submenu: null, label: "Tag Image…" }],
    when: hasSelection,
    run: async (_ctx, arg) => {
      const tag = arg?.trim();
      if (tag) await tagSelected(tag);
    },
  });

  // Load stored labels as a scope's entries land, asking only about files
  // never asked about before; labelsLoaded merges the answers (epoch-guarded).
  //
  // Tracked by path rather than by a count of how far down the list we got.
  // A streamed scan only appends, so a cursor sufficed — but a watched folder
  // can also lose a file, and then every index after it means a different
  // photograph and the tail is silently never fetched.
  let lastEntries: FileEntry[] | null = null;
  let lastEpoch = -1;
  let asked = new Set<string>();
  useAppStore.subscribe((state) => {
    if (state.entries === lastEntries) return;
    lastEntries = state.entries;
    if (state.epoch !== lastEpoch) {
      lastEpoch = state.epoch;
      asked = new Set();
    }
    const fresh = state.entries.filter((e) => !asked.has(e.path));
    if (fresh.length === 0) return;
    for (const entry of fresh) asked.add(entry.path);
    const epoch = state.epoch;
    void labelsForPaths(fresh.map((e) => e.path)).then((labels) => {
      useAppStore.getState().labelsLoaded(labels, epoch);
    });
  });
}
