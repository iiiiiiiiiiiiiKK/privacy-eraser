/**
 * PNG chunk scanner.
 *
 * A PNG is a signature followed by length-prefixed chunks. Metadata lives in
 * clearly named ancillary chunks:
 *
 *   tEXt / zTXt / iTXt   free-text key/value pairs, including XMP (iTXt with
 *                        the `XML:com.adobe.xmp` keyword) and sometimes GPS
 *   eXIf                 a raw EXIF block (PNG 1.5+, common on phones)
 *   iCCP                 embedded ICC colour profile (zlib-compressed)
 *   gAMA/cHRM/sRGB       colour space information
 *   tIME                 last-modification timestamp
 *   pHYs                 physical pixel density
 *   sPLT/hIST/sBIT       palette/bit-depth hints
 *
 * Pixels live in `IDAT`; APNG adds `acTL`/`fcTL`/`fdAT`. Removing metadata never
 * requires re-encoding, so a cleaned PNG stays pixel-identical.
 */

import { ascii } from './format';
import type { ContainerKind, Dimension } from './types';

export interface PngChunk {
  type: string;
  /** Offset of the length field. */
  offset: number;
  /** Total bytes: 4 (length) + 4 (type) + data + 4 (CRC). */
  length: number;
  dataOffset: number;
  dataLength: number;
}

export interface PngScan {
  chunks: PngChunk[];
  dimension: Dimension | null;
  /** Offset just past IEND (+4 for the CRC), or -1 when absent. */
  endOffset: number;
  trailingBytes: number;
  valid: boolean;
  reason?: string;
  hasAlpha: boolean;
  isAnimated: boolean;
  bitDepth: number | null;
  colorType: number | null;
}

export const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** Chunks we understand well enough to name in the UI. */
export const PNG_CHUNK_INFO: Record<string, { kind: ContainerKind; label: string; note: string }> = {
  tEXt: { kind: 'text', label: 'tEXt 文本', note: '未压缩的文本键值对（可能包含软件名、作者、XMP）。' },
  zTXt: { kind: 'text', label: 'zTXt 压缩文本', note: 'zlib 压缩的文本块。' },
  iTXt: { kind: 'text', label: 'iTXt 国际化文本', note: 'UTF-8 文本块，XMP 通常以 XML:com.adobe.xmp 为关键字存在这里。' },
  eXIf: { kind: 'exif', label: 'eXIf（EXIF）', note: 'PNG 内嵌的原始 EXIF 块：相机、时间、GPS 都可能在这里。' },
  iCCP: { kind: 'icc', label: 'iCCP 色彩配置', note: '嵌入的 ICC 色彩配置文件，不含个人信息但影响颜色显示。' },
  gAMA: { kind: 'unknown', label: 'gAMA', note: '伽马值。' },
  cHRM: { kind: 'unknown', label: 'cHRM', note: '色度坐标。' },
  sRGB: { kind: 'unknown', label: 'sRGB', note: 'sRGB 渲染意图。' },
  cICP: { kind: 'unknown', label: 'cICP', note: '编码无关的色彩描述。' },
  tIME: { kind: 'time', label: 'tIME 时间戳', note: '最后修改时间（UTC）。' },
  pHYs: { kind: 'unknown', label: 'pHYs', note: '物理像素尺寸与单位。' },
  sBIT: { kind: 'unknown', label: 'sBIT', note: '有效位深。' },
  sPLT: { kind: 'unknown', label: 'sPLT', note: '建议调色板。' },
  hIST: { kind: 'unknown', label: 'hIST', note: '调色板直方图。' },
  bKGD: { kind: 'unknown', label: 'bKGD', note: '默认背景色。' },
  sbEX: { kind: 'unknown', label: 'sbEX', note: '非标准扩展块。' },
  acTL: { kind: 'unknown', label: 'acTL', note: 'APNG 动画控制块。' },
  fcTL: { kind: 'unknown', label: 'fcTL', note: 'APNG 帧控制块。' },
  fdAT: { kind: 'unknown', label: 'fdAT', note: 'APNG 帧数据块。' },
};

/** Ancillary chunks that carry no personal data and are safe to drop too. */
const DROPPABLE_ANCILLARY = new Set(['tIME', 'pHYs', 'bKGD', 'sBIT', 'sPLT', 'hIST', 'sbEX', 'prVW', 'mkBF', 'mkTS', 'mkBS', 'mkBT']);

export function isPng(data: Uint8Array): boolean {
  if (data.length < 8) return false;
  return PNG_SIGNATURE.every((b, i) => data[i] === b);
}

