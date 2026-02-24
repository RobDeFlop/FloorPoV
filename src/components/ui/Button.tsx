import { forwardRef } from "react";

interface ButtonProps {
  children: React.ReactNode;
  variant?: "primary" | "secondary" | "danger" | "ghost";
  size?: "sm" | "md" | "lg";
  disabled?: boolean;
  onClick?: () => void;
  type?: "button" | "submit" | "reset";
  className?: string;
  ariaLabel?: string;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  (
    {
      children,
      variant = "secondary",
      size = "md",
      disabled = false,
      onClick,
      type = "button",
      className = "",
      ariaLabel,
    },
    ref
  ) => {
    const baseClasses = "rounded-sm border font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 disabled:cursor-not-allowed disabled:opacity-50";

    const variantClasses = {
      primary: "border-(--color-emerald-300)/35 bg-(--color-emerald-500)/20 text-(--color-emerald-100) hover:bg-(--color-emerald-500)/30 focus-visible:ring-(--color-emerald-300)/60",
      secondary: "border-white/20 bg-black/20 text-(--color-neutral-200) hover:bg-white/5 focus-visible:ring-white/45",
      danger: "border-(--color-rose-300)/35 bg-(--color-rose-500)/20 text-(--color-rose-100) hover:bg-(--color-rose-500)/30 focus-visible:ring-(--color-rose-300)/60",
      ghost: "border-transparent bg-transparent text-(--color-neutral-200) hover:bg-white/5 focus-visible:ring-white/45",
    };

    const sizeClasses = {
      sm: "px-2.5 py-1 text-xs",
      md: "px-4 py-2 text-sm",
      lg: "px-6 py-3 text-base",
    };

    const classes = `${baseClasses} ${variantClasses[variant]} ${sizeClasses[size]} ${className}`;

    return (
      <button
        ref={ref}
        type={type}
        onClick={onClick}
        disabled={disabled}
        className={classes}
        aria-label={ariaLabel}
      >
        {children}
      </button>
    );
  }
);

Button.displayName = "Button";