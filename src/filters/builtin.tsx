import {
  AspectMenuItems,
  CameraMenuItems,
  FormatMenuItems,
  RangeMenuForm,
} from "../components/shell/filterMenus";
import { registerFilterField } from "../registry/filters";
import { aspectLabelOf, effectiveDims, takenMs } from "../state/derived";
import { dateRangeSpec, numberRangeSpec } from "../state/query";
import { useAppStore } from "../state/store";

function rangeMenu(field: string) {
  return function RangeMenu({ close }: { close: () => void }) {
    return <RangeMenuForm field={field} close={close} />;
  };
}

/** The fields every scope can filter on; registered once at startup. */
export function registerBuiltinFilterFields(): void {
  registerFilterField({
    id: "name",
    label: "name…",
    // Not a menu: picking it opens the inline find-as-you-type chip.
    pick: () => useAppStore.getState().setFindOpen(true),
  });
  registerFilterField({
    id: "format",
    label: "format",
    Menu: FormatMenuItems,
  });
  registerFilterField({
    id: "camera",
    label: "camera",
    needsMeta: true,
    select: { value: (_entry, meta) => meta?.exif?.camera ?? null },
    Menu: CameraMenuItems,
  });
  registerFilterField({
    id: "aspect",
    label: "aspect",
    needsMeta: true,
    select: {
      value: (_entry, meta) => {
        const dims = meta ? effectiveDims(meta) : null;
        return dims ? aspectLabelOf(dims) : null;
      },
    },
    Menu: AspectMenuItems,
  });
  registerFilterField({
    id: "taken",
    label: "taken",
    needsMeta: true,
    range: dateRangeSpec((_entry, meta) => (meta ? takenMs(meta) : null)),
    Menu: rangeMenu("taken"),
  });
  registerFilterField({
    id: "modified",
    label: "modified",
    range: dateRangeSpec((entry) => entry.modifiedMs),
    Menu: rangeMenu("modified"),
  });
  registerFilterField({
    id: "size",
    label: "size",
    // Exact file size is never a useful question; ranges only.
    range: numberRangeSpec((entry) => entry.size, { unit: "MB", scale: 1e6, ops: ["<=", ">="] }),
    Menu: rangeMenu("size"),
  });
  registerFilterField({
    id: "edge",
    label: "longest edge",
    needsMeta: true,
    range: numberRangeSpec(
      (_entry, meta) => {
        const dims = meta ? effectiveDims(meta) : null;
        return dims ? Math.max(dims.width, dims.height) : null;
      },
      { unit: "px", integer: true },
    ),
    Menu: rangeMenu("edge"),
  });
}
