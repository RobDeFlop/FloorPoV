import { TitleBar } from "./TitleBar";
import { Sidebar } from "./Sidebar";
import { VideoPlayer } from "./VideoPlayer";
import { Timeline } from "./Timeline";
import { GameEvents } from "./GameEvents";
import { VideoProvider } from "../contexts/VideoContext";

export function Layout() {
  return (
    <VideoProvider>
      <div className="h-screen w-screen flex flex-col bg-neutral-900 text-neutral-200 overflow-hidden">
        <TitleBar />
        <div className="flex flex-1 min-h-0">
          <Sidebar />
          <div className="flex-1 flex flex-col min-w-0">
            <main className="flex-1 flex items-center justify-center bg-neutral-950">
              <VideoPlayer />
            </main>
            <Timeline />
            <GameEvents />
          </div>
        </div>
      </div>
    </VideoProvider>
  );
}
