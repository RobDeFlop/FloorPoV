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
    <label
      htmlFor={id}
      className="flex cursor-pointer items-start gap-3 rounded-sm border border-white/20 bg-black/20 px-3 py-2.5 text-neutral-200"
    >
      <input
        id={id}
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
        className="mt-0.5 h-4 w-4 shrink-0"
      />
      <span className="min-w-0">
        <span className="block text-sm">{label}</span>
        {description && <span className="mt-1 block text-xs font-normal text-neutral-400">{description}</span>}
      </span>
    </label>
  );
}
