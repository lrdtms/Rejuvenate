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
import { useEffect, useCallback } from 'react';
import { useEditor, EditorContent } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import Image from '@tiptap/extension-image';
import Link from '@tiptap/extension-link';
import type { MediaAsset } from '@/shared/types';
import { ImageUploadField } from './ImageUploadField';

interface RichTextEditorProps {
  value: string;
  onChange: (html: string) => void;
  /** If provided, show the image upload widget bound to this post/event */
  mediaOwner?: { ownerType: 'BLOG_POST' | 'EVENT'; ownerId: string };
  onMediaUploaded?: (asset: MediaAsset) => void;
}

export function RichTextEditor({ value, onChange, mediaOwner, onMediaUploaded }: RichTextEditorProps) {
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
      Image.configure({ allowBase64: false }),
      Link.configure({ openOnClick: false, autolink: false }),
    ],
    content: value,
    onUpdate({ editor: e }) {
      onChange(e.getHTML());
    },
  });

  // Sync external value changes (e.g. on load) without triggering onUpdate loop
  useEffect(() => {
    if (!editor) return;
    const currentHTML = editor.getHTML();
    if (currentHTML !== value) {
      // setContent without emitting update event
      editor.commands.setContent(value, { emitUpdate: false });
    }
  }, [value, editor]);

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
    if (editor) {
      editor.chain().focus().setImage({ src: asset.url, alt: asset.altText ?? '' }).run();
    }
    onMediaUploaded?.(asset);
  }, [editor, onMediaUploaded]);

  if (!editor) return null;

  const btn = (label: string, action: () => void, active?: boolean, title?: string) => (
    <button
      key={label}
      type="button"
      className={['tiptap-toolbar-btn', active ? 'is-active' : ''].filter(Boolean).join(' ')}
      onClick={action}
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
      </div>

      {mediaOwner && (
        <div style={{ padding: '0 0.6rem 0.5rem' }}>
          <ImageUploadField
            ownerType={mediaOwner.ownerType}
            ownerId={mediaOwner.ownerId}
            onUploaded={handleUploaded}
          />
        </div>
      )}

      <div className="tiptap-editor-content">
        <EditorContent editor={editor} />
      </div>
    </div>
  );
}