export function scanPng(data: Uint8Array): PngScan {
  const chunks: PngChunk[] = [];
  let dimension: Dimension | null = null;
  let hasAlpha = false;
  let isAnimated = false;
  let bitDepth: number | null = null;
  let colorType: number | null = null;

  if (!isPng(data)) {
    return {
      chunks,
      dimension: null,
      endOffset: -1,
      trailingBytes: 0,
      valid: false,
      reason: '文件缺少 PNG 签名。',
      hasAlpha,
      isAnimated,
      bitDepth,
      colorType,
    };
  }

  let pos = 8;
  let endOffset = -1;

  while (pos + 12 <= data.length) {
    const length = (data[pos]! << 24) | (data[pos + 1]! << 16) | (data[pos + 2]! << 8) | data[pos + 3]!;
    if (length < 0 || pos + 12 + length > data.length) {
      return {
        chunks,
        dimension,
        endOffset: -1,
        trailingBytes: 0,
        valid: false,
        reason: `偏移 ${pos} 处的 PNG 块长度非法或超出文件末尾。`,
        hasAlpha,
        isAnimated,
        bitDepth,
        colorType,
      };
    }
    const type = ascii(data, pos + 4, 4);
    const dataOffset = pos + 8;
    chunks.push({ type, offset: pos, length: length + 12, dataOffset, dataLength: length });

    if (type === 'IHDR' && length >= 13) {
      const width = (data[dataOffset]! << 24) | (data[dataOffset + 1]! << 16) | (data[dataOffset + 2]! << 8) | data[dataOffset + 3]!;
      const height = (data[dataOffset + 4]! << 24) | (data[dataOffset + 5]! << 16) | (data[dataOffset + 6]! << 8) | data[dataOffset + 7]!;
      bitDepth = data[dataOffset + 8]!;
      colorType = data[dataOffset + 9]!;
      dimension = { width, height };
      hasAlpha = colorType === 4 || colorType === 6;
    }
    if (type === 'acTL') isAnimated = true;

    pos += length + 12;
    if (type === 'IEND') {
      endOffset = pos;
      break;
    }
  }

  return {
    chunks,
    dimension,
    endOffset,
    trailingBytes: endOffset > 0 ? Math.max(0, data.length - endOffset) : 0,
    valid: endOffset > 0,
    reason: endOffset > 0 ? undefined : 'PNG 没有找到 IEND 结束块，文件可能被截断。',
    hasAlpha,
    isAnimated,
    bitDepth,
    colorType,
  };
}

export function pngChunkKind(type: string): ContainerKind {
  return PNG_CHUNK_INFO[type]?.kind ?? 'unknown';
}

/** Should this chunk be removed when cleaning? */
export function shouldDropPngChunk(type: string, keepColorProfile: boolean): boolean {
  // Structural chunks must always survive.
  if (type === 'IHDR' || type === 'PLTE' || type === 'IDAT' || type === 'IEND') return false;
  if (type === 'acTL' || type === 'fcTL' || type === 'fdAT') return false; // APNG frames
  if (type === 'tRNS') return false;

  switch (type) {
    case 'eXIf':
    case 'tEXt':
    case 'zTXt':
    case 'iTXt':
    case 'tIME':
      return true;
    case 'iCCP':
      return !keepColorProfile;
    case 'gAMA':
    case 'cHRM':
    case 'sRGB':
    case 'cICP':
      return false; // colour rendering hints, no personal data
    default:
      if (DROPPABLE_ANCILLARY.has(type)) return true;
      // Unknown ancillary chunks: drop them, they cannot be needed to decode.
      if (type[0] === type[0]!.toLowerCase()) return true;
      return false;
  }
}

/** Copy the file keeping only the chunks we want; pixels are untouched. */
export function rebuildPng(
  data: Uint8Array,
  scan: PngScan,
  keep: (chunk: PngChunk) => boolean,
  includeTrailing: boolean,
): Uint8Array {
  const kept = scan.chunks.filter(keep);
  const end = scan.endOffset > 0 ? scan.endOffset : data.length;
  const trailing = includeTrailing && scan.trailingBytes > 0 ? data.subarray(end) : new Uint8Array(0);
  const total = 8 + kept.reduce((sum, chunk) => sum + chunk.length, 0) + trailing.length;
  const out = new Uint8Array(total);
  out.set(data.subarray(0, 8), 0);
  let offset = 8;
  for (const chunk of kept) {
    out.set(data.subarray(chunk.offset, chunk.offset + chunk.length), offset);
    offset += chunk.length;
  }
  if (trailing.length > 0) out.set(trailing, offset);
  return out;
}

/**
 * Read the keyword of a tEXt/zTXt/iTXt chunk so the UI can say what the text is
 * (e.g. `Software`, `Comment`, `XML:com.adobe.xmp`).
 */
export function pngTextKeyword(data: Uint8Array, chunk: PngChunk): string {
  const end = Math.min(data.length, chunk.dataOffset + chunk.dataLength);
  let out = '';
  for (let i = chunk.dataOffset; i < end; i += 1) {
    if (data[i] === 0) break;
    out += String.fromCharCode(data[i]!);
    if (out.length > 79) break;
  }
  return out;
}
