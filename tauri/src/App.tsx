import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  scanFolder,
  pathExists,
  pickFolder,
  onFolderDrop,
  setWindowTitle,
  type FileNode,
} from "@/lib/platform";
import {
  Watched,
  Notes,
  Recents,
  Playback,
  getSpeed,
  setSpeed,
  getShowDetails,
  setShowDetails,
} from "@/lib/store";
import {
  ancestorsOf,
  countVideos,
  filteredRoots,
  nextUnwatched,
  searchTree,
  videoAfter,
  videoBefore,
} from "@/lib/tree";
import { AppHeader } from "@/components/AppHeader";
import { Home } from "@/components/Home";
import { Sidebar } from "@/components/Sidebar";
import { PlayerArea } from "@/components/PlayerArea";
import { NotesPanel } from "@/components/NotesPanel";
import { WatchedBanner } from "@/components/WatchedBanner";
import { Player, type PlayerHandle } from "@/components/Player";
import { ShortcutsDialog } from "@/components/ShortcutsDialog";
import {
  ResizablePanelGroup,
  ResizablePanel,
  ResizableHandle,
} from "@/components/ui/resizable";
import type { ImperativePanelHandle } from "react-resizable-panels";

const SEEK_STEP = 5; // seconds per arrow press

export default function App() {
  const [roots, setRoots] = useState<FileNode[]>([]);
  const [rootPath, setRootPath] = useState<string | null>(null);
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
  const [query, setQuery] = useState("");
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [dropping, setDropping] = useState(false);
  const [showShortcuts, setShowShortcuts] = useState(false);
  const [showDetails, setShowDetailsState] = useState(getShowDetails());
  const [noted, setNoted] = useState<Set<string>>(new Set(Notes.paths()));
  const [, bumpRecents] = useState(0);

  const currentTimeRef = useRef(0);
  const lastSavedRef = useRef(0);
  const wakeLockRef = useRef<WakeLockSentinel | null>(null);
  const wakeWantedRef = useRef(false);
  const wakePendingRef = useRef(false);
  const scanTokenRef = useRef(0);
  const playerRef = useRef<PlayerHandle | null>(null);
  const sidebarPanelRef = useRef<ImperativePanelHandle | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const resumeTargetRef = useRef<string | null>(null);

  // ---- playback
  const persistProgress = useCallback(() => {
    if (!currentVideo || Watched.contains(currentVideo.path)) return;
    const t = currentTimeRef.current;
    if (Number.isFinite(t) && t > 3) Watched.setProgress(currentVideo.path, t);
  }, [currentVideo]);

  const basename = (p: string) => p.split(/[\\/]/).filter(Boolean).pop() ?? "";

  // Root-to-leaf folder names, so the breadcrumb shows the whole path rather
  // than just the folder the video sits in.
  const folderTrailFor = useCallback(
    (node: FileNode | null): string[] => {
      if (!node) return [];
      const ancestors = ancestorsOf(roots, node);
      if (ancestors.length === 0) return rootPath ? [basename(rootPath)] : [];
      return [...ancestors].reverse().map(basename);
    },
    [roots, rootPath]
  );

  const parentFolderName = useCallback(
    (node: FileNode | null) => folderTrailFor(node).at(-1) ?? "",
    [folderTrailFor]
  );

  const playVideo = useCallback(
    (node: FileNode, autoPlay = true) => {
      if (node.type !== "video") return;
      setExpanded((prev) => new Set([...prev, ...ancestorsOf(roots, node)]));
      persistProgress();
      currentTimeRef.current = 0;
      lastSavedRef.current = 0;
      setAutoPlayIntent(autoPlay);
      if (node.path === currentVideo?.path) setPlayNonce((n) => n + 1);
      else setCurrentVideo(node);
      void setWindowTitle(node.name);
      if (rootPath)
        Playback.setLastPlayed({
          path: node.path,
          name: node.name,
          folderName: parentFolderName(node),
          rootPath,
          at: Date.now(),
        });
    },
    [roots, currentVideo, persistProgress, rootPath, parentFolderName]
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
    currentTimeRef.current = 0;
    setAutoPlayIntent(true);
    if (currentVideo?.path === node.path) setPlayNonce((n) => n + 1);
    else playVideo(node);
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

  const onDuration = (seconds: number) => {
    if (currentVideo) Playback.setDuration(currentVideo.path, seconds);
  };

  const cbRef = useRef({
    handleEnded,
    onProgress,
    onPlayingChange,
    changeSpeed,
    onDuration,
  });
  cbRef.current = {
    handleEnded,
    onProgress,
    onPlayingChange,
    changeSpeed,
    onDuration,
  };
  const stableEnded = useCallback(() => cbRef.current.handleEnded(), []);
  const stableProgress = useCallback((n: number) => cbRef.current.onProgress(n), []);
  const stablePlaying = useCallback((b: boolean) => cbRef.current.onPlayingChange(b), []);
  const stableSpeed = useCallback((s: number) => cbRef.current.changeSpeed(s), []);
  const stableDuration = useCallback((s: number) => cbRef.current.onDuration(s), []);

  // ---- folder loading / routing
  const openFolder = useCallback(
    async (path: string) => {
      persistProgress();
      void releaseWake();
      const name = path.split(/[\\/]/).filter(Boolean).pop() ?? path;
      const token = ++scanTokenRef.current;
      setIsLoading(true);
      setHasOpenedFolder(true);
      setRootPath(path);
      setCurrentVideo(null);
      setPendingWatched(null);
      setExpanded(new Set());
      setQuery("");
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
      bumpRecents((v) => v + 1);

      // Resuming from the home screen: select the video once the tree is in.
      const target = resumeTargetRef.current;
      resumeTargetRef.current = null;
      if (target) {
        const stack = [...tree];
        while (stack.length) {
          const n = stack.pop()!;
          if (n.type === "video" && n.path === target) {
            handleVideoTap(n);
            break;
          }
          if (n.children) stack.push(...n.children);
        }
      }
    },
    [persistProgress, handleVideoTap]
  );

  const selectFolder = useCallback(async () => {
    const path = await pickFolder();
    if (path) void openFolder(path);
  }, [openFolder]);

  const resumeLast = useCallback(
    (root: string, videoPath: string) => {
      resumeTargetRef.current = videoPath;
      void openFolder(root);
    },
    [openFolder]
  );

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
    setRootPath(null);
    setHasOpenedFolder(false);
    setIsLoading(false);
    bumpRecents((v) => v + 1);
  }, [persistProgress]);

  const toggleNotes = useCallback(() => setShowingNotes((s) => !s), []);

  const focusSearch = useCallback(() => {
    sidebarPanelRef.current?.expand();
    setSidebarCollapsed(false);
    requestAnimationFrame(() => searchRef.current?.focus());
  }, []);

  // ---- global shortcuts
  const apiRef = useRef({
    goHome,
    selectFolder,
    toggleNotes,
    playNext,
    playPrevious,
    focusSearch,
    seekBy: (d: number) => playerRef.current?.seekBy(d),
    hasOpenedFolder,
  });
  apiRef.current = {
    goHome,
    selectFolder,
    toggleNotes,
    playNext,
    playPrevious,
    focusSearch,
    seekBy: (d: number) => playerRef.current?.seekBy(d),
    hasOpenedFolder,
  };

  useEffect(() => {
    const isMac = navigator.platform.toLowerCase().includes("mac");
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const editing =
        target?.isContentEditable ||
        /^(input|textarea|select)$/i.test(target?.tagName ?? "");
      const mod = isMac ? e.metaKey : e.ctrlKey;
      const api = apiRef.current;

      if (editing && e.key === "Escape") {
        (target as HTMLElement).blur();
        return;
      }
      if (editing) {
        if (mod && e.key.toLowerCase() === "k") {
          e.preventDefault();
          api.focusSearch();
        }
        return;
      }
      if (!mod && !e.altKey && !e.shiftKey && api.hasOpenedFolder) {
        if (e.key === "ArrowRight") return e.preventDefault(), api.seekBy(SEEK_STEP);
        if (e.key === "ArrowLeft") return e.preventDefault(), api.seekBy(-SEEK_STEP);
      }
      if (!mod) return;
      const key = e.key.toLowerCase();
      if (key === "o") return e.preventDefault(), void api.selectFolder();
      if (!api.hasOpenedFolder) return;
      if (e.shiftKey && key === "h") return e.preventDefault(), api.goHome();
      if (key === "k") return e.preventDefault(), api.focusSearch();
      if (key === "n") return e.preventDefault(), api.toggleNotes();
      if (e.key === "ArrowLeft") return e.preventDefault(), api.playPrevious();
      if (e.key === "ArrowRight") return e.preventDefault(), api.playNext();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    const unlisten = onFolderDrop({
      onOver: () => setDropping(true),
      onLeave: () => setDropping(false),
      onDrop: (paths) => handleDropRef.current(paths),
    });
    return () => {
      void unlisten.then((fn) => fn());
    };
  }, []);
  const handleDropRef = useRef(handleDrop);
  handleDropRef.current = handleDrop;

  useEffect(() => {
    const onVisibility = () => {
      if (!document.hidden && wakeWantedRef.current) void acquireWake();
    };
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("beforeunload", persistProgress);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("beforeunload", persistProgress);
      void releaseWake();
    };
  }, [persistProgress]);

  // ---- derived
  const searched = useMemo(() => searchTree(roots, query), [roots, query]);
  const visibleRoots = useMemo(
    () => filteredRoots(searched, hideWatched, watched),
    [searched, hideWatched, watched]
  );
  const totalVideos = useMemo(
    () => roots.reduce((n, r) => n + countVideos(r), 0),
    [roots]
  );
  const nextVideo = currentVideo ? videoAfter(roots, currentVideo) : null;
  const hasNext = pendingWatched ? Boolean(videoAfter(roots, pendingWatched)) : false;
  const resumeSeconds =
    currentVideo && autoPlayIntent ? Watched.getProgress(currentVideo.path) ?? 0 : 0;
  const rootName = rootPath?.split(/[\\/]/).filter(Boolean).pop() ?? "Library";

  return (
    <div className="flex h-full flex-col">
      <AppHeader canGoBack={hasOpenedFolder} onHome={goHome} onShowShortcuts={() => setShowShortcuts(true)} />

      {!hasOpenedFolder ? (
        <Home
          dropping={dropping}
          onOpenFolder={selectFolder}
          onOpenPath={openFolder}
          onResume={resumeLast}
          onChanged={() => {
            setWatchedState(new Set(Watched.watched));
            bumpRecents((v) => v + 1);
          }}
        />
      ) : (
        <div className="flex min-h-0 flex-1">
          <ResizablePanelGroup
            direction="horizontal"
            autoSaveId="vpp-split"
            className="min-h-0 flex-1"
          >
            <ResizablePanel
              id="sidebar"
              order={1}
              ref={sidebarPanelRef}
              defaultSize={22}
              minSize={14}
              maxSize={40}
              collapsible
              collapsedSize={0}
              onCollapse={() => setSidebarCollapsed(true)}
              onExpand={() => setSidebarCollapsed(false)}
            >
              <Sidebar
                rootName={rootName}
                roots={visibleRoots}
                totalVideos={totalVideos}
                isLoading={isLoading}
                hideWatched={hideWatched}
                watched={watched}
                noted={noted}
                expanded={expanded}
                currentPath={currentVideo?.path ?? null}
                query={query}
                searchRef={searchRef}
                onQueryChange={setQuery}
                onToggleHideWatched={() => setHideWatched((v) => !v)}
                onCollapse={() => sidebarPanelRef.current?.collapse()}
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
              <PlayerArea
                video={currentVideo}
                folderTrail={folderTrailFor(currentVideo)}
                watched={currentVideo ? watched.has(currentVideo.path) : false}
                nextVideo={nextVideo}
                autoplayNext={autoplayNext}
                showingNotes={showingNotes}
                hasNotes={currentVideo ? noted.has(currentVideo.path) : false}
                showDetails={showDetails}
                sidebarCollapsed={sidebarCollapsed}
                onHome={goHome}
                onExpandSidebar={() => sidebarPanelRef.current?.expand()}
                onNext={playNext}
                onToggleAutoplay={() => setAutoplayNext((v) => !v)}
                onToggleNotes={toggleNotes}
                onToggleDetails={() => {
                  const next = !showDetails;
                  setShowDetails(next);
                  setShowDetailsState(next);
                }}
              >
                {currentVideo && (
                  <>
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
                      onDuration={stableDuration}
                    />
                    {pendingWatched && (
                      <WatchedBanner
                        video={pendingWatched}
                        hasNext={hasNext}
                        onSkip={() => skipPendingToNext(pendingWatched)}
                        onRestart={() => restartFromBeginning(pendingWatched)}
                      />
                    )}
                  </>
                )}
              </PlayerArea>
            </ResizablePanel>

            {showingNotes && <ResizableHandle key="notes-handle" />}
            {showingNotes && (
              <ResizablePanel id="notes" order={3} defaultSize={24} minSize={16} maxSize={40}>
                <NotesPanel
                  video={currentVideo}
                  onNotesChange={() => setNoted(new Set(Notes.paths()))}
                />
              </ResizablePanel>
            )}
          </ResizablePanelGroup>
        </div>
      )}

      {dropping && hasOpenedFolder && (
        <div className="pointer-events-none fixed inset-2 z-40 rounded-xl border-2 border-dashed border-primary" />
      )}

      <ShortcutsDialog open={showShortcuts} onOpenChange={setShowShortcuts} />
    </div>
  );
}
