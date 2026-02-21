import { useEffect, useState } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { TitleBar } from './TitleBar';
import { Sidebar } from './Sidebar';
import { VideoPlayer } from './VideoPlayer';
import { GameEvents } from './GameEvents';
import { RecordingControls } from './RecordingControls';
import { RecordingsList } from './RecordingsList';
import { Settings } from './Settings';
import { VideoProvider } from '../contexts/VideoContext';
import { RecordingProvider } from '../contexts/RecordingContext';
import { SettingsProvider } from '../contexts/SettingsContext';
import { MarkerProvider } from '../contexts/MarkerContext';
import { panelVariants, smoothTransition } from '../lib/motion';

export function Layout() {
  const [currentView, setCurrentView] = useState<'main' | 'settings'>('main');
  const [isResizingMedia, setIsResizingMedia] = useState(false);
  const [mediaSectionHeight, setMediaSectionHeight] = useState(() =>
    typeof window === 'undefined' ? 520 : Math.round(window.innerHeight * 0.52),
  );
  const reduceMotion = useReducedMotion();

  const clampMediaSectionHeight = (height: number, viewportHeight: number) => {
    const minHeight = 320;
    const maxHeight = Math.max(minHeight, Math.round(viewportHeight * 0.58));
    return Math.min(maxHeight, Math.max(minHeight, height));
  };

  useEffect(() => {
    const handleWindowResize = () => {
      setMediaSectionHeight((currentHeight) =>
        clampMediaSectionHeight(currentHeight, window.innerHeight),
      );
    };

    handleWindowResize();
    window.addEventListener('resize', handleWindowResize);
    return () => {
      window.removeEventListener('resize', handleWindowResize);
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
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', handlePointerEnd);
      window.removeEventListener('pointercancel', handlePointerEnd);
    };

    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', handlePointerEnd);
    window.addEventListener('pointercancel', handlePointerEnd);
  };

  return (
    <VideoProvider>
      <SettingsProvider>
        <MarkerProvider>
          <RecordingProvider>
            <div className="h-screen w-screen flex flex-col bg-neutral-950 text-neutral-100 overflow-hidden">
              <TitleBar />
              <div className="flex flex-1 min-h-0">
                <Sidebar 
                  onNavigate={setCurrentView}
                  currentView={currentView}
                />
                <AnimatePresence mode="wait" initial={false}>
                  {currentView === 'main' ? (
                    <motion.div
                      key="main-view"
                      className={`flex-1 flex flex-col min-w-0 ${isResizingMedia ? 'select-none' : ''}`}
                      variants={panelVariants}
                      initial={reduceMotion ? false : 'initial'}
                      animate="animate"
                      exit={reduceMotion ? undefined : 'exit'}
                      transition={smoothTransition}
                    >
                      <section
                        className="flex w-full shrink-0 flex-col overflow-hidden"
                        style={{ height: mediaSectionHeight }}
                      >
                        <main className="flex-1 min-h-0 overflow-hidden flex items-center justify-center bg-neutral-950/95">
                          <VideoPlayer />
                        </main>
                        <RecordingControls />
                      </section>
                      <div
                        className={`flex h-3 w-full cursor-row-resize items-center justify-center border-t border-neutral-800/80 bg-neutral-900 ${
                          isResizingMedia ? 'bg-neutral-800/90' : 'hover:bg-neutral-800/70'
                        }`}
                        onPointerDown={handleMediaResizeStart}
                        role="separator"
                        aria-orientation="horizontal"
                        aria-label="Resize media section"
                      >
                        <div className="h-0.5 w-24 rounded-full bg-neutral-600" />
                      </div>
                      <RecordingsList />
                      <GameEvents />
                    </motion.div>
                  ) : (
                    <motion.div
                      key="settings-view"
                      className="h-full flex-1 min-w-0 min-h-0 flex flex-col"
                      variants={panelVariants}
                      initial={reduceMotion ? false : 'initial'}
                      animate="animate"
                      exit={reduceMotion ? undefined : 'exit'}
                      transition={smoothTransition}
                    >
                      <Settings onBack={() => setCurrentView('main')} />
                    </motion.div>
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
