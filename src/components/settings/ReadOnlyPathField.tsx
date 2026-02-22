import { Folder } from "lucide-react";

interface ReadOnlyPathFieldProps {
  inputId: string;
  label: string;
  value: string;
  onBrowse: () => void | Promise<void>;
}

export function ReadOnlyPathField({ inputId, label, value, onBrowse }: ReadOnlyPathFieldProps) {
  return (
    <div>
      <label htmlFor={inputId} className="mb-2 block text-sm text-neutral-300">
        {label}
      </label>
      <div className="flex flex-col gap-2 sm:flex-row">
        <input
          id={inputId}
          type="text"
          value={value}
          readOnly
          className="flex-1 rounded-sm border border-white/20 bg-black/20 px-3 py-2 text-sm text-neutral-300"
        />
        <button
          type="button"
          onClick={onBrowse}
          className="inline-flex items-center justify-center gap-2 rounded-sm border border-white/20 bg-white/6 px-4 py-2 text-sm text-neutral-100 transition-colors hover:bg-white/12 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/45"
        >
          <Folder className="h-4 w-4" />
          Browse
        </button>
      </div>
    </div>
  );
}
