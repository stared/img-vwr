/** Optional development convenience for automated/manual testing. Production
 * builds always start without opening a machine-specific folder. */
const configuredStartFolder = import.meta.env.VITE_START_FOLDER?.trim();
export const DEFAULT_START_FOLDER: string | null =
  import.meta.env.DEV && configuredStartFolder ? configuredStartFolder : null;
