import { type ComponentType, type ReactElement, useId, useRef } from "react";

export interface TabControlItem<TValue extends string> {
  value: TValue;
  label: string;
  icon?: ComponentType<{ className?: string }>;
}

interface TabControlsProps<TValue extends string> {
  value: TValue;
  onChange: (nextValue: TValue) => void;
  items: TabControlItem<TValue>[];
  ariaLabel?: string;
  idBase?: string;
}

export function getNextTabIndex(
  currentIndex: number,
  itemCount: number,
  key: string,
): number | null {
  if (itemCount <= 0) {
    return null;
  }

  if (key === "ArrowRight" || key === "ArrowDown") {
    return (currentIndex + 1) % itemCount;
  }

  if (key === "ArrowLeft" || key === "ArrowUp") {
    return (currentIndex - 1 + itemCount) % itemCount;
  }

  if (key === "Home") {
    return 0;
  }

  if (key === "End") {
    return itemCount - 1;
  }

  return null;
}

export function TabControls<TValue extends string>({
  value,
  onChange,
  items,
  ariaLabel = "Tabs",
  idBase,
}: TabControlsProps<TValue>): ReactElement {
  const generatedId = useId();
  const baseId = idBase ?? `tab-controls-${generatedId}`;
  const tabRefs = useRef<Record<string, HTMLButtonElement | null>>({});

  return (
    <div className="border-b border-white/10 bg-(--surface-1) px-4 pt-2">
      <div className="-mb-px flex items-end gap-2" role="tablist" aria-label={ariaLabel}>
        {items.map(({ value: itemValue, label, icon: Icon }, index) => {
          const isActive = itemValue === value;
          const focusAdjacentTab = (nextIndex: number) => {
            const nextValue = items[nextIndex].value;
            onChange(nextValue);
            window.requestAnimationFrame(() => tabRefs.current[nextValue]?.focus());
          };
          const tabId = `${baseId}-${itemValue}-tab`;
          const panelId = `${baseId}-${itemValue}-panel`;

          return (
            <button
              key={itemValue}
              ref={(element) => {
                tabRefs.current[itemValue] = element;
              }}
              id={tabId}
              type="button"
              onClick={() => onChange(itemValue)}
              onKeyDown={(event) => {
                const nextIndex = getNextTabIndex(index, items.length, event.key);
                if (nextIndex === null) {
                  return;
                }

                event.preventDefault();
                focusAdjacentTab(nextIndex);
              }}
              role="tab"
              tabIndex={isActive ? 0 : -1}
              aria-selected={isActive}
              aria-controls={panelId}
              className={`inline-flex min-h-9 items-center gap-1.5 rounded-t-sm border border-b-0 px-3.5 py-2 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-300/60 ${
                isActive
                  ? "border-emerald-300/40 bg-(--surface-0) text-emerald-100"
                  : "border-white/15 bg-black/20 text-neutral-300 hover:bg-white/8 hover:text-neutral-100"
              }`}
            >
              {Icon && <Icon className="h-3.5 w-3.5" />}
              {label}
            </button>
          );
        })}
      </div>
    </div>
  );
}
