import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Check, ChevronDown } from "lucide-react";

export interface SettingsSelectOption {
  value: string;
  label: string;
  disabled?: boolean;
}

interface SettingsSelectProps {
  id: string;
  value: string;
  options: SettingsSelectOption[];
  placeholder?: string;
  disabled?: boolean;
  ariaDescribedBy?: string;
  onChange: (value: string) => void;
}

export function SettingsSelect({
  id,
  value,
  options,
  placeholder,
  disabled = false,
  ariaDescribedBy,
  onChange,
}: SettingsSelectProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState<number>(-1);
  const containerRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const optionRefs = useRef<Array<HTMLLIElement | null>>([]);
  const listboxId = useId();

  const selectedOption = useMemo(() => {
    return options.find((option) => option.value === value);
  }, [options, value]);

  const firstEnabledIndex = useMemo(() => {
    return options.findIndex((option) => !option.disabled);
  }, [options]);

  const getNextEnabledIndex = (startIndex: number, direction: 1 | -1): number => {
    if (options.length === 0) {
      return -1;
    }

    let index = startIndex;
    for (let step = 0; step < options.length; step += 1) {
      index = (index + direction + options.length) % options.length;
      if (!options[index].disabled) {
        return index;
      }
    }

    return -1;
  };

  const closeList = () => {
    setIsOpen(false);
    setActiveIndex(-1);
  };

  const openList = (preferredIndex?: number) => {
    if (disabled) {
      return;
    }

    const selectedIndex = options.findIndex((option) => option.value === value && !option.disabled);
    const initialIndex =
      preferredIndex !== undefined
        ? preferredIndex
        : selectedIndex >= 0
          ? selectedIndex
          : firstEnabledIndex;

    setIsOpen(true);
    setActiveIndex(initialIndex);
  };

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    const handlePointerDown = (event: PointerEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) {
        closeList();
      }
    };

    window.addEventListener("pointerdown", handlePointerDown);
    return () => {
      window.removeEventListener("pointerdown", handlePointerDown);
    };
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    listRef.current?.focus();
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen || activeIndex < 0) {
      return;
    }

    optionRefs.current[activeIndex]?.scrollIntoView({ block: "nearest" });
  }, [activeIndex, isOpen]);

  const handleListKeyDown = (event: React.KeyboardEvent<HTMLUListElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      closeList();
      buttonRef.current?.focus();
      return;
    }

    if (event.key === "Tab") {
      closeList();
      return;
    }

    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActiveIndex((current) => getNextEnabledIndex(current >= 0 ? current : -1, 1));
      return;
    }

    if (event.key === "ArrowUp") {
      event.preventDefault();
      const startIndex = activeIndex >= 0 ? activeIndex : options.length;
      setActiveIndex(getNextEnabledIndex(startIndex, -1));
      return;
    }

    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      if (activeIndex >= 0 && !options[activeIndex]?.disabled) {
        onChange(options[activeIndex].value);
      }
      closeList();
      buttonRef.current?.focus();
    }
  };

  const handleButtonKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>) => {
    if (disabled) {
      return;
    }

    if (event.key === "ArrowDown") {
      event.preventDefault();
      const selectedIndex = options.findIndex((option) => option.value === value && !option.disabled);
      const nextIndex = getNextEnabledIndex(selectedIndex >= 0 ? selectedIndex : -1, 1);
      openList(nextIndex);
      return;
    }

    if (event.key === "ArrowUp") {
      event.preventDefault();
      const selectedIndex = options.findIndex((option) => option.value === value && !option.disabled);
      const nextIndex = getNextEnabledIndex(
        selectedIndex >= 0 ? selectedIndex : options.length,
        -1,
      );
      openList(nextIndex);
      return;
    }

    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      openList();
    }
  };

  const displayLabel = selectedOption?.label ?? placeholder ?? "Select an option";

  return (
    <div ref={containerRef} className="relative">
      <button
        id={id}
        ref={buttonRef}
        type="button"
        className="w-full rounded-sm border border-white/20 bg-black/20 px-3 py-2 pr-9 text-left text-sm text-neutral-100 transition-colors focus:border-white/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/45 disabled:cursor-not-allowed disabled:border-white/10 disabled:bg-black/10 disabled:text-neutral-500"
        aria-haspopup="listbox"
        aria-expanded={isOpen}
        aria-controls={`${listboxId}-listbox`}
        aria-describedby={ariaDescribedBy}
        onClick={() => (isOpen ? closeList() : openList())}
        onKeyDown={handleButtonKeyDown}
        disabled={disabled}
      >
        <span className="block truncate">{displayLabel}</span>
      </button>
      <ChevronDown
        className={`pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 transition-transform ${
          isOpen ? "rotate-180 text-neutral-200" : "text-neutral-400"
        }`}
      />

      {isOpen && !disabled && (
        <ul
          id={`${listboxId}-listbox`}
          ref={listRef}
          role="listbox"
          tabIndex={-1}
          aria-labelledby={id}
          className="absolute z-30 mt-1 max-h-56 w-full overflow-auto rounded-sm border border-white/20 bg-black/70 p-1 backdrop-blur-sm shadow-[var(--surface-glow)]"
          onKeyDown={handleListKeyDown}
        >
          {options.map((option, index) => {
            const isSelected = option.value === value;
            const isActive = index === activeIndex;

            return (
              <li
                key={option.value}
                ref={(element) => {
                  optionRefs.current[index] = element;
                }}
                role="option"
                aria-selected={isSelected}
                className={`flex cursor-pointer items-center justify-between rounded px-2.5 py-1.5 text-sm transition-colors ${
                  option.disabled
                    ? "cursor-not-allowed text-neutral-500"
                    : isActive
                      ? "bg-white/12 text-neutral-100"
                      : isSelected
                        ? "bg-white/8 text-neutral-100"
                        : "text-neutral-200 hover:bg-white/5"
                }`}
                onMouseEnter={() => {
                  if (!option.disabled) {
                    setActiveIndex(index);
                  }
                }}
                onMouseDown={(event) => {
                  event.preventDefault();
                }}
                onClick={() => {
                  if (option.disabled) {
                    return;
                  }
                  onChange(option.value);
                  closeList();
                  buttonRef.current?.focus();
                }}
              >
                <span className="truncate pr-2">{option.label}</span>
                {isSelected && <Check className="h-4 w-4 shrink-0 text-neutral-200" />}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
