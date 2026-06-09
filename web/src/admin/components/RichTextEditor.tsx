/**
 * RichTextEditor — TipTap-based controlled rich-text field for blog post bodies.
 *
 * Toolbar (coordinated with backend RICH_TEXT_ALLOW_LIST):
 *   H2 / H3 / H4 | Bold | Italic | Bullet list | Ordered list |
 *   Blockquote | Link | Image (by URL) | Upload image
 *
 * Intentionally limited — no table, code, strike, etc. The backend will
 * strip anything outside its allow-list; restricting the toolbar here prevents
 * "my formatting disappeared after save" confusion (architecture.md §9.5).
 *
 * Wired as a controlled field via props (value + onChange) so the parent
 * can use useController from React Hook Form.
 */
import { useEffect, useCallback, useRef, useState } from 'react';
import { useEditor, EditorContent } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import Image from '@tiptap/extension-image';
import Link from '@tiptap/extension-link';

// Extends the base Image extension with a `data-size` attribute so images
// can be resized inside the editor and the attribute survives sanitization.
const SizedImage = Image.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      size: {
        default: 'full',
        parseHTML: (el) => el.getAttribute('data-size') ?? 'full',
        renderHTML: (attrs) => ({ 'data-size': attrs.size as string }),
      },
    };
  },
});
import type { MediaAsset } from '@/shared/types';
import { ImageUploadField } from './ImageUploadField';

interface RichTextEditorProps {
  value: string;
  onChange: (html: string) => void;
  /** If provided, show the image upload widget bound to this post/event */
  mediaOwner?: { ownerType: 'BLOG_POST' | 'EVENT'; ownerId: string };
}

