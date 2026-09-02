import { useEffect, useState } from "react";
import {
  FolderOpen,
  Plus,
  ChevronRight,
  AlertTriangle,
  Play,
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
import { MiddleTruncate } from "@/components/MiddleTruncate";
import { pathExists, revealInFinder } from "@/lib/platform";
import {
  Watched,
  Notes,
  Recents,
  Playback,
  type RecentFolder,
} from "@/lib/store";
import { cn } from "@/lib/utils";

const rtf = new Intl.RelativeTimeFormat(undefined, {
  style: "long",
  numeric: "auto",
});

function relativeDate(ts: number) {
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
      return rtf.format(Math.trunc(diff / secs), unit);
  }
  return "";
}

function formatTime(seconds: number) {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const mm = h ? String(m).padStart(2, "0") : String(m);
  return `${h ? `${h}:` : ""}${mm}:${String(sec).padStart(2, "0")}`;
}

type RemoveCandidate = {
  folder: RecentFolder;
  watchedCount: number;
  notesCount: number;
};

type DialogState =
  | { kind: "unavailable"; folder: RecentFolder }
  | { kind: "confirm"; candidate: RemoveCandidate }
  | null;

type Props = {
  dropping: boolean;
  onOpenFolder: () => void;
  onOpenPath: (path: string) => void;
  onResume: (rootPath: string, videoPath: string) => void;
  onChanged: () => void;
};

export function Home({
  dropping,
  onOpenFolder,
  onOpenPath,
  onResume,
  onChanged,
}: Props) {
  const [dialog, setDialog] = useState<DialogState>(null);

  const folders = Recents.folders;
  const last = Playback.last;
  const subtitle = folders.length
    ? "Your content, exactly as you left it."
    : "Open a folder to get started.";

  const openFolder = async (folder: RecentFolder) => {
    if (await pathExists(folder.path)) onOpenPath(folder.path);
    else setDialog({ kind: "unavailable", folder });
  };

  const requestRemove = (folder: RecentFolder) => {
    const w = Watched.watchedCount(folder.path);
    const n = Notes.notesCount(folder.path);
    if (w === 0 && n === 0) performRemove(folder);
    else
      setDialog({
        kind: "confirm",
        candidate: { folder, watchedCount: w, notesCount: n },
      });
  };

  const performRemove = (folder: RecentFolder) => {
    Watched.removeAll(folder.path);
    Notes.removeAll(folder.path);
    Playback.clearLastPlayedUnder(folder.path);
    Recents.remove(folder.id);
    setDialog(null);
    onChanged();
  };

  return (
    <div className="relative min-h-0 flex-1 overflow-auto">
      <div className="mx-auto max-w-[1180px] px-11 pb-20 pt-14">
        <section className="flex items-end justify-between gap-8 pb-14">
          <div>
            <p className="eyebrow mb-3">Your local library</p>
            <h1 className="text-5xl font-semibold tracking-[-0.04em]">
              Pick up where you left off.
            </h1>
            <p className="mt-4 text-[17px] text-muted-foreground">
              Open a folder and keep your whole viewing history in one place.
            </p>
          </div>
          <Button size="lg" className="shrink-0" onClick={onOpenFolder}>
            <Plus className="size-[18px]" />
            Open folder
          </Button>
        </section>

        <SectionHeading
          title="Recent folders"
          hint={subtitle}
          action={
            folders.length > 1 ? (
              <button
                className="flex items-center gap-1 text-[13px] text-primary"
                onClick={() => void openFolder(folders[0])}
              >
                Open latest <ChevronRight className="size-[15px]" />
              </button>
            ) : null
          }
        />

        <div className="grid grid-cols-2 gap-4">
          {folders.map((folder) => (
            <RecentCard
              key={folder.id}
              folder={folder}
              onOpen={() => void openFolder(folder)}
              onReveal={() => void revealInFinder(folder.path)}
              onRemove={() => requestRemove(folder)}
            />
          ))}

          <button
            onClick={onOpenFolder}
            className="flex min-h-[220px] flex-col items-center justify-center gap-3 rounded-xl border border-dashed bg-card p-[18px] transition-colors hover:border-primary/50"
          >
            <span className="grid size-12 place-items-center rounded-full border border-dashed text-primary">
              <Plus className="size-5" />
            </span>
            <strong className="text-base">Open another folder</strong>
            <span className="text-[13px] text-muted-foreground">
              Choose a new library
            </span>
          </button>
        </div>

        {last && (
          <>
            <SectionHeading
              className="mt-14"
              title="Continue watching"
              hint="Resume your most recent video."
            />
            <ContinueCard
              last={last}
              onResume={() => onResume(last.rootPath, last.path)}
            />
          </>
        )}
      </div>

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
                  Remove from recents
                </Button>
              </DialogFooter>
            </>
          )}
          {dialog?.kind === "confirm" && (
            <>
              <DialogHeader>
                <DialogTitle>Remove from recents?</DialogTitle>
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

function SectionHeading({
  title,
  hint,
  action,
  className,
}: {
  title: string;
  hint: string;
  action?: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "mb-5 flex items-end justify-between border-t pt-7",
        className
      )}
    >
      <div>
        <h2 className="text-xl font-semibold">{title}</h2>
        <p className="mt-1.5 text-sm text-muted-foreground">{hint}</p>
      </div>
      {action}
    </div>
  );
}

