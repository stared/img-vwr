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
    kind: "action",
    id: "name",
    label: "name…",
    appliesTo: () => true,
    // Not a menu: picking it opens the inline find-as-you-type chip.
    pick: () => useAppStore.getState().setFindOpen(true),
  });
  registerFilterField({
    kind: "menu",
    id: "format",
    label: "format",
    hint: "›",
    appliesTo: () => true,
    reads: "entry",
    Menu: FormatMenuItems,
  });
  registerFilterField({
    kind: "select",
    id: "camera",
    label: "camera",
    appliesTo: () => true,
    reads: "meta",
    value: (_entry, { meta }) => meta?.exif?.camera ?? null,
    Menu: CameraMenuItems,
  });
  registerFilterField({
    kind: "select",
    id: "aspect",
    label: "aspect",
    appliesTo: () => true,
    reads: "meta",
    value: (_entry, { meta }) => {
      const dims = meta ? effectiveDims(meta) : null;
      return dims ? aspectLabelOf(dims) : null;
    },
    Menu: AspectMenuItems,
  });
  registerFilterField({
    kind: "range",
    id: "taken",
    label: "taken",
    appliesTo: () => true,
    reads: "meta",
    spec: dateRangeSpec((_entry, { meta }) => (meta ? takenMs(meta) : null)),
    Menu: rangeMenu("taken"),
  });
  registerFilterField({
    kind: "range",
    id: "modified",
    label: "modified",
    appliesTo: () => true,
    reads: "entry",
    spec: dateRangeSpec((entry) => entry.modifiedMs),
    Menu: rangeMenu("modified"),
  });
  registerFilterField({
    kind: "range",
    id: "size",
    label: "size",
    appliesTo: () => true,
    reads: "entry",
    // Exact file size is never a useful question; ranges only.
    spec: numberRangeSpec((entry) => entry.size, {
      unit: "MB",
      scale: 1e6,
      integer: false,
      ops: ["<=", ">="],
    }),
    Menu: rangeMenu("size"),
  });
  registerFilterField({
    kind: "range",
    id: "edge",
    label: "longest edge",
    appliesTo: () => true,
    reads: "meta",
    spec: numberRangeSpec(
      (_entry, { meta }) => {
        const dims = meta ? effectiveDims(meta) : null;
        return dims ? Math.max(dims.width, dims.height) : null;
      },
      { unit: "px", scale: 1, integer: true, ops: ["<=", "=", ">="] },
    ),
    Menu: rangeMenu("edge"),
  });
}
