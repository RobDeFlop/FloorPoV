import { createContext, ReactNode, useContext, useState, useCallback, useMemo } from "react";
import { GameEvent, isNpcKind } from "../types/events";

interface MarkerContextType {
  events: GameEvent[];
  filteredEvents: GameEvent[];
  hideNpcEvents: boolean;
  addEvent: (event: GameEvent) => void;
  setEvents: (events: GameEvent[]) => void;
  setHideNpcEvents: (hide: boolean) => void;
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
  const [hideNpcEvents, setHideNpcEvents] = useState(true);

  const filteredEvents = useMemo(() => {
    if (!hideNpcEvents) return events;
    return events.filter((event) => !isNpcKind(event.targetKind, event.target));
  }, [events, hideNpcEvents]);

  const addEvent = useCallback((event: GameEvent) => {
    setEvents((previousEvents) => insertEventByTimestamp(previousEvents, event));
  }, []);

  const replaceEvents = useCallback((nextEvents: GameEvent[]) => {
    setEvents(sortEventsByTimestamp(nextEvents));
  }, []);

  const clearEvents = useCallback(() => {
    setEvents([]);
  }, []);

  return (
    <MarkerContext.Provider
      value={{
        events,
        filteredEvents,
        hideNpcEvents,
        addEvent,
        setEvents: replaceEvents,
        setHideNpcEvents,
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
