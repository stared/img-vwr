/** Lowercased extension of a URL's last path segment, ignoring query and fragment. */
export function urlExtension(url: string): string {
  const path = url.split(/[?#]/, 1)[0] ?? url;
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}
