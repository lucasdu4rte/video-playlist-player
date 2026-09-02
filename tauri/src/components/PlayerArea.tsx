import type { ReactNode } from "react";
import {
  Home as HomeIcon,
  ChevronRight,
  ChevronDown,
  PanelLeftOpen,
  SkipForward,
  StickyNote,
  PlaySquare,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { MiddleTruncate } from "@/components/MiddleTruncate";
import { Playback } from "@/lib/store";
import type { FileNode } from "@/lib/platform";
import { cn } from "@/lib/utils";

function formatTime(seconds?: number) {
  if (!seconds || !Number.isFinite(seconds)) return null;
  const s = Math.floor(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const mm = h ? String(m).padStart(2, "0") : String(m);
  return `${h ? `${h}:` : ""}${mm}:${String(sec).padStart(2, "0")}`;
}

type Props = {
  video: FileNode | null;
  folderName: string;
  watched: boolean;
  hasNotes: boolean;
  nextVideo: FileNode | null;
  autoplayNext: boolean;
  showingNotes: boolean;
  showDetails: boolean;
  sidebarCollapsed: boolean;
  onHome: () => void;
  onExpandSidebar: () => void;
  onNext: () => void;
  onToggleAutoplay: () => void;
  onToggleNotes: () => void;
  onToggleDetails: () => void;
  children: ReactNode;
};

export function PlayerArea(props: Props) {
  const { video } = props;
  const showDetails = Boolean(video) && props.showDetails;

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col px-8 pb-5">
      <div className="flex h-[68px] flex-none items-center justify-between gap-3">
        <nav className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
          {props.sidebarCollapsed && (
            <button
              onClick={props.onExpandSidebar}
              aria-label="Show library"
              className="mr-1 text-muted-foreground hover:text-foreground"
            >
              <PanelLeftOpen className="size-[18px]" />
            </button>
          )}
          <button
            onClick={props.onHome}
            className="flex items-center gap-1.5 hover:text-foreground"
          >
            <HomeIcon className="size-3.5" /> Home
          </button>
          {video && (
            <>
              <ChevronRight className="size-3.5 shrink-0" />
              <span className="shrink-0">{props.folderName}</span>
              <ChevronRight className="size-3.5 shrink-0" />
              <MiddleTruncate
                text={video.name}
                className="min-w-0 font-semibold text-foreground"
              />
            </>
          )}
        </nav>

        {video && (
          <button
            onClick={props.onToggleDetails}
            className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground"
          >
            {props.showDetails ? "Hide details" : "Show details"}
            <ChevronDown
              className={cn(
                "size-3.5 transition-transform",
                !props.showDetails && "rotate-180"
              )}
            />
          </button>
        )}
      </div>

      <div className="flex min-h-0 flex-1 items-center justify-center">
        <div
          className="relative aspect-video max-h-full w-full max-w-[1100px] overflow-hidden rounded-xl border bg-black"
          style={{ containIntrinsicSize: "auto" }}
        >
          {video ? (
            props.children
          ) : (
            <div className="flex h-full flex-col items-center justify-center gap-2 bg-card text-center text-muted-foreground">
              <PlaySquare className="size-11 opacity-40" />
              <div className="text-base font-semibold text-foreground">
                No video selected
              </div>
              <div className="max-w-80 text-xs">
                Choose a video from the library to start playing.
              </div>
            </div>
          )}
        </div>
      </div>

      {showDetails && video && (
        <>
          <div className="flex flex-none items-end justify-between gap-5 px-0.5 pb-5 pt-6">
            <div className="min-w-0">
              <p className="eyebrow mb-2">{props.folderName}</p>
              <h1 className="truncate text-[26px] font-semibold tracking-[-0.03em]">
                {video.name}
              </h1>
              <p className="mt-2 text-xs text-muted-foreground">
                {formatTime(Playback.duration(video.path)) ?? "—"}
                <span className="mx-2 opacity-50">·</span>
                {props.watched ? "Watched" : "Not finished"}
              </p>
            </div>
            <div className="flex shrink-0 gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={props.onToggleAutoplay}
                className={cn(
                  "text-xs",
                  props.autoplayNext && "border-primary/50 text-primary"
                )}
              >
                <SkipForward className="size-[15px]" /> Autoplay
                {props.autoplayNext && (
                  <span className="ml-1 size-1.5 rounded-full bg-primary" />
                )}
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={props.onToggleNotes}
                className={cn(
                  "text-xs",
                  props.showingNotes && "border-primary/50 text-primary"
                )}
              >
                <StickyNote className="size-[15px]" /> Notes
                {props.hasNotes && (
                  <span className="ml-1 size-1.5 rounded-full bg-primary" />
                )}
              </Button>
            </div>
          </div>

          {props.nextVideo && (
            <div className="flex flex-none items-center justify-between gap-4 border-t pt-4">
              <div className="flex min-w-0 items-center gap-3">
                <span className="eyebrow shrink-0">Up next</span>
                <MiddleTruncate
                  text={props.nextVideo.name}
                  className="min-w-0 text-[13px] font-semibold"
                />
                <span className="shrink-0 text-xs text-muted-foreground">
                  {formatTime(Playback.duration(props.nextVideo.path)) ?? ""}
                </span>
              </div>
              <Button size="sm" className="shrink-0 text-xs" onClick={props.onNext}>
                Next video <SkipForward className="size-[15px]" />
              </Button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
