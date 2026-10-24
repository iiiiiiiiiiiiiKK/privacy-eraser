/**
 * Browser download helpers.
 *
 * Everything here works on in-memory bytes; nothing is uploaded, and object URLs
 * are revoked as soon as the browser has had a chance to start the download.
 */

import { zipSync } from 'fflate';

/** Trigger a download of `bytes` with the given filename. */
export function downloadBytes(bytes: Uint8Array, filename: string, mime: string): void {
  // Copy into a fresh buffer so the Blob never references a larger backing store.
  const blob = new Blob([bytes.slice().buffer as ArrayBuffer], { type: mime || 'application/octet-stream' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.rel = 'noopener';
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  // Safari needs a tick before the URL can be released.
  window.setTimeout(() => URL.revokeObjectURL(url), 2000);
}

export interface ZipEntryInput {
  name: string;
  bytes: Uint8Array;
}

/**
 * Build a ZIP archive in memory (no worker, no library CDN).
 * Compression level 6 keeps the archive small without a noticeable delay for
 * the handful of images a browser session normally handles.
 */
export function buildZip(entries: ZipEntryInput[]): Uint8Array {
  const files: Record<string, Uint8Array> = {};
  const used = new Set<string>();
  for (const entry of entries) {
    // Zip entry names must be unique.
    let name = entry.name;
    let counter = 1;
    while (used.has(name)) {
      const dot = entry.name.lastIndexOf('.');
      name = dot > 0
        ? `${entry.name.slice(0, dot)}-${counter}${entry.name.slice(dot)}`
        : `${entry.name}-${counter}`;
      counter += 1;
    }
    used.add(name);
    files[name] = entry.bytes;
  }
  return zipSync(files, { level: 6 });
}

/** Download several files as one ZIP. */
export function downloadZip(entries: ZipEntryInput[], zipName = 'privacy-eraser-clean.zip'): void {
  const zip = buildZip(entries);
  downloadBytes(zip, zipName, 'application/zip');
}

/** Replace/append a `-clean` suffix to a filename while keeping the extension. */
export function cleanedFileName(original: string, ext: string): string {
  const base = original.replace(/\.[^.]+$/, '');
  const safe = base.replace(/[\\/:*?"<>|]+/g, '_').slice(0, 80) || 'image';
  return `${safe}-clean.${ext}`;
}
