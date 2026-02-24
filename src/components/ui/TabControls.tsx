import { type ComponentType, useId } from "react";

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

export function TabControls<TValue extends string>({
  value,
  onChange,
  items,
  ariaLabel = "Tabs",
  idBase,
}: TabControlsProps<TValue>) {
  const generatedId = useId();
  const baseId = idBase ?? `tab-controls-${generatedId}`;

  return (
    <div className="border-b border-white/10 bg-(--surface-1) px-4 pt-2">
      <div className="-mb-px flex items-end gap-2" role="tablist" aria-label={ariaLabel}>
        {items.map(({ value: itemValue, label, icon: Icon }) => {
          const isActive = itemValue === value;
          const tabId = `${baseId}-${itemValue}-tab`;
          const panelId = `${baseId}-${itemValue}-panel`;

          return (
            <button
              key={itemValue}
              id={tabId}
              type="button"
              onClick={() => onChange(itemValue)}
              role="tab"
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
