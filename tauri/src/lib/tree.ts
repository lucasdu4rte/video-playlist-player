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
