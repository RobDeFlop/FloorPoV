import { ArrowLeft, type LucideIcon } from "lucide-react";
import { type ReactNode } from "react";

interface PageHeaderProps {
  icon: LucideIcon;
  title: string;
  description?: ReactNode;
  backAction?: {
    label: string;
    onClick: () => void;
  };
  action?: ReactNode;
}

export function PageHeader({ icon: Icon, title, description, backAction, action }: PageHeaderProps) {
  return (
    <header className="flex shrink-0 flex-wrap items-center gap-3 border-b border-white/10 bg-(--surface-1) px-4 py-4 md:px-6">
      {backAction && (
        <button
          type="button"
          onClick={backAction.onClick}
          autoFocus
          className="inline-flex min-h-8 items-center gap-1.5 rounded-sm border border-white/15 bg-black/20 px-2.5 text-xs text-neutral-300 transition-colors hover:border-emerald-300/40 hover:bg-emerald-500/10 hover:text-emerald-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-300/60"
        >
          <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" />
          {backAction.label}
        </button>
      )}
      <Icon className="h-4 w-4 shrink-0 text-neutral-300" aria-hidden="true" />
      <div className="min-w-0">
        <h1 className="text-lg font-semibold text-neutral-100">{title}</h1>
        {description && <p className="mt-1 truncate text-sm text-neutral-400">{description}</p>}
      </div>
      {action && <div className="ml-auto">{action}</div>}
    </header>
  );
}
