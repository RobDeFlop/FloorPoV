import { forwardRef } from "react";

interface InputProps {
  id?: string;
  type?: "text" | "number" | "email" | "password" | "search";
  variant?: "default" | "filter";
  placeholder?: string;
  value?: string | number;
  readOnly?: boolean;
  onChange?: (e: React.ChangeEvent<HTMLInputElement>) => void;
  onBlur?: (e: React.FocusEvent<HTMLInputElement>) => void;
  disabled?: boolean;
  className?: string;
  ariaLabel?: string;
  min?: number;
  max?: number;
  step?: number;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(
  (
    {
      id,
      type = "text",
      variant = "default",
      placeholder,
      value,
      readOnly = false,
      onChange,
      onBlur,
      disabled = false,
      className = "",
      ariaLabel,
      min,
      max,
      step,
    },
    ref
  ) => {
    const baseClasses =
      "w-full rounded-sm border border-white/20 bg-black/20 px-3 py-2 text-sm text-neutral-100 transition-colors placeholder:text-neutral-400 focus-visible:outline-none focus-visible:ring-2 disabled:cursor-not-allowed disabled:border-white/10 disabled:bg-black/10 disabled:text-neutral-500";

    const variantClasses = {
      default: "focus:border-white/30 focus-visible:ring-white/45",
      filter: "focus:border-emerald-300/45 focus-visible:ring-emerald-300/60",
    };

    const classes = `${baseClasses} ${variantClasses[variant]} ${className}`;

    return (
      <input
        ref={ref}
        id={id}
        type={type}
        value={value}
        readOnly={readOnly}
        onChange={onChange}
        onBlur={onBlur}
        placeholder={placeholder}
        disabled={disabled}
        className={classes}
        aria-label={ariaLabel}
        min={min}
        max={max}
        step={step}
      />
    );
  }
);

Input.displayName = "Input";
