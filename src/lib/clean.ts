/**
 * Cleaning + verification.
 *
 * The cleaning strategy is deliberately *byte level*, not canvas based:
 *
 *  - JPEG: keep every marker segment except the metadata ones; copy the entropy
 *    coded scan verbatim. No re-encode, no quality loss, pixels identical.
 *  - PNG: drop ancillary metadata chunks; keep IHDR/PLTE/IDAT/IEND (and APNG
 *    frames). Pixels identical.
 *  - WebP: drop EXIF/XMP (and ICCP when the user opts out) from the RIFF
 *    container and rewrite the RIFF size + VP8X flags. Pixels identical.
 *
 * Canvas re-encoding is available as an explicit fallback for files whose
 * container is too damaged to rewrite — it is labelled as lossy in the UI.
 *
 * After cleaning we **re-parse the produced bytes** rather than trusting that
 * the removal worked, which is the only way to say "verified" honestly.
 */

import exifr from 'exifr';

import { exifrOptions, fieldsFromExifr, inspectImage, isPersonalField } from './inspect';
import { detectFormat } from './format';
import { jpegSegmentKind, rebuildJpeg, scanJpeg } from './jpeg';
import { rebuildPng, scanPng, shouldDropPngChunk } from './png';
import { rebuildWebp, scanWebp, shouldDropWebpChunk } from './webp';
import type { CleanOptions, CleanResult, ContainerKind, ContainerReport, Dimension, MetaField } from './types';

const CONTAINER_LABEL: Record<ContainerKind, string> = {
  exif: 'EXIF',
  xmp: 'XMP',
  iptc: 'IPTC / Photoshop',
  icc: 'ICC 色彩配置',
  comment: 'JPEG 注释',
  text: 'PNG 文本块',
  time: '时间戳',
  jfif: 'JFIF 头',
  adobe: 'Adobe 标记',
  photoshop: 'Photoshop 资源块',
  'application-extension': '私有 APP 段',
  unknown: '额外数据',
};

export interface CleanedFile {
  buffer: Uint8Array;
  mime: string;
  ext: string;
  removed: CleanResult['removed'];
  dimension: Dimension | null;
  /** Structural notes from the rewrite (e.g. "dropped 3 segments"). */
  notes: string[];
}

/**
 * Remove metadata at the container level. Throws when the container cannot be
 * parsed well enough to rewrite safely.
 */
