import { type ComponentType } from "react";
import { AnimatePresence, motion } from "motion/react";
import { smoothTransition } from "../../../lib/motion";
import { Button } from "../../ui/Button";

type SidebarNavTone = "accent" | "muted";

interface SidebarNavButtonProps {
  label: string;
  icon?: ComponentType<{ className?: string }>;
  isActive: boolean;
  tone?: SidebarNavTone;
  onClick: () => void;
}

interface SidebarNavToneClasses {
  indicator: string;
  idle: string;
}

const TONE_CLASSES: Record<SidebarNavTone, SidebarNavToneClasses> = {
  accent: {
    indicator: "border-l-emerald-300/75 bg-emerald-500/10",
    idle: "text-neutral-300 hover:border-white/20 hover:bg-white/5 hover:text-neutral-100",
  },
  muted: {
    indicator: "border-l-neutral-300/70 bg-neutral-500/10",
    idle: "text-neutral-500 hover:border-neutral-300/15 hover:bg-white/3 hover:text-neutral-300",
  },
};

export function SidebarNavButton({
  label,
  icon: Icon,
  isActive,
  tone = "accent",
  onClick,
}: SidebarNavButtonProps) {
  const toneClasses = TONE_CLASSES[tone];

  return (
    <Button
      variant="ghost"
      onClick={onClick}
      className={`relative flex w-full items-center gap-2 border-l-2 border-l-transparent ${
        isActive ? "text-neutral-100" : toneClasses.idle
      }`}
      ariaLabel={label}
    >
      <AnimatePresence initial={false}>
        {isActive && (
          // The negative offsets cover the button's transparent border.
          <motion.span
            key="sidebar-nav-highlight"
            className={`absolute -top-px -right-px -bottom-px -left-0.5 rounded-sm border-l-2 ${toneClasses.indicator}`}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={smoothTransition}
            aria-hidden="true"
          />
        )}
      </AnimatePresence>
      {Icon && <Icon className="relative h-4 w-4" />}
      <span className="relative">{label}</span>
    </Button>
  );
}
