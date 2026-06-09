/**
 * Button — renders as <button> by default; pass as="a" for link-styled buttons.
 *
 * Variants:
 *  'primary'   — accent gradient (matches .contact-form button / .event-link)
 *  'secondary' — ghost/bordered
 */
import './Button.css';

export type ButtonVariant = 'primary' | 'secondary';

interface ButtonBaseProps {
  variant?: ButtonVariant;
  className?: string;
  children: React.ReactNode;
}

interface ButtonAsButton extends ButtonBaseProps {
  as?: 'button';
  href?: never;
  type?: 'button' | 'submit' | 'reset';
  disabled?: boolean;
  onClick?: React.MouseEventHandler<HTMLButtonElement>;
}

interface ButtonAsAnchor extends ButtonBaseProps {
  as: 'a';
  href: string;
  type?: never;
  disabled?: never;
  onClick?: React.MouseEventHandler<HTMLAnchorElement>;
  target?: string;
  rel?: string;
}

export type ButtonProps = ButtonAsButton | ButtonAsAnchor;

export function Button({
  variant = 'primary',
  className,
  children,
  as: Tag = 'button',
  ...rest
}: ButtonProps) {
  const classes = ['btn', `btn-${variant}`, className].filter(Boolean).join(' ');

  if (Tag === 'a') {
    const { href, onClick, target, rel } = rest as ButtonAsAnchor;
    return (
      <a className={classes} href={href} onClick={onClick} target={target} rel={rel}>
        {children}
      </a>
    );
  }

  const { type = 'button', disabled, onClick } = rest as ButtonAsButton;
  return (
    <button className={classes} type={type} disabled={disabled} onClick={onClick}>
      {children}
    </button>
  );
}
