import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import type { UnlistenFn } from "@tauri-apps/api/event";

export type FileNode = {
  path: string;
  name: string;
  type: "folder" | "video";
  children?: FileNode[];
};

// Outside a Tauri window (e.g. `vite preview` in a plain browser) the native
// bridge is absent — degrade to a demo so the UI still renders and can be
// inspected. This whole branch is dead in the shipped app.
export const isTauri = "__TAURI_INTERNALS__" in window;

function demoVideos(folder: string, count: number): FileNode[] {
  return Array.from({ length: count }, (_, i) => {
    const name = `${i + 1} Lesson ${i + 1}.mp4`;
    return { path: `${folder}/${name}`, name, type: "video" };
  });
}

// Long enough (~200 rows) to exercise sidebar scrolling.
const DEMO_TREE: FileNode[] = [
  ...Array.from({ length: 10 }, (_, i): FileNode => {
    const path = `/Demo/${String(i + 1).padStart(2, "0")} Module ${i + 1}`;
    const exercises = `${path}/Exercises`;
    return {
      path,
      name: path.slice("/Demo/".length),
      type: "folder",
      children: [
        ...demoVideos(path, 15),
        { path: exercises, name: "Exercises", type: "folder", children: demoVideos(exercises, 3) },
      ],
    };
  }),
  { path: "/Demo/README.mp4", name: "README.mp4", type: "video" },
];

export function scanFolder(path: string): Promise<FileNode[]> {
  if (!isTauri) return Promise.resolve(DEMO_TREE);
  return invoke("scan_folder", { path });
}

export function pathExists(path: string): Promise<boolean> {
  if (!isTauri) return Promise.resolve(true);
  return invoke("path_exists", { path });
}

export function toMediaSrc(path: string): string {
  return isTauri ? convertFileSrc(path) : path;
}

export async function pickFolder(): Promise<string | null> {
  if (!isTauri) return "/Demo/Course Folder";
  const selected = await open({ directory: true, multiple: false });
  return typeof selected === "string" ? selected : null;
}

export async function revealInFinder(path: string): Promise<void> {
  try {
    await revealItemInDir(path);
  } catch (e) {
    console.error("reveal failed", e);
  }
}

export async function setWindowTitle(title: string): Promise<void> {
  document.title = title;
  try {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    await getCurrentWindow().setTitle(title);
  } catch {
    /* ignore */
  }
}

type DropHandlers = {
  onOver?: () => void;
  onLeave?: () => void;
  onDrop?: (paths: string[]) => void;
};

// Tauri intercepts native file drops, so HTML5 dnd never carries paths — they
// arrive on this webview event instead.
export function onFolderDrop(handlers: DropHandlers): Promise<UnlistenFn> {
  if (!isTauri) return Promise.resolve(() => {});
  return getCurrentWebview().onDragDropEvent((event) => {
    const p = event.payload;
    if (p.type === "over" || p.type === "enter") handlers.onOver?.();
    else if (p.type === "leave") handlers.onLeave?.();
    else if (p.type === "drop") {
      handlers.onLeave?.();
      handlers.onDrop?.(p.paths ?? []);
    }
  });
}