export function RichTextEditor({ value, onChange, mediaOwner }: RichTextEditorProps) {
  // Saved when the editor loses focus so image uploads can restore cursor position.
  const savedSelectionRef = useRef<{ from: number; to: number } | null>(null);
  // Force re-render when TipTap selection changes — needed so isActive('image')
  // becomes reactive (useEditor alone doesn't re-render on selection-only changes).
  const [, rerender] = useState(0);

  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        // Disable extensions whose HTML the backend will strip
        code: false,
        codeBlock: false,
        strike: false,
        horizontalRule: false,
        // Keep: paragraph, heading, bold, italic, lists, blockquote, hardBreak
        heading: { levels: [2, 3, 4] },
      }),
      SizedImage.configure({ allowBase64: false }),
      Link.configure({ openOnClick: false, autolink: false }),
    ],
    content: value,
    onUpdate({ editor: e }) {
      onChange(e.getHTML());
    },
    onBlur({ editor: e }) {
      const { from, to } = e.state.selection;
      savedSelectionRef.current = { from, to };
    },
  });

  // Sync external value changes (e.g. on load) without triggering onUpdate loop
  useEffect(() => {
    if (!editor) return;
    const currentHTML = editor.getHTML();
    if (currentHTML !== value) {
      editor.commands.setContent(value, { emitUpdate: false });
    }
  }, [value, editor]);

  // Re-render toolbar whenever the selection moves so isActive('image') reflects reality.
  useEffect(() => {
    if (!editor) return;
    const handler = () => rerender((n) => n + 1);
    editor.on('selectionUpdate', handler);
    return () => { editor.off('selectionUpdate', handler); };
  }, [editor]);

  const setLink = useCallback(() => {
    if (!editor) return;
    const prev = editor.getAttributes('link').href as string | undefined;
    const url = window.prompt('Enter URL', prev ?? 'https://');
    if (url === null) return; // cancelled
    if (url === '') {
      editor.chain().focus().extendMarkRange('link').unsetLink().run();
      return;
    }
    editor.chain().focus().extendMarkRange('link').setLink({ href: url, target: '_blank', rel: 'noopener noreferrer' }).run();
  }, [editor]);

  const insertImageByUrl = useCallback(() => {
    if (!editor) return;
    const url = window.prompt('Enter image URL');
    if (!url) return;
    editor.chain().focus().setImage({ src: url, alt: '' }).run();
  }, [editor]);

  const handleUploaded = useCallback((asset: MediaAsset) => {
    if (!editor) return;
    const sel = savedSelectionRef.current;
    const chain = sel
      ? editor.chain().setTextSelection(sel).focus()
      : editor.chain().focus();
    chain.setImage({ src: asset.url, alt: asset.altText ?? '' }).run();
  }, [editor]);

  if (!editor) return null;

  const btn = (label: string, action: () => void, active?: boolean, title?: string) => (
    <button
      key={label}
      type="button"
      className={['tiptap-toolbar-btn', active ? 'is-active' : ''].filter(Boolean).join(' ')}
      onMouseDown={(e) => { e.preventDefault(); action(); }}
      title={title ?? label}
      aria-pressed={active}
    >
      {label}
    </button>
  );

  const divider = (key: string) => <span key={key} className="tiptap-toolbar-divider" aria-hidden="true" />;

  return (
    <div className="tiptap-wrapper">
      <div className="tiptap-toolbar" role="toolbar" aria-label="Text formatting">
        {btn('H2', () => editor.chain().focus().toggleHeading({ level: 2 }).run(), editor.isActive('heading', { level: 2 }))}
        {btn('H3', () => editor.chain().focus().toggleHeading({ level: 3 }).run(), editor.isActive('heading', { level: 3 }))}
        {btn('H4', () => editor.chain().focus().toggleHeading({ level: 4 }).run(), editor.isActive('heading', { level: 4 }))}
        {divider('d1')}
        {btn('B', () => editor.chain().focus().toggleBold().run(), editor.isActive('bold'), 'Bold')}
        {btn('I', () => editor.chain().focus().toggleItalic().run(), editor.isActive('italic'), 'Italic')}
        {divider('d2')}
        {btn('• List', () => editor.chain().focus().toggleBulletList().run(), editor.isActive('bulletList'), 'Bullet list')}
        {btn('1. List', () => editor.chain().focus().toggleOrderedList().run(), editor.isActive('orderedList'), 'Ordered list')}
        {divider('d3')}
        {btn('"', () => editor.chain().focus().toggleBlockquote().run(), editor.isActive('blockquote'), 'Blockquote')}
        {divider('d4')}
        {btn('Link', setLink, editor.isActive('link'), 'Insert / edit link')}
        {divider('d5')}
        {btn('Image URL', insertImageByUrl, false, 'Insert image by URL')}
        {editor.isActive('image') && (
          <>
            {divider('d6')}
            {(['small', 'medium', 'full'] as const).map((size) => {
              const current = (editor.getAttributes('image').size as string | undefined) ?? 'full';
              return (
                <button
                  key={size}
                  type="button"
                  className={['tiptap-toolbar-btn', current === size ? 'is-active' : ''].filter(Boolean).join(' ')}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    editor.chain().focus().updateAttributes('image', { size }).run();
                  }}
                  title={`Image size: ${size}`}
                  aria-pressed={current === size}
                >
                  {size === 'small' ? 'S' : size === 'medium' ? 'M' : 'F'}
                </button>
              );
            })}
          </>
        )}
      </div>

      <div className="tiptap-editor-content">
        <EditorContent editor={editor} />
      </div>

      {/* Insert-at-cursor bar. The paragraph button uses onMouseDown +
          preventDefault so the editor never loses focus — cursor stays put.
          The image button opens a file dialog (editor will blur), so the
          saved selection from onBlur is restored in handleUploaded. */}
      <div className="tiptap-insert-bar">
        <span className="tiptap-insert-label">Add at cursor:</span>
        <button
          type="button"
          className="tiptap-toolbar-btn"
          onMouseDown={(e) => {
            e.preventDefault();
            editor.chain().focus().insertContent({ type: 'paragraph' }).run();
          }}
          title="Insert a new paragraph at cursor position"
        >
          + Paragraph
        </button>
        {mediaOwner && (
          <ImageUploadField
            ownerType={mediaOwner.ownerType}
            ownerId={mediaOwner.ownerId}
            onUploaded={handleUploaded}
            compact
          />
        )}
      </div>
    </div>
  );
}
