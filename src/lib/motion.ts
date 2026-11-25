export const MOTION_EASE = [0.22, 1, 0.36, 1] as const;

export const smoothTransition = {
  duration: 0.16,
  ease: MOTION_EASE,
};

export const contentTransition = {
  duration: 0.2,
  ease: MOTION_EASE,
};

export const indicatorTransition = {
  type: "spring",
  stiffness: 500,
  damping: 40,
} as const;

export const pressFeedback = {
  whileHover: { y: -1 },
  whileTap: { scale: 0.98 },
};

/**
 * MotionConfig only strips transforms under reduced motion, so callers of this infinite loop
 * must skip it themselves.
 */
export const recordingPulse = {
  animate: { opacity: [0.55, 1, 0.55], scale: [0.95, 1.05, 0.95] },
  transition: { duration: 1.6, repeat: Infinity, ease: "easeInOut" as const },
};

export const contentViewVariants = {
  visible: { opacity: 1, y: 0 },
  hidden: { opacity: 0, y: 5 },
};

export const panelVariants = {
  initial: { opacity: 0, scale: 0.995 },
  animate: { opacity: 1, scale: 1 },
  exit: { opacity: 0, scale: 1.005 },
};

const STAGGER_STEP_SECONDS = 0.03;
const STAGGER_ITEM_LIMIT = 12;

/**
 * Items past the limit share the last delay, so a long list settles in about half a second
 * and lower rows never appear before the rows above them.
 */
export function getStaggerTransition(index: number): typeof smoothTransition & { delay: number } {
  return {
    ...smoothTransition,
    delay: Math.min(index, STAGGER_ITEM_LIMIT - 1) * STAGGER_STEP_SECONDS,
  };
}

/**
 * Items animate once when they mount. Callers key rows by stable ids so a data refresh keeps
 * existing rows mounted and does not replay the stagger.
 */
export function getListItemMotion(index: number) {
  return {
    initial: { opacity: 0, y: 4 },
    animate: { opacity: 1, y: 0 },
    transition: getStaggerTransition(index),
  };
}
