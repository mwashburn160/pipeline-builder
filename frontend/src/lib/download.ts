// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Trigger a browser download of `blob` saved as `filename`. Owns the object-URL
 * lifecycle (create → click → revoke) so callers don't each re-implement (and
 * occasionally leak) the anchor dance.
 *
 * The revoke is deferred: revoking synchronously after `click()` can cancel the
 * download before the browser has read the blob — an empty or failed file on
 * large downloads such as the streamed log export.
 */
export function triggerBlobDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
