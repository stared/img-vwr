import { SelectMenuItems } from "../../components/shell/filterMenus";
import type { FileEntry } from "../../ipc";
import { labelsForPaths, labelsSetStars, labelsToggleTag } from "../../ipc";
import { registerBadge } from "../../registry/badges";
import { registerCommand, type CommandContext } from "../../registry/commands";
import { getFilterField, registerFilterField } from "../../registry/filters";
import { registerKeybindings } from "../../registry/keybindings";
import { registerPanel } from "../../registry/panels";
import { registerSort } from "../../registry/sorts";
import { numberRangeSpec } from "../../state/query";
import { chosenEntries, filesBehind, useAppStore } from "../../state/store";
import "./labels.css";
import { LabelsPanel } from "./LabelsPanel";
import { LABELS, useLabelsStore } from "./store";
import { LabelsBadge, TagDot } from "./TagDot";

/** A stacked raw+JPEG pair is one photograph; its labels go to both files. */
function labelTargets(): { photographs: FileEntry[]; files: FileEntry[] } {
  const s = useAppStore.getState();
  const photographs = chosenEntries(s);
  return { photographs, files: filesBehind(s, photographs) };
}

async function rateSelected(stars: number | null): Promise<void> {
  const { photographs, files } = labelTargets();
  if (photographs.length === 0) return;
  useLabelsStore.getState().applied(await labelsSetStars(files.map((e) => e.path), stars));
}

async function tagSelected(tag: string): Promise<void> {
  const { photographs, files } = labelTargets();
  if (photographs.length === 0) return;
  const labels = await labelsToggleTag(files.map((e) => e.path), tag);
  useLabelsStore.getState().applied(labels);
}

const STARS = ["★", "★★", "★★★", "★★★★", "★★★★★"];
const UNRATED = "unrated";

/** Picks a value; the operator stays as the chip has it (≥ for a new chip). */
function StarsMenuItems({ close }: { close: () => void }) {
  const query = useAppStore((s) => s.query);
  const setRangeFilter = useAppStore((s) => s.setRangeFilter);
  const field = getFilterField("stars");
  if (field?.kind !== "range") return null;
  const { spec } = field;
  const active = query.filters.find((f) => f.kind === "range" && f.field === "stars");
  const unrated = active?.kind === "range" && active.label === UNRATED;
  const current = active?.kind === "range" && !unrated ? spec.initial(active) : null;
  const pick = (from: number, to: number, label: string) => {
    setRangeFilter("stars", from, to, label);
    close();
  };
  return (
    <>
      {STARS.map((label, i) => {
        const n = i + 1;
        return (
          <button
            key={label}
            onClick={() => {
              const b = spec.parse(current?.op ?? ">=", String(n));
              if (b !== null) pick(b.from, b.to, label);
            }}
          >
            {label}
            <span className="menu-check">{current?.value === String(n) ? "✓" : ""}</span>
          </button>
        );
      })}
      <button onClick={() => pick(0, 1, UNRATED)}>
        {UNRATED}
        <span className="menu-check">{unrated ? "✓" : ""}</span>
      </button>
    </>
  );
}

function TagMenuItems({ close }: { close: () => void }) {
  const entries = useAppStore((s) => s.entries);
  const labels = useLabelsStore((s) => s.labels);
  const counts = new Map<string, number>();
  for (const entry of entries) {
    for (const tag of labels[entry.path]?.tags ?? []) {
      counts.set(tag, (counts.get(tag) ?? 0) + 1);
    }
  }
  const buckets = [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([tag]) => ({
      label: (
        <span className="menu-tag">
          <TagDot tag={tag} fill="all" />
          {tag}
        </span>
      ),
      value: tag,
    }));
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
    reads: [LABELS],
    Menu: StarsMenuItems,
    // Unrated maps to 0 stars, the menu's [0, 1) "unrated" row.
    spec: numberRangeSpec((_entry, data) => data.get(LABELS).stars ?? 0, {
      unit: "★",
      scale: 1,
      integer: true,
      ops: [">=", "=", "<="],
    }),
  });

  registerFilterField({
    kind: "flags",
    id: "tag",
    label: "tag",
    appliesTo: () => true,
    reads: [LABELS],
    Menu: TagMenuItems,
    values: (_entry, data) => data.get(LABELS).tags,
  });

  registerSort({
    id: "stars",
    label: "stars",
    hints: { asc: "lowest rated", desc: "highest rated" },
    defaultDir: "desc",
    appliesTo: () => true,
    reads: [LABELS],
    missing: "last",
    param: null,
    value: (_entry, data) => data.get(LABELS).stars,
  });

  const hasSelection = (ctx: CommandContext) => ctx.store.getState().selection.length > 0;

  for (let n = 0; n <= 5; n += 1) {
    registerCommand({
      id: `labels.stars.${n}`,
      title: n === 0 ? "Clear Rating" : `Rate ${"★".repeat(n)}`,
      input: null,
      keywords: STAR_KEYWORDS,
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

  registerKeybindings([
    ["0", "labels.stars.0"],
    ["1", "labels.stars.1"],
    ["2", "labels.stars.2"],
    ["3", "labels.stars.3"],
    ["4", "labels.stars.4"],
    ["5", "labels.stars.5"],
    ["t", "labels.tag"],
  ]);

  registerPanel({
    id: "labels",
    title: "Labels",
    component: LabelsPanel,
    icon: null,
    side: "right",
    order: 50,
    fill: false,
    when: () => useAppStore.getState().selectedIndex !== null,
  });

  registerBadge({ id: "labels", component: LabelsBadge });

  // Asked-set is tracked by path, not a cursor: a watched folder can lose a file, shifting every later index.
  let lastEntries: FileEntry[] | null = null;
  let lastEpoch = -1;
  let asked = new Set<string>();
  useAppStore.subscribe((state) => {
    if (state.entries === lastEntries) return;
    lastEntries = state.entries;
    if (state.epoch !== lastEpoch) {
      lastEpoch = state.epoch;
      asked = new Set();
      useLabelsStore.getState().reset();
    }
    const fresh = state.entries.filter((e) => !asked.has(e.path));
    if (fresh.length === 0) return;
    for (const entry of fresh) asked.add(entry.path);
    const epoch = state.epoch;
    void labelsForPaths(fresh.map((e) => e.path)).then((labels) => {
      useLabelsStore.getState().loaded(labels, epoch);
    });
  });
}
