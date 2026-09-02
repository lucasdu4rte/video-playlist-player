import { CircleHelp, Settings2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

const IS_MAC = navigator.platform.toLowerCase().includes("mac");

type Props = {
  onHome: () => void;
  onShowShortcuts: () => void;
};

// The macOS window uses an overlay title bar, so the real traffic lights float
// over this strip — hence the left inset. Elsewhere the OS draws its own bar
// above us and no inset is needed.
export function AppHeader({ onHome, onShowShortcuts }: Props) {
  return (
    <header
      data-tauri-drag-region
      className="flex h-[62px] flex-none items-center gap-5 border-b bg-chrome px-6"
      style={IS_MAC ? { paddingLeft: 82 } : undefined}
    >
      <button
        onClick={onHome}
        className="flex items-center gap-2.5 font-bold"
        aria-label="Back to home"
      >
        <span className="grid size-6 place-items-center rounded-[7px] bg-primary text-sm text-primary-foreground">
          V
        </span>
        <span>Video Playlist Player</span>
      </button>

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
