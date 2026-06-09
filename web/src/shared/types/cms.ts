/**
 * CmsSlotView — shape returned by GET /api/v1/cms?keys=...
 * for each requested slot key.
 */
export interface CmsSlotView {
  format: 'PLAIN_TEXT' | 'RICH_TEXT';
  value: string;
  updatedAt: string | null;
}
