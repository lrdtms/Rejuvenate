/**
 * CmsSlot — presentational renderer for a single CMS slot value.
 *
 * Props:
 *  slotKey  — the registered slot key (e.g. 'about.card.who-are-we')
 *  slots    — the map returned by useCmsSlots(); undefined while loading
 *  fallback — content to render while slots is undefined (default: nothing)
 *
 * Rendering rules:
 *  PLAIN_TEXT  → <p style="white-space: pre-wrap"> preserving line breaks
 *  RICH_TEXT   → <div class="rich-text"> via dangerouslySetInnerHTML;
 *                HTML is sanitized server-side — do NOT re-sanitize here.
 *
 * This component is intentionally "dumb": no fetching, no admin vs public
 * branching. The parent page owns the useCmsSlots() call and passes the
 * map down. This is what makes the admin SlotEditor's live preview trivial
 * to build in Phase 8 (architecture.md §9.5) — same component, same props,
 * WYSIWYG fidelity is structural not promised.
 */
import type { CmsSlotView } from '@/shared/types';

export interface CmsSlotProps {
  slotKey: string;
  slots: Record<string, CmsSlotView> | undefined;
  fallback?: React.ReactNode;
}

export function CmsSlot({ slotKey, slots, fallback = null }: CmsSlotProps) {
  if (slots === undefined) {
    return <>{fallback}</>;
  }

  const slot = slots[slotKey];

  // If slot is somehow missing (shouldn't happen — backend contract guarantees
  // every requested key is present) render nothing gracefully.
  if (!slot || slot.value === '') {
    return null;
  }

  if (slot.format === 'RICH_TEXT') {
    return (
      <div
        className="rich-text"
        dangerouslySetInnerHTML={{ __html: slot.value }}
      />
    );
  }

  // PLAIN_TEXT — preserve line breaks via CSS white-space
  return <p style={{ whiteSpace: 'pre-wrap' }}>{slot.value}</p>;
}
