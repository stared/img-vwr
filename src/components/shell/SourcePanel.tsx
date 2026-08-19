import { useEffect, useState, type ComponentType } from "react";

import type { ImageSource } from "../../registry/sources";
import { useAppStore } from "../../state/store";

export function makeSourcePanel(source: ImageSource): ComponentType {
  return function SourcePanel() {
    const activeArg = useAppStore((s) =>
      s.scope?.kind === "source" && s.scope.sourceId === source.id ? s.scope.arg : null,
    );
    const openSource = useAppStore((s) => s.openSource);
    const [text, setText] = useState(activeArg ?? "");

    useEffect(() => {
      if (activeArg !== null) setText(activeArg);
    }, [activeArg]);

    return (
      <form
        className="source-form"
        onSubmit={(e) => {
          e.preventDefault();
          const arg = text.trim();
          if (arg) void openSource(source.id, arg);
        }}
      >
        <input
          value={text}
          placeholder={source.placeholder}
          onChange={(e) => setText(e.target.value)}
        />
      </form>
    );
  };
}
