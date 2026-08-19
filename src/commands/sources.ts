import { registerCommand } from "../registry/commands";
import { allSources } from "../registry/sources";

export function registerSourceCommands(): void {
  for (const source of allSources()) {
    registerCommand({
      id: `source.${source.id}`,
      title: source.title,
      keywords: ["source", "open", source.id],
      input: { placeholder: source.placeholder },
      menus: [],
      run: ({ store }, arg) => {
        if (arg !== undefined && arg.trim() !== "") {
          void store.getState().openSource(source.id, arg.trim());
        }
      },
    });
  }
}