function removalMessage(c: RemoveCandidate) {
  const parts: string[] = [];
  if (c.watchedCount > 0)
    parts.push(
      `${c.watchedCount} watched ${c.watchedCount === 1 ? "mark" : "marks"}`
    );
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

  const watched = Watched.watchedCount(folder.path);

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <button
          onClick={onOpen}
          title={folder.path}
          className={cn(
            "group relative rounded-xl border bg-card p-[18px] text-left transition-all hover:-translate-y-0.5 hover:border-primary/50",
            !available && "opacity-55"
          )}
        >
          <div
            className={cn(
              "relative grid h-[150px] place-items-center rounded-lg",
              available ? "bg-primary-soft text-primary" : "bg-accent text-muted-foreground"
            )}
          >
            <FolderOpen className="size-14" strokeWidth={1.4} />
            {watched > 0 && (
              <span className="absolute right-3 top-3 rounded-md bg-background/80 px-2.5 py-1.5 text-[11px] text-muted-foreground">
                {watched} watched
              </span>
            )}
            {!available && (
              <AlertTriangle className="absolute left-3 top-3 size-4 text-amber-500" />
            )}
          </div>
          <div className="mt-4 flex flex-col gap-1.5">
            <MiddleTruncate text={folder.name} className="text-base font-semibold" />
            <span className="truncate text-[13px] text-muted-foreground">
              {relativeDate(folder.lastOpenedAt)}
            </span>
          </div>
          <ChevronRight className="absolute bottom-5 right-5 size-[18px] text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
        </button>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem disabled={!available} onClick={onOpen}>
          Open
        </ContextMenuItem>
        <ContextMenuItem disabled={!available} onClick={onReveal}>
          Reveal in file manager
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem variant="destructive" onClick={onRemove}>
          Remove from recents
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

function ContinueCard({
  last,
  onResume,
}: {
  last: NonNullable<typeof Playback.last>;
  onResume: () => void;
}) {
  const at = Watched.getProgress(last.path) ?? 0;
  const total = Playback.duration(last.path);
  const pct = total ? Math.min(100, (at / total) * 100) : 0;
  const done = Watched.contains(last.path);

  return (
    <button
      onClick={onResume}
      className="flex w-full items-center gap-4 rounded-xl border bg-card p-3 text-left transition-colors hover:border-primary/50"
    >
      <span className="grid h-[82px] w-[150px] shrink-0 place-items-center rounded-md bg-primary-soft text-primary">
        <Play className="size-6" fill="currentColor" />
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-1.5">
        <span className="text-xs text-muted-foreground">{last.folderName}</span>
        <MiddleTruncate text={last.name} className="text-base font-semibold" />
        <span className="text-xs text-muted-foreground">
          {done
            ? "Watched"
            : total
              ? `${formatTime(at)} of ${formatTime(total)}`
              : "Not finished"}
        </span>
        <span className="mt-1 h-1 overflow-hidden rounded-full bg-accent">
          <span
            className="block h-full rounded-full bg-primary"
            style={{ width: `${done ? 100 : pct}%` }}
          />
        </span>
      </span>
      <Play className="mx-3 size-5 shrink-0 text-primary" />
    </button>
  );
}