export function stripMetadata(bytes: Uint8Array, options: CleanOptions): CleanedFile {
  const signature = detectFormat(bytes);
  const removed: CleanResult['removed'] = [];
  const notes: string[] = [];

  if (signature.format === 'jpeg') {
    const scan = scanJpeg(bytes);
    if (!scan.valid) {
      throw new Error(scan.reason ?? 'JPEG 结构无效，无法安全清理。');
    }
    const keep = (segment: Parameters<Parameters<typeof rebuildJpeg>[2]>[0], kind: ContainerKind) => {
      if (kind === 'exif' || kind === 'xmp' || kind === 'iptc' || kind === 'comment' || kind === 'photoshop') return false;
      if (kind === 'icc') return options.keepColorProfile;
      // JFIF / Adobe / other APP segments are not personal data but are also
      // not needed to decode; drop the risky vendor ones, keep JFIF density.
      if (kind === 'jfif') return true;
      if (kind === 'adobe') return true;
      if (kind === 'application-extension') {
        // APP2/MPF and maker-specific blocks can embed extra images or serials.
        return segment.identifier === 'APP2/ICC';
      }
      return true;
    };

    for (const segment of scan.segments) {
      const kind = jpegSegmentKind(segment);
      if (keep(segment, kind)) continue;
      const existing = removed.find((entry) => entry.kind === kind);
      if (existing) {
        existing.bytes += segment.length + 2;
        existing.count += 1;
      } else {
        removed.push({ kind, bytes: segment.length + 2, count: 1, label: CONTAINER_LABEL[kind] });
      }
    }
    if (options.stripTrailingBytes && scan.trailingBytes > 0) {
      removed.push({ kind: 'unknown', bytes: scan.trailingBytes, count: 1, label: 'EOI 之后的额外字节' });
    }

    const output = rebuildJpeg(bytes, scan, (segment, kind) => keep(segment, kind), !options.stripTrailingBytes);
    return { buffer: output, mime: 'image/jpeg', ext: 'jpg', removed, dimension: scan.dimension, notes };
  }

  if (signature.format === 'png') {
    const scan = scanPng(bytes);
    if (!scan.valid) throw new Error(scan.reason ?? 'PNG 结构无效，无法安全清理。');

    for (const chunk of scan.chunks) {
      if (!shouldDropPngChunk(chunk.type, options.keepColorProfile)) continue;
      const kind: ContainerKind =
        chunk.type === 'eXIf' ? 'exif' : chunk.type === 'iCCP' ? 'icc' : chunk.type === 'tIME' ? 'time' : 'text';
      const existing = removed.find((entry) => entry.kind === kind);
      if (existing) {
        existing.bytes += chunk.length;
        existing.count += 1;
      } else {
        removed.push({ kind, bytes: chunk.length, count: 1, label: CONTAINER_LABEL[kind] });
      }
    }
    if (options.stripTrailingBytes && scan.trailingBytes > 0) {
      removed.push({ kind: 'unknown', bytes: scan.trailingBytes, count: 1, label: 'IEND 之后的额外字节' });
    }

    const output = rebuildPng(
      bytes,
      scan,
      (chunk) => !shouldDropPngChunk(chunk.type, options.keepColorProfile),
      !options.stripTrailingBytes,
    );
    if (scan.isAnimated) notes.push('这是 APNG 动画文件，动画帧已原样保留。');
    return { buffer: output, mime: 'image/png', ext: 'png', removed, dimension: scan.dimension, notes };
  }

  if (signature.format === 'webp') {
    const scan = scanWebp(bytes);
    if (!scan.valid) throw new Error(scan.reason ?? 'WebP 结构无效，无法安全清理。');

    for (const chunk of scan.chunks) {
      if (!shouldDropWebpChunk(chunk.type, options.keepColorProfile)) continue;
      const kind: ContainerKind = chunk.type === 'EXIF' ? 'exif' : chunk.type === 'XMP' ? 'xmp' : 'icc';
      const existing = removed.find((entry) => entry.kind === kind);
      if (existing) {
        existing.bytes += chunk.length;
        existing.count += 1;
      } else {
        removed.push({ kind, bytes: chunk.length, count: 1, label: CONTAINER_LABEL[kind] });
      }
    }

    const output = rebuildWebp(
      bytes,
      scan,
      (chunk) => !shouldDropWebpChunk(chunk.type, options.keepColorProfile),
      !options.stripTrailingBytes,
    );
    return { buffer: output, mime: 'image/webp', ext: 'webp', removed, dimension: scan.dimension, notes };
  }

  throw new Error(signature.reason ?? '不支持的格式，无法清理元数据。');
}

/**
 * Clean a file and verify the result by re-parsing it.
 *
 * `verified` is only true when the output parses AND no personal-data fields are
 * found in it again. Anything we cannot prove is reported in
 * `verificationNotes` instead of being claimed as removed.
 */
