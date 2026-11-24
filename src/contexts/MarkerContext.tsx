import { createContext, ReactNode, useContext, useState, useCallback, useMemo } from "react";
import {
  GameEvent,
  GameEventType,
  RecordingEncounterMetadata,
  RecordingPlayerMetadata,
  shouldPromptManualMarkerName,
  shouldShowGameEvent,
} from "../types/events";

const DEFAULT_EVENT_TYPE_VISIBILITY: Record<GameEventType, boolean> = {
  death: true,
  manual: true,
  bloodlust: true,
  encounterStart: true,
  encounterEnd: true,
  note: true,
};

interface MarkerContextType {
  events: GameEvent[];
  filteredEvents: GameEvent[];
  encounters: RecordingEncounterMetadata[];
  players: RecordingPlayerMetadata[];
  hideNpcEvents: boolean;
  eventTypeVisibility: Record<GameEventType, boolean>;
  addEvent: (event: GameEvent) => void;
  updateEvent: (eventId: string, nextEvent: GameEvent) => void;
  removeEvent: (eventId: string) => void;
  setEvents: (events: GameEvent[]) => void;
  setEncounters: (encounters: RecordingEncounterMetadata[]) => void;
  setPlayers: (players: RecordingPlayerMetadata[]) => void;
  setHideNpcEvents: (hide: boolean) => void;
  toggleEventTypeVisibility: (type: GameEventType) => void;
  updateEventName: (eventId: string, name: string | undefined) => void;
  pendingRenameEventId: string | null;
  clearPendingRename: () => void;
  clearEvents: () => void;
}

const MarkerContext = createContext<MarkerContextType | undefined>(undefined);

function sortEventsByTimestamp(unsortedEvents: GameEvent[]): GameEvent[] {
  return [...unsortedEvents].sort((a, b) => a.timestamp - b.timestamp);
}

function insertEventByTimestamp(sortedEvents: GameEvent[], nextEvent: GameEvent): GameEvent[] {
  if (
    sortedEvents.length === 0 ||
    sortedEvents[sortedEvents.length - 1].timestamp <= nextEvent.timestamp
  ) {
    return [...sortedEvents, nextEvent];
  }

  let low = 0;
  let high = sortedEvents.length;

  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (sortedEvents[middle].timestamp <= nextEvent.timestamp) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }

  const nextEvents = [...sortedEvents];
  nextEvents.splice(low, 0, nextEvent);
  return nextEvents;
}

export function MarkerProvider({ children }: { children: ReactNode }) {
  const [events, setEvents] = useState<GameEvent[]>([]);
  const [encounters, setEncounters] = useState<RecordingEncounterMetadata[]>([]);
  const [players, setPlayers] = useState<RecordingPlayerMetadata[]>([]);
  const [hideNpcEvents, setHideNpcEvents] = useState(true);
  const [eventTypeVisibility, setEventTypeVisibility] = useState(DEFAULT_EVENT_TYPE_VISIBILITY);
  const [pendingRenameEventId, setPendingRenameEventId] = useState<string | null>(null);

  const filteredEvents = useMemo(() => {
    return events.filter((event) => shouldShowGameEvent(event, hideNpcEvents, eventTypeVisibility));
  }, [events, hideNpcEvents, eventTypeVisibility]);

  const toggleEventTypeVisibility = useCallback((type: GameEventType) => {
    setEventTypeVisibility((currentVisibility) => ({
      ...currentVisibility,
      [type]: !currentVisibility[type],
    }));
  }, []);

  const addEvent = useCallback((event: GameEvent) => {
    setEvents((previousEvents) => insertEventByTimestamp(previousEvents, event));
    if (event.type === "manual" && shouldPromptManualMarkerName()) {
      setPendingRenameEventId(event.id);
    }
  }, []);

  const updateEvent = useCallback((eventId: string, nextEvent: GameEvent) => {
    setEvents((previousEvents) => {
      const remainingEvents = previousEvents.filter((event) => event.id !== eventId);
      return insertEventByTimestamp(remainingEvents, nextEvent);
    });
  }, []);

  const removeEvent = useCallback((eventId: string) => {
    setEvents((previousEvents) => previousEvents.filter((event) => event.id !== eventId));
  }, []);

  const replaceEvents = useCallback((nextEvents: GameEvent[]) => {
    setEvents(sortEventsByTimestamp(nextEvents));
    setPendingRenameEventId(null);
  }, []);

  const updateEventName = useCallback((eventId: string, name: string | undefined) => {
    setEvents((previousEvents) =>
      previousEvents.map((event) => (event.id === eventId ? { ...event, name } : event)),
    );
  }, []);

  const clearPendingRename = useCallback(() => {
    setPendingRenameEventId(null);
  }, []);

  const clearEvents = useCallback(() => {
    setEvents([]);
    setEncounters([]);
    setPlayers([]);
    setPendingRenameEventId(null);
  }, []);

  return (
    <MarkerContext.Provider
      value={{
        events,
        filteredEvents,
        encounters,
        players,
        hideNpcEvents,
        eventTypeVisibility,
        addEvent,
        updateEvent,
        removeEvent,
        setEvents: replaceEvents,
        setEncounters,
        setPlayers,
        setHideNpcEvents,
        toggleEventTypeVisibility,
        updateEventName,
        pendingRenameEventId,
        clearPendingRename,
        clearEvents,
      }}
    >
      {children}
    </MarkerContext.Provider>
  );
}

export function useMarker() {
  const context = useContext(MarkerContext);
  if (!context) {
    throw new Error("useMarker must be used within MarkerProvider");
  }
  return context;
}
