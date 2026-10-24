/**
 * JPEG segment scanner.
 *
 * A JPEG is a sequence of markers. Everything a camera or editor wants to tell
 * the world lives in the "application" segments before the first scan:
 *
 *   FFE0 APP0  JFIF (density, sometimes a thumbnail)
 *   FFE1 APP1  Exif (camera, lens, timestamps, GPS)  ← the big one
 *   FFE1 APP1  XMP  (Adobe/Lightroom, often duplicates GPS as XML)
 *   FFE2 APP2  ICC colour profile
 *   FFED APP13 Photoshop IRB / IPTC (captions, creator, city)
 *   FFEE APP14 Adobe
 *   FFFE COM   free-text comment
 *
 * None of these are required to decode the pixels, so a JPEG can be cleaned by
 * rewriting the marker stream without touching any compressed image data.
 */

import { ascii } from './format';
import type { ContainerKind, Dimension } from './types';

export interface JpegSegment {
  /** Marker byte, e.g. 0xe1 for APP1. */
  marker: number;
  /** Offset of the 0xFF fill byte. */
  offset: number;
  /** Total bytes of this segment including marker and length. */
  length: number;
  /** Payload bytes (after the 2-byte length field). */
  payloadOffset: number;
  payloadLength: number;
  /** Human identifier derived from the payload, e.g. `APP1/Exif`. */
  identifier: string;
}

export interface JpegScan {
  segments: JpegSegment[];
  /** Offset of the SOS marker (start of scan), or -1 if absent. */
  sosOffset: number;
  /** Offset just past the EOI marker, or -1 if missing. */
  endOffset: number;
  /** Byte length of data after EOI. */
  trailingBytes: number;
  dimension: Dimension | null;
  valid: boolean;
  reason?: string;
  /** Progressive / baseline, for the info panel. */
  progressive: boolean;
}

const MARKER_NAMES: Record<number, string> = {
  0xe0: 'APP0',
  0xe1: 'APP1',
  0xe2: 'APP2',
  0xe3: 'APP3',
  0xe4: 'APP4',
  0xe5: 'APP5',
  0xe6: 'APP6',
  0xe7: 'APP7',
  0xe8: 'APP8',
  0xe9: 'APP9',
  0xea: 'APP10',
  0xeb: 'APP11',
  0xec: 'APP12',
  0xed: 'APP13',
  0xee: 'APP14',
  0xef: 'APP15',
  0xfe: 'COM',
};

/** Frames that carry dimensions (anything that is not DHT/JPG/DAC). */
const SOF_MARKERS = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);

export function isJpegAppSegment(marker: number): boolean {
  return (marker >= 0xe0 && marker <= 0xef) || marker === 0xfe;
}

function identifierFor(data: Uint8Array, marker: number, payloadOffset: number, payloadLength: number): string {
  const name = MARKER_NAMES[marker] ?? `FF${marker.toString(16).toUpperCase()}`;
  if (payloadLength < 6) return name;
  const head = ascii(data, payloadOffset, Math.min(32, payloadLength));
  if (marker === 0xe1) {
    if (head.startsWith('Exif')) return `${name}/Exif`;
    if (head.includes('http://ns.adobe.com/xap')) return `${name}/XMP`;
    return `${name}/${head.slice(0, 8).replace(/\0/g, '')}`;
  }
  if (marker === 0xe2) {
    if (head.startsWith('ICC_PROFILE')) return `${name}/ICC`;
    if (head.startsWith('MPF')) return `${name}/MPF`;
    return `${name}/${head.slice(0, 8).replace(/\0/g, '')}`;
  }
  if (marker === 0xe0) return head.startsWith('JFIF') ? `${name}/JFIF` : `${name}/${head.slice(0, 8).replace(/\0/g, '')}`;
  if (marker === 0xed) return head.startsWith('Photoshop') ? `${name}/Photoshop` : `${name}/${head.slice(0, 8).replace(/\0/g, '')}`;
  if (marker === 0xee) return head.startsWith('Adobe') ? `${name}/Adobe` : name;
  if (marker === 0xfe) return `${name}/${head.slice(0, 16)}`;
  return name;
}

