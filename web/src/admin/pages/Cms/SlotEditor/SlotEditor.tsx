/**
 * SlotEditor — two-column WYSIWYG CMS editor (architecture.md §9.5).
 *
 * Left panel: slot selector + input affordance (textarea for PLAIN_TEXT,
 * constrained TipTap for RICH_TEXT — bold/italic/hard-break only).
 *
 * Right panel: live <CmsSlot> preview fed the in-progress form value —
 * updates on every keystroke, not after save.  This "live uncommitted
 * value in, live render out" wiring is the structural WYSIWYG guarantee.
 *
 * On save (PUT /api/v1/admin/cms/:slotKey): invalidate the 'cms' cache
 * so public pages pick up the new value on next navigation.
 */
import { useState, useEffect } from 'react';
import { useForm, useWatch } from 'react-hook-form';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useEditor, EditorContent } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { apiFetch, isApiError } from '@/shared/api/client';
import { CmsSlot } from '@/shared/components/CmsSlot';
import { Button } from '@/design-system/Button';
import type { AdminCmsSlot, CmsSlotView } from '@/shared/types';
import '@/admin/admin.css';

/** Human-readable labels — stable, hardcoded per spec */
const SLOT_LABELS: Record<string, string> = {
  'about.card.who-are-we': 'About — Who Are We',
  'about.card.what-we-do': 'About — What We Do',
  'about.card.get-involved': 'About — Get Involved',
  'contact.capeTown.card': 'Contact — Cape Town',
  'contact.durban.card': 'Contact — Durban',
  'contact.page.details': 'Contact — Page Details',
};

const ALL_SLOT_KEYS = Object.keys(SLOT_LABELS);

interface SlotFormValues {
  value: string;
}

/** Minimal TipTap editor for RICH_TEXT slots (bold, italic, hard break only) */
function MiniRichEditor({
  value,
  onChange,
}: {
  value: string;
  onChange: (html: string) => void;
}) {
  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        // Disable everything except paragraph, bold, italic, hardBreak
        heading: false,
        bulletList: false,
        orderedList: false,
        blockquote: false,
        code: false,
        codeBlock: false,
        strike: false,
        horizontalRule: false,
      }),
    ],
    content: value,
    onUpdate({ editor: e }) {
      onChange(e.getHTML());
    },
  });

  useEffect(() => {
    if (!editor) return;
    if (editor.getHTML() !== value) {
      editor.commands.setContent(value, { emitUpdate: false });
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, editor]);

  if (!editor) return null;

  return (
    <div className="tiptap-wrapper">
      <div className="tiptap-toolbar" role="toolbar" aria-label="Minimal text formatting">
        <button
          type="button"
          className={['tiptap-toolbar-btn', editor.isActive('bold') ? 'is-active' : ''].filter(Boolean).join(' ')}
          onClick={() => editor.chain().focus().toggleBold().run()}
          title="Bold"
          aria-pressed={editor.isActive('bold')}
        >
          B
        </button>
        <button
          type="button"
          className={['tiptap-toolbar-btn', editor.isActive('italic') ? 'is-active' : ''].filter(Boolean).join(' ')}
          onClick={() => editor.chain().focus().toggleItalic().run()}
          title="Italic"
          aria-pressed={editor.isActive('italic')}
        >
          I
        </button>
        <span className="tiptap-toolbar-divider" aria-hidden="true" />
        <button
          type="button"
          className="tiptap-toolbar-btn"
          onClick={() => editor.chain().focus().setHardBreak().run()}
          title="Line break"
        >
          BR
        </button>
      </div>
      <div className="tiptap-editor-content">
        <EditorContent editor={editor} />
      </div>
    </div>
  );
}

