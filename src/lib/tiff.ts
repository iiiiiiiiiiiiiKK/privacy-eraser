/**
 * Minimal TIFF/EXIF reader.
 *
 * `exifr` covers JPEG, PNG, HEIC and AVIF, but not the EXIF block inside a WebP
 * container. Rather than claiming "no metadata" for WebP files that clearly
 * carry an `EXIF` chunk, we parse that block ourselves: it is a plain TIFF
 * header with IFD0 + ExifIFD + GPS IFD.
 *
 * This reader is intentionally small: it extracts the tags people care about
 * (device, timestamps, owner, GPS) and never evaluates anything.
 */

import { GPS_TAGS, TIFF_TAGS } from './tiff-tags';

export type TiffValue = string | number | number[] | null;

export interface TiffResult {
  ifd0: Record<string, TiffValue>;
  exif: Record<string, TiffValue>;
  gps: Record<string, TiffValue>;
  /** Human-readable problems, e.g. "invalid TIFF byte order". */
  errors: string[];
}

const TYPE_BYTES: Record<number, number> = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8 };

interface Reader {
  le: boolean;
  view: DataView;
  errors: string[];
}

function u16(r: Reader, offset: number): number {
  return r.view.getUint16(offset, r.le);
}
function u32(r: Reader, offset: number): number {
  return r.view.getUint32(offset, r.le);
}

function readValue(r: Reader, type: number, count: number, valueOffset: number): TiffValue {
  const width = TYPE_BYTES[type];
  if (!width) return null;
  const total = width * count;
  const dataOffset = total <= 4 ? valueOffset : u32(r, valueOffset);
  if (dataOffset + total > r.view.byteLength) {
    r.errors.push(`TIFF 值超出范围（偏移 ${dataOffset}，长度 ${total}）。`);
    return null;
  }
  switch (type) {
    case 2: {
      // ASCII
      let out = '';
      for (let i = 0; i < count; i += 1) {
        const code = r.view.getUint8(dataOffset + i);
        if (code === 0) break;
        out += String.fromCharCode(code);
      }
      return out;
    }
    case 1:
    case 7: {
      const out: number[] = [];
      for (let i = 0; i < count; i += 1) out.push(r.view.getUint8(dataOffset + i));
      return count === 1 ? out[0]! : out;
    }
    case 3: {
      const out: number[] = [];
      for (let i = 0; i < count; i += 1) out.push(r.view.getUint16(dataOffset + i * 2, r.le));
      return count === 1 ? out[0]! : out;
    }
    case 4: {
      const out: number[] = [];
      for (let i = 0; i < count; i += 1) out.push(r.view.getUint32(dataOffset + i * 4, r.le));
      return count === 1 ? out[0]! : out;
    }
    case 5: {
      const out: number[] = [];
      for (let i = 0; i < count; i += 1) {
        const numerator = r.view.getUint32(dataOffset + i * 8, r.le);
        const denominator = r.view.getUint32(dataOffset + i * 8 + 4, r.le);
        out.push(denominator === 0 ? 0 : numerator / denominator);
      }
      return count === 1 ? out[0]! : out;
    }
    case 9: {
      const out: number[] = [];
      for (let i = 0; i < count; i += 1) out.push(r.view.getInt32(dataOffset + i * 4, r.le));
      return count === 1 ? out[0]! : out;
    }
    case 10: {
      const out: number[] = [];
      for (let i = 0; i < count; i += 1) {
        const numerator = r.view.getInt32(dataOffset + i * 8, r.le);
        const denominator = r.view.getInt32(dataOffset + i * 8 + 4, r.le);
        out.push(denominator === 0 ? 0 : numerator / denominator);
      }
      return count === 1 ? out[0]! : out;
    }
    case 11: {
      const out: number[] = [];
      for (let i = 0; i < count; i += 1) out.push(r.view.getFloat32(dataOffset + i * 4, r.le));
      return count === 1 ? out[0]! : out;
    }
    case 12: {
      const out: number[] = [];
      for (let i = 0; i < count; i += 1) out.push(r.view.getFloat64(dataOffset + i * 8, r.le));
      return count === 1 ? out[0]! : out;
    }
    default:
      return null;
  }
}

interface IfdEntry {
  tag: number;
  type: number;
  count: number;
  valueOffset: number;
}

