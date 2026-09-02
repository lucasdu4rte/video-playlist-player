import { useCallback, useEffect, useRef, useState } from "react";
import {
  scanFolder,
  pathExists,
  pickFolder,
  onFolderDrop,
  setWindowTitle,
  type FileNode,
} from "@/lib/platform";
import { Watched, Recents, getSpeed, setSpeed } from "@/lib/store";
import {
  ancestorsOf,
  filteredRoots,
  nextUnwatched,
  videoAfter,
  videoBefore,
} from "@/lib/tree";
import { Home } from "@/components/Home";
import { Toolbar } from "@/components/Toolbar";
import { Sidebar } from "@/components/Sidebar";
import { NotesPanel } from "@/components/NotesPanel";
import { WatchedBanner } from "@/components/WatchedBanner";
import { Player, type PlayerHandle } from "@/components/Player";
import {
  ResizablePanelGroup,
  ResizablePanel,
  ResizableHandle,
} from "@/components/ui/resizable";
import { PlaySquare } from "lucide-react";

const SEEK_STEP = 5; // seconds per arrow press

export default function App() {
  const [roots, setRoots] = useState<FileNode[]>([]);
  const [hasOpenedFolder, setHasOpenedFolder] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [hideWatched, setHideWatched] = useState(false);
  const [autoplayNext, setAutoplayNext] = useState(true);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [watched, setWatchedState] = useState<Set<string>>(
    new Set(Watched.watched)
  );
  const [currentVideo, setCurrentVideo] = useState<FileNode | null>(null);
  const [autoPlayIntent, setAutoPlayIntent] = useState(true);
  const [playNonce, setPlayNonce] = useState(0);
  const [pendingWatched, setPendingWatched] = useState<FileNode | null>(null);
  const [showingNotes, setShowingNotes] = useState(false);
  const [speed, setSpeedState] = useState<number>(getSpeed());
  const [dropping, setDropping] = useState(false);
  const [recentsVersion, setRecentsVersion] = useState(0);

  const currentTimeRef = useRef(0);
  const lastSavedRef = useRef(0);
  const wakeLockRef = useRef<WakeLockSentinel | null>(null);
  const wakeWantedRef = useRef(false);
  const wakePendingRef = useRef(false);
  const scanTokenRef = useRef(0);
  const playerRef = useRef<PlayerHandle | null>(null);

  // ---- playback -----------------------------------------------------------
  // Reads the store, not the `watched` state mirror: within one event the
  // mirror is a render behind, which would re-save a resume point for a video
  // that was just marked watched.
  const persistProgress = useCallback(() => {
    if (!currentVideo || Watched.contains(currentVideo.path)) return;
    const t = currentTimeRef.current;
    if (Number.isFinite(t) && t > 3) Watched.setProgress(currentVideo.path, t);
  }, [currentVideo]);

  const playVideo = useCallback(
    (node: FileNode, autoPlay = true) => {
      if (node.type !== "video") return;
      const ancestors = ancestorsOf(roots, node);
      setExpanded((prev) => new Set([...prev, ...ancestors]));
      persistProgress();
      currentTimeRef.current = 0;
      lastSavedRef.current = 0;
      setAutoPlayIntent(autoPlay);
      // Re-selecting the current video remounts the player instead of falling
      // through, so the banner never sits over a still-playing video.
      if (node.path === currentVideo?.path) setPlayNonce((n) => n + 1);
      else setCurrentVideo(node);
      void setWindowTitle(node.name);
    },
    [roots, currentVideo, persistProgress]
  );

  const markWatched = useCallback((node: FileNode) => {
    if (Watched.contains(node.path)) return;
    Watched.setWatched(node.path, true);
    setWatchedState(new Set(Watched.watched));
  }, []);

  const markUnwatched = useCallback((node: FileNode) => {
    if (!Watched.contains(node.path)) return;
    Watched.setWatched(node.path, false);
    setWatchedState(new Set(Watched.watched));
  }, []);

  const handleVideoTap = useCallback(
    (node: FileNode) => {
      if (node.type !== "video") return;
      if (Watched.contains(node.path)) {
        setPendingWatched(node);
        playVideo(node, false);
      } else {
        setPendingWatched(null);
        playVideo(node);
      }
    },
    [playVideo]
  );

  const handleEnded = () => {
    if (!currentVideo) return;
    markWatched(currentVideo);
    if (autoplayNext) {
      const next = nextUnwatched(roots, new Set(Watched.watched), currentVideo);
      if (next) playVideo(next);
    }
  };

  const playNext = useCallback(() => {
    if (!currentVideo) return;
    const next = videoAfter(roots, currentVideo);
    if (next) handleVideoTap(next);
  }, [currentVideo, roots, handleVideoTap]);

  const playPrevious = useCallback(() => {
    if (!currentVideo) return;
    const prev = videoBefore(roots, currentVideo);
    if (prev) handleVideoTap(prev);
  }, [currentVideo, roots, handleVideoTap]);

  const restartFromBeginning = (node: FileNode) => {
    markUnwatched(node);
    Watched.clearProgress(node.path);
    setPendingWatched(null);
    if (currentVideo?.path === node.path) {
      currentTimeRef.current = 0;
      setAutoPlayIntent(true);
      setPlayNonce((n) => n + 1); // remount the player from the start
    } else {
      playVideo(node);
    }
  };

  const skipPendingToNext = (node: FileNode) => {
    setPendingWatched(null);
    const next = videoAfter(roots, node);
    if (!next) return;
    if (Watched.contains(next.path)) {
      setPendingWatched(next);
      playVideo(next, false);
    } else {
      playVideo(next);
    }
  };

  const onProgress = (seconds: number) => {
    currentTimeRef.current = seconds;
    if (!currentVideo || seconds <= 3) return;
    const now = performance.now();
    if (now - lastSavedRef.current < 5000) return;
    lastSavedRef.current = now;
    if (!Watched.contains(currentVideo.path))
      Watched.setProgress(currentVideo.path, seconds);
  };

  const acquireWake = async () => {
    wakeWantedRef.current = true;
    if (wakeLockRef.current || wakePendingRef.current) return;
    if (!("wakeLock" in navigator)) return;
    wakePendingRef.current = true;
    try {
      const sentinel = await navigator.wakeLock.request("screen");
      // The platform auto-releases while the document is hidden; clearing the
      // ref on that event is what lets a later play re-acquire it.
      sentinel.addEventListener("release", () => {
        if (wakeLockRef.current === sentinel) wakeLockRef.current = null;
      });
      wakeLockRef.current = sentinel;
      if (!wakeWantedRef.current) void releaseWake();
    } catch {
      /* best effort */
    } finally {
      wakePendingRef.current = false;
    }
  };
  const releaseWake = async () => {
    wakeWantedRef.current = false;
    const sentinel = wakeLockRef.current;
    wakeLockRef.current = null;
    try {
      await sentinel?.release();
    } catch {
      /* ignore */
    }
  };
  const onPlayingChange = (playing: boolean) => {
    if (playing) void acquireWake();
    else void releaseWake();
  };

  const changeSpeed = (value: number) => {
    setSpeed(value);
    setSpeedState(value);
  };

  // Stable callbacks for the player (it captures them once on mount).
  const cbRef = useRef({ handleEnded, onProgress, onPlayingChange, changeSpeed });
  cbRef.current = { handleEnded, onProgress, onPlayingChange, changeSpeed };
  const stableEnded = useCallback(() => cbRef.current.handleEnded(), []);
  const stableProgress = useCallback(
    (n: number) => cbRef.current.onProgress(n),
    []
  );
  const stablePlaying = useCallback(
    (b: boolean) => cbRef.current.onPlayingChange(b),
    []
  );
  const stableSpeed = useCallback((s: number) => cbRef.current.changeSpeed(s), []);

  // ---- folder loading / routing ------------------------------------------
  const openFolder = useCallback(
    async (path: string) => {
      persistProgress();
      void releaseWake();
      const name = path.split(/[\\/]/).filter(Boolean).pop() ?? path;
      // Token so a slow scan that resolves after a newer one is discarded
      // instead of overwriting the folder the user actually opened.
      const token = ++scanTokenRef.current;
      setIsLoading(true);
      setHasOpenedFolder(true);
      setCurrentVideo(null);
      setPendingWatched(null);
      setExpanded(new Set());
      let tree: FileNode[] = [];
      try {
        tree = await scanFolder(path);
      } catch (e) {
        console.error("scan_folder failed", e);
      }
      if (scanTokenRef.current !== token) return;
      setRoots(tree);
      setIsLoading(false);
      Recents.record(path, name);
      setRecentsVersion((v) => v + 1);
    },
    [persistProgress]
  );

  const selectFolder = useCallback(async () => {
    const path = await pickFolder();
    if (path) void openFolder(path);
  }, [openFolder]);

  const handleDrop = useCallback(
    (paths: string[]) => {
      void (async () => {
        for (const p of paths) {
          if (await pathExists(p)) {
            void openFolder(p);
            return;
          }
        }
      })();
    },
    [openFolder]
  );

  const goHome = useCallback(() => {
    persistProgress();
    void releaseWake();
    void setWindowTitle("Video Playlist Player");
    setCurrentVideo(null);
    setPendingWatched(null);
    setRoots([]);
    setHasOpenedFolder(false);
    setIsLoading(false);
  }, [persistProgress]);

  const toggleNotes = useCallback(() => setShowingNotes((s) => !s), []);

  // ---- global shortcuts (read latest actions via a ref) ------------------
  const apiRef = useRef({
    goHome,
    selectFolder,
    toggleNotes,
    playNext,
    playPrevious,
    handleDrop,
    seekBy: (d: number) => playerRef.current?.seekBy(d),
    hasOpenedFolder,
  });
  apiRef.current = {
    goHome,
    selectFolder,
    toggleNotes,
    playNext,
    playPrevious,
    handleDrop,
    seekBy: (d: number) => playerRef.current?.seekBy(d),
    hasOpenedFolder,
  };

  useEffect(() => {
    const isMac = navigator.platform.toLowerCase().includes("mac");
    const onKey = (e: KeyboardEvent) => {
      // Never steal editing keys (⌘←/⌘→ move the caret) from the notes field.
      const target = e.target as HTMLElement | null;
      if (
        target?.isContentEditable ||
        /^(input|textarea|select)$/i.test(target?.tagName ?? "")
      )
        return;
      const api = apiRef.current;
      const mod = isMac ? e.metaKey : e.ctrlKey;
      // Bare arrows scrub the current video; with the modifier they change video.
      if (!mod && !e.altKey && !e.shiftKey && api.hasOpenedFolder) {
        if (e.key === "ArrowRight") {
          e.preventDefault();
          return api.seekBy(SEEK_STEP);
        }
        if (e.key === "ArrowLeft") {
          e.preventDefault();
          return api.seekBy(-SEEK_STEP);
        }
      }
      if (!mod) return;
      const key = e.key.toLowerCase();
      if (api.hasOpenedFolder) {
        if (e.shiftKey && key === "h") return e.preventDefault(), api.goHome();
        if (key === "o") return e.preventDefault(), void api.selectFolder();
        if (key === "n") return e.preventDefault(), api.toggleNotes();
        if (e.key === "ArrowLeft") return e.preventDefault(), api.playPrevious();
        if (e.key === "ArrowRight") return e.preventDefault(), api.playNext();
      } else if (key === "o") {
        e.preventDefault();
        void api.selectFolder();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Registered once — re-subscribing per video would leave a window where the
  // async unlisten and the new listen overlap, double-handling or losing a drop.
  useEffect(() => {
    const unlisten = onFolderDrop({
      onOver: () => setDropping(true),
      onLeave: () => setDropping(false),
      onDrop: (paths) => apiRef.current.handleDrop(paths),
    });
    return () => {
      void unlisten.then((fn) => fn());
    };
  }, []);

  useEffect(() => {
    const onVisibility = () => {
      if (!document.hidden && wakeWantedRef.current) void acquireWake();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      void releaseWake();
    };
  }, []);

  useEffect(() => {
    window.addEventListener("beforeunload", persistProgress);
    return () => window.removeEventListener("beforeunload", persistProgress);
  }, [persistProgress]);

  // ---- render -------------------------------------------------------------
  if (!hasOpenedFolder) {
    return (
      <Home
        dropping={dropping}
        onOpenFolder={selectFolder}
        onOpenPath={openFolder}
        onChanged={() => {
          // Removing a folder wipes its marks in the store; mirror that here or
          // the sidebar keeps rendering checks the store no longer holds.
          setWatchedState(new Set(Watched.watched));
          setRecentsVersion((v) => v + 1);
        }}
      />
    );
  }

  const visibleRoots = filteredRoots(roots, hideWatched, watched);
  const hasNext = pendingWatched
    ? Boolean(videoAfter(roots, pendingWatched))
    : false;
  const resumeSeconds =
    currentVideo && autoPlayIntent
      ? Watched.getProgress(currentVideo.path) ?? 0
      : 0;

  return (
    <div className="flex h-full flex-col">
      <Toolbar
        currentVideo={currentVideo}
        hideWatched={hideWatched}
        autoplayNext={autoplayNext}
        showingNotes={showingNotes}
        speed={speed}
        onHome={goHome}
        onOpen={selectFolder}
        onToggleHideWatched={() => setHideWatched((v) => !v)}
        onToggleAutoplay={() => setAutoplayNext((v) => !v)}
        onChangeSpeed={changeSpeed}
        onToggleNotes={toggleNotes}
        onPrevious={playPrevious}
        onNext={playNext}
      />

      <div className="flex min-h-0 flex-1">
        <ResizablePanelGroup
          direction="horizontal"
          autoSaveId="vpp-split"
          className="min-h-0 flex-1"
        >
          <ResizablePanel id="sidebar" order={1} defaultSize={22} minSize={14} maxSize={40}>
            <Sidebar
              roots={visibleRoots}
              isLoading={isLoading}
              hideWatched={hideWatched}
              watched={watched}
              expanded={expanded}
              currentPath={currentVideo?.path ?? null}
              onToggleExpand={(path) =>
                setExpanded((prev) => {
                  const next = new Set(prev);
                  next.has(path) ? next.delete(path) : next.add(path);
                  return next;
                })
              }
              onPlay={handleVideoTap}
              onMarkWatched={markWatched}
              onMarkUnwatched={markUnwatched}
            />
          </ResizablePanel>

          <ResizableHandle />

          <ResizablePanel id="main" order={2} minSize={30}>
            <main className="relative flex h-full items-center justify-center overflow-hidden bg-black">
              {currentVideo ? (
                <Player
                  ref={playerRef}
                  key={`${currentVideo.path}#${playNonce}`}
                  path={currentVideo.path}
                  autoPlay={autoPlayIntent}
                  resumeSeconds={resumeSeconds}
                  speed={speed}
                  onEnded={stableEnded}
                  onProgress={stableProgress}
                  onPlayingChange={stablePlaying}
                  onSpeedChange={stableSpeed}
                />
              ) : (
                <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-background px-6 text-center text-muted-foreground">
                  <PlaySquare className="size-11 opacity-40" />
                  <div className="text-base font-semibold text-foreground">
                    No video selected
                  </div>
                  <div className="max-w-80 text-xs">
                    Choose a video from the sidebar to start playing.
                  </div>
                </div>
              )}

              {pendingWatched && (
                <WatchedBanner
                  video={pendingWatched}
                  hasNext={hasNext}
                  onSkip={() => skipPendingToNext(pendingWatched)}
                  onRestart={() => restartFromBeginning(pendingWatched)}
                />
              )}
            </main>
          </ResizablePanel>

          {showingNotes && <ResizableHandle key="notes-handle" />}
          {showingNotes && (
            <ResizablePanel
              id="notes"
              order={3}
              defaultSize={24}
              minSize={16}
              maxSize={40}
            >
              <NotesPanel video={currentVideo} />
            </ResizablePanel>
          )}
        </ResizablePanelGroup>
      </div>

      {dropping && (
        <div className="pointer-events-none fixed inset-2 z-40 rounded-xl border-2 border-dashed border-primary" />
      )}
    </div>
  );
}
