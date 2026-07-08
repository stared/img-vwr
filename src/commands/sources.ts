import { registerCommand } from "../registry/commands";
import { allSources } from "../registry/sources";

/**
 * Every registered source gets one palette command: pick it, type the
 * argument (subreddit, search…), Enter loads it as the gallery scope.
 */
export function registerSourceCommands(): void {
  for (const source of allSources()) {
    registerCommand({
      id: `source.${source.id}`,
      title: source.title,
      keywords: ["source", "open", source.id],
      input: { placeholder: source.placeholder },
      run: ({ store }, arg) => {
        if (arg !== undefined && arg.trim() !== "") {
          void store.getState().openSource(source.id, arg.trim());
        }
      },
    });
  }
}
