import type { ReactNode } from "react";
import {
  House,
  FolderOpen,
  Eye,
  EyeOff,
  FastForward,
  Gauge,
  StickyNote,
  SkipBack,
  SkipForward,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Toggle } from "@/components/ui/toggle";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { FileNode } from "@/lib/platform";
import { cn } from "@/lib/utils";

const SPEEDS = [0.5, 0.75, 1.0, 1.25, 1.5, 1.75, 2.0];
const speedLabel = (s: number) => `${s}×`;
const isMac = navigator.platform.toLowerCase().includes("mac");
const cmd = isMac ? "⌘" : "Ctrl+";

type Props = {
  currentVideo: FileNode | null;
  hideWatched: boolean;
  autoplayNext: boolean;
  showingNotes: boolean;
  speed: number;
  onHome: () => void;
  onOpen: () => void;
  onToggleHideWatched: () => void;
  onToggleAutoplay: () => void;
  onChangeSpeed: (v: number) => void;
  onToggleNotes: () => void;
  onPrevious: () => void;
  onNext: () => void;
};

function Tip({ label, children }: { label: string; children: ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

function BarButton({
  icon,
  label,
  onClick,
  disabled,
}: {
  icon: ReactNode;
  label: string;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <Button
      variant="ghost"
      onClick={onClick}
      disabled={disabled}
      className="flex h-auto flex-col gap-0.5 px-2.5 py-1.5 text-[10px] font-normal text-muted-foreground hover:text-foreground"
    >
      {icon}
      <span className="leading-none">{label}</span>
    </Button>
  );
}

function BarToggle({
  icon,
  label,
  pressed,
  onClick,
}: {
  icon: ReactNode;
  label: string;
  pressed: boolean;
  onClick: () => void;
}) {
  return (
    <Toggle
      pressed={pressed}
      onPressedChange={onClick}
      className={cn(
        "flex h-auto flex-col gap-0.5 px-2.5 py-1.5 text-[10px] font-normal text-muted-foreground",
        "data-[state=on]:bg-transparent data-[state=on]:text-primary"
      )}
    >
      {icon}
      <span className="leading-none">{label}</span>
    </Toggle>
  );
}

export function Toolbar(props: Props) {
  const disabled = !props.currentVideo;
  const icon = "size-[18px]";
  return (
    <div className="flex h-12 flex-none items-center gap-1 border-b bg-background/80 px-3 backdrop-blur">
      <Tip label="Back to Home (⌘⇧H)">
        <div>
          <BarButton icon={<House className={icon} />} label="Home" onClick={props.onHome} />
        </div>
      </Tip>

      <div className="mx-1 h-6 w-px bg-border" />

      <Tip label={`Open Folder (${cmd}O)`}>
        <div>
          <BarButton icon={<FolderOpen className={icon} />} label="Open" onClick={props.onOpen} />
        </div>
      </Tip>

      <Tip label="Hide videos already watched">
        <div>
          <BarToggle
            icon={props.hideWatched ? <EyeOff className={icon} /> : <Eye className={icon} />}
            label="Hide Watched"
            pressed={props.hideWatched}
            onClick={props.onToggleHideWatched}
          />
        </div>
      </Tip>

      <Tip label="Automatically play the next unwatched video">
        <div>
          <BarToggle
            icon={<FastForward className={icon} />}
            label="Autoplay"
            pressed={props.autoplayNext}
            onClick={props.onToggleAutoplay}
          />
        </div>
      </Tip>

      <DropdownMenu>
        <Tip label="Playback Speed">
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              className="flex h-auto flex-col gap-0.5 px-2.5 py-1.5 text-[10px] font-normal text-muted-foreground hover:text-foreground"
            >
              <Gauge className={icon} />
              <span className="leading-none">{speedLabel(props.speed)}</span>
            </Button>
          </DropdownMenuTrigger>
        </Tip>
        <DropdownMenuContent align="center">
          <DropdownMenuRadioGroup
            value={String(props.speed)}
            onValueChange={(v) => props.onChangeSpeed(parseFloat(v))}
          >
            {SPEEDS.map((s) => (
              <DropdownMenuRadioItem key={s} value={String(s)}>
                {speedLabel(s)}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>

      <Tip label={`Toggle Notes Panel (${cmd}N)`}>
        <div>
          <BarToggle
            icon={<StickyNote className={icon} />}
            label="Notes"
            pressed={props.showingNotes}
            onClick={props.onToggleNotes}
          />
        </div>
      </Tip>

      <div className="flex-1" />

      <Tip label={`Previous Video (${isMac ? "⌘←" : "Ctrl+←"})`}>
        <div>
          <BarButton
            icon={<SkipBack className={icon} />}
            label="Previous"
            onClick={props.onPrevious}
            disabled={disabled}
          />
        </div>
      </Tip>
      <Tip label={`Next Video (${isMac ? "⌘→" : "Ctrl+→"})`}>
        <div>
          <BarButton
            icon={<SkipForward className={icon} />}
            label="Next"
            onClick={props.onNext}
            disabled={disabled}
          />
        </div>
      </Tip>
    </div>
  );
}
