import type { FileEntry } from "../ipc";

/**
 * Stacking: a raw file and the JPEG a camera wrote beside it are one
 * photograph, and stepping through both means looking at the same picture
 * twice.
 *
 * Which is a complaint about *working* through a shoot, not about browsing
 * one — so the collapse applies where one photograph is on screen at a time
 * (the darkroom and the viewer) and nowhere else. The grid stays a contact
 * sheet of the files that are actually on the card.
 *
 * The collapse is deliberately a *presentation* step over the already
 * filtered and sorted list, not a change to what the collection contains.
 * Files stay files: the scan still holds both, format filters still match
 * both, and turning stacking off puts everything back with no state to
 * unwind. Anything reading the visible list — the count in the status bar,
 * the statistics panel — describes what is on screen, which is the whole
 * point of it being a view.
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
  return stackKeyOfPath(entry.path);
}

/** The same, for a path with no entry to hand — following a selection across
 * a change that removed the file it was on. */
export function stackKeyOfPath(path: string): string {
  const slash = path.lastIndexOf("/");
  const dir = slash < 0 ? "" : path.slice(0, slash);
  const name = slash < 0 ? path : path.slice(slash + 1);
  const dot = name.lastIndexOf(".");
  return `${dir}/${dot <= 0 ? name : name.slice(0, dot)}`;
}

/**
 * Which photograph a file belongs to, HDR sets included.
 *
 * An HDR set widens the stack: five bracketed stems are one photograph, so
 * every member's stack key maps onto the set's face path and the whole
 * bracket collapses together. `hdrKeys` is that mapping (stack key → face
 * path), and null means no set has a say.
 */
export function photographKeyOf(
  entry: FileEntry,
  hdrKeys: ReadonlyMap<string, string> | null,
): string {
  const key = stackKeyOf(entry);
  return hdrKeys?.get(key) ?? key;
}

/** Every stack in the list, in the order their first member appears. */
export function groupStacks(
  entries: FileEntry[],
  hdrKeys: ReadonlyMap<string, string> | null = null,
): Map<string, FileEntry[]> {
  const stacks = new Map<string, FileEntry[]>();
  for (const entry of entries) {
    const key = photographKeyOf(entry, hdrKeys);
    const members = stacks.get(key);
    if (members) members.push(entry);
    else stacks.set(key, [entry]);
  }
  return stacks;
}

/**
 * Which member stands for a stack when the user has not picked one: the
 * camera's JPG, or the raw negative.
 *
 * A global default rather than the raw always winning, because it depends on
 * what the raw files are to the shoot. Working through an event where the
 * JPGs are the pictures and the raws are insurance, the JPG is the one to
 * look at and send; sitting down to edit, the raw holds the sensor data.
 */
export type StackLead = "jpg" | "raw";

/**
 * The member that stands for a stack: whichever one was picked, else the one
 * `lead` asks for, else the first there is.
 */
export function leadOf(
  members: FileEntry[],
  preferred: string | undefined,
  lead: StackLead,
): FileEntry | null {
  if (members.length === 0) return null;
  const picked = preferred ? members.find((m) => m.path === preferred) : undefined;
  const wanted =
    lead === "raw" ? members.find(isRawEntry) : members.find((m) => !isRawEntry(m));
  return picked ?? wanted ?? members[0] ?? null;
}

/**
 * The list with each stack reduced to one member.
 *
 * Order is preserved by keeping each stack where its first member sat, so
 * whatever the sort decided still holds. An HDR set is one photograph whose
 * face frame stands for it — the fused picture lives behind that path — so
 * the face wins over the jpg/raw rule unless the user picked a member.
 */
export function collapseStacks(
  entries: FileEntry[],
  preferred: Record<string, string>,
  lead: StackLead,
  hdrKeys: ReadonlyMap<string, string> | null = null,
): FileEntry[] {
  const stacks = groupStacks(entries, hdrKeys);
  const out: FileEntry[] = [];
  const done = new Set<string>();
  for (const entry of entries) {
    const key = photographKeyOf(entry, hdrKeys);
    if (done.has(key)) continue;
    done.add(key);
    const members = stacks.get(key) ?? [entry];
    // For an HDR group the key *is* the face path; a filter can hide the
    // face, and then the group is fronted like any stack.
    const face = members.find((m) => m.path === key);
    const shown = face && preferred[key] === undefined ? face : leadOf(members, preferred[key], lead);
    if (shown) out.push(shown);
  }
  return out;
}

/** The other files that are the same photograph as this one. */
export function siblingsOf(
  entries: FileEntry[],
  entry: FileEntry,
  hdrKeys: ReadonlyMap<string, string> | null = null,
): FileEntry[] {
  const key = photographKeyOf(entry, hdrKeys);
  return entries.filter(
    (e) => e.path !== entry.path && photographKeyOf(e, hdrKeys) === key,
  );
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

/**
 * The pile's formats, the shown one first: "JPG+NEF".
 *
 * What a badge on a stacked cell says instead of a count — for the
 * ordinary pair the interesting fact is not that there are two files but
 * which kinds they are, and the formats say both at once.
 */
export function stackFormats(entry: FileEntry, siblings: FileEntry[]): string {
  const shown = entry.formatHint.toUpperCase();
  const others = [...new Set(siblings.map((s) => s.formatHint.toUpperCase()))]
    .filter((f) => f !== shown)
    .sort();
  return [shown, ...others].join("+");
}

/**
 * The photograph's name in every format it exists in: "DSC_1234.JPG+NEF",
 * the shown file's format first.
 *
 * For the status bar, where the name answers "which file am I on" — a
 * raw+JPEG pair is one photograph in two files, and naming only the shown
 * one would hide the other's existence exactly where you decide what to
 * edit or delete.
 */
export function pairedName(entry: FileEntry, siblings: FileEntry[]): string {
  if (siblings.length === 0) return entry.name;
  const stem = entry.name.replace(/\.[^.]+$/, "");
  return `${stem}.${stackFormats(entry, siblings)}`;
}
