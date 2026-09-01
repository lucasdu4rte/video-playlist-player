import {
  Folder,
  FolderOpen,
  Film,
  PlayCircle,
  CheckCircle2,
  ChevronRight,
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
import { revealInFinder, type FileNode } from "@/lib/platform";
import { subtreeHasUnwatched } from "@/lib/tree";
import { MiddleTruncate } from "@/components/MiddleTruncate";
import { cn } from "@/lib/utils";

type Props = {
  roots: FileNode[];
  isLoading: boolean;
  hideWatched: boolean;
  watched: Set<string>;
  expanded: Set<string>;
  currentPath: string | null;
  onToggleExpand: (path: string) => void;
  onPlay: (node: FileNode) => void;
  onMarkWatched: (node: FileNode) => void;
  onMarkUnwatched: (node: FileNode) => void;
};

function EmptyState({
  icon,
  title,
  sub,
}: {
  icon: React.ReactNode;
  title: string;
  sub: string;
}) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center text-muted-foreground">
      {icon}
      <div className="text-base font-semibold text-foreground">{title}</div>
      <div className="max-w-72 text-xs">{sub}</div>
    </div>
  );
}

export function Sidebar(props: Props) {
  const width = "h-full w-full";

  if (props.isLoading) {
    return (
      <aside className={cn(width, "bg-sidebar")}>
        <div className="flex h-full flex-col items-center justify-center gap-2 text-muted-foreground">
          <Loader2 className="size-5 animate-spin" />
          <span className="text-xs">Loading folder…</span>
        </div>
      </aside>
    );
  }

  if (props.roots.length === 0) {
    return (
      <aside className={cn(width, "bg-sidebar")}>
        <EmptyState
          icon={<Inbox className="size-11 opacity-40" />}
          title={props.hideWatched ? "Nothing left to watch" : "No videos here"}
          sub={
            props.hideWatched
              ? "All videos in this folder are marked as watched."
              : "This folder contains no playable videos."
          }
        />
      </aside>
    );
  }

  return (
    <aside className={cn(width, "bg-sidebar")}>
      <ScrollArea className="h-full">
        <div className="py-1.5">
          {props.roots.map((node) => (
            <Row key={node.path} node={node} depth={0} {...props} />
          ))}
        </div>
      </ScrollArea>
    </aside>
  );
}

function Row({
  node,
  depth,
  ...props
}: Props & { node: FileNode; depth: number }) {
  const pad = { paddingLeft: 8 + depth * 14 } as React.CSSProperties;

  if (node.type === "folder") {
    const open = props.expanded.has(node.path);
    const children = props.hideWatched
      ? (node.children ?? []).filter((c) => subtreeHasUnwatched(c, props.watched))
      : node.children ?? [];
    return (
      <>
        <button
          style={pad}
          onClick={() => props.onToggleExpand(node.path)}
          className="flex h-[26px] w-full items-center gap-1.5 rounded-md px-2 pr-2 text-left hover:bg-accent/60"
        >
          <ChevronRight
            className={cn(
              "size-3 text-muted-foreground transition-transform",
              open && "rotate-90"
            )}
          />
          {open ? (
            <FolderOpen className="size-4 shrink-0 text-primary" />
          ) : (
            <Folder className="size-4 shrink-0 text-primary" />
          )}
          <MiddleTruncate text={node.name} className="flex-1" />
        </button>
        {open &&
          children.map((c) => (
            <Row key={c.path} node={c} depth={depth + 1} {...props} />
          ))}
      </>
    );
  }

  const playing = node.path === props.currentPath;
  const isWatched = props.watched.has(node.path);
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <button
          style={pad}
          onClick={() => props.onPlay(node)}
          className={cn(
            "flex h-[26px] w-full items-center gap-1.5 rounded-md px-2 pr-2 text-left hover:bg-accent/60",
            playing && "bg-primary/15 hover:bg-primary/15"
          )}
        >
          {playing ? (
            <PlayCircle className="size-4 shrink-0 text-primary" />
          ) : (
            <Film className="size-4 shrink-0 text-muted-foreground" />
          )}
          <MiddleTruncate
            text={node.name}
            className={cn("flex-1", playing && "font-semibold")}
          />
          {isWatched && (
            <CheckCircle2 className="ml-auto size-4 shrink-0 text-success" />
          )}
        </button>
      </ContextMenuTrigger>
      <ContextMenuContent>
        {isWatched ? (
          <ContextMenuItem onClick={() => props.onMarkUnwatched(node)}>
            Mark as Unwatched
          </ContextMenuItem>
        ) : (
          <ContextMenuItem onClick={() => props.onMarkWatched(node)}>
            Mark as Watched
          </ContextMenuItem>
        )}
        <ContextMenuSeparator />
        <ContextMenuItem onClick={() => void revealInFinder(node.path)}>
          Reveal in Finder
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}
