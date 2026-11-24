const MOTION_EASE = [0.22, 1, 0.36, 1] as const;

export const smoothTransition = {
  duration: 0.16,
  ease: MOTION_EASE,
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
