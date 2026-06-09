/**
 * ImageUploadField — file picker that POSTs to /api/v1/admin/media.
 *
 * Uses multipart/form-data (NOT JSON). The Content-Type header is intentionally
 * omitted so the browser sets it with the correct multipart boundary.
 *
 * Props:
 *  ownerType  — 'BLOG_POST' | 'EVENT'
 *  ownerId    — the saved post/event id (caller must ensure the entity exists first)
 *  onUploaded — called with the MediaAsset on successful upload
 */
import { useRef, useState } from 'react';
import type { MediaAsset } from '@/shared/types';
import { isApiError } from '@/shared/api/client';

const BASE_URL = (import.meta.env.VITE_API_BASE_URL as string | undefined) ?? '';

interface ImageUploadFieldProps {
  ownerType: 'BLOG_POST' | 'EVENT';
  ownerId: string;
  onUploaded: (asset: MediaAsset) => void;
}

export function ImageUploadField({ ownerType, ownerId, onUploaded }: ImageUploadFieldProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [isPending, setIsPending] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  async function handleChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;

    setIsPending(true);
    setErrorMsg(null);

    const form = new FormData();
    form.append('file', file);
    form.append('ownerType', ownerType);
    form.append('ownerId', ownerId);

    try {
      // Do NOT set Content-Type here — let the browser set the multipart boundary.
      const response = await fetch(`${BASE_URL}/api/v1/admin/media`, {
        method: 'POST',
        credentials: 'include',
        body: form,
      });

      if (!response.ok) {
        let msg = `Upload failed (HTTP ${response.status})`;
        try {
          const body = (await response.json()) as { error?: { message?: string } };
          if (body.error?.message) msg = body.error.message;
        } catch {
          // ignore parse failure
        }
        setErrorMsg(msg);
        return;
      }

      const data = (await response.json()) as { asset: MediaAsset };
      onUploaded(data.asset);
      // Reset the input so the same file can be re-uploaded if needed.
      if (inputRef.current) inputRef.current.value = '';
    } catch (err) {
      if (isApiError(err)) {
        setErrorMsg(err.body.message);
      } else if (err instanceof Error) {
        setErrorMsg(err.message);
      } else {
        setErrorMsg('Upload failed — network error');
      }
    } finally {
      setIsPending(false);
    }
  }

  return (
    <div className="image-upload-field">
      <label htmlFor="image-upload-input">Upload image</label>
      <input
        id="image-upload-input"
        ref={inputRef}
        type="file"
        accept="image/jpeg,image/png,image/gif,image/webp"
        disabled={isPending}
        onChange={handleChange}
        aria-describedby={errorMsg ? 'image-upload-error' : 'image-upload-hint'}
      />
      <span id="image-upload-hint" className="image-upload-hint">
        JPEG, PNG, GIF or WebP
      </span>
      {isPending && (
        <span className="image-upload-pending" role="status">
          Uploading…
        </span>
      )}
      {errorMsg && (
        <span id="image-upload-error" className="image-upload-error" role="alert">
          {errorMsg}
        </span>
      )}
    </div>
  );
}
