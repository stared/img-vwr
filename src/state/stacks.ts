import type { FileEntry } from "../ipc";

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

/** Same folder + same stem; the folder matters because cameras restart numbering across shoots. */
export function stackKeyOf(entry: FileEntry): string {
  return stackKeyOfPath(entry.path);
}

export function stackKeyOfPath(path: string): string {
  const slash = path.lastIndexOf("/");
  const dir = slash < 0 ? "" : path.slice(0, slash);
  const name = slash < 0 ? path : path.slice(slash + 1);
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

export type StackLead = "jpg" | "raw";

/** The picked member, else the one `lead` asks for, else the first there is. */
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

/** Each stack kept where its first member sat. */
export function collapseStacks(
  entries: FileEntry[],
  preferred: Record<string, string>,
  lead: StackLead,
): FileEntry[] {
  const stacks = groupStacks(entries);
  const out: FileEntry[] = [];
  const done = new Set<string>();
  for (const entry of entries) {
    const key = stackKeyOf(entry);
    if (done.has(key)) continue;
    done.add(key);
    const members = stacks.get(key) ?? [entry];
    const shown = leadOf(members, preferred[key], lead);
    if (shown) out.push(shown);
  }
  return out;
}

export function siblingsOf(entries: FileEntry[], entry: FileEntry): FileEntry[] {
  const key = stackKeyOf(entry);
  return entries.filter((e) => e.path !== entry.path && stackKeyOf(e) === key);
}

export function stackCaption(entry: FileEntry, siblings: FileEntry[]): string {
  if (siblings.length === 0) return entry.name;
  const others = [...new Set(siblings.map((s) => s.formatHint.toUpperCase()))].sort();
  return `${entry.name} +${others.join("+")}`;
}

/** The pile's formats, the shown one first: "JPG+NEF". */
export function stackFormats(entry: FileEntry, siblings: FileEntry[]): string {
  const shown = entry.formatHint.toUpperCase();
  const others = [...new Set(siblings.map((s) => s.formatHint.toUpperCase()))]
    .filter((f) => f !== shown)
    .sort();
  return [shown, ...others].join("+");
}

/** The name in every format it exists in: "DSC_1234.JPG+NEF", shown format first. */
export function pairedName(entry: FileEntry, siblings: FileEntry[]): string {
  if (siblings.length === 0) return entry.name;
  const stem = entry.name.replace(/\.[^.]+$/, "");
  return `${stem}.${stackFormats(entry, siblings)}`;
}
