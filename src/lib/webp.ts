/**
 * WebP (RIFF) chunk scanner.
 *
 * WebP is a RIFF container: `RIFF <size> WEBP` followed by chunks. Metadata is
 * stored in dedicated chunks:
 *
 *   EXIF   raw EXIF block (same byte layout as JPEG APP1/Exif minus the header)
 *   XMP    XMP XML
 *   ICCP   ICC colour profile
 *   ANIM / ANMF   animation control and frames
 *   VP8 / VP8L / VP8X   the image itself
 *
 * Removing EXIF/XMP means dropping whole chunks and rewriting the RIFF size,
 * which leaves the compressed image bitstream untouched.
 */

import { ascii } from './format';
import type { ContainerKind, Dimension } from './types';

export interface WebpChunk {
  type: string;
  offset: number;
  /** Total bytes including the 8-byte header and padding. */
  length: number;
  dataOffset: number;
  dataLength: number;
}

export interface WebpScan {
  chunks: WebpChunk[];
  dimension: Dimension | null;
  valid: boolean;
  reason?: string;
  hasAlpha: boolean;
  isAnimated: boolean;
  trailingBytes: number;
}

export const WEBP_CHUNK_INFO: Record<string, { kind: ContainerKind; label: string; note: string }> = {
  EXIF: { kind: 'exif', label: 'EXIF', note: 'WebP 内嵌的 EXIF：相机、镜头、时间与 GPS。' },
  XMP: { kind: 'xmp', label: 'XMP', note: 'Adobe XMP XML，常与 EXIF 重复，也可能单独包含编辑历史。' },
  ICCP: { kind: 'icc', label: 'ICCP 色彩配置', note: 'ICC 色彩配置文件，不含个人信息但影响颜色。' },
  ANIM: { kind: 'unknown', label: 'ANIM', note: '动画参数。' },
  ANMF: { kind: 'unknown', label: 'ANMF', note: '动画帧数据。' },
  ALPH: { kind: 'unknown', label: 'ALPH', note: 'Alpha 通道数据。' },
  VP8: { kind: 'unknown', label: 'VP8（有损图像）', note: '压缩的像素数据。' },
  VP8L: { kind: 'unknown', label: 'VP8L（无损图像）', note: '压缩的像素数据。' },
  VP8X: { kind: 'unknown', label: 'VP8X（扩展格式头）', note: '扩展格式标志，声明是否含 EXIF/XMP/Alpha/动画。' },
};

export function isWebp(data: Uint8Array): boolean {
  if (data.length < 12) return false;
  return (
    data[0] === 0x52 && data[1] === 0x49 && data[2] === 0x46 && data[3] === 0x46 &&
    data[8] === 0x57 && data[9] === 0x45 && data[10] === 0x42 && data[11] === 0x50
  );
}

function readU16LE(data: Uint8Array, offset: number): number {
  return data[offset]! | (data[offset + 1]! << 8);
}

function readU24LE(data: Uint8Array, offset: number): number {
  return data[offset]! | (data[offset + 1]! << 8) | (data[offset + 2]! << 16);
}

