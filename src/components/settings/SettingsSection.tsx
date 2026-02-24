import { type ReactNode } from "react";

interface SettingsSectionProps {
  title: string;
  icon: ReactNode;
  children: ReactNode;
  className?: string;
}

const BASE_SECTION_CLASS_NAME =
  "rounded-sm border border-white/10 bg-(--surface-1)/80 p-4";
const HEADING_CLASS_NAME =
  "mb-4 inline-flex items-center gap-2 text-sm font-semibold uppercase tracking-[0.13em] text-neutral-200";

export function SettingsSection({ title, icon, children, className }: SettingsSectionProps) {
  return (
    <section className={`${BASE_SECTION_CLASS_NAME} ${className || ""}`.trim()}>
      <h2 className={HEADING_CLASS_NAME}>
        {icon}
        {title}
      </h2>
      {children}
    </section>
  );
}
