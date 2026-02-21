import { useState } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { TitleBar } from './TitleBar';
import { Sidebar } from './Sidebar';
import { VideoPlayer } from './VideoPlayer';
import { Timeline } from './Timeline';
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
  const reduceMotion = useReducedMotion();

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
                      className="flex-1 flex flex-col min-w-0"
                      variants={panelVariants}
                      initial={reduceMotion ? false : 'initial'}
                      animate="animate"
                      exit={reduceMotion ? undefined : 'exit'}
                      transition={smoothTransition}
                    >
                      <main className="flex-1 flex items-center justify-center bg-neutral-950/95">
                        <VideoPlayer />
                      </main>
                      <Timeline />
                      <RecordingControls />
                      <RecordingsList />
                      <GameEvents />
                    </motion.div>
                  ) : (
                    <motion.div
                      key="settings-view"
                      className="flex-1 min-w-0"
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
