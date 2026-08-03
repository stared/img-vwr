import type { FileEntry } from "../ipc";

/**
 * Stacking: a raw file and the JPEG a camera wrote beside it are one
 * photograph, and a gallery that lists both is counting the same picture
 * twice.
 *
 * The collapse is deliberately a *presentation* step over the already
 * filtered and sorted list, not a change to what the collection contains.
 * Files stay files: the statistics keep counting them, format filters keep
 * matching them, and turning stacking off puts everything back with no state
 * to unwind.
 *
 * What a stack shows is one of its members, not a synthetic thing. That is
 * what makes picking the other one work without any special case — choosing
 * a member swaps which file represents the stack, and the list keeps exactly
 * the same length, so nothing downstream has to think about selection
 * shifting under it.
 */

/** Formats that are a photograph's negative rather than a finished picture. */
const RAW_HINTS = new Set([
  "nef",
  "cr2",
  "cr3",
  "arw",
  "dng",
  "orf",
  "raf",
  "rw2",
  "pef",
  "srw",
  "3fr",
  "erf",
  "mrw",
  "iiq",
  "k25",
  "kdc",
  "mef",
  "mos",
  "nrw",
  "raw",
  "sr2",
  "srf",
  "x3f",
]);

export function isRawEntry(entry: FileEntry): boolean {
  return RAW_HINTS.has(entry.formatHint.toLowerCase());
}

/**
 * What makes two files the same photograph: the same folder and the same
 * name before the extension.
 *
 * The folder matters. Two shoots can each hold a DSC_0001, and merging them
 * because a camera restarts its numbering would be worse than not stacking
 * at all.
 */
export function stackKeyOf(entry: FileEntry): string {
  const slash = entry.path.lastIndexOf("/");
  const dir = slash < 0 ? "" : entry.path.slice(0, slash);
  const name = slash < 0 ? entry.path : entry.path.slice(slash + 1);
  const dot = name.lastIndexOf(".");
  return `${dir}/${dot <= 0 ? name : name.slice(0, dot)}`;
}

/** Every stack in the list, in the order their first member appears. */
export function groupStacks(entries: FileEntry[]): Map<string, FileEntry[]> {
  const stacks = new Map<string, FileEntry[]>();
  for (const entry of entries) {
    const key = stackKeyOf(entry);
    const members = stacks.get(key);
    if (members) members.push(entry);
    else stacks.set(key, [entry]);
  }
  return stacks;
}

/**
 * The member that stands for a stack: whichever one was picked, else the raw
 * file.
 *
 * Raw first because it is the one worth editing — it holds the sensor data,
 * and the JPEG beside it is a rendering somebody's camera already chose.
 */
export function leadOf(members: FileEntry[], preferred: string | undefined): FileEntry | null {
  if (members.length === 0) return null;
  const picked = preferred ? members.find((m) => m.path === preferred) : undefined;
  return picked ?? members.find(isRawEntry) ?? members[0] ?? null;
}

/**
 * The list with each stack reduced to one member.
 *
 * Order is preserved by keeping each stack where its first member sat, so
 * whatever the sort decided still holds.
 */
export function collapseStacks(
  entries: FileEntry[],
  preferred: Record<string, string>,
): FileEntry[] {
  const stacks = groupStacks(entries);
  const out: FileEntry[] = [];
  const done = new Set<string>();
  for (const entry of entries) {
    const key = stackKeyOf(entry);
    if (done.has(key)) continue;
    done.add(key);
    const lead = leadOf(stacks.get(key) ?? [entry], preferred[key]);
    if (lead) out.push(lead);
  }
  return out;
}

/** The other files that are the same photograph as this one. */
export function siblingsOf(entries: FileEntry[], entry: FileEntry): FileEntry[] {
  const key = stackKeyOf(entry);
  return entries.filter((e) => e.path !== entry.path && stackKeyOf(e) === key);
}

/**
 * How a stacked cell names itself: the file it is showing, plus what else is
 * in the stack.
 *
 * In words, on the caption the cell already has. A badge would be one more
 * thing to learn, and the interesting fact is precisely which formats are
 * there — "+JPG" says it.
 */
export function stackCaption(entry: FileEntry, siblings: FileEntry[]): string {
  if (siblings.length === 0) return entry.name;
  const others = [...new Set(siblings.map((s) => s.formatHint.toUpperCase()))].sort();
  return `${entry.name} +${others.join("+")}`;
}
