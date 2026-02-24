import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { TitleBar } from "./TitleBar";
import { Sidebar } from "./Sidebar";
import { GameModePage } from "../gamemodes/GameModePage";
import { VideoPlayer } from "../playback/VideoPlayer";

import { RecordingsList } from "../playback/RecordingsList";
import { Settings } from "../settings/Settings";
import { CombatLogDebug } from "../debug/CombatLogDebug";
import { VideoProvider } from "../../contexts/VideoContext";
import { RecordingProvider } from "../../contexts/RecordingContext";
import { SettingsProvider } from "../../contexts/SettingsContext";
import { MarkerProvider } from "../../contexts/MarkerContext";
import { panelVariants, smoothTransition } from "../../lib/motion";
import { MEDIA_SECTION_RESIZE_DELTA } from "../../types/settings";

type AppView = "main" | "settings" | "debug" | "mythic-plus" | "raid" | "pvp";
const GAME_MODE_VIEWS = new Set<AppView>(["mythic-plus", "raid", "pvp"]);

export function Layout() {
  const [currentView, setCurrentView] = useState<AppView>("main");
  const [gameModeNavigationVersion, setGameModeNavigationVersion] = useState(0);
  const [isDebugBuild, setIsDebugBuild] = useState(false);
  const [isResizingMedia, setIsResizingMedia] = useState(false);
  const [mediaSectionHeight, setMediaSectionHeight] = useState(() =>
    typeof window === "undefined" ? 520 : Math.round(window.innerHeight * 0.52),
  );
  const reduceMotion = useReducedMotion();
  const mediaSectionMaxHeight =
    typeof window === "undefined" ? 320 : Math.max(320, Math.round(window.innerHeight * 0.66));

  const clampMediaSectionHeight = (height: number, viewportHeight: number) => {
    const minHeight = 320;
    const maxHeight = Math.max(minHeight, Math.round(viewportHeight * 0.66));
    return Math.min(maxHeight, Math.max(minHeight, height));
  };

  useEffect(() => {
    const loadDebugFlag = async () => {
      try {
        const debugEnabled = await invoke<boolean>("is_debug_build");
        setIsDebugBuild(debugEnabled);
      } catch (error) {
        console.error("Failed to load debug build flag:", error);
        setIsDebugBuild(false);
      }
    };

    loadDebugFlag();
  }, []);

  useEffect(() => {
    if (!isDebugBuild && currentView === "debug") {
      setCurrentView("main");
    }
  }, [currentView, isDebugBuild]);

  useEffect(() => {
    const handleWindowResize = () => {
      setMediaSectionHeight((currentHeight) =>
        clampMediaSectionHeight(currentHeight, window.innerHeight),
      );
    };

    handleWindowResize();
    window.addEventListener("resize", handleWindowResize);
    return () => {
      window.removeEventListener("resize", handleWindowResize);
    };
  }, []);

  const handleMediaResizeStart = (event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    setIsResizingMedia(true);

    const startY = event.clientY;
    const startHeight = mediaSectionHeight;

    const handlePointerMove = (moveEvent: PointerEvent) => {
      const deltaY = moveEvent.clientY - startY;
      const targetHeight = startHeight + deltaY;
      setMediaSectionHeight(clampMediaSectionHeight(targetHeight, window.innerHeight));
    };

    const handlePointerEnd = () => {
      setIsResizingMedia(false);
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerEnd);
      window.removeEventListener("pointercancel", handlePointerEnd);
    };

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerEnd);
    window.addEventListener("pointercancel", handlePointerEnd);
  };

  const adjustMediaSectionHeight = (delta: number) => {
    setMediaSectionHeight((currentHeight) => {
      return clampMediaSectionHeight(currentHeight + delta, window.innerHeight);
    });
  };

  const handleNavigate = (view: AppView) => {
    setCurrentView(view);

    if (GAME_MODE_VIEWS.has(view)) {
      setGameModeNavigationVersion((currentVersion) => currentVersion + 1);
    }
  };

  return (
    <VideoProvider>
      <SettingsProvider>
        <MarkerProvider>
          <RecordingProvider>
            <div className="h-screen w-screen flex flex-col bg-neutral-950 text-neutral-100 overflow-hidden">
              <TitleBar />
              <div className="flex flex-1 min-h-0 flex-col gap-2 p-2 md:flex-row md:gap-3 md:p-3">
                <Sidebar 
                  onNavigate={handleNavigate}
                  currentView={currentView}
                  isDebugMode={isDebugBuild}
                />
                <AnimatePresence mode="wait" initial={false}>
                  {currentView === "main" ? (
                    <motion.div
                      key="main-view"
                      className={`flex-1 flex flex-col min-w-0 rounded-md border border-white/10 bg-(--surface-1) shadow-(--surface-glow) overflow-hidden ${isResizingMedia ? "select-none" : ""}`}
                      variants={panelVariants}
                      initial={reduceMotion ? false : "initial"}
                      animate="animate"
                      exit={reduceMotion ? undefined : "exit"}
                      transition={smoothTransition}
                    >
                       <section
                         className="flex w-full shrink-0 flex-col overflow-hidden"
                         style={{ height: mediaSectionHeight }}
                       >
                         <main className="flex-1 min-h-0 overflow-hidden flex items-center justify-center bg-neutral-950/70">
                           <VideoPlayer />
                         </main>
                       </section>
                      <div
                        className={`flex h-3 w-full cursor-row-resize items-center justify-center border-y border-white/10 bg-(--surface-2) focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/45 ${
                          isResizingMedia ? "bg-white/10" : "hover:bg-white/5"
                        }`}
                        onPointerDown={handleMediaResizeStart}
                        onKeyDown={(event) => {
                          if (event.key === "ArrowUp") {
                            event.preventDefault();
                            adjustMediaSectionHeight(-MEDIA_SECTION_RESIZE_DELTA);
                            return;
                          }

                          if (event.key === "ArrowDown") {
                            event.preventDefault();
                            adjustMediaSectionHeight(MEDIA_SECTION_RESIZE_DELTA);
                          }
                        }}
                        role="separator"
                        aria-orientation="horizontal"
                        aria-label="Resize media section"
                        aria-valuemin={320}
                        aria-valuenow={mediaSectionHeight}
                        aria-valuemax={mediaSectionMaxHeight}
                        aria-valuetext={`${mediaSectionHeight}px`}
                        tabIndex={0}
                      >
                        <div className="h-0.5 w-24 rounded-full bg-white/35" />
                      </div>
                      <RecordingsList />
                    </motion.div>
                  ) : currentView === "settings" ? (
                    <motion.div
                      key="settings-view"
                      className="h-full flex-1 min-w-0 min-h-0 flex flex-col rounded-md border border-white/10 bg-(--surface-1) shadow-(--surface-glow) overflow-hidden"
                      variants={panelVariants}
                      initial={reduceMotion ? false : "initial"}
                      animate="animate"
                      exit={reduceMotion ? undefined : "exit"}
                      transition={smoothTransition}
                    >
                      <Settings />
                    </motion.div>
      ) : currentView === "mythic-plus" ? (
        <motion.div
          key="mythic-plus-view"
          className="h-full flex-1 min-w-0 min-h-0 flex flex-col rounded-md border border-white/10 bg-(--surface-1) shadow-(--surface-glow) overflow-hidden"
          variants={panelVariants}
          initial={reduceMotion ? false : "initial"}
          animate="animate"
          exit={reduceMotion ? undefined : "exit"}
          transition={smoothTransition}
        >
          <GameModePage
            key={`mythic-plus-page-${gameModeNavigationVersion}`}
            gameMode="mythic-plus"
          />
        </motion.div>
      ) : currentView === "raid" ? (
        <motion.div
          key="raid-view"
          className="h-full flex-1 min-w-0 min-h-0 flex flex-col rounded-md border border-white/10 bg-(--surface-1) shadow-(--surface-glow) overflow-hidden"
          variants={panelVariants}
          initial={reduceMotion ? false : "initial"}
          animate="animate"
          exit={reduceMotion ? undefined : "exit"}
          transition={smoothTransition}
        >
          <GameModePage key={`raid-page-${gameModeNavigationVersion}`} gameMode="raid" />
        </motion.div>
      ) : currentView === "pvp" ? (
        <motion.div
          key="pvp-view"
          className="h-full flex-1 min-w-0 min-h-0 flex flex-col rounded-md border border-white/10 bg-(--surface-1) shadow-(--surface-glow) overflow-hidden"
          variants={panelVariants}
          initial={reduceMotion ? false : "initial"}
          animate="animate"
          exit={reduceMotion ? undefined : "exit"}
          transition={smoothTransition}
        >
          <GameModePage key={`pvp-page-${gameModeNavigationVersion}`} gameMode="pvp" />
        </motion.div>
      ) : (
        <CombatLogDebug />
      )}
                </AnimatePresence>
              </div>
            </div>
          </RecordingProvider>
        </MarkerProvider>
      </SettingsProvider>
    </VideoProvider>
  );
}
