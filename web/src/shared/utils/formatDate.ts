/**
 * Date formatting utilities for event display.
 */

/**
 * Formats an event date range for display.
 * If endsAt is null or the same day as startsAt, shows just the start date/time.
 * Otherwise shows "Start — End".
 */
export function formatEventDateRange(startsAt: string, endsAt: string | null): string {
  const start = new Date(startsAt);

  const dateOpts: Intl.DateTimeFormatOptions = {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  };
  const timeOpts: Intl.DateTimeFormatOptions = {
    hour: '2-digit',
    minute: '2-digit',
  };

  const startDateStr = start.toLocaleDateString('en-ZA', dateOpts);
  const startTimeStr = start.toLocaleTimeString('en-ZA', timeOpts);

  if (!endsAt) {
    return `${startDateStr}, ${startTimeStr}`;
  }

  const end = new Date(endsAt);
  const endDateStr = end.toLocaleDateString('en-ZA', dateOpts);
  const endTimeStr = end.toLocaleTimeString('en-ZA', timeOpts);

  if (startDateStr === endDateStr) {
    return `${startDateStr}, ${startTimeStr} – ${endTimeStr}`;
  }

  return `${startDateStr}, ${startTimeStr} – ${endDateStr}, ${endTimeStr}`;
}

/**
 * Formats a single datetime string for display (blog publishedAt, etc.)
 */
export function formatDateTime(dateStr: string | null): string {
  if (!dateStr) return '';
  const date = new Date(dateStr);
  return date.toLocaleDateString('en-ZA', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });
}