export function SlotEditor() {
  const [selectedKey, setSelectedKey] = useState<string>(ALL_SLOT_KEYS[0]);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saveSuccess, setSaveSuccess] = useState(false);
  const queryClient = useQueryClient();

  const {
    register,
    handleSubmit,
    reset,
    control,
    setValue,
  } = useForm<SlotFormValues>({ defaultValues: { value: '' } });

  // Watch the form value in real-time for the live preview
  const watchedValue = useWatch({ control, name: 'value' });

  // Fetch the selected slot
  const { data: slotData, isLoading } = useQuery<{ slot: AdminCmsSlot }>({
    queryKey: ['adminCmsSlot', selectedKey],
    queryFn: () => apiFetch<{ slot: AdminCmsSlot }>(`/api/v1/admin/cms/${selectedKey}`),
  });

  const slot = slotData?.slot;

  // Seed form when slot loads or selection changes
  useEffect(() => {
    if (slot) {
      reset({ value: slot.value });
    }
  }, [slot, reset]);

  const saveMutation = useMutation({
    mutationFn: (value: string) =>
      apiFetch<{ slot: AdminCmsSlot }>(`/api/v1/admin/cms/${selectedKey}`, {
        method: 'PUT',
        body: JSON.stringify({ value }),
      }),
    onSuccess: () => {
      setSaveError(null);
      setSaveSuccess(true);
      setTimeout(() => setSaveSuccess(false), 3000);
      // Invalidate public CMS cache so pages pick up new content
      queryClient.invalidateQueries({ queryKey: ['cms'] });
      // Also invalidate admin slot cache
      queryClient.invalidateQueries({ queryKey: ['adminCmsSlot', selectedKey] });
    },
    onError: (err) => {
      setSaveError(isApiError(err) ? err.body.message : 'Save failed');
    },
  });

  function onSubmit(values: SlotFormValues) {
    setSaveError(null);
    setSaveSuccess(false);
    saveMutation.mutate(values.value);
  }

  function handleSelectSlot(key: string) {
    setSelectedKey(key);
    setSaveError(null);
    setSaveSuccess(false);
  }

  // Build the slots map for <CmsSlot> preview
  // We always pass the live watched value (not the saved value)
  const previewSlots: Record<string, CmsSlotView> | undefined =
    slot
      ? {
          [selectedKey]: {
            format: slot.format,
            value: watchedValue,
            updatedAt: slot.updatedAt,
          },
        }
      : undefined;

  return (
    <div>
      <div className="admin-page-header">
        <h1 className="admin-page-title">CMS Slot Editor</h1>
      </div>

      <div className="slot-editor-layout">
        {/* Left panel: selector + input */}
        <div className="slot-editor-panel">
          <span className="slot-editor-panel-label">Select a content slot</span>

          <ul className="slot-selector-list" role="listbox" aria-label="CMS slots">
            {ALL_SLOT_KEYS.map((key) => (
              <li key={key} role="option" aria-selected={key === selectedKey}>
                <button
                  type="button"
                  className={['slot-selector-btn', key === selectedKey ? 'selected' : ''].filter(Boolean).join(' ')}
                  onClick={() => handleSelectSlot(key)}
                >
                  {SLOT_LABELS[key]}
                </button>
              </li>
            ))}
          </ul>

          {isLoading && (
            <div className="admin-state" style={{ padding: '1rem 0', textAlign: 'left' }}>
              Loading…
            </div>
          )}

          {slot && (
            <form onSubmit={handleSubmit(onSubmit)} noValidate>
              <div className="admin-form-group">
                <label
                  htmlFor={slot.format === 'PLAIN_TEXT' ? 'slot-value-textarea' : undefined}
                  style={{
                    display: 'block',
                    fontSize: '0.875rem',
                    fontWeight: 600,
                    color: 'var(--muted)',
                    marginBottom: '0.4rem',
                  }}
                >
                  {SLOT_LABELS[selectedKey]}
                  <span
                    style={{
                      marginLeft: '0.5rem',
                      fontSize: '0.72rem',
                      fontWeight: 400,
                      opacity: 0.7,
                    }}
                  >
                    ({slot.format === 'PLAIN_TEXT' ? 'Plain text' : 'Rich text'})
                  </span>
                </label>

                {slot.format === 'PLAIN_TEXT' ? (
                  <textarea
                    id="slot-value-textarea"
                    rows={6}
                    style={{
                      width: '100%',
                      background: 'var(--panel-strong)',
                      border: '1px solid var(--line)',
                      borderRadius: '8px',
                      color: 'var(--text)',
                      fontFamily: 'inherit',
                      fontSize: '0.95rem',
                      padding: '0.55rem 0.8rem',
                      resize: 'vertical',
                      boxSizing: 'border-box',
                    }}
                    {...register('value')}
                  />
                ) : (
                  <MiniRichEditor
                    value={watchedValue}
                    onChange={(html) => setValue('value', html, { shouldDirty: true })}
                  />
                )}
              </div>

              {saveError && (
                <div role="alert" style={{ color: '#ff6b6b', fontSize: '0.875rem', marginBottom: '0.75rem' }}>
                  {saveError}
                </div>
              )}
              {saveSuccess && (
                <div role="status" style={{ color: 'var(--accent)', fontSize: '0.875rem', marginBottom: '0.75rem' }}>
                  Saved successfully.
                </div>
              )}

              <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
                <Button type="submit" variant="primary" disabled={saveMutation.isPending}>
                  {saveMutation.isPending ? 'Saving…' : 'Save'}
                </Button>
                {slot.updatedAt && (
                  <span style={{ fontSize: '0.78rem', color: 'var(--muted)' }}>
                    Last saved:{' '}
                    {new Date(slot.updatedAt).toLocaleDateString('en-ZA', {
                      day: 'numeric',
                      month: 'short',
                      year: 'numeric',
                    })}
                  </span>
                )}
              </div>
            </form>
          )}
        </div>

        {/* Right panel: live preview */}
        <div className="slot-preview-panel">
          <span className="slot-preview-label">
            Live Preview — how it appears on the public site
          </span>
          {previewSlots ? (
            <CmsSlot
              slotKey={selectedKey}
              slots={previewSlots}
              fallback={
                <span className="slot-preview-empty">
                  (empty — type something to preview)
                </span>
              }
            />
          ) : (
            <span className="slot-preview-empty">(loading…)</span>
          )}
        </div>
      </div>
    </div>
  );
}