/** Walk the marker stream up to the first SOS. */
export function scanJpeg(data: Uint8Array): JpegScan {
  const segments: JpegSegment[] = [];
  let dimension: Dimension | null = null;
  let progressive = false;

  if (data.length < 4 || data[0] !== 0xff || data[1] !== 0xd8) {
    return {
      segments,
      sosOffset: -1,
      endOffset: -1,
      trailingBytes: 0,
      dimension: null,
      valid: false,
      progressive: false,
      reason: '文件缺少 JPEG 起始标记（FF D8）。',
    };
  }

  let pos = 2;

  while (pos + 1 < data.length) {
    if (data[pos] !== 0xff) {
      // JPEG allows fill bytes, but a non-0xFF here means the stream is corrupt.
      return {
        segments,
        sosOffset: -1,
        endOffset: -1,
        trailingBytes: 0,
        dimension,
        valid: false,
        progressive,
        reason: `在偏移 ${pos} 处期望标记前缀 FF，实际是 ${data[pos]!.toString(16).toUpperCase()}。文件可能已损坏。`,
      };
    }
    // Skip fill bytes (FF FF ...)
    let marker = data[pos + 1]!;
    const markerStart = pos;
    while (marker === 0xff && pos + 2 < data.length) {
      pos += 1;
      marker = data[pos + 1]!;
    }
    if (marker === 0xff) break;

    const standalone = marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01;
    if (standalone) {
      pos += 2;
      if (marker === 0xd9) break;
      continue;
    }

    if (pos + 3 >= data.length) {
      return {
        segments,
        sosOffset: -1,
        endOffset: -1,
        trailingBytes: 0,
        dimension,
        valid: false,
        progressive,
        reason: 'JPEG 在段长度字段处意外结束。',
      };
    }
    const length = (data[pos + 2]! << 8) | data[pos + 3]!;
    if (length < 2) {
      return {
        segments,
        sosOffset: -1,
        endOffset: -1,
        trailingBytes: 0,
        dimension,
        valid: false,
        progressive,
        reason: `偏移 ${pos} 处的段长度非法（${length}）。`,
      };
    }
    const payloadOffset = pos + 4;
    const payloadLength = length - 2;
    if (payloadOffset + payloadLength > data.length) {
      return {
        segments,
        sosOffset: -1,
        endOffset: -1,
        trailingBytes: 0,
        dimension,
        valid: false,
        progressive,
        reason: 'JPEG 段的长度超出了文件末尾，文件可能被截断。',
      };
    }

    if (SOF_MARKERS.has(marker) && payloadLength >= 5) {
      const height = (data[payloadOffset + 1]! << 8) | data[payloadOffset + 2]!;
      const width = (data[payloadOffset + 3]! << 8) | data[payloadOffset + 4]!;
      if (width > 0 && height > 0) dimension = { width, height };
      progressive = marker === 0xc2 || marker === 0xc6 || marker === 0xca || marker === 0xce;
    }

    if (marker === 0xda) {
      // Start of scan. Find EOI by scanning from here; entropy-coded data may
      // contain FF00 (stuffed zero) and FFDx restart markers.
      let scan = payloadOffset + payloadLength;
      let end = -1;
      while (scan + 1 < data.length) {
        if (data[scan] === 0xff) {
          const next = data[scan + 1]!;
          if (next === 0xd9) {
            end = scan + 2;
            break;
          }
        }
        scan += 1;
      }
      const sosOffset = markerStart;
      const endOffset = end;
      return {
        segments,
        sosOffset,
        endOffset,
        trailingBytes: endOffset > 0 ? data.length - endOffset : 0,
        dimension,
        valid: endOffset > 0,
        progressive,
        reason: endOffset > 0 ? undefined : '未找到 JPEG 结束标记（FF D9），文件可能被截断。',
      };
    }

    segments.push({
      marker,
      offset: markerStart,
      length,
      payloadOffset,
      payloadLength,
      identifier: identifierFor(data, marker, payloadOffset, payloadLength),
    });
    pos = payloadOffset + payloadLength;
  }

  return {
    segments,
    sosOffset: -1,
    endOffset: -1,
    trailingBytes: 0,
    dimension,
    valid: false,
    progressive,
    reason: 'JPEG 中没有找到图像数据段（SOS）。',
  };
}

/** Map a JPEG segment to the container taxonomy used by the UI. */
export function jpegSegmentKind(segment: JpegSegment): ContainerKind {
  if (segment.marker === 0xfe) return 'comment';
  if (segment.marker === 0xe1 && segment.identifier === 'APP1/Exif') return 'exif';
  if (segment.marker === 0xe1 && segment.identifier === 'APP1/XMP') return 'xmp';
  if (segment.marker === 0xe2 && segment.identifier === 'APP2/ICC') return 'icc';
  if (segment.marker === 0xed) return 'iptc';
  if (segment.marker === 0xee) return 'adobe';
  if (segment.marker === 0xe0) return 'jfif';
  if (isJpegAppSegment(segment.marker)) return 'application-extension';
  // Quantisation tables, frame headers, Huffman tables and the rest are
  // structural: they are never metadata and must always be preserved.
  return 'unknown';
}

/**
 * Rebuild a JPEG from: the header byte pair, only the segments we keep, and the
 * original scan data. Pixel data is copied verbatim, so this is lossless.
 */
export function rebuildJpeg(
  data: Uint8Array,
  scan: JpegScan,
  keep: (segment: JpegSegment, kind: ContainerKind) => boolean,
  includeTrailing: boolean,
): Uint8Array {
  const header = data.subarray(0, 2);
  const kept = scan.segments.filter((segment) => keep(segment, jpegSegmentKind(segment)));
  const scanEnd = scan.endOffset > 0 ? scan.endOffset : data.length;
  const scanData = data.subarray(scan.sosOffset, scanEnd);
  const trailing = includeTrailing && scan.trailingBytes > 0 ? data.subarray(scanEnd) : new Uint8Array(0);

  const keptBytes = kept.reduce((sum, segment) => sum + segment.length + 2, 0);
  const out = new Uint8Array(header.length + keptBytes + scanData.length + trailing.length);
  let offset = 0;
  out.set(header, offset);
  offset += header.length;
  for (const segment of kept) {
    // A JPEG segment is: FF <marker> <len hi> <len lo> <payload>
    out[offset] = 0xff;
    out[offset + 1] = segment.marker;
    out[offset + 2] = (segment.length >> 8) & 0xff;
    out[offset + 3] = segment.length & 0xff;
    out.set(data.subarray(segment.payloadOffset, segment.payloadOffset + segment.payloadLength), offset + 4);
    offset += segment.length + 2;
  }
  out.set(scanData, offset);
  offset += scanData.length;
  if (trailing.length > 0) out.set(trailing, offset);
  return out;
}
