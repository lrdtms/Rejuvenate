/**
 * FormField — presentational wrapper used by every form in the app
 * (RSVP, login, blog editor, CMS slot editor).
 *
 * Renders: <div> → <label> + {children} + optional <FieldError>
 *
 * The consuming form is responsible for wiring aria-invalid /
 * aria-describedby onto the input it places inside the children slot.
 * The errorId prop is used to generate a consistent id for the error
 * message so that aria-describedby can reference it.
 *
 * Example usage with React Hook Form:
 *
 *   <FormField label="Email" htmlFor="email" errorMessage={errors.email?.message} errorId="email-error">
 *     <input
 *       id="email"
 *       type="email"
 *       aria-invalid={!!errors.email}
 *       aria-describedby={errors.email ? 'email-error' : undefined}
 *       {...register('email')}
 *     />
 *   </FormField>
 */
import { FieldError } from './FieldError';

export interface FormFieldProps {
  label: string;
  htmlFor: string;
  errorMessage?: string;
  errorId?: string;
  children: React.ReactNode;
  className?: string;
}

export function FormField({
  label,
  htmlFor,
  errorMessage,
  errorId,
  children,
  className,
}: FormFieldProps) {
  return (
    <div className={className}>
      <label htmlFor={htmlFor}>{label}</label>
      {children}
      {errorMessage && <FieldError message={errorMessage} id={errorId} />}
    </div>
  );
}
