// Shared UI-level types used across multiple components.

/** The three WoW game modes the app tracks recordings for. */
export type GameMode = "mythic-plus" | "raid" | "pvp";

/** All navigable views in the app shell. */
export type AppView = "main" | "settings" | "warcraftlogs" | "debug" | GameMode;
