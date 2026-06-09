/**
 * FieldError — renders a field-level validation message.
 * Returns null when no message is provided so callers can use it
 * unconditionally without extra conditionals.
 *
 * The id prop enables aria-describedby wiring on the associated input:
 *   <input aria-describedby={error ? 'field-error-id' : undefined} />
 *   <FieldError message={error} id="field-error-id" />
 */

export interface FieldErrorProps {
  message?: string;
  id?: string;
}

export function FieldError({ message, id }: FieldErrorProps) {
  if (!message) return null;
  return (
    <span
      id={id}
      role="alert"
      style={{
        display: 'block',
        marginTop: '0.25rem',
        fontSize: '0.85rem',
        color: '#ff6b6b',
      }}
    >
      {message}
    </span>
  );
}
