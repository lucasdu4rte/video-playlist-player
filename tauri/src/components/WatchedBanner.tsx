import { CheckCircle2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { MiddleTruncate } from "@/components/MiddleTruncate";
import type { FileNode } from "@/lib/platform";

type Props = {
  video: FileNode;
  hasNext: boolean;
  onSkip: () => void;
  onRestart: () => void;
};

export function WatchedBanner({ video, hasNext, onSkip, onRestart }: Props) {
  return (
    <div className="absolute inset-x-4 top-3 z-10 flex items-center gap-3.5 rounded-xl border bg-popover/90 px-4 py-3.5 shadow-2xl backdrop-blur">
      <CheckCircle2 className="size-6 shrink-0 text-success" />
      <div className="min-w-0 flex-1">
        <div className="text-sm font-semibold">Already watched</div>
        <MiddleTruncate
          text={video.name}
          className="text-sm text-muted-foreground"
        />
      </div>
      <div className="flex shrink-0 gap-2.5">
        <Button variant="secondary" onClick={onSkip} disabled={!hasNext}>
          Next video
        </Button>
        <Button autoFocus onClick={onRestart}>
          Watch from start
        </Button>
      </div>
    </div>
  );
}
