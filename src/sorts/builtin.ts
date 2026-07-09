import { registerSort } from "../registry/sorts";

/** The file-fact sorts every scope has; registered once at startup. */
export function registerBuiltinSorts(): void {
  registerSort({
    id: "name",
    label: "name",
    hints: { asc: "A→Z", desc: "Z→A" },
    defaultDir: "asc",
    appliesTo: () => true,
    reads: "entry",
    param: null,
    value: (entry) => entry.name,
  });
  registerSort({
    id: "modified",
    label: "modified",
    hints: { asc: "oldest", desc: "newest" },
    defaultDir: "desc",
    appliesTo: () => true,
    reads: "entry",
    param: null,
    value: (entry) => entry.modifiedMs,
  });
  registerSort({
    id: "size",
    label: "size",
    hints: { asc: "smallest", desc: "largest" },
    defaultDir: "desc",
    appliesTo: () => true,
    reads: "entry",
    param: null,
    value: (entry) => entry.size,
  });
}
