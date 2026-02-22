interface SettingsToggleFieldProps {
  id: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
  description?: string;
}

export function SettingsToggleField({
  id,
  checked,
  onChange,
  label,
  description,
}: SettingsToggleFieldProps) {
  return (
    <div className="space-y-2">
      <label
        htmlFor={id}
        className="flex items-center gap-3 rounded-md border border-emerald-300/20 bg-black/20 px-3 py-2 text-neutral-200"
      >
        <input
          id={id}
          type="checkbox"
          checked={checked}
          onChange={(event) => onChange(event.target.checked)}
          className="h-4 w-4"
        />
        <span className="text-sm">{label}</span>
      </label>
      {description && <p className="text-xs text-neutral-400">{description}</p>}
    </div>
  );
}
