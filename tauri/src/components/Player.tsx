import { useImperativeHandle, useRef, useState, type Ref } from "react";
import { Play, Pause, ChevronsRight, ChevronsLeft } from "lucide-react";
import {
  MediaPlayer,
  MediaProvider,
  type MediaPlayerInstance,
} from "@vidstack/react";
import {
  DefaultVideoLayout,
  defaultLayoutIcons,
} from "@vidstack/react/player/layouts/default";
import "@vidstack/react/player/styles/default/theme.css";
import "@vidstack/react/player/styles/default/layouts/video.css";
import { toMediaSrc } from "@/lib/platform";

function mimeFor(path: string) {
  const ext = path.split(".").pop()?.toLowerCase();
  switch (ext) {
    case "mp4":
    case "m4v":
    case "mov":
      return "video/mp4";
    case "webm":
      return "video/webm";
    case "ogg":
    case "ogv":
      return "video/ogg";
    default:
      return undefined;
  }
}

type Props = {
  path: string;
  autoPlay: boolean;
  resumeSeconds: number;
  speed: number;
  onEnded: () => void;
  onProgress: (seconds: number) => void;
  onPlayingChange: (playing: boolean) => void;
  onSpeedChange: (speed: number) => void;
  onDuration: (seconds: number) => void;
  ref?: Ref<PlayerHandle>;
};

type FlashKind = "play" | "pause" | "forward" | "back";

export type PlayerHandle = {
  /** Nudge playback by `delta` seconds, clamped to the media duration. */
  seekBy: (delta: number) => void;
};

// Vidstack's default layout ships an aligned, accessible control bar, so the
// player carries no hand-written chrome CSS of its own.
export function Player({
  path,
  autoPlay,
  resumeSeconds,
  speed,
  onEnded,
  onProgress,
  onPlayingChange,
  onSpeedChange,
  onDuration,
  ref,
}: Props) {
  const playerRef = useRef<MediaPlayerInstance | null>(null);
  const [flash, setFlash] = useState<{ kind: FlashKind; id: number } | null>(null);
  const flashIdRef = useRef(0);
  const startedRef = useRef(false);
  const resumedRef = useRef(false);

  const showFlash = (kind: FlashKind) =>
    setFlash({ kind, id: ++flashIdRef.current });

  useImperativeHandle(
    ref,
    () => ({
      seekBy(delta: number) {
        const p = playerRef.current;
        if (!p) return;
        const now = p.currentTime;
        const total = p.state.duration;
        if (!Number.isFinite(now)) return;
        const max = Number.isFinite(total) && total > 0 ? total : now + delta;
        p.currentTime = Math.max(0, Math.min(now + delta, max));
        showFlash(delta >= 0 ? "forward" : "back");
      },
    }),
    []
  );

  const FlashIcon = flash && FLASH_ICONS[flash.kind];
  const type = mimeFor(path);
  const src = toMediaSrc(path);

  return (
    <div className="relative h-full w-full">
      <MediaPlayer
        ref={playerRef}
        className="h-full w-full"
        src={type ? { src, type } : src}
        autoPlay={autoPlay}
        playsInline
        playbackRate={speed}
        onLoadedMetadata={() => {
          const p = playerRef.current;
          if (!p) return;
          const total = p.state.duration;
          if (Number.isFinite(total) && total > 0) onDuration(total);
          // Resume once per mount, and only when we meant to start playing.
          if (autoPlay && resumeSeconds > 0 && !resumedRef.current) {
            resumedRef.current = true;
            p.currentTime = resumeSeconds;
          }
        }}
        onTimeUpdate={({ currentTime }) => onProgress(currentTime)}
        onEnded={onEnded}
        onPlay={() => {
          onPlayingChange(true);
          // Skip the autoplay that starts each video — only echo user toggles.
          if (startedRef.current) showFlash("play");
          else startedRef.current = true;
        }}
        onPause={() => {
          onPlayingChange(false);
          if (!playerRef.current?.state.ended) showFlash("pause");
        }}
        onRateChange={(rate) => {
          if (typeof rate === "number" && rate !== speed) onSpeedChange(rate);
        }}
      >
        <MediaProvider />
        <DefaultVideoLayout icons={defaultLayoutIcons} />
      </MediaPlayer>

      {FlashIcon && (
        <div
          key={flash.id}
          className="player-flash"
          aria-hidden="true"
          onAnimationEnd={() => setFlash(null)}
        >
          <FlashIcon className="size-9" strokeWidth={2.5} />
        </div>
      )}
    </div>
  );
}

const FLASH_ICONS = {
  play: Play,
  pause: Pause,
  forward: ChevronsRight,
  back: ChevronsLeft,
} as const;
