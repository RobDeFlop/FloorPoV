export const smoothTransition = {
  duration: 0.22,
  ease: [0.22, 1, 0.36, 1] as const,
};

export const panelVariants = {
  initial: { opacity: 0, y: 8 },
  animate: { opacity: 1, y: 0 },
  exit: { opacity: 0, y: -6 },
};
