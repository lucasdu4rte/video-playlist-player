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
import { Player } from "@/components/Player";
import {
  ResizablePanelGroup,
  ResizablePanel,
  ResizableHandle,
} from "@/components/ui/resizable";
import { PlaySquare } from "lucide-react";

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

  // ---- playback -----------------------------------------------------------
  const persistProgress = useCallback(() => {
    if (!currentVideo || watched.has(currentVideo.path)) return;
    const t = currentTimeRef.current;
    if (Number.isFinite(t) && t > 3) Watched.setProgress(currentVideo.path, t);
  }, [currentVideo, watched]);

  const playVideo = useCallback(
    (node: FileNode, autoPlay = true) => {
      if (node.type !== "video" || node.path === currentVideo?.path) return;
      const ancestors = ancestorsOf(roots, node);
      setExpanded((prev) => new Set([...prev, ...ancestors]));
      persistProgress();
      currentTimeRef.current = 0;
      lastSavedRef.current = 0;
      setAutoPlayIntent(autoPlay);
      setCurrentVideo(node);
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
    try {
      if (!wakeLockRef.current && "wakeLock" in navigator)
        wakeLockRef.current = await navigator.wakeLock.request("screen");
    } catch {
      /* best effort */
    }
  };
  const releaseWake = async () => {
    try {
      await wakeLockRef.current?.release();
    } catch {
      /* ignore */
    }
    wakeLockRef.current = null;
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
  const cbRef = useRef({ handleEnded, onProgress, onPlayingChange });
  cbRef.current = { handleEnded, onProgress, onPlayingChange };
  const stableEnded = useCallback(() => cbRef.current.handleEnded(), []);
  const stableProgress = useCallback(
    (n: number) => cbRef.current.onProgress(n),
    []
  );
  const stablePlaying = useCallback(
    (b: boolean) => cbRef.current.onPlayingChange(b),
    []
  );

  // ---- folder loading / routing ------------------------------------------
  const openFolder = useCallback(async (path: string) => {
    persistProgress();
    const name = path.split(/[\\/]/).filter(Boolean).pop() ?? path;
    setIsLoading(true);
    setHasOpenedFolder(true);
    setCurrentVideo(null);
    setPendingWatched(null);
    setExpanded(new Set());
    const tree = await scanFolder(path);
    setRoots(tree);
    setIsLoading(false);
    Recents.record(path, name);
    setRecentsVersion((v) => v + 1);
  }, [persistProgress]);

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
    hasOpenedFolder,
  });
  apiRef.current = {
    goHome,
    selectFolder,
    toggleNotes,
    playNext,
    playPrevious,
    hasOpenedFolder,
  };

  useEffect(() => {
    const isMac = navigator.platform.toLowerCase().includes("mac");
    const onKey = (e: KeyboardEvent) => {
      const mod = isMac ? e.metaKey : e.ctrlKey;
      if (!mod) return;
      const api = apiRef.current;
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

  useEffect(() => {
    const unlisten = onFolderDrop({
      onOver: () => setDropping(true),
      onLeave: () => setDropping(false),
      onDrop: handleDrop,
    });
    return () => {
      void unlisten.then((fn) => fn());
    };
  }, [handleDrop]);

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
        onChanged={() => setRecentsVersion((v) => v + 1)}
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
                  key={`${currentVideo.path}#${playNonce}`}
                  path={currentVideo.path}
                  autoPlay={autoPlayIntent}
                  resumeSeconds={resumeSeconds}
                  speed={speed}
                  onEnded={stableEnded}
                  onProgress={stableProgress}
                  onPlayingChange={stablePlaying}
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
