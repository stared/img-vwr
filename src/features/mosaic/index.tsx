import { parseNumber, Slider } from "../../components/shell/Slider";
import { registerView } from "../../registry/views";
import "./mosaic.css";
import { MosaicGallery } from "./MosaicGallery";
import { useMosaicSettings } from "./settings";

function MosaicKnobs() {
  const rowPx = useMosaicSettings((s) => s.rowPx);
  const setRowPx = (px: number) => useMosaicSettings.setState({ rowPx: px });
  const packing = useMosaicSettings((s) => s.packing);
  const setPacking = (value: "order" | "packed") => useMosaicSettings.setState({ packing: value });
  return (
        <div className="menu-knobs">
          <Slider
            label="row height"
            value={rowPx}
            neutral={80}
            min={80}
            max={360}
            step={1}
            display={`${rowPx} px`}
            parse={parseNumber}
            ticks={[]}
            layout="inline"
            title="how tall the rows aim to be"
            onChange={setRowPx}
          />
          {(
            [
              { value: "order", label: "as sorted", hint: "rows vary a little in scale" },
              { value: "packed", label: "one scale", hint: "reordered locally to fit" },
            ] as const
          ).map((row) => (
            <button key={row.value} onClick={() => setPacking(row.value)}>
              <span>{row.label}</span>
              <span className="menu-hint">{row.hint}</span>
              <span className="menu-check">{packing === row.value ? "✓" : ""}</span>
            </button>
          ))}
        </div>
      );
}

export function registerMosaic(): void {
  registerView({
    id: "mosaic",
    label: "Mosaic",
    hint: "edge-to-edge photographs",
    component: MosaicGallery,
    keywords: ["packed", "wall", "justified"],
    zoomable: false,
    stacks: false,
    Knobs: MosaicKnobs,
  });
}
