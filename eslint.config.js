import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist", "src-tauri", "src/ipc/bindings.ts"] },
  js.configs.recommended,
  ...tseslint.configs.strict,
  {
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
    },
  },
  {
    // Features import the core, never the reverse: deleting a feature folder must not break the core.
    files: ["src/**/*.{ts,tsx}"],
    ignores: ["src/features/**", "src/main.tsx"],
    rules: {
      "no-restricted-imports": [
        "error",
        { patterns: [{ group: ["**/features/**", "**/features"], message: "core must not import a feature; register through a registry instead" }] },
      ],
    },
  },
);
