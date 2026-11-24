import { Check, ChevronDown } from "lucide-react";
import { createPortal } from "react-dom";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type ReactElement,
} from "react";
import { KeyCode } from "../../types/key-code";

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

const LISTBOX_GAP = 4;
const LISTBOX_MAX_HEIGHT = 240;
const VIEWPORT_PADDING = 8;

export function SettingsSelect({
  id,
  value,
  options,
  placeholder,
  disabled = false,
  ariaDescribedBy,
  onChange,
}: SettingsSelectProps): ReactElement {
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listboxRef = useRef<HTMLDivElement>(null);
  const [isOpen, setIsOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [listboxStyle, setListboxStyle] = useState<CSSProperties>({
    position: "fixed",
    visibility: "hidden",
  });
  const listboxId = `${id}-listbox`;
  const enabledIndices = options.reduce<number[]>((indices, option, index) => {
    if (!option.disabled) {
      indices.push(index);
    }
    return indices;
  }, []);
  const selectedIndex = options.findIndex((option) => option.value === value);
  const selectedOption = options[selectedIndex];
  const displayLabel = selectedOption?.label ?? placeholder ?? "Select an option";

  useEffect(() => {
    if (disabled && isOpen) {
      setIsOpen(false);
    }
  }, [disabled, isOpen]);

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (
        !containerRef.current?.contains(target) &&
        !listboxRef.current?.contains(target)
      ) {
        setIsOpen(false);
      }
    };

    document.addEventListener("pointerdown", handlePointerDown);
    return () => document.removeEventListener("pointerdown", handlePointerDown);
  }, [isOpen]);

  const updateListboxPosition = useCallback(() => {
    const trigger = triggerRef.current;
    const listbox = listboxRef.current;
    if (!trigger || !listbox) {
      return;
    }

    const triggerRect = trigger.getBoundingClientRect();
    const listboxHeight = Math.min(listbox.scrollHeight, LISTBOX_MAX_HEIGHT);
    const spaceBelow = window.innerHeight - triggerRect.bottom - LISTBOX_GAP - VIEWPORT_PADDING;
    const spaceAbove = triggerRect.top - LISTBOX_GAP - VIEWPORT_PADDING;
    const openAbove = spaceBelow < listboxHeight && spaceAbove > spaceBelow;
    const availableHeight = Math.max(0, openAbove ? spaceAbove : spaceBelow);
    const left = Math.min(
      Math.max(VIEWPORT_PADDING, triggerRect.left),
      Math.max(VIEWPORT_PADDING, window.innerWidth - triggerRect.width - VIEWPORT_PADDING),
    );

    setListboxStyle({
      position: "fixed",
      left,
      width: triggerRect.width,
      maxHeight: Math.min(LISTBOX_MAX_HEIGHT, availableHeight),
      ...(openAbove
        ? { bottom: window.innerHeight - triggerRect.top + LISTBOX_GAP }
        : { top: triggerRect.bottom + LISTBOX_GAP }),
    });
  }, []);

  useLayoutEffect(() => {
    if (isOpen) {
      updateListboxPosition();
    }
  }, [isOpen, options, updateListboxPosition]);

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    const handleViewportChange = (event: Event) => {
      if (event.target instanceof Node && listboxRef.current?.contains(event.target)) {
        return;
      }
      updateListboxPosition();
    };

    window.addEventListener("resize", handleViewportChange);
    window.addEventListener("scroll", handleViewportChange, true);
    return () => {
      window.removeEventListener("resize", handleViewportChange);
      window.removeEventListener("scroll", handleViewportChange, true);
    };
  }, [isOpen, updateListboxPosition]);

  useEffect(() => {
    if (!isOpen) {
      setActiveIndex(selectedIndex >= 0 && !options[selectedIndex]?.disabled ? selectedIndex : enabledIndices[0] ?? -1);
      return;
    }

    if (activeIndex < 0 || options[activeIndex]?.disabled) {
      setActiveIndex(selectedIndex >= 0 && !options[selectedIndex]?.disabled ? selectedIndex : enabledIndices[0] ?? -1);
    }
  }, [activeIndex, enabledIndices, isOpen, options, selectedIndex]);

  useEffect(() => {
    if (isOpen && activeIndex >= 0) {
      document.getElementById(`${id}-option-${activeIndex}`)?.scrollIntoView({ block: "nearest" });
    }
  }, [activeIndex, id, isOpen]);

  const openListbox = () => {
    if (disabled || enabledIndices.length === 0) {
      return;
    }

    setActiveIndex(selectedIndex >= 0 && !options[selectedIndex]?.disabled ? selectedIndex : enabledIndices[0]);
    setIsOpen(true);
  };

  const selectOption = (index: number) => {
    const option = options[index];
    if (disabled || !option || option.disabled) {
      return;
    }

    onChange(option.value);
    setIsOpen(false);
  };

  const moveActiveOption = (direction: 1 | -1) => {
    const currentPosition = enabledIndices.indexOf(activeIndex);
    const nextPosition = currentPosition < 0
      ? direction === 1 ? 0 : enabledIndices.length - 1
      : (currentPosition + direction + enabledIndices.length) % enabledIndices.length;
    setActiveIndex(enabledIndices[nextPosition]);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (disabled) {
      return;
    }

    if (event.key === KeyCode.Tab) {
      setIsOpen(false);
      return;
    }

    if (event.key === KeyCode.Escape) {
      if (isOpen) {
        event.preventDefault();
        setIsOpen(false);
      }
      return;
    }

    if (event.key === KeyCode.Enter || event.key === KeyCode.Space) {
      event.preventDefault();
      if (isOpen) {
        selectOption(activeIndex);
      } else {
        openListbox();
      }
      return;
    }

    if (event.key === KeyCode.ArrowDown || event.key === KeyCode.ArrowUp) {
      event.preventDefault();
      if (!isOpen) {
        openListbox();
      } else {
        moveActiveOption(event.key === KeyCode.ArrowDown ? 1 : -1);
      }
      return;
    }

    if (event.key === KeyCode.Home || event.key === KeyCode.End) {
      event.preventDefault();
      if (!isOpen) {
        openListbox();
      } else {
        setActiveIndex(event.key === KeyCode.Home ? enabledIndices[0] : enabledIndices[enabledIndices.length - 1]);
      }
    }
  };

  return (
    <div ref={containerRef} className="relative">
      <button
        ref={triggerRef}
        id={id}
        type="button"
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={isOpen}
        aria-controls={listboxId}
        aria-describedby={ariaDescribedBy}
        aria-activedescendant={isOpen && activeIndex >= 0 ? `${id}-option-${activeIndex}` : undefined}
        disabled={disabled || enabledIndices.length === 0}
        onClick={() => (isOpen ? setIsOpen(false) : openListbox())}
        onKeyDown={handleKeyDown}
        className="flex w-full items-center justify-between gap-3 rounded-sm border border-white/20 bg-black/20 px-3 py-2 text-left text-sm text-neutral-100 transition-colors hover:border-white/35 hover:bg-white/6 focus:border-white/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--color-emerald-300)/60 disabled:cursor-not-allowed disabled:border-white/10 disabled:bg-black/10 disabled:text-neutral-500"
      >
        <span className={!selectedOption && placeholder ? "text-neutral-400" : "truncate"}>{displayLabel}</span>
        <ChevronDown className={`h-4 w-4 shrink-0 text-neutral-400 transition-transform ${isOpen ? "rotate-180" : ""}`} aria-hidden="true" />
      </button>

      {isOpen && createPortal(
        <div
          ref={listboxRef}
          id={listboxId}
          role="listbox"
          aria-label={displayLabel}
          className="z-[200] overflow-y-auto rounded-sm border border-white/15 bg-(--surface-2) p-1 shadow-(--surface-glow)"
          style={listboxStyle}
        >
          {options.map((option, index) => {
            const isSelected = option.value === value;
            const isActive = index === activeIndex;

            return (
              <div
                key={option.value}
                id={`${id}-option-${index}`}
                role="option"
                aria-selected={isSelected}
                aria-disabled={option.disabled || undefined}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => selectOption(index)}
                className={`flex items-center justify-between gap-3 rounded-sm px-3 py-2 text-sm transition-colors ${
                  option.disabled
                    ? "cursor-not-allowed text-neutral-500"
                    : isActive
                      ? "cursor-pointer bg-emerald-500/15 text-emerald-100"
                      : "cursor-pointer text-neutral-200 hover:bg-white/8 hover:text-neutral-100"
                }`}
              >
                <span className="min-w-0 truncate">{option.label}</span>
                {isSelected && <Check className="h-4 w-4 shrink-0 text-emerald-300" aria-hidden="true" />}
              </div>
            );
          })}
        </div>,
        document.body,
      )}
    </div>
  );
}
