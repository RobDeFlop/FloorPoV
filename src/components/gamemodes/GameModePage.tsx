import { ArrowLeft, Sword, Shield, Trophy } from "lucide-react";
import { RecordingsList } from "../playback/RecordingsList";
import { Button } from "../ui/Button";

interface GameModePageProps {
  gameMode: "mythic-plus" | "raid" | "pvp";
  onBack: () => void;
}

const gameModeConfig = {
  "mythic-plus": {
    title: "Mythic+ Recordings",
    description: "Recordings from Mythic+ dungeon runs",
    icon: Sword,
    filterKeywords: ["mythic", "dungeon", "m+"],
  },
  "raid": {
    title: "Raid Recordings", 
    description: "Recordings from raid encounters",
    icon: Shield,
    filterKeywords: ["raid", "boss"],
  },
  "pvp": {
    title: "PvP Recordings",
    description: "Recordings from PvP activities",
    icon: Trophy,
    filterKeywords: ["pvp", "arena", "battleground", "bg"],
  },
};

export function GameModePage({ gameMode, onBack }: GameModePageProps) {
  const config = gameModeConfig[gameMode];
  const Icon = config.icon;

  return (
    <div className="flex h-full flex-col">
      <header className="border-b border-white/10 bg-[var(--surface-1)] px-4 py-3">
        <div className="flex items-center gap-3">
          <Button
            variant="ghost"
            onClick={onBack}
            className="h-8 w-8 p-0"
            ariaLabel="Back to main view"
          >
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <div className="flex items-center gap-2">
            <Icon className="h-5 w-5 text-neutral-300" />
            <div>
              <h1 className="text-sm font-medium text-neutral-100">{config.title}</h1>
              <p className="text-xs text-neutral-400">{config.description}</p>
            </div>
          </div>
        </div>
      </header>
      
      <div className="flex-1 min-h-0">
        <RecordingsList />
      </div>
    </div>
  );
}