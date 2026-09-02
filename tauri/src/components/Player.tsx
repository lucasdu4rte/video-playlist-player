import { useEffect, useRef } from "react";
import videojs from "video.js";
import "video.js/dist/video-js.css";
import { toMediaSrc } from "@/lib/platform";

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
      controlBar: { pictureInPictureToggle: true },
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

  return (
    <div data-vjs-player className="h-full w-full">
      <div ref={containerRef} className="h-full w-full" />
    </div>
  );
}
