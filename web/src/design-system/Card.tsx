/**
 * Card — generic <article class="card"> wrapper.
 *
 * Variants:
 *  'default'          → plain .card  (About page cards, location contact card)
 *  'location-contact' → .card .location-contact-card
 *  'contact-form'     → .card .contact-form  (Contact page form wrapper)
 *
 * All grid-column rules live in global.css alongside the grid containers
 * (.about-content-grid, .contact-layout, .location-content-grid).
 *
 * Renders as <article> by default; pass `as="form"` etc. for semantic
 * overrides (the Contact page form uses <form class="card contact-form">).
 */
import './Card.css';

type CardElement = 'article' | 'form' | 'section' | 'div';

export type CardVariant = 'default' | 'location-contact' | 'contact-form';

export interface CardProps {
  variant?: CardVariant;
  as?: CardElement;
  className?: string;
  children: React.ReactNode;
  [key: string]: unknown; // forward any native element props (onSubmit, etc.)
}

export function Card({ variant = 'default', as: Tag = 'article', className, children, ...rest }: CardProps) {
  const variantClass =
    variant === 'location-contact'
      ? 'location-contact-card'
      : variant === 'contact-form'
        ? 'contact-form'
        : null;

  const classes = ['card', variantClass, className].filter(Boolean).join(' ');

  return (
    <Tag className={classes} {...(rest as Record<string, unknown>)}>
      {children}
    </Tag>
  );
}
