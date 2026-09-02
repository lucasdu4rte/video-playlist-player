import { useEffect, useImperativeHandle, useRef, type Ref } from "react";
import videojs from "video.js";
import "video.js/dist/video-js.css";
import "@/player-theme.css";
import { toMediaSrc } from "@/lib/platform";

const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];

type VjsPlayer = ReturnType<typeof videojs>;

function mimeFor(path: string): string {
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
      return "";
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
  ref?: Ref<PlayerHandle>;
};

export type PlayerHandle = {
  /** Nudge playback by `delta` seconds, clamped to the media duration. */
  seekBy: (delta: number) => void;
};

// Video.js gives a consistent player UI + error reporting across platforms.
// Keyed by video path in the parent, so it mounts fresh per video.
export function Player({
  path,
  autoPlay,
  resumeSeconds,
  speed,
  onEnded,
  onProgress,
  onPlayingChange,
  onSpeedChange,
  ref,
}: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const playerRef = useRef<VjsPlayer | null>(null);
  // The mount effect runs once, so read the speed through a ref — capturing it
  // would let a late `loadedmetadata` revert a change made while loading.
  const speedRef = useRef(speed);
  speedRef.current = speed;

  useEffect(() => {
    if (playerRef.current || !containerRef.current) return;

    const el = document.createElement("video-js");
    el.classList.add("vjs-big-play-centered");
    containerRef.current.appendChild(el);

    const type = mimeFor(path);
    const player = (playerRef.current = videojs(el, {
      controls: true,
      preload: "auto",
      fill: true,
      playsinline: true,
      playbackRates: SPEEDS,
      // YouTube ordering: transport + time on the left, settings on the right,
      // seek bar pulled onto its own row above them by the theme.
      controlBar: {
        volumePanel: { inline: true },
        // progressControl comes first so it paints *under* the menu popups;
        // the theme moves it onto its own row above via `order`.
        children: [
          "progressControl",
          "playToggle",
          "volumePanel",
          "currentTimeDisplay",
          "timeDivider",
          "durationDisplay",
          "customControlSpacer",
          "playbackRateMenuButton",
          "pictureInPictureToggle",
          "fullscreenToggle",
        ],
      },
      sources: [{ src: toMediaSrc(path), ...(type ? { type } : {}) }],
    }));

    player.ready(() => {
      player.playbackRate(speedRef.current);
    });

    player.on("loadedmetadata", () => {
      player.playbackRate(speedRef.current);
      if (autoPlay) {
        if (resumeSeconds > 0) player.currentTime(resumeSeconds);
        const p = player.play();
        if (p && typeof p.catch === "function") p.catch(() => {});
      }
    });

    player.on("timeupdate", () => {
      const t = player.currentTime();
      if (typeof t === "number") onProgress(t);
    });
    player.on("ended", onEnded);
    player.on("play", () => onPlayingChange(true));
    player.on("pause", () => onPlayingChange(false));
    // The player's own speed menu is a second entry point; report it back so
    // the toolbar label and the persisted setting stay in agreement.
    player.on("ratechange", () => {
      const rate = player.playbackRate();
      if (typeof rate === "number" && rate !== speedRef.current) onSpeedChange(rate);
    });

    return () => {
      const p = playerRef.current;
      playerRef.current = null;
      if (p && !p.isDisposed()) p.dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const p = playerRef.current;
    if (p && !p.isDisposed()) p.playbackRate(speed);
  }, [speed]);

  useImperativeHandle(ref, () => ({
    seekBy(delta: number) {
      const p = playerRef.current;
      if (!p || p.isDisposed()) return;
      const now = p.currentTime();
      const total = p.duration();
      if (typeof now !== "number" || !Number.isFinite(now)) return;
      const max = typeof total === "number" && Number.isFinite(total) ? total : now + delta;
      p.currentTime(Math.max(0, Math.min(now + delta, max)));
    },
  }), []);

  return (
    <div data-vjs-player className="h-full w-full">
      <div ref={containerRef} className="h-full w-full" />
    </div>
  );
}
