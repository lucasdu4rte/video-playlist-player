import { useEffect, useState } from "react";
import {
  Folder,
  FolderPlus,
  AlertTriangle,
  ChevronLeft,
  ChevronRight,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { pathExists, revealInFinder } from "@/lib/platform";
import { Watched, Notes, Recents, type RecentFolder } from "@/lib/store";
import { cn } from "@/lib/utils";

function relativeDate(ts: number) {
  const rtf = new Intl.RelativeTimeFormat(undefined, {
    style: "long",
    numeric: "auto",
  });
  const diff = (ts - Date.now()) / 1000;
  const units: [Intl.RelativeTimeFormatUnit, number][] = [
    ["year", 31536000],
    ["month", 2592000],
    ["week", 604800],
    ["day", 86400],
    ["hour", 3600],
    ["minute", 60],
    ["second", 1],
  ];
  for (const [unit, secs] of units) {
    if (Math.abs(diff) >= secs || unit === "second")
      return rtf.format(Math.round(diff / secs), unit);
  }
  return "";
}

type Props = {
  dropping: boolean;
  onOpenFolder: () => void;
  onOpenPath: (path: string) => void;
  onChanged: () => void;
};

type RemoveCandidate = {
  folder: RecentFolder;
  watchedCount: number;
  notesCount: number;
};

type DialogState =
  | { kind: "unavailable"; folder: RecentFolder }
  | { kind: "confirm"; candidate: RemoveCandidate }
  | null;

export function Home({ dropping, onOpenFolder, onOpenPath, onChanged }: Props) {
  const [page, setPage] = useState(0);
  // One dialog with two steps, not two dialogs: mounting a second modal while
  // the first is still animating out leaves body pointer-events stuck at none.
  const [dialog, setDialog] = useState<DialogState>(null);

  const folders = Recents.folders;
  const pageCount = Recents.pageCount;
  const clampedPage = Math.max(0, Math.min(page, pageCount - 1));
  const count = folders.length;
  const subtitle =
    count === 0
      ? "No folders yet — open one to get started."
      : count === 1
        ? "1 folder"
        : `${count} folders`;

  const openFolder = async (folder: RecentFolder) => {
    if (await pathExists(folder.path)) onOpenPath(folder.path);
    else setDialog({ kind: "unavailable", folder });
  };

  const requestRemove = (folder: RecentFolder) => {
    const w = Watched.watchedCount(folder.path);
    const n = Notes.notesCount(folder.path);
    if (w === 0 && n === 0) performRemove(folder);
    else setDialog({ kind: "confirm", candidate: { folder, watchedCount: w, notesCount: n } });
  };

  const performRemove = (folder: RecentFolder) => {
    Watched.removeAll(folder.path);
    Notes.removeAll(folder.path);
    Recents.remove(folder.id);
    setDialog(null);
    onChanged();
  };

  return (
    <div className="relative flex h-full flex-col bg-background">
      <div className="flex items-end justify-between px-8 py-6">
        <div>
          <h1 className="text-[26px] font-semibold">Recent Folders</h1>
          <p className="mt-0.5 text-sm text-muted-foreground">{subtitle}</p>
        </div>
        <Button size="lg" onClick={onOpenFolder}>
          <FolderPlus className="size-4" />
          Open Folder…
        </Button>
      </div>
      <div className="h-px bg-border" />

      {count === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 text-center text-muted-foreground">
          <Folder className="size-11 opacity-40" />
          <div className="text-base font-semibold text-foreground">
            No folders yet
          </div>
          <div className="max-w-96 text-sm">
            Open a folder from the toolbar or drag one anywhere into this window.
          </div>
          <Button size="lg" className="mt-2" onClick={onOpenFolder}>
            <FolderPlus className="size-4" />
            Open Folder…
          </Button>
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="flex-1 overflow-auto">
            <div className="grid grid-cols-4 gap-4 p-8">
              {Recents.page(clampedPage).map((folder) => (
                <RecentCard
                  key={folder.id}
                  folder={folder}
                  onOpen={() => openFolder(folder)}
                  onReveal={() => void revealInFinder(folder.path)}
                  onRemove={() => requestRemove(folder)}
                />
              ))}
            </div>
          </div>
          {pageCount > 1 && (
            <div className="flex items-center justify-center gap-4 border-t bg-background/80 py-3.5">
              <Button
                variant="outline"
                size="icon"
                disabled={clampedPage === 0}
                onClick={() => setPage(clampedPage - 1)}
              >
                <ChevronLeft className="size-4" />
              </Button>
              <span className="min-w-28 text-center text-sm tabular-nums text-muted-foreground">
                Page {clampedPage + 1} of {pageCount}
              </span>
              <Button
                variant="outline"
                size="icon"
                disabled={clampedPage >= pageCount - 1}
                onClick={() => setPage(clampedPage + 1)}
              >
                <ChevronRight className="size-4" />
              </Button>
            </div>
          )}
        </div>
      )}

      {dropping && (
        <div className="pointer-events-none fixed inset-2 z-40 rounded-xl border-2 border-dashed border-primary" />
      )}

      <Dialog open={!!dialog} onOpenChange={(o) => !o && setDialog(null)}>
        <DialogContent>
          {dialog?.kind === "unavailable" && (
            <>
              <DialogHeader>
                <DialogTitle>Folder is not available</DialogTitle>
                <DialogDescription>
                  “{dialog.folder.name}” can’t be opened. The disk may be
                  disconnected, the folder may have been moved or deleted, or
                  access was revoked.
                </DialogDescription>
              </DialogHeader>
              <DialogFooter>
                <Button variant="secondary" onClick={() => setDialog(null)}>
                  Keep
                </Button>
                <Button
                  variant="destructive"
                  onClick={() => requestRemove(dialog.folder)}
                >
                  Remove from Recents
                </Button>
              </DialogFooter>
            </>
          )}
          {dialog?.kind === "confirm" && (
            <>
              <DialogHeader>
                <DialogTitle>Remove from Recents?</DialogTitle>
                <DialogDescription>
                  {removalMessage(dialog.candidate)}
                </DialogDescription>
              </DialogHeader>
              <DialogFooter>
                <Button variant="secondary" onClick={() => setDialog(null)}>
                  Cancel
                </Button>
                <Button
                  variant="destructive"
                  onClick={() => performRemove(dialog.candidate.folder)}
                >
                  Remove
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

function removalMessage(c: RemoveCandidate) {
  const parts: string[] = [];
  if (c.watchedCount > 0)
    parts.push(`${c.watchedCount} watched ${c.watchedCount === 1 ? "mark" : "marks"}`);
  if (c.notesCount > 0)
    parts.push(`${c.notesCount} ${c.notesCount === 1 ? "note" : "notes"}`);
  return `Removing “${c.folder.name}” will also delete ${parts.join(
    " and "
  )} saved for videos in this folder. This can’t be undone.`;
}

function RecentCard({
  folder,
  onOpen,
  onReveal,
  onRemove,
}: {
  folder: RecentFolder;
  onOpen: () => void;
  onReveal: () => void;
  onRemove: () => void;
}) {
  const [available, setAvailable] = useState(true);

  useEffect(() => {
    let alive = true;
    void pathExists(folder.path).then((ok) => alive && setAvailable(ok));
    return () => {
      alive = false;
    };
  }, [folder.path]);

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <button
          onClick={onOpen}
          title={folder.path}
          className={cn(
            "flex flex-col gap-3 rounded-xl border bg-card p-3 text-left transition-colors hover:border-primary/40",
            !available && "opacity-55"
          )}
        >
          <div
            className={cn(
              "relative flex h-24 items-center justify-center rounded-lg",
              available ? "bg-primary/10" : "bg-accent"
            )}
          >
            <Folder
              className={cn(
                "size-11",
                available ? "text-primary" : "text-muted-foreground"
              )}
            />
            {!available && (
              <AlertTriangle className="absolute right-2 top-2 size-4 text-amber-500" />
            )}
          </div>
          <div className="min-w-0">
            <div className="truncate text-sm font-semibold">{folder.name}</div>
            <div className="truncate text-[11px] text-muted-foreground">
              {folder.path}
            </div>
            <div className="text-[10px] text-muted-foreground/70">
              {relativeDate(folder.lastOpenedAt)}
            </div>
          </div>
        </button>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem disabled={!available} onClick={onOpen}>
          Open
        </ContextMenuItem>
        <ContextMenuItem disabled={!available} onClick={onReveal}>
          Reveal in Finder
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem variant="destructive" onClick={onRemove}>
          Remove from Recents
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}
