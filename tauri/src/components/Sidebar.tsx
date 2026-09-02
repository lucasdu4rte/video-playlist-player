import type { Ref } from "react";
import {
  Folder,
  FolderOpen,
  FileVideo2,
  Check,
  ChevronDown,
  Search,
  StickyNote,
  PanelLeftClose,
  Library,
  Inbox,
  Loader2,
} from "lucide-react";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { ScrollArea } from "@/components/ui/scroll-area";
import { MiddleTruncate } from "@/components/MiddleTruncate";
import { revealInFinder, type FileNode } from "@/lib/platform";
import { countVideos, subtreeHasUnwatched } from "@/lib/tree";
import { cn } from "@/lib/utils";

const IS_MAC = navigator.platform.toLowerCase().includes("mac");

type Props = {
  rootName: string;
  roots: FileNode[];
  totalVideos: number;
  isLoading: boolean;
  hideWatched: boolean;
  watched: Set<string>;
  noted: Set<string>;
  expanded: Set<string>;
  currentPath: string | null;
  query: string;
  searchRef: Ref<HTMLInputElement>;
  onQueryChange: (q: string) => void;
  onToggleHideWatched: () => void;
  onCollapse: () => void;
  onToggleExpand: (path: string) => void;
  onPlay: (node: FileNode) => void;
  onMarkWatched: (node: FileNode) => void;
  onMarkUnwatched: (node: FileNode) => void;
};

export function Sidebar(props: Props) {
  return (
    <aside className="flex h-full w-full flex-col border-r bg-sidebar px-4 pb-4 pt-6">
      <div className="flex items-start justify-between px-2 pb-5">
        <div className="min-w-0">
          <p className="eyebrow mb-1">Library</p>
          <h2 className="truncate text-base font-semibold">{props.rootName}</h2>
        </div>
        <button
          onClick={props.onCollapse}
          aria-label="Collapse library"
          className="shrink-0 text-muted-foreground hover:text-foreground"
        >
          <PanelLeftClose className="size-[18px]" />
        </button>
      </div>

      <label className="flex items-center gap-2.5 rounded-lg border bg-background px-2.5 py-2 text-muted-foreground focus-within:border-ring">
        <Search className="size-4 shrink-0" />
        <input
          ref={props.searchRef}
          value={props.query}
          onChange={(e) => props.onQueryChange(e.target.value)}
          placeholder="Search videos…"
          className="min-w-0 flex-1 select-text bg-transparent text-xs text-foreground outline-none"
        />
        <kbd className="shrink-0 text-[10px] text-muted-foreground/70">
          {IS_MAC ? "⌘K" : "^K"}
        </kbd>
      </label>

      <div className="flex gap-1.5 pb-3.5 pt-4">
        <button
          onClick={props.onToggleHideWatched}
          className={cn(
            "flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs text-muted-foreground",
            !props.hideWatched && "bg-primary-soft text-primary"
          )}
        >
          <Check className="size-3.5" />
          Watched
        </button>
        <span className="ml-auto self-center text-xs text-muted-foreground">
          {props.totalVideos} videos
        </span>
      </div>

      {props.isLoading ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 text-muted-foreground">
          <Loader2 className="size-5 animate-spin" />
          <span className="text-xs">Loading folder…</span>
        </div>
      ) : props.roots.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 px-4 text-center text-muted-foreground">
          <Inbox className="size-10 opacity-40" />
          <div className="text-sm font-semibold text-foreground">
            {props.query
              ? "No matches"
              : props.hideWatched
                ? "Nothing left to watch"
                : "No videos here"}
          </div>
          <div className="text-xs">
            {props.query
              ? "Try a different search."
              : props.hideWatched
                ? "Every video here is marked as watched."
                : "This folder contains no playable videos."}
          </div>
        </div>
      ) : (
        <ScrollArea className="-mx-1 flex-1">
          <div className="px-1">
            {props.roots.map((node) => (
              <Row key={node.path} node={node} depth={0} {...props} />
            ))}
          </div>
        </ScrollArea>
      )}

      <div className="mt-2 flex items-center gap-2 border-t px-1.5 pt-4 text-[11px] text-muted-foreground">
        <Library className="size-[15px]" />
        <span>{props.roots.length} folders</span>
        <span className="ml-auto opacity-70">Local library</span>
      </div>
    </aside>
  );
}

function Row({ node, depth, ...props }: Props & { node: FileNode; depth: number }) {
  if (node.type === "folder") {
    const open = props.expanded.has(node.path) || Boolean(props.query);
    const children = props.hideWatched
      ? (node.children ?? []).filter((c) => subtreeHasUnwatched(c, props.watched))
      : node.children ?? [];

    return (
      <>
        <button
          onClick={() => props.onToggleExpand(node.path)}
          className="flex w-full items-center gap-2 rounded-md p-2 text-left text-xs hover:bg-accent/60"
        >
          <ChevronDown
            className={cn(
              "size-4 shrink-0 text-muted-foreground transition-transform",
              !open && "-rotate-90"
            )}
          />
          {open ? (
            <FolderOpen className="size-4 shrink-0 text-primary" />
          ) : (
            <Folder className="size-4 shrink-0 text-primary" />
          )}
          <MiddleTruncate text={node.name} className="flex-1" />
          <small className="shrink-0 text-muted-foreground">
            {countVideos(node)}
          </small>
        </button>
        {open && children.length > 0 && (
          <div className="ml-3.5 border-l pl-2">
            {children.map((c) => (
              <Row key={c.path} node={c} depth={depth + 1} {...props} />
            ))}
          </div>
        )}
      </>
    );
  }

  const playing = node.path === props.currentPath;
  const isWatched = props.watched.has(node.path);

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <button
          onClick={() => props.onPlay(node)}
          className={cn(
            "flex w-full items-center gap-2 rounded-md p-2 text-left text-xs text-muted-foreground hover:bg-accent/60",
            playing && "bg-primary-soft text-foreground hover:bg-primary-soft"
          )}
        >
          <FileVideo2 className="size-[15px] shrink-0" />
          <MiddleTruncate text={node.name} className={cn("flex-1", playing && "font-semibold")} />
          {props.noted.has(node.path) && (
            <StickyNote
              className="size-3.5 shrink-0 text-primary"
              aria-label="Has notes"
            />
          )}
          {isWatched && <Check className="size-3.5 shrink-0 text-success" />}
        </button>
      </ContextMenuTrigger>
      <ContextMenuContent>
        {isWatched ? (
          <ContextMenuItem onClick={() => props.onMarkUnwatched(node)}>
            Mark as unwatched
          </ContextMenuItem>
        ) : (
          <ContextMenuItem onClick={() => props.onMarkWatched(node)}>
            Mark as watched
          </ContextMenuItem>
        )}
        <ContextMenuSeparator />
        <ContextMenuItem onClick={() => void revealInFinder(node.path)}>
          Reveal in file manager
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}
