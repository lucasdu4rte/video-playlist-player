import { CircleHelp, Settings2, ChevronLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

const IS_MAC = navigator.platform.toLowerCase().includes("mac");

type Props = {
  canGoBack: boolean;
  onHome: () => void;
  onShowShortcuts: () => void;
};

// The macOS window uses an overlay title bar, so the real traffic lights float
// over the top of this strip — hence the taller header and the top padding that
// drops our own controls below them. Elsewhere the OS draws its own bar above us.
export function AppHeader({ canGoBack, onHome, onShowShortcuts }: Props) {
  return (
    <header
      data-tauri-drag-region="deep"
      className={cn(
        "relative flex flex-none items-center gap-3 border-b bg-chrome px-6",
        IS_MAC ? "h-20 pt-7" : "h-[68px] pt-2"
      )}
    >
      {canGoBack && (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              onClick={onHome}
              aria-label="Back to home"
              className="-ml-1 shrink-0 text-muted-foreground"
            >
              <ChevronLeft className="size-[18px]" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Back to home</TooltipContent>
        </Tooltip>
      )}

      <div
        className={cn(
          "pointer-events-none absolute inset-x-0 bottom-0 flex items-center justify-center gap-2.5",
          IS_MAC ? "top-7" : "top-2"
        )}
      >
        <span className="grid size-6 place-items-center rounded-[7px] bg-primary text-sm font-bold text-primary-foreground">
          V
        </span>
        <span className="font-bold">Video Playlist Player</span>
        <span className="text-xs text-muted-foreground">v{__APP_VERSION__}</span>
      </div>

      <div className="ml-auto flex items-center gap-1">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              onClick={onShowShortcuts}
              aria-label="Keyboard shortcuts"
              className="text-muted-foreground"
            >
              <CircleHelp className="size-[18px]" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Keyboard shortcuts</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              aria-label="Settings"
              className="text-muted-foreground"
              disabled
            >
              <Settings2 className="size-[18px]" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Settings (not implemented)</TooltipContent>
        </Tooltip>
      </div>
    </header>
  );
}
