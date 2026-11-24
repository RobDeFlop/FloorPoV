"use client";

import { MotionConfig, motion, type Variants } from "motion/react";
import { useEffect, useState, type ReactNode } from "react";

interface NavLink {
  label: string;
  href: string;
}

export function SectionNav({ links }: { links: NavLink[] }) {
  const [activeHref, setActiveHref] = useState<string | null>(null);

  useEffect(() => {
    const sections = links
      .map((link) => document.querySelector<HTMLElement>(link.href))
      .filter((section): section is HTMLElement => section !== null);
    // A thin band near the top of the viewport decides which section counts as current.
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries.find((entry) => entry.isIntersecting);
        if (visible) setActiveHref(`#${visible.target.id}`);
      },
      { rootMargin: "-30% 0px -65% 0px" },
    );
    sections.forEach((section) => observer.observe(section));
    return () => observer.disconnect();
  }, [links]);

  return (
    <>
      {links.map((link) => {
        const isActive = link.href === activeHref;
        return (
          <a
            key={link.href}
            href={link.href}
            aria-current={isActive ? "true" : undefined}
            className={`relative hidden rounded-sm px-3 py-1.5 text-xs uppercase tracking-[0.14em] transition-colors hover:bg-white/5 hover:text-neutral-100 sm:block ${
              isActive ? "text-emerald-100" : "text-neutral-400"
            }`}
          >
            {link.label}
            {isActive && (
              <motion.span
                layoutId="section-nav-indicator"
                className="absolute inset-x-3 -bottom-[11px] h-px bg-emerald-300/80"
                transition={{ type: "spring", stiffness: 500, damping: 40 }}
              />
            )}
          </a>
        );
      })}
    </>
  );
}

export function PressableLink({ href, className, children }: {
  href: string;
  className: string;
  children: ReactNode;
}) {
  // Same lift and press response as the recording button in the app sidebar.
  return (
    <motion.a href={href} className={className} whileHover={{ y: -1 }} whileTap={{ scale: 0.98 }}>
      {children}
    </motion.a>
  );
}

const EASE_OUT: [number, number, number, number] = [0.22, 1, 0.36, 1];

interface ChildrenProps {
  children: ReactNode;
  className?: string;
}

interface RevealProps extends ChildrenProps {
  delay?: number;
}

export function MotionRoot({ children }: { children: ReactNode }) {
  // "user" drops transform animations when the visitor prefers reduced motion.
  return <MotionConfig reducedMotion="user">{children}</MotionConfig>;
}

export function Reveal({ children, className, delay = 0 }: RevealProps) {
  return (
    <motion.div
      className={className}
      initial={{ opacity: 0, y: 20 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: "-80px" }}
      transition={{ duration: 0.6, delay, ease: EASE_OUT }}
    >
      {children}
    </motion.div>
  );
}

const STAGGER_PARENT: Variants = {
  hidden: {},
  visible: { transition: { staggerChildren: 0.07 } },
};

const STAGGER_CHILD: Variants = {
  hidden: { opacity: 0, y: 14 },
  visible: { opacity: 1, y: 0, transition: { duration: 0.5, ease: EASE_OUT } },
};

interface StaggerProps extends ChildrenProps {
  onLoad?: boolean;
  as?: "div" | "ul" | "dl";
}

export function Stagger({ children, className, onLoad = false, as = "div" }: StaggerProps) {
  const trigger = onLoad
    ? { animate: "visible" }
    : { whileInView: "visible", viewport: { once: true, margin: "-60px" } };
  const Component = motion[as];
  return (
    <Component className={className} variants={STAGGER_PARENT} initial="hidden" {...trigger}>
      {children}
    </Component>
  );
}

export function StaggerItem({ children, className, as = "div" }: ChildrenProps & {
  as?: "div" | "li";
}) {
  const Component = motion[as];
  return (
    <Component className={className} variants={STAGGER_CHILD}>
      {children}
    </Component>
  );
}

export function HeroShot({ children, className }: ChildrenProps) {
  return (
    <motion.div
      className={className}
      initial={{ opacity: 0, y: 40 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.9, delay: 0.35, ease: EASE_OUT }}
    >
      {children}
    </motion.div>
  );
}
