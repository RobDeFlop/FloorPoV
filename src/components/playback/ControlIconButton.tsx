import type { ReactNode } from "react";

interface ControlIconButtonProps {
  label: string;
  onClick: () => void;
  children: ReactNode;
  disabled?: boolean;
  pressed?: boolean;
  controls?: string;
}

export function ControlIconButton({
  label,
  onClick,
  children,
  disabled = false,
  pressed,
  controls,
}: ControlIconButtonProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="rounded p-1 text-white transition-colors hover:text-neutral-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/45 disabled:cursor-not-allowed disabled:opacity-45"
      aria-label={label}
      aria-pressed={pressed}
      aria-expanded={pressed}
      aria-controls={controls}
      title={label}
    >
      {children}
    </button>
  );
}