export function scanWebp(data: Uint8Array): WebpScan {
  const chunks: WebpChunk[] = [];
  let dimension: Dimension | null = null;
  let hasAlpha = false;
  let isAnimated = false;

  if (!isWebp(data)) {
    return { chunks, dimension, valid: false, reason: '文件缺少 RIFF/WEBP 头。', hasAlpha, isAnimated, trailingBytes: 0 };
  }

  const riffSize = data[4]! | (data[5]! << 8) | (data[6]! << 16) | (data[7]! << 24);
  const declaredEnd = Math.min(data.length, 8 + riffSize);
  let pos = 12;

  while (pos + 8 <= declaredEnd) {
    // FourCC codes are space-padded (`XMP `), so trim trailing spaces for display
    // while still copying the original bytes when rebuilding.
    const type = ascii(data, pos, 4).replace(/\s+$/, '');
    const size = data[pos + 4]! | (data[pos + 5]! << 8) | (data[pos + 6]! << 16) | (data[pos + 7]! << 24);
    const dataOffset = pos + 8;
    const padded = size + (size % 2);
    if (dataOffset + size > data.length) {
      return {
        chunks,
        dimension,
        valid: false,
        reason: `偏移 ${pos} 处的 WebP 块超出文件末尾。`,
        hasAlpha,
        isAnimated,
        trailingBytes: 0,
      };
    }
    chunks.push({ type, offset: pos, length: padded + 8, dataOffset, dataLength: size });

    if (type === 'VP8X' && size >= 10) {
      const flags = data[dataOffset]!;
      hasAlpha = (flags & 0x10) !== 0;
      isAnimated = (flags & 0x02) !== 0;
      const width = readU24LE(data, dataOffset + 4) + 1;
      const height = readU24LE(data, dataOffset + 7) + 1;
      dimension = { width, height };
    }
    if (type === 'VP8 ' && size >= 10) {
      // Lossy bitstream: 3-byte frame tag, then 3-byte start code 9D 01 2A,
      // then two 16-bit little-endian dimensions (14 bits used).
      if (data[dataOffset + 3] === 0x9d && data[dataOffset + 4] === 0x01 && data[dataOffset + 5] === 0x2a) {
        const width = readU16LE(data, dataOffset + 6) & 0x3fff;
        const height = readU16LE(data, dataOffset + 8) & 0x3fff;
        if (!dimension) dimension = { width, height };
      }
    }
    if (type === 'VP8L' && size >= 5) {
      // Lossless: signature 0x2F then 14 bits width-1, 14 bits height-1.
      if (data[dataOffset] === 0x2f) {
        const bits = data[dataOffset + 1]! | (data[dataOffset + 2]! << 8) | (data[dataOffset + 3]! << 16) | (data[dataOffset + 4]! << 24);
        const width = (bits & 0x3fff) + 1;
        const height = ((bits >> 14) & 0x3fff) + 1;
        if (!dimension) dimension = { width, height };
        hasAlpha = true; // VP8L may carry alpha in the bitstream
      }
    }
    if (type === 'ANIM') isAnimated = true;

    pos = dataOffset + padded;
  }

  const consumed = pos;
  return {
    chunks,
    dimension,
    valid: chunks.length > 0,
    reason: chunks.length > 0 ? undefined : 'WEBP 容器中没有任何数据块。',
    hasAlpha,
    isAnimated,
    trailingBytes: Math.max(0, data.length - consumed),
  };
}

export function webpChunkKind(type: string): ContainerKind {
  return WEBP_CHUNK_INFO[type]?.kind ?? 'unknown';
}

export function shouldDropWebpChunk(type: string, keepColorProfile: boolean): boolean {
  if (type === 'EXIF' || type === 'XMP') return true;
  if (type === 'ICCP') return !keepColorProfile;
  return false;
}

/**
 * Rebuild the RIFF container with only the kept chunks.
 *
 * The VP8X header advertises which metadata chunks exist. If we remove EXIF/XMP
 * while leaving those flags set, strict decoders may complain, so the flags are
 * cleared to match reality.
 */
export function rebuildWebp(
  data: Uint8Array,
  scan: WebpScan,
  keep: (chunk: WebpChunk) => boolean,
  includeTrailing: boolean,
): Uint8Array {
  const kept = scan.chunks.filter(keep);
  const bodySize = kept.reduce((sum, chunk) => sum + chunk.length, 0);
  const trailing = includeTrailing && scan.trailingBytes > 0 ? data.subarray(data.length - scan.trailingBytes) : new Uint8Array(0);
  const out = new Uint8Array(8 + 4 + bodySize + trailing.length);

  out.set(data.subarray(0, 4), 0); // 'RIFF'
  const riffSize = 4 + bodySize;
  out[4] = riffSize & 0xff;
  out[5] = (riffSize >> 8) & 0xff;
  out[6] = (riffSize >> 16) & 0xff;
  out[7] = (riffSize >> 24) & 0xff;
  out.set(data.subarray(8, 12), 8); // 'WEBP'

  let offset = 12;
  for (const chunk of kept) {
    const isHeader = chunk.type === 'VP8X';
    const src = data.subarray(chunk.offset, chunk.offset + chunk.length);
    out.set(src, offset);
    if (isHeader) {
      const dataOffset = offset + 8;
      const hasExif = kept.some((c) => c.type === 'EXIF');
      const hasXmp = kept.some((c) => c.type === 'XMP');
      const hasIcc = kept.some((c) => c.type === 'ICCP');
      const hasAnim = kept.some((c) => c.type === 'ANIM');
      const hasAlphaChunk = kept.some((c) => c.type === 'ALPH');
      let flags = out[dataOffset]!;
      flags = hasIcc ? flags | 0x20 : flags & ~0x20;
      flags = hasAlphaChunk || (flags & 0x10) !== 0 ? flags : flags & ~0x10;
      flags = hasExif ? flags | 0x08 : flags & ~0x08;
      flags = hasXmp ? flags | 0x04 : flags & ~0x04;
      flags = hasAnim ? flags | 0x02 : flags & ~0x02;
      out[dataOffset] = flags;
    }
    offset += chunk.length;
  }
  if (trailing.length > 0) out.set(trailing, offset);
  return out;
}
