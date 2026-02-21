import { useState } from 'react';
import { TitleBar } from './TitleBar';
import { Sidebar } from './Sidebar';
import { VideoPlayer } from './VideoPlayer';
import { Timeline } from './Timeline';
import { GameEvents } from './GameEvents';
import { RecordingControls } from './RecordingControls';
import { Settings } from './Settings';
import { VideoProvider } from '../contexts/VideoContext';
import { RecordingProvider } from '../contexts/RecordingContext';
import { SettingsProvider } from '../contexts/SettingsContext';
import { MarkerProvider } from '../contexts/MarkerContext';

export function Layout() {
  const [currentView, setCurrentView] = useState<'main' | 'settings'>('main');

  return (
    <VideoProvider>
      <SettingsProvider>
        <MarkerProvider>
          <RecordingProvider>
            <div className="h-screen w-screen flex flex-col bg-neutral-900 text-neutral-200 overflow-hidden">
              <TitleBar />
              <div className="flex flex-1 min-h-0">
                <Sidebar 
                  onNavigate={setCurrentView}
                  currentView={currentView}
                />
                {currentView === 'main' ? (
                  <div className="flex-1 flex flex-col min-w-0">
                    <main className="flex-1 flex items-center justify-center bg-neutral-950">
                      <VideoPlayer />
                    </main>
                    <Timeline />
                    <RecordingControls />
                    <GameEvents />
                  </div>
                ) : (
                  <Settings onBack={() => setCurrentView('main')} />
                )}
              </div>
            </div>
          </RecordingProvider>
        </MarkerProvider>
      </SettingsProvider>
    </VideoProvider>
  );
}
