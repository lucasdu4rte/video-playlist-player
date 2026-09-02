import type { FileNode } from "./platform";

export function videosInOrder(roots: FileNode[]): FileNode[] {
  const out: FileNode[] = [];
  const walk = (items: FileNode[]) => {
    for (const it of items) {
      if (it.type === "video") out.push(it);
      else if (it.children) walk(it.children);
    }
  };
  walk(roots);
  return out;
}

export function nextUnwatched(
  roots: FileNode[],
  watched: Set<string>,
  after: FileNode
): FileNode | null {
  const vids = videosInOrder(roots);
  const idx = vids.findIndex((v) => v.path === after.path);
  if (idx < 0) return null;
  const rest = vids.slice(idx + 1);
  return rest.find((v) => !watched.has(v.path)) ?? rest[0] ?? null;
}

export function videoAfter(roots: FileNode[], node: FileNode): FileNode | null {
  const vids = videosInOrder(roots);
  const idx = vids.findIndex((v) => v.path === node.path);
  return idx >= 0 && idx + 1 < vids.length ? vids[idx + 1] : null;
}

export function videoBefore(roots: FileNode[], node: FileNode): FileNode | null {
  const vids = videosInOrder(roots);
  const idx = vids.findIndex((v) => v.path === node.path);
  return idx > 0 ? vids[idx - 1] : null;
}

export function subtreeHasUnwatched(node: FileNode, watched: Set<string>): boolean {
  if (node.type === "video") return !watched.has(node.path);
  return (node.children ?? []).some((c) => subtreeHasUnwatched(c, watched));
}

export function filteredRoots(
  roots: FileNode[],
  hideWatched: boolean,
  watched: Set<string>
): FileNode[] {
  if (!hideWatched) return roots;
  return roots.filter((n) => subtreeHasUnwatched(n, watched));
}

export function countVideos(node: FileNode): number {
  if (node.type === "video") return 1;
  return (node.children ?? []).reduce((n, c) => n + countVideos(c), 0);
}

/** Keeps videos whose name matches, and folders that still have a match under them. */
export function searchTree(roots: FileNode[], query: string): FileNode[] {
  const q = query.trim().toLowerCase();
  if (!q) return roots;
  const walk = (items: FileNode[]): FileNode[] =>
    items.flatMap((it) => {
      if (it.type === "video")
        return it.name.toLowerCase().includes(q) ? [it] : [];
      const children = walk(it.children ?? []);
      if (children.length === 0 && !it.name.toLowerCase().includes(q)) return [];
      return [{ ...it, children: children.length ? children : it.children }];
    });
  return walk(roots);
}

// Ancestor folder paths that must be expanded for `target` to be visible.
export function ancestorsOf(roots: FileNode[], target: FileNode): string[] {
  const trail: string[] = [];
  const found: string[] = [];
  const walk = (items: FileNode[]): boolean => {
    for (const it of items) {
      if (it.path === target.path) return true;
      if (it.type === "folder" && it.children) {
        trail.push(it.path);
        if (walk(it.children)) {
          found.push(it.path);
          trail.pop();
          return true;
        }
        trail.pop();
      }
    }
    return false;
  };
  walk(roots);
  return found;
}
