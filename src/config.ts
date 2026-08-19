/** Dev-only; production builds never open a machine-specific folder. */
const configuredStartFolder = import.meta.env.VITE_START_FOLDER?.trim();
export const DEFAULT_START_FOLDER: string | null =
  import.meta.env.DEV && configuredStartFolder ? configuredStartFolder : null;
