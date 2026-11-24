import { type ReactNode } from "react";

interface SettingsSectionProps {
  title: string;
  icon: ReactNode;
  children: ReactNode;
  embedded?: boolean;
}

const BASE_SECTION_CLASS_NAME =
  "rounded-sm border border-white/10 bg-(--surface-1)/80 p-3.5";
const HEADING_CLASS_NAME =
  "mb-3 inline-flex items-center gap-2 text-sm font-semibold text-neutral-200";

export function SettingsSection({ title, icon, children, embedded = false }: SettingsSectionProps) {
  return (
    <section className={embedded ? undefined : BASE_SECTION_CLASS_NAME}>
      <h2 className={HEADING_CLASS_NAME}>
        {icon}
        {title}
      </h2>
      {children}
    </section>
  );
}
