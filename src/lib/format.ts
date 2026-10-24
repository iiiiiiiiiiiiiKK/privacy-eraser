/**
 * Byte-level image format detection.
 *
 * We only trust magic numbers, never the file extension or the browser's
 * reported MIME type: a `.jpg` that is really a PNG must be handled as a PNG,
 * and a file we cannot identify must be rejected instead of half-processed.
 */

import type { ImageFormat } from './types';

export interface Signature {
  format: ImageFormat;
  mime: string;
  ext: string;
  label: string;
  /** Can we parse and clean it? */
  supported: boolean;
  reason?: string;
}

/** Does the buffer contain the byte pattern at `offset`? `null` means "any byte". */
export function matchesAt(data: Uint8Array, pattern: Array<number | null>, offset = 0): boolean {
  if (data.length < offset + pattern.length) return false;
  for (let i = 0; i < pattern.length; i += 1) {
    const expected = pattern[i]!;
    if (expected === null) continue;
    if (data[offset + i] !== expected) return false;
  }
  return true;
}

export function startsWith(data: Uint8Array, bytes: number[]): boolean {
  return matchesAt(data, bytes, 0);
}

/** ASCII helper used by container scanners. */
export function ascii(data: Uint8Array, offset: number, length: number): string {
  let out = '';
  const end = Math.min(data.length, offset + length);
  for (let i = offset; i < end; i += 1) out += String.fromCharCode(data[i]!);
  return out;
}

export function detectFormat(data: Uint8Array): Signature {
  if (data.length < 12) {
    return {
      format: 'unknown',
      mime: 'application/octet-stream',
      ext: 'bin',
      label: '未知',
      supported: false,
      reason: '文件过小，无法识别格式。',
    };
  }

  // JPEG: FF D8 FF
  if (data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) {
    return { format: 'jpeg', mime: 'image/jpeg', ext: 'jpg', label: 'JPEG', supported: true };
  }

  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (startsWith(data, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return { format: 'png', mime: 'image/png', ext: 'png', label: 'PNG', supported: true };
  }

  // WebP: RIFF....WEBP
  if (matchesAt(data, [0x52, 0x49, 0x46, 0x46], 0) && matchesAt(data, [0x57, 0x45, 0x42, 0x50], 8)) {
    return { format: 'webp', mime: 'image/webp', ext: 'webp', label: 'WebP', supported: true };
  }

  // GIF87a / GIF89a
  if (matchesAt(data, [0x47, 0x49, 0x46, 0x38], 0)) {
    return {
      format: 'gif',
      mime: 'image/gif',
      ext: 'gif',
      label: 'GIF',
      supported: false,
      reason: 'GIF 的元数据清理尚未实现（本项目只读取并提示，不导出清理结果）。',
    };
  }

  // AVIF / HEIC: ....ftyp<brand>
  if (matchesAt(data, [0x66, 0x74, 0x79, 0x70], 4)) {
    const brand = ascii(data, 8, 4);
    if (brand.startsWith('avi')) {
      return {
        format: 'avif',
        mime: 'image/avif',
        ext: 'avif',
        label: 'AVIF',
        supported: false,
        reason: 'AVIF 使用 ISOBMFF 容器，清理需要重写 box 结构，暂不支持。',
      };
    }
    if (['heic', 'heix', 'hevc', 'mif1', 'msf1'].some((prefix) => brand.startsWith(prefix.slice(0, 3)))) {
      return {
        format: 'heic',
        mime: 'image/heic',
        ext: 'heic',
        label: 'HEIC',
        supported: false,
        reason: 'HEIC 使用 ISOBMFF 容器，清理需要重写 box 结构，暂不支持。',
      };
    }
  }

  // BMP: BM
  if (startsWith(data, [0x42, 0x4d])) {
    return {
      format: 'bmp',
      mime: 'image/bmp',
      ext: 'bmp',
      label: 'BMP',
      supported: false,
      reason: 'BMP 不含元数据段，也不在本工具的清理范围内。',
    };
  }

  // TIFF: II*\0 or MM\0*
  if (startsWith(data, [0x49, 0x49, 0x2a, 0x00]) || startsWith(data, [0x4d, 0x4d, 0x00, 0x2a])) {
    return {
      format: 'tiff',
      mime: 'image/tiff',
      ext: 'tiff',
      label: 'TIFF',
      supported: false,
      reason: 'TIFF 的结构本身就是元数据容器，无法仅删除叠加块来清理。',
    };
  }

  return {
    format: 'unknown',
    mime: 'application/octet-stream',
    ext: 'bin',
    label: '无法识别',
    supported: false,
    reason: '无法识别的文件格式（不是 JPEG / PNG / WebP）。',
  };
}
