import { motion } from "motion/react";
import { smoothTransition } from "../../lib/motion";

interface AnimatedTooltipProps {
  x: number;
  children: React.ReactNode;
}

/**
 * Absolute-positioned tooltip that animates in/out above the hovered element.
 * Consumers are responsible for wrapping with AnimatePresence.
 */
export function AnimatedTooltip({ x, children }: AnimatedTooltipProps) {

  return (
    <motion.div
      className="absolute bottom-full mb-2 px-2 py-1 bg-neutral-900 border border-neutral-700 text-neutral-200 text-xs rounded whitespace-nowrap pointer-events-none z-[45] -translate-x-1/2"
      style={{ left: x }}
      initial={{ opacity: 0, y: 4, scale: 0.98 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: 4, scale: 0.98 }}
      transition={smoothTransition}
    >
      {children}
    </motion.div>
  );
}
