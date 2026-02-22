interface FormFieldProps {
  id: string;
  label: string;
  description?: string;
  error?: string;
  children: React.ReactNode;
  className?: string;
}

export function FormField({
  id,
  label,
  description,
  error,
  children,
  className = "",
}: FormFieldProps) {
  return (
    <div className={`space-y-2 ${className}`}>
      <label
        htmlFor={id}
        className="block text-sm font-medium text-neutral-200"
      >
        {label}
      </label>
      
      {children}
      
      {description && (
        <p className="text-xs text-neutral-400">{description}</p>
      )}
      
      {error && (
        <p className="text-xs text-rose-400">{error}</p>
      )}
    </div>
  );
}