// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { useEffect, useRef, useState } from 'react';
import { Paperclip, Download } from 'lucide-react';
import api from '@/lib/api';
import { getAttachmentImageUrl } from '@/lib/attachment-image-cache';
import { formatBytes } from '@/lib/format';
import type { MessageAttachment } from '@/types';


/**
 * One attachment row. Images fetch their (auth-gated) bytes on mount and render
 * an inline preview via an object URL; everything else shows a download button
 * that fetches on click. Object URLs are revoked on unmount to avoid leaks.
 */
function AttachmentItem({ att }: { att: MessageAttachment }) {
  const isImage = att.contentType.startsWith('image/');
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [downloading, setDownloading] = useState(false);
  const rowRef = useRef<HTMLDivElement>(null);
  // Only fetch an image's bytes once its row is near the viewport (lazy). Where
  // IntersectionObserver is unavailable (jsdom/tests), default to visible so the
  // preview still loads.
  const [inView, setInView] = useState<boolean>(
    typeof IntersectionObserver === 'undefined',
  );

  useEffect(() => {
    if (!isImage || inView || typeof IntersectionObserver === 'undefined') return;
    const el = rowRef.current;
    if (!el) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setInView(true);
          observer.disconnect();
        }
      },
      // Prefetch a little before the row actually enters the viewport.
      { rootMargin: '200px' },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [isImage, inView]);

  useEffect(() => {
    if (!isImage || !inView) return;
    let ignore = false;
    // Shared cache: fetch the DOWNSCALED thumbnail once per attachment and reuse
    // the object URL across renders/mounts (keyed `:thumb` so it never collides
    // with a full-image entry). The server falls back to the original when no
    // thumbnail exists. The cache owns the URL's lifecycle — do NOT revoke here.
    getAttachmentImageUrl(`${att.id}:thumb`, () => api.fetchAttachmentBlob(att.id, { thumb: true }))
      .then((url) => { if (!ignore) setPreviewUrl(url); })
      .catch(() => { /* preview is best-effort; the row still shows the filename */ });
    return () => { ignore = true; };
  }, [att.id, isImage, inView]);

  const [downloadFailed, setDownloadFailed] = useState(false);

  const download = async () => {
    setDownloading(true);
    setDownloadFailed(false);
    try {
      const blob = await api.fetchAttachmentBlob(att.id);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = att.filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      // Revoke on a later tick — revoking synchronously right after click() can
      // cancel the download in some browsers.
      setTimeout(() => URL.revokeObjectURL(url), 0);
    } catch {
      setDownloadFailed(true);
    } finally {
      setDownloading(false);
    }
  };

  return (
    <div ref={rowRef} className="border border-gray-200 dark:border-gray-700 rounded-lg p-2 max-w-xs">
      {isImage && previewUrl && (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={previewUrl} alt={att.filename} loading="lazy" className="max-h-48 rounded mb-1 object-contain" />
      )}
      <div className="flex items-center gap-2 text-xs">
        <Paperclip className="w-3.5 h-3.5 text-gray-400 shrink-0" />
        <span className="truncate flex-1 text-gray-700 dark:text-gray-300" title={att.filename}>{att.filename}</span>
        <span className="text-gray-400 shrink-0">{formatBytes(att.sizeBytes)}</span>
        <button
          type="button"
          onClick={download}
          disabled={downloading}
          className={`shrink-0 disabled:opacity-50 ${downloadFailed ? 'text-red-500' : 'text-gray-400 hover:text-blue-600'}`}
          aria-label={`Download ${att.filename}`}
          title={downloadFailed ? 'Download failed — click to retry' : `Download ${att.filename}`}
        >
          <Download className="w-3.5 h-3.5" />
        </button>
      </div>
    </div>
  );
}

/**
 * Renders a message's attachments. If `attachments` is supplied (e.g. embedded
 * in the thread payload) it's used directly — no fetch. Only when omitted does
 * it fetch by `messageId` (fallback). Renders nothing when there are none.
 */
export function MessageAttachments({ messageId, attachments }: { messageId: string; attachments?: MessageAttachment[] }) {
  const provided = attachments !== undefined;
  const [fetched, setFetched] = useState<MessageAttachment[]>([]);

  useEffect(() => {
    if (provided) return; // caller supplied the list — avoid an N+1 fetch
    let ignore = false;
    api.getMessageAttachments(messageId)
      .then((r) => { if (!ignore) setFetched(r.data?.attachments ?? []); })
      .catch(() => { if (!ignore) setFetched([]); });
    return () => { ignore = true; };
  }, [messageId, provided]);

  const items = provided ? attachments! : fetched;
  if (items.length === 0) return null;

  return (
    <div className="mt-2 space-y-1.5">
      {items.map((a) => <AttachmentItem key={a.id} att={a} />)}
    </div>
  );
}
