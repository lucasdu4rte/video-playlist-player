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

const DEMO_TREE: FileNode[] = [
  {
    path: "/Demo/01 Introduction",
    name: "01 Introduction",
    type: "folder",
    children: [
      { path: "/Demo/01 Introduction/01 Welcome.mp4", name: "01 Welcome.mp4", type: "video" },
      { path: "/Demo/01 Introduction/02 Setup.mp4", name: "02 Setup.mp4", type: "video" },
    ],
  },
  {
    path: "/Demo/02 Deep Dive",
    name: "02 Deep Dive",
    type: "folder",
    children: [
      { path: "/Demo/02 Deep Dive/2 Basics.mp4", name: "2 Basics.mp4", type: "video" },
      { path: "/Demo/02 Deep Dive/10 Advanced.mp4", name: "10 Advanced.mp4", type: "video" },
    ],
  },
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
