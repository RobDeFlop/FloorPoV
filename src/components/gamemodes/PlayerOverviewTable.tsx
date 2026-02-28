import { useMemo } from "react";
import { RecordingPlayerMetadata } from "../../types/events";

type PlayerRole = "Tank" | "Healer" | "DPS" | "Unknown";

const TANK_SPEC_IDS = new Set([66, 73, 104, 250, 268, 581]);
const HEALER_SPEC_IDS = new Set([65, 105, 256, 257, 264, 270, 1468]);
const TANK_SPEC_NAMES = new Set(["protection", "guardian", "blood", "brewmaster", "vengeance"]);
const HEALER_SPEC_NAMES = new Set([
  "holy",
  "restoration",
  "discipline",
  "mistweaver",
  "preservation",
]);
const ROLE_SORT_ORDER: Record<PlayerRole, number> = {
  Tank: 0,
  Healer: 1,
  DPS: 2,
  Unknown: 3,
};

function getPlayerOverviewName(player: RecordingPlayerMetadata): string {
  const trimmedName = player.name?.trim();
  if (trimmedName) {
    return trimmedName;
  }

  if (player.guid.length > 24) {
    return `${player.guid.slice(0, 24)}...`;
  }

  return player.guid;
}

function getPlayerRole(player: RecordingPlayerMetadata): PlayerRole {
  const specId = player.specId;
  if (typeof specId === "number") {
    if (TANK_SPEC_IDS.has(specId)) {
      return "Tank";
    }
    if (HEALER_SPEC_IDS.has(specId)) {
      return "Healer";
    }
    if (specId > 0) {
      return "DPS";
    }
  }

  const specName = player.specName?.trim().toLowerCase();
  if (!specName) {
    return "Unknown";
  }

  if (TANK_SPEC_NAMES.has(specName)) {
    return "Tank";
  }
  if (HEALER_SPEC_NAMES.has(specName)) {
    return "Healer";
  }

  return "DPS";
}

function getRoleBadgeClasses(role: PlayerRole): string {
  switch (role) {
    case "Tank":
      return "border-sky-400/35 bg-sky-400/15 text-sky-200";
    case "Healer":
      return "border-emerald-400/35 bg-emerald-400/15 text-emerald-200";
    case "DPS":
      return "border-rose-400/35 bg-rose-400/15 text-rose-200";
    default:
      return "border-white/20 bg-white/8 text-neutral-300";
  }
}

function getRoleSortOrder(role: PlayerRole): number {
  return ROLE_SORT_ORDER[role];
}

interface PlayerOverviewTableProps {
  players: RecordingPlayerMetadata[];
}

export function PlayerOverviewTable({ players }: PlayerOverviewTableProps) {
  const sortedPlayers = useMemo(() => {
    return [...players].sort((left, right) => {
      const roleDiff = getRoleSortOrder(getPlayerRole(left)) - getRoleSortOrder(getPlayerRole(right));
      if (roleDiff !== 0) {
        return roleDiff;
      }

      const leftName = getPlayerOverviewName(left);
      const rightName = getPlayerOverviewName(right);
      return leftName.localeCompare(rightName);
    });
  }, [players]);

  if (sortedPlayers.length === 0) {
    return (
      <p className="mt-2 text-xs text-neutral-500">
        No COMBATANT_INFO player data is available for this recording.
      </p>
    );
  }

  return (
    <div className="mt-2 overflow-hidden rounded-sm border border-white/10 bg-black/20">
      <table className="min-w-full text-left text-xs text-neutral-300">
        <thead className="bg-(--surface-2) text-neutral-400">
          <tr>
            <th className="px-2 py-1.5 font-medium">Player</th>
            <th className="px-2 py-1.5 font-medium">Class</th>
            <th className="px-2 py-1.5 font-medium">Spec</th>
          </tr>
        </thead>
        <tbody>
          {sortedPlayers.map((player) => {
            const role = getPlayerRole(player);

            return (
              <tr key={player.guid} className="border-t border-white/10">
                <td className="px-2 py-1.5 text-neutral-100">
                  <div className="inline-flex items-center gap-2">
                    <span
                      className={`inline-flex items-center rounded-sm border px-1.5 py-0.5 text-[11px] font-medium ${getRoleBadgeClasses(role)}`}
                    >
                      {role}
                    </span>
                    <span>{getPlayerOverviewName(player)}</span>
                  </div>
                </td>
                <td className="px-2 py-1.5 text-neutral-300">{player.className || "Unknown"}</td>
                <td className="px-2 py-1.5 text-neutral-300">{player.specName || "Unknown"}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
