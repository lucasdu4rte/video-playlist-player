export function toRelPath(path: string, root: string, sep: string): string | null {
  const prefix = root + sep;
  if (!path.startsWith(prefix)) return null;
  const rel = path.slice(prefix.length);
  if (!rel) return null;
  return sep === "/" ? rel : rel.split(sep).join("/");
}

export function fromRelPath(relPath: string, root: string, sep: string): string {
  return root + sep + relPath.split("/").join(sep);
}

export function webPath(libraryId: string, relPath: string): string {
  return `/${libraryId}/${relPath}`;
}

export function parseWebPath(
  path: string
): { libraryId: string; relPath: string } | null {
  if (!path.startsWith("/")) return null;
  const slash = path.indexOf("/", 1);
  if (slash < 0) return null;
  const relPath = path.slice(slash + 1);
  if (!relPath) return null;
  const libraryId = path.slice(1, slash);
  if (!libraryId) return null;
  return { libraryId, relPath };
}
