/**
 * The upload → inspect → clean → export state machine.
 *
 * Deliberate constraints encoded here:
 *  - bytes stay in memory only (no IndexedDB, no localStorage);
 *  - object URLs are revoked when an item leaves the workspace or the tab closes;
 *  - a per-file size cap and a per-batch cap stop a 60-file drop from exhausting
 *    memory before the user sees an error;
 *  - a failed inspection keeps the item visible with its error instead of
 *    silently disappearing.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { cleanAndVerify } from '../lib/clean';
import { detectFormat } from '../lib/format';
import { inspectImage } from '../lib/inspect';
import type { CleanOptions, CleanResult, Inspection, WorkItem } from '../lib/types';

/** 40 MB per file: bigger than any phone JPEG, small enough to stay responsive. */
export const MAX_FILE_BYTES = 40 * 1024 * 1024;
/** Total bytes allowed in one batch. */
export const MAX_BATCH_BYTES = 240 * 1024 * 1024;

const DEFAULT_OPTIONS: CleanOptions = {
  keepColorProfile: true,
  stripTrailingBytes: true,
};

let counter = 0;

function mimeFor(bytes: Uint8Array, fileName: string): string {
  const signature = detectFormat(bytes);
  if (signature.supported) return signature.mime;
  // Fall back to the extension so the preview still tries to render.
  if (/\.png$/i.test(fileName)) return 'image/png';
  if (/\.webp$/i.test(fileName)) return 'image/webp';
  if (/\.jpe?g$/i.test(fileName)) return 'image/jpeg';
  if (/\.gif$/i.test(fileName)) return 'image/gif';
  return 'application/octet-stream';
}