export async function cleanAndVerify(bytes: Uint8Array, options: CleanOptions): Promise<CleanResult> {
  const before = detectFormat(bytes);
  const cleaned = stripMetadata(bytes, options);

  const verificationNotes = [...cleaned.notes];

  // 1. Structural re-parse of the *output*.
  const afterSignature = detectFormat(cleaned.buffer);
  if (afterSignature.format !== before.format) {
    verificationNotes.push(
      `清理后格式从 ${before.label} 变成了 ${afterSignature.label}，这不符合预期，请勿直接发布该文件。`,
    );
  }

  let remainingFields: MetaField[] = [];
  let remaining: ContainerReport[] = [];
  let dimension: Dimension | null = cleaned.dimension;

  try {
    const reInspection = await inspectImage(cleaned.buffer);
    remaining = reInspection.containers;
    remainingFields = reInspection.fields.filter(isPersonalField);
    dimension = reInspection.info.dimension ?? dimension;
    if (!reInspection.info.structurallyValid) {
      verificationNotes.push('清理后的文件重新解析失败，导出结果可能无法被图片查看器打开。');
    }
    if (reInspection.gps) {
      verificationNotes.push('清理后仍能解析出 GPS 坐标，请勿发布该文件。');
    }
  } catch (error) {
    verificationNotes.push(`清理结果验证失败：${error instanceof Error ? error.message : String(error)}`);
  }

  // 2. Independent second opinion: parse the EXIF payload directly.
  try {
    const parsed = (await exifr.parse(cleaned.buffer, exifrOptions())) as
      | Record<string, Record<string, unknown>>
      | undefined;
    if (parsed && Object.keys(parsed).length > 0) {
      const leftovers = fieldsFromExifr(parsed).filter(isPersonalField);
      const merged = new Map<string, MetaField>();
      for (const field of [...remainingFields, ...leftovers]) merged.set(`${field.key}|${field.value}`, field);
      remainingFields = [...merged.values()];
      if (remainingFields.length > 0 && !verificationNotes.some((note) => note.includes('仍能解析'))) {
        verificationNotes.push('重新解析仍在输出中发现可读的个人数据字段，见下方「残留」列表。');
      }
    }
  } catch {
    verificationNotes.push('第二遍解析（exifr）未能执行，已用容器扫描结果作为验证依据。');
  }

  const verified = remainingFields.length === 0 && !verificationNotes.some((note) => note.includes('失败') || note.includes('仍能解析'));

  return {
    buffer: cleaned.buffer,
    mime: cleaned.mime,
    ext: cleaned.ext,
    removed: cleaned.removed,
    remaining,
    remainingFields,
    verified,
    dimension,
    bytesBefore: bytes.length,
    bytesAfter: cleaned.buffer.length,
    verificationNotes,
  };
}

/**
 * Lossy fallback: redraw through a canvas. Used only when the container cannot
 * be rewritten, and always labelled as re-encoding in the UI because it changes
 * pixels, can flatten transparency and converts the format.
 */
export async function cleanByReencode(
  bytes: Uint8Array,
  mime: string,
  quality = 0.92,
): Promise<{ buffer: Uint8Array; width: number; height: number }> {
  const blob = new Blob([bytes as BlobPart], { type: mime || 'application/octet-stream' });
  const url = URL.createObjectURL(blob);
  try {
    const img = await loadImage(url);
    const canvas = document.createElement('canvas');
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('无法创建 Canvas 上下文（浏览器不支持）。');
    context.drawImage(img, 0, 0);
    const type = mime === 'image/png' ? 'image/png' : mime === 'image/webp' ? 'image/webp' : 'image/jpeg';
    const outputBlob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, type, quality));
    if (!outputBlob) throw new Error('Canvas 编码失败。');
    const buffer = new Uint8Array(await outputBlob.arrayBuffer());
    return { buffer, width: canvas.width, height: canvas.height };
  } finally {
    URL.revokeObjectURL(url);
  }
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('图片无法被浏览器解码，可能已损坏。'));
    image.src = url;
  });
}

/** Format a byte delta as "+12.3 KB" / "-4.8 KB". */
export function formatDelta(before: number, after: number): string {
  const delta = after - before;
  const sign = delta > 0 ? '+' : delta < 0 ? '−' : '±';
  const size = Math.abs(delta);
  if (size < 1024) return `${sign}${size} B`;
  if (size < 1024 * 1024) return `${sign}${(size / 1024).toFixed(1)} KB`;
  return `${sign}${(size / (1024 * 1024)).toFixed(2)} MB`;
}

/** Percent change, e.g. "−12.4%". */
export function formatPercent(before: number, after: number): string {
  if (before === 0) return '0%';
  const pct = ((after - before) / before) * 100;
  const sign = pct > 0 ? '+' : pct < 0 ? '−' : '±';
  return `${sign}${Math.abs(pct).toFixed(1)}%`;
}