function readIfd(r: Reader, offset: number): Map<number, IfdEntry> {
  const out = new Map<number, IfdEntry>();
  if (offset + 2 > r.view.byteLength) {
    r.errors.push('TIFF IFD 偏移超出范围。');
    return out;
  }
  const count = u16(r, offset);
  if (count > 4096) {
    r.errors.push(`TIFF IFD 条目数量异常（${count}），已停止解析。`);
    return out;
  }
  for (let i = 0; i < count; i += 1) {
    const base = offset + 2 + i * 12;
    if (base + 12 > r.view.byteLength) break;
    out.set(u16(r, base), {
      tag: u16(r, base),
      type: u16(r, base + 2),
      count: u32(r, base + 4),
      valueOffset: base + 8,
    });
  }
  const next = out.size > 0 ? offset + 2 + count * 12 : 0;
  if (next + 4 <= r.view.byteLength) out.set(-1, { tag: -1, type: 0, count: 0, valueOffset: next });
  return out;
}

/**
 * Parse a TIFF/EXIF block.
 *
 * `bytes` must start at the TIFF header (`II*\0` or `MM\0*`). JPEG APP1 payloads
 * include a 6-byte `Exif\0\0` prefix, so callers should skip that first.
 */
export function parseTiff(bytes: Uint8Array): TiffResult {
  const result: TiffResult = { ifd0: {}, exif: {}, gps: {}, errors: [] };
  if (bytes.length < 8) {
    result.errors.push('TIFF 数据过短。');
    return result;
  }
  const little = bytes[0] === 0x49 && bytes[1] === 0x49;
  const big = bytes[0] === 0x4d && bytes[1] === 0x4d;
  if (!little && !big) {
    result.errors.push('TIFF 字节序标记无效。');
    return result;
  }
  const reader: Reader = {
    le: little,
    view: new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength),
    errors: result.errors,
  };
  const magic = u16(reader, 2);
  if (magic !== 42) {
    result.errors.push(`TIFF 魔数无效（${magic}）。`);
    return result;
  }

  const ifd0Offset = u32(reader, 4);
  const ifd0 = readIfd(reader, ifd0Offset);

  let exifOffset = 0;
  let gpsOffset = 0;

  for (const [tag, entry] of ifd0) {
    if (tag === -1) continue;
    const name = TIFF_TAGS[tag];
    if (tag === 0x8769) {
      exifOffset = u32(reader, entry.valueOffset);
      continue;
    }
    if (tag === 0x8825) {
      gpsOffset = u32(reader, entry.valueOffset);
      continue;
    }
    if (!name) continue;
    result.ifd0[name] = readValue(reader, entry.type, entry.count, entry.valueOffset);
  }

  if (exifOffset > 0 && exifOffset < bytes.length) {
    for (const [tag, entry] of readIfd(reader, exifOffset)) {
      if (tag === -1) continue;
      const name = TIFF_TAGS[tag];
      if (!name) continue;
      result.exif[name] = readValue(reader, entry.type, entry.count, entry.valueOffset);
    }
  }

  if (gpsOffset > 0 && gpsOffset < bytes.length) {
    for (const [tag, entry] of readIfd(reader, gpsOffset)) {
      if (tag === -1) continue;
      const name = GPS_TAGS[tag];
      if (!name) continue;
      result.gps[name] = readValue(reader, entry.type, entry.count, entry.valueOffset);
    }
    // Convert DMS + ref into decimal degrees, matching exifr's `latitude`.
    const lat = toDegrees(result.gps.GPSLatitude);
    const lon = toDegrees(result.gps.GPSLongitude);
    if (lat !== null && lon !== null) {
      const latRef = typeof result.gps.GPSLatitudeRef === 'string' ? result.gps.GPSLatitudeRef : '';
      const lonRef = typeof result.gps.GPSLongitudeRef === 'string' ? result.gps.GPSLongitudeRef : '';
      result.gps.latitude = latRef.toUpperCase().startsWith('S') ? -lat : lat;
      result.gps.longitude = lonRef.toUpperCase().startsWith('W') ? -lon : lon;
    }
  }

  return result;
}

function toDegrees(value: TiffValue): number | null {
  if (typeof value === 'number') return value;
  if (!Array.isArray(value) || value.length === 0) return null;
  const [d = 0, m = 0, s = 0] = value;
  return d + m / 60 + s / 3600;
}

/** Locate and parse the EXIF block inside a WebP `EXIF` chunk payload. */
export function parseExifPayload(payload: Uint8Array): TiffResult {
  // Some writers keep the `Exif\0\0` marker, some store the bare TIFF header.
  if (payload.length > 6 && payload[0] === 0x45 && payload[1] === 0x78 && payload[2] === 0x69 && payload[3] === 0x66) {
    return parseTiff(payload.subarray(6));
  }
  return parseTiff(payload);
}