export function useWorkspace() {
  const [items, setItems] = useState<WorkItem[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [options, setOptions] = useState<CleanOptions>(DEFAULT_OPTIONS);
  const [busy, setBusy] = useState(false);
  const urlsRef = useRef<Set<string>>(new Set());

  // Revoke every object URL when the tab goes away, so nothing lingers.
  useEffect(() => {
    const urls = urlsRef.current;
    const cleanup = () => {
      for (const url of urls) URL.revokeObjectURL(url);
      urls.clear();
    };
    window.addEventListener('pagehide', cleanup);
    return () => {
      window.removeEventListener('pagehide', cleanup);
      cleanup();
    };
  }, []);

  const revoke = useCallback((url: string) => {
    URL.revokeObjectURL(url);
    urlsRef.current.delete(url);
  }, []);

  const updateItem = useCallback((id: string, patch: Partial<WorkItem>) => {
    setItems((current) => current.map((item) => (item.id === id ? { ...item, ...patch } : item)));
  }, []);

  /** Inspect one item in the background, then store its report. */
  const inspectItem = useCallback(
    async (id: string, bytes: Uint8Array) => {
      updateItem(id, { status: 'inspecting' });
      try {
        const inspection = await inspectImage(bytes);
        updateItem(id, { inspection, status: 'ready', error: null });
      } catch (error) {
        updateItem(id, {
          status: 'error',
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },
    [updateItem],
  );

  const addFiles = useCallback(
    async (files: FileList | File[]) => {
      const list = Array.from(files);
      if (list.length === 0) return { added: 0, skipped: [] as string[] };

      const existingBytes = items.reduce((sum, item) => sum + item.original.length, 0);
      let runningBytes = existingBytes;
      const skipped: string[] = [];
      const created: Array<{ item: WorkItem; bytes: Uint8Array }> = [];

      for (const file of list) {
        if (file.size > MAX_FILE_BYTES) {
          skipped.push(`${file.name}：超过单文件上限 40 MB`);
          continue;
        }
        if (runningBytes + file.size > MAX_BATCH_BYTES) {
          skipped.push(`${file.name}：本次工作区总量会超过 240 MB`);
          continue;
        }
        let bytes: Uint8Array;
        try {
          bytes = new Uint8Array(await file.arrayBuffer());
        } catch {
          skipped.push(`${file.name}：读取失败`);
          continue;
        }
        runningBytes += file.size;

        counter += 1;
        const id = `item-${counter}`;
        const blob = new Blob([bytes.slice().buffer as ArrayBuffer], { type: mimeFor(bytes, file.name) });
        const previewUrl = URL.createObjectURL(blob);
        urlsRef.current.add(previewUrl);

        const item: WorkItem = {
          id,
          fileName: file.name,
          original: bytes,
          previewUrl,
          status: 'queued',
          inspection: null,
          result: null,
          error: null,
        };
        created.push({ item, bytes });
      }

      if (created.length === 0) return { added: 0, skipped };

      setItems((current) => [...current, ...created.map((entry) => entry.item)]);
      setSelectedId((current) => current ?? created[0]!.item.id);

      // Inspect sequentially so a big batch does not block the main thread with
      // dozens of simultaneous parses.
      for (const entry of created) {
        await inspectItem(entry.item.id, entry.bytes);
      }
      return { added: created.length, skipped };
    },
    [items, inspectItem],
  );

  const removeItem = useCallback(
    (id: string) => {
      setItems((current) => {
        const target = current.find((item) => item.id === id);
        if (target) revoke(target.previewUrl);
        const next = current.filter((item) => item.id !== id);
        setSelectedId((selected) => (selected === id ? (next[0]?.id ?? null) : selected));
        return next;
      });
    },
    [revoke],
  );

  const clearAll = useCallback(() => {
    setItems((current) => {
      for (const item of current) revoke(item.previewUrl);
      return [];
    });
    setSelectedId(null);
  }, [revoke]);

  const cleanItem = useCallback(
    async (id: string): Promise<CleanResult | null> => {
      const item = items.find((entry) => entry.id === id);
      if (!item) return null;
      if (item.inspection && !item.inspection.info.unsupportedReason && !item.inspection.info.structurallyValid) {
        updateItem(id, { status: 'error', error: '文件结构无效，无法安全清理。' });
        return null;
      }
      updateItem(id, { status: 'cleaning' });
      try {
        const result = await cleanAndVerify(item.original, options);
        updateItem(id, { result, status: 'cleaned', error: null });
        return result;
      } catch (error) {
        updateItem(id, { status: 'error', error: error instanceof Error ? error.message : String(error) });
        return null;
      }
    },
    [items, options, updateItem],
  );

  const cleanAll = useCallback(async () => {
    setBusy(true);
    try {
      for (const item of items) {
        if (item.status === 'error') continue;
        if (item.inspection?.info.unsupportedReason) continue;
        await cleanItem(item.id);
      }
    } finally {
      setBusy(false);
    }
  }, [items, cleanItem]);

  const selected = useMemo(() => items.find((item) => item.id === selectedId) ?? null, [items, selectedId]);

  const totals = useMemo(() => {
    const inspected = items.filter((item) => item.inspection);
    const cleaned = items.filter((item) => item.result);
    const withGps = items.filter((item) => item.inspection?.gps);
    return {
      count: items.length,
      inspected: inspected.length,
      cleaned: cleaned.length,
      withGps: withGps.length,
      bytesBefore: cleaned.reduce((sum, item) => sum + (item.result?.bytesBefore ?? 0), 0),
      bytesAfter: cleaned.reduce((sum, item) => sum + (item.result?.bytesAfter ?? 0), 0),
      verified: cleaned.filter((item) => item.result?.verified).length,
    };
  }, [items]);

  return {
    items,
    selected,
    selectedId,
    setSelectedId,
    options,
    setOptions,
    busy,
    totals,
    addFiles,
    removeItem,
    clearAll,
    cleanItem,
    cleanAll,
    inspectItem,
  };
}

export type Workspace = ReturnType<typeof useWorkspace>;
export type { Inspection };
