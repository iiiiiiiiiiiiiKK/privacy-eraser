/**
 * Metadata inspection.
 *
 * Two sources are combined, because neither alone is honest:
 *
 *  1. **`exifr`** parses tag by tag. It gives us real field names and values
 *     (Make, Model, DateTimeOriginal, GPSLatitude, …) for JPEG and PNG/WebP
 *     eXIf blocks — but it only knows EXIF/XMP/IPTC/ICC, not "trailing bytes",
 *     and a corrupt block yields nothing at all.
 *  2. **Our own container scanners** (`jpeg.ts`, `png.ts`, `webp.ts`) list every
 *     physical block with its byte size, so the UI can honestly say "an APP1
 *     block of 4 872 bytes exists here" even when its contents fail to parse.
 *
 * Exif-only fields are labelled with the container they came from, and anything
 * we found bytes for but could not parse is reported as `unknown` rather than
 * silently dropped.
 */

import exifr from 'exifr';

import { ascii, detectFormat } from './format';
import { jpegSegmentKind, scanJpeg } from './jpeg';
import { isPng, pngChunkKind, pngTextKeyword, scanPng } from './png';
import { isWebp, scanWebp, webpChunkKind } from './webp';
import { parseExifPayload, type TiffResult } from './tiff';
import type {
  ContainerKind,
  ContainerReport,
  GpsInfo,
  ImageInfo,
  Inspection,
  MetaField,
  Sensitivity,
} from './types';

/** Field catalog: how to label and rank the tags people actually care about. */
interface FieldSpec {
  label: string;
  category: string;
  sensitivity: Sensitivity;
}

const DATE_CATEGORY = '时间';
const DEVICE_CATEGORY = '设备';
const OWNER_CATEGORY = '作者 / 版权';
const SOFTWARE_CATEGORY = '软件';
const GPS_CATEGORY = '位置';
const IMAGE_CATEGORY = '图像参数';

const FIELD_SPECS: Record<string, FieldSpec> = {
  Make: { label: '相机厂商', category: DEVICE_CATEGORY, sensitivity: 'medium' },
  Model: { label: '相机型号', category: DEVICE_CATEGORY, sensitivity: 'medium' },
  LensMake: { label: '镜头厂商', category: DEVICE_CATEGORY, sensitivity: 'low' },
  LensModel: { label: '镜头型号', category: DEVICE_CATEGORY, sensitivity: 'medium' },
  LensSerialNumber: { label: '镜头序列号', category: DEVICE_CATEGORY, sensitivity: 'high' },
  SerialNumber: { label: '机身序列号', category: DEVICE_CATEGORY, sensitivity: 'high' },
  BodySerialNumber: { label: '机身序列号', category: DEVICE_CATEGORY, sensitivity: 'high' },
  OwnerName: { label: '相机所有者', category: OWNER_CATEGORY, sensitivity: 'high' },
  Software: { label: '处理软件', category: SOFTWARE_CATEGORY, sensitivity: 'low' },
  ProcessingSoftware: { label: '处理软件', category: SOFTWARE_CATEGORY, sensitivity: 'low' },
  HostComputer: { label: '主机名', category: SOFTWARE_CATEGORY, sensitivity: 'medium' },
  DateTimeOriginal: { label: '拍摄时间', category: DATE_CATEGORY, sensitivity: 'high' },
  CreateDate: { label: '创建时间', category: DATE_CATEGORY, sensitivity: 'high' },
  ModifyDate: { label: '修改时间', category: DATE_CATEGORY, sensitivity: 'medium' },
  DateTimeDigitized: { label: '数字化时间', category: DATE_CATEGORY, sensitivity: 'medium' },
  OffsetTime: { label: '时区偏移', category: DATE_CATEGORY, sensitivity: 'low' },
  GPSLatitude: { label: 'GPS 纬度', category: GPS_CATEGORY, sensitivity: 'high' },
  GPSLongitude: { label: 'GPS 经度', category: GPS_CATEGORY, sensitivity: 'high' },
  GPSAltitude: { label: 'GPS 海拔', category: GPS_CATEGORY, sensitivity: 'high' },
  GPSAltitudeRef: { label: '海拔基准', category: GPS_CATEGORY, sensitivity: 'medium' },
  GPSSpeed: { label: 'GPS 速度', category: GPS_CATEGORY, sensitivity: 'medium' },
  GPSSpeedRef: { label: '速度单位', category: GPS_CATEGORY, sensitivity: 'low' },
  GPSImgDirection: { label: '拍摄方向', category: GPS_CATEGORY, sensitivity: 'medium' },
  GPSImgDirectionRef: { label: '方向基准', category: GPS_CATEGORY, sensitivity: 'low' },
  GPSDateStamp: { label: 'GPS 日期', category: GPS_CATEGORY, sensitivity: 'high' },
  GPSTimeStamp: { label: 'GPS 时间', category: GPS_CATEGORY, sensitivity: 'high' },
  GPSProcessingMethod: { label: '定位方式', category: GPS_CATEGORY, sensitivity: 'medium' },
  GPSAreaInformation: { label: '位置描述', category: GPS_CATEGORY, sensitivity: 'high' },
  GPSPosition: { label: 'GPS 位置', category: GPS_CATEGORY, sensitivity: 'high' },
  Artist: { label: '作者', category: OWNER_CATEGORY, sensitivity: 'high' },
  Copyright: { label: '版权信息', category: OWNER_CATEGORY, sensitivity: 'medium' },
  ImageDescription: { label: '图像描述', category: OWNER_CATEGORY, sensitivity: 'medium' },
  UserComment: { label: '用户注释', category: OWNER_CATEGORY, sensitivity: 'high' },
  XPComment: { label: 'Windows 注释', category: OWNER_CATEGORY, sensitivity: 'high' },
  XPAuthor: { label: 'Windows 作者', category: OWNER_CATEGORY, sensitivity: 'high' },
  XPSubject: { label: 'Windows 主题', category: OWNER_CATEGORY, sensitivity: 'medium' },
  XPKeywords: { label: 'Windows 关键词', category: OWNER_CATEGORY, sensitivity: 'medium' },
  XPTitle: { label: 'Windows 标题', category: OWNER_CATEGORY, sensitivity: 'low' },
  ImageWidth: { label: '像素宽', category: IMAGE_CATEGORY, sensitivity: 'none' },
  ImageHeight: { label: '像素高', category: IMAGE_CATEGORY, sensitivity: 'none' },
  ExifImageWidth: { label: 'EXIF 记录宽度', category: IMAGE_CATEGORY, sensitivity: 'none' },
  ExifImageHeight: { label: 'EXIF 记录高度', category: IMAGE_CATEGORY, sensitivity: 'none' },
  Orientation: { label: '方向标记', category: IMAGE_CATEGORY, sensitivity: 'none' },
  ColorSpace: { label: '色彩空间', category: IMAGE_CATEGORY, sensitivity: 'none' },
  ExposureTime: { label: '曝光时间', category: IMAGE_CATEGORY, sensitivity: 'none' },
  FNumber: { label: '光圈', category: IMAGE_CATEGORY, sensitivity: 'none' },
  ISO: { label: 'ISO', category: IMAGE_CATEGORY, sensitivity: 'none' },
  FocalLength: { label: '焦距', category: IMAGE_CATEGORY, sensitivity: 'none' },
  Flash: { label: '闪光灯', category: IMAGE_CATEGORY, sensitivity: 'none' },
  WhiteBalance: { label: '白平衡', category: IMAGE_CATEGORY, sensitivity: 'none' },
  MeteringMode: { label: '测光模式', category: IMAGE_CATEGORY, sensitivity: 'none' },
  ExposureProgram: { label: '曝光程序', category: IMAGE_CATEGORY, sensitivity: 'none' },
  ExifVersion: { label: 'EXIF 版本', category: IMAGE_CATEGORY, sensitivity: 'none' },
  // ICC profile fields
  ProfileDescription: { label: 'ICC 描述', category: '色彩', sensitivity: 'none' },
  // IPTC
  Byline: { label: 'IPTC 作者', category: OWNER_CATEGORY, sensitivity: 'high' },
  Caption: { label: 'IPTC 说明', category: OWNER_CATEGORY, sensitivity: 'medium' },
  City: { label: 'IPTC 城市', category: GPS_CATEGORY, sensitivity: 'high' },
  Country: { label: 'IPTC 国家', category: GPS_CATEGORY, sensitivity: 'high' },
  Keywords: { label: '关键词', category: OWNER_CATEGORY, sensitivity: 'medium' },
};

/** Tags that are noise in a privacy report (raw byte blobs, tables). */
const IGNORED_TAGS = new Set([
  'MakerNote',
  'ApplicationNotes',
  'PrintIM',
  'ImageSourceData',
  'XML',
  'XMPToolkit',
  'UserCommentEncoding',
  'thumbnail',
  'Thumbnail',
  'hasThumbnail',
  'ICC_Profile',
]);

const SENSITIVITY_ORDER: Record<Sensitivity, number> = { high: 3, medium: 2, low: 1, none: 0 };

function describeValue(key: string, value: unknown): string {
  if (value === null || value === undefined) return '—';
  if (value instanceof Date) return value.toISOString().replace('T', ' ').replace('.000Z', ' UTC');
  if (typeof value === 'number') {
    if (key.startsWith('GPS') && !Number.isInteger(value)) return value.toFixed(6);
    return Number.isInteger(value) ? String(value) : value.toFixed(4);
  }
  if (typeof value === 'boolean') return value ? '是' : '否';
  if (typeof value === 'string') return value.length > 200 ? `${value.slice(0, 197)}…` : value;
  if (Array.isArray(value)) {
    if (value.length > 8) return `[${value.length} 项]`;
    return value.map((item) => describeValue(key, item)).join(', ');
  }
  if (value instanceof Uint8Array) return `[二进制 ${value.length} 字节]`;
  if (value instanceof ArrayBuffer) return `[二进制 ${value.byteLength} 字节]`;
  if (typeof value === 'object') {
    const json = JSON.stringify(value);
    return json.length > 200 ? `${json.slice(0, 197)}…` : json;
  }
  return String(value);
}

function fieldSpec(tag: string): FieldSpec {
  return FIELD_SPECS[tag] ?? { label: tag, category: '其他', sensitivity: 'low' };
}

function formatFromExifrName(name: string): ContainerKind {
  if (name === 'exif' || name === 'ifd0' || name === 'ifd1' || name === 'gps') return 'exif';
  if (name === 'xmp') return 'xmp';
  if (name === 'iptc') return 'iptc';
  if (name === 'icc') return 'icc';
  if (name === 'jfif') return 'jfif';
  if (name === 'ihdr') return 'unknown';
  return 'unknown';
}

/** Turn exifr's grouped output into a flat, de-duplicated field list. */
export function fieldsFromExifr(grouped: Record<string, Record<string, unknown>>): MetaField[] {
  const fields: MetaField[] = [];
  const seen = new Map<string, MetaField>();

  for (const [group, tags] of Object.entries(grouped)) {
    if (!tags || typeof tags !== 'object') continue;
    const container = formatFromExifrName(group);
    for (const [tag, value] of Object.entries(tags as Record<string, unknown>)) {
      if (IGNORED_TAGS.has(tag)) continue;
      if (value === undefined || value === null) continue;
      const spec = fieldSpec(tag);
      const field: MetaField = {
        key: `${group}.${tag}`,
        label: spec.label,
        value: describeValue(tag, value),
        category: group === 'gps' && spec.category !== GPS_CATEGORY ? GPS_CATEGORY : spec.category,
        sensitivity: spec.sensitivity,
        container,
      };
      // GPS coordinates show up as both `gps.latitude` and `gps.GPSLatitude`;
      // keep the first (more specific) entry only.
      const dedupe = `${field.label}|${field.value}`;
      const existing = seen.get(dedupe);
      if (existing) {
        if (SENSITIVITY_ORDER[field.sensitivity] > SENSITIVITY_ORDER[existing.sensitivity]) {
          existing.sensitivity = field.sensitivity;
        }
        continue;
      }
      seen.set(dedupe, field);
      fields.push(field);
    }
  }

  return fields;
}

function extractGps(grouped: Record<string, Record<string, unknown>>): GpsInfo | null {
  const gps = grouped.gps as Record<string, unknown> | undefined;
  if (!gps) return null;
  const lat = typeof gps.latitude === 'number' ? gps.latitude : typeof gps.GPSLatitude === 'number' ? (gps.GPSLatitude as number) : null;
  const lon = typeof gps.longitude === 'number' ? gps.longitude : typeof gps.GPSLongitude === 'number' ? (gps.GPSLongitude as number) : null;
  if (lat === null || lon === null) return null;
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (lat === 0 && lon === 0) return null;
  return {
    latitude: lat,
    longitude: lon,
    latitudeRef: typeof gps.GPSLatitudeRef === 'string' ? gps.GPSLatitudeRef : undefined,
    longitudeRef: typeof gps.GPSLongitudeRef === 'string' ? gps.GPSLongitudeRef : undefined,
    altitude: typeof gps.GPSAltitude === 'number' ? gps.GPSAltitude : undefined,
  };
}

const CONTAINER_LABELS: Record<ContainerKind, string> = {
  exif: 'EXIF',
  xmp: 'XMP',
  iptc: 'IPTC / Photoshop',
  icc: 'ICC 色彩配置',
  comment: 'JPEG 注释 (COM)',
  text: 'PNG 文本块',
  time: '时间戳',
  jfif: 'JFIF (APP0)',
  adobe: 'Adobe (APP14)',
  photoshop: 'Photoshop IRB',
  'application-extension': '其他 APP 段',
  unknown: '未分类',
};

const CONTAINER_NOTES: Record<ContainerKind, string> = {
  exif: '相机 / 镜头 / 时间 / GPS，最常见的隐私泄漏来源。可整段删除。',
  xmp: 'Adobe XMP（XML），常带编辑历史、作者与位置。可整段删除。',
  iptc: 'Photoshop IRB 中的 IPTC 字段（作者、城市、说明）。可整段删除。',
  icc: '色彩配置文件，不含个人信息，但删除可能轻微改变颜色。',
  comment: '自由文本注释，内容不可预测。可整段删除。',
  text: 'PNG 的 tEXt/zTXt/iTXt 键值对，常含软件名与 XMP。可整段删除。',
  time: 'PNG tIME 记录的最后修改时间。可删除。',
  jfif: 'JFIF 头（像素密度，可能有缩略图）。可删除，不影响解码。',
  adobe: 'Adobe APP14 色彩变换标记。可删除。',
  photoshop: 'Photoshop 私有资源块。可删除。',
  'application-extension': '厂商私有 APP 段（如 MPF、MakerNote 外层）。可整段删除。',
  unknown: '结构性或未知数据块。',
};

/**
 * Containers that can hold personal data. JFIF/ICC/IHDR carry only technical
 * parameters, so their fields never count as "residual personal information"
 * even though we still display them.
 */
const PERSONAL_CONTAINERS: ReadonlySet<ContainerKind> = new Set<ContainerKind>([
  'exif',
  'xmp',
  'iptc',
  'comment',
  'text',
  'photoshop',
]);

/** True when a field is genuinely about a person, a device or a location. */
export function isPersonalField(field: MetaField): boolean {
  if (!PERSONAL_CONTAINERS.has(field.container)) {
    return field.sensitivity === 'high' && field.container !== 'jfif' && field.container !== 'icc';
  }
  return field.sensitivity === 'high' || field.sensitivity === 'medium';
}

/**
 * `exifr` supports `silentErrors` at runtime but does not declare it in its
 * typings, so the option bag is widened here once instead of scattering casts.
 * Silent errors matter: a broken EXIF block must not abort the whole inspection.
 */
export function exifrOptions(): NonNullable<Parameters<typeof exifr.parse>[1]> {
  return {
    tiff: true,
    ifd1: false,
    exif: true,
    gps: true,
    xmp: true,
    iptc: true,
    icc: true,
    jfif: true,
    ihdr: false,
    translateKeys: true,
    translateValues: true,
    reviveValues: true,
    mergeOutput: false,
    silentErrors: true,
  } as unknown as NonNullable<Parameters<typeof exifr.parse>[1]>;
}

/**
 * Inspect a file: format, dimensions, every metadata container, every field.
 * Never throws — malformed input becomes `structurallyValid: false` + notes.
 */
export async function inspectImage(bytes: Uint8Array): Promise<Inspection> {
  const signature = detectFormat(bytes);
  const notes: string[] = [];
  const fields: MetaField[] = [];
  const parsedBy: string[] = [];
  const containerMap = new Map<ContainerKind, ContainerReport>();

  const addContainer = (kind: ContainerKind, size: number, removable: boolean, note?: string) => {
    const existing = containerMap.get(kind);
    if (existing) {
      existing.bytes += size;
      existing.count += 1;
      return;
    }
    containerMap.set(kind, {
      kind,
      bytes: size,
      count: 1,
      removable,
      note: note ?? CONTAINER_NOTES[kind],
    });
  };

  let info: ImageInfo = {
    format: signature.format,
    mime: signature.mime,
    ext: signature.ext,
    bytes: bytes.length,
    dimension: null,
    structurallyValid: false,
    unsupportedReason: signature.supported ? undefined : signature.reason,
  };

  if (!signature.supported) {
    notes.push(signature.reason ?? '这个文件格式不受支持，只能查看信息，无法清理。');
  }

  // ---- container scan (format specific) --------------------------------
  if (signature.format === 'jpeg') {
    const scan = scanJpeg(bytes);
    info = {
      ...info,
      dimension: scan.dimension,
      structurallyValid: scan.valid,
    };
    if (!scan.valid && scan.reason) notes.push(scan.reason);
    for (const segment of scan.segments) {
      const kind = jpegSegmentKind(segment);
      // Structural segments (DQT/DHT/SOF/…) are not metadata; skip them so the
      // report only lists things a user could actually care about.
      if (kind === 'unknown') continue;
      addContainer(kind, segment.length + 2, true);
    }
    if (scan.trailingBytes > 0) {
      addContainer('unknown', scan.trailingBytes, true, '文件结束标记之后的额外字节，可能隐藏任意数据。');
      notes.push(`JPEG 末尾有 ${scan.trailingBytes} 字节多余数据（EOI 之后），清理时会一并删除。`);
    }
  } else if (signature.format === 'png' && isPng(bytes)) {
    const scan = scanPng(bytes);
    info = {
      ...info,
      dimension: scan.dimension,
      structurallyValid: scan.valid,
      hasAlpha: scan.hasAlpha,
      frames: scan.isAnimated ? undefined : 1,
    };
    if (!scan.valid && scan.reason) notes.push(scan.reason);
    for (const chunk of scan.chunks) {
      if (chunk.type === 'IHDR' || chunk.type === 'PLTE' || chunk.type === 'IDAT' || chunk.type === 'IEND') continue;
      const kind = pngChunkKind(chunk.type);
      const info = [...(kind === 'text' ? [pngTextKeyword(bytes, chunk)] : [])].join('');
      addContainer(kind, chunk.length, true, kind === 'text' && info ? `PNG 文本块（关键字：${info || '空'}）。可整段删除。` : undefined);
    }
    if (scan.trailingBytes > 0) {
      addContainer('unknown', scan.trailingBytes, true, 'IEND 之后的额外字节。');
      notes.push(`PNG 末尾有 ${scan.trailingBytes} 字节多余数据（IEND 之后），清理时会一并删除。`);
    }
  } else if (signature.format === 'webp' && isWebp(bytes)) {
    const scan = scanWebp(bytes);
    info = {
      ...info,
      dimension: scan.dimension,
      structurallyValid: scan.valid,
      hasAlpha: scan.hasAlpha,
    };
    if (!scan.valid && scan.reason) notes.push(scan.reason);
    for (const chunk of scan.chunks) {
      const kind = webpChunkKind(chunk.type);
      if (kind === 'unknown') continue;
      addContainer(kind, chunk.length, true);
    }
    if (scan.trailingBytes > 0) {
      addContainer('unknown', scan.trailingBytes, true, 'RIFF 声明长度之外的额外字节。');
      notes.push(`WebP 末尾有 ${scan.trailingBytes} 字节超出 RIFF 声明的数据。`);
    }
  }

  // ---- field extraction ------------------------------------------------
  if (signature.supported) {
    try {
      const parsed = (await exifr.parse(bytes, exifrOptions())) as
        | Record<string, Record<string, unknown>>
        | undefined;

      if (parsed && typeof parsed === 'object') {
        const groups = Object.keys(parsed);
        if (groups.length > 0) {
          parsedBy.push('exifr');
          fields.push(...fieldsFromExifr(parsed));
          for (const group of groups) {
            const kind = formatFromExifrName(group);
            if (!containerMap.has(kind) && kind !== 'unknown') {
              addContainer(kind, 0, true, `${CONTAINER_NOTES[kind]}（大小由上方容器扫描给出）`);
            }
          }
        }
      } else {
        notes.push('未从文件中解析到 EXIF / XMP / IPTC 字段。');
      }
    } catch (error) {
      notes.push(`元数据解析失败：${error instanceof Error ? error.message : String(error)}。文件可能已损坏或使用了非标准结构。`);
    }
  }

  // WebP is not supported by exifr, so EXIF/XMP chunks inside a RIFF container
  // are decoded by our own TIFF reader. Without this a phone-exported .webp
  // would look "clean" while still carrying GPS.
  let webpTiff: TiffResult | null = null;
  if (signature.format === 'webp' && isWebp(bytes)) {
    const scan = scanWebp(bytes);
    const exifChunk = scan.chunks.find((chunk) => chunk.type === 'EXIF');
    if (exifChunk) {
      const payload = bytes.subarray(exifChunk.dataOffset, exifChunk.dataOffset + exifChunk.dataLength);
      webpTiff = parseExifPayload(payload);
      if (webpTiff.errors.length > 0) {
        notes.push(`WebP 内的 EXIF 块解析异常：${webpTiff.errors[0]}`);
      }
      const flat: Record<string, Record<string, unknown>> = {};
      if (Object.keys(webpTiff.ifd0).length > 0) flat.ifd0 = webpTiff.ifd0 as Record<string, unknown>;
      if (Object.keys(webpTiff.exif).length > 0) flat.exif = webpTiff.exif as Record<string, unknown>;
      if (Object.keys(webpTiff.gps).length > 0) flat.gps = webpTiff.gps as Record<string, unknown>;
      if (Object.keys(flat).length > 0) {
        parsedBy.push('内置 TIFF 解析器');
        fields.push(...fieldsFromExifr(flat));
      }
    }
    const xmpChunk = scan.chunks.find((chunk) => chunk.type === 'XMP');
    if (xmpChunk) {
      parsedBy.push('RIFF XMP 块');
      const xml = ascii(bytes, xmpChunk.dataOffset, Math.min(xmpChunk.dataLength, 4000));
      for (const field of xmpFieldsFromXml(xml)) fields.push(field);
    }
  }


  for (const report of containerMap.values()) {
    if (report.bytes > 0 && fields.length === 0 && report.kind === 'exif') {
      notes.push('检测到 EXIF 数据块，但没能解析出可读字段（可能被加密或结构损坏）。清理仍会整段删除它。');
    }
  }

  const containers = [...containerMap.values()]
    .filter((report) => report.kind !== 'unknown' || report.bytes > 0)
    .sort((a, b) => b.bytes - a.bytes);

  const gpsFromExifr = signature.supported
    ? await exifr
        .parse(bytes, exifrOptions())
        .then((parsed) => extractGps((parsed ?? {}) as Record<string, Record<string, unknown>>))
        .catch(() => null)
    : null;

  const gpsFromWebp =
    webpTiff && typeof webpTiff.gps.latitude === 'number' && typeof webpTiff.gps.longitude === 'number'
      ? {
          latitude: webpTiff.gps.latitude,
          longitude: webpTiff.gps.longitude,
          latitudeRef: typeof webpTiff.gps.GPSLatitudeRef === 'string' ? webpTiff.gps.GPSLatitudeRef : undefined,
          longitudeRef: typeof webpTiff.gps.GPSLongitudeRef === 'string' ? webpTiff.gps.GPSLongitudeRef : undefined,
          altitude: typeof webpTiff.gps.GPSAltitude === 'number' ? webpTiff.gps.GPSAltitude : undefined,
        }
      : null;

  const gps = gpsFromExifr ?? gpsFromWebp;

  const risk = fields.reduce<Sensitivity>((worst, field) => {
    return SENSITIVITY_ORDER[field.sensitivity] > SENSITIVITY_ORDER[worst] ? field.sensitivity : worst;
  }, gps ? 'high' : 'none');

  return {
    info,
    fields: fields.sort((a, b) => {
      const bySensitivity = SENSITIVITY_ORDER[b.sensitivity] - SENSITIVITY_ORDER[a.sensitivity];
      if (bySensitivity !== 0) return bySensitivity;
      return a.label.localeCompare(b.label, 'zh-CN');
    }),
    containers,
    gps,
    parsedBy,
    notes,
    risk,
  };
}

export { CONTAINER_LABELS, CONTAINER_NOTES };

/**
 * Best-effort XMP reader.
 *
 * We do not ship an XML parser: the packet is a flat list of `prefix:Name="value"`
 * attributes in practice, and a full parser would be a much larger dependency for
 * a handful of fields. Anything we cannot attribute is left out rather than
 * guessed — the container itself is still reported and removed.
 */
export function xmpFieldsFromXml(xml: string): MetaField[] {
  const fields: MetaField[] = [];
  const push = (tag: string, value: string) => {
    const clean = value.trim();
    if (!clean) return;
    const spec = fieldSpec(tag);
    fields.push({
      key: `xmp.${tag}`,
      label: spec.label,
      value: clean.length > 200 ? `${clean.slice(0, 197)}…` : clean,
      category: spec.category,
      sensitivity: spec.sensitivity,
      container: 'xmp',
    });
  };

  const attr = /([A-Za-z][\w.-]*):([A-Za-z][\w.-]*)\s*=\s*"([^"]*)"/g;
  let match: RegExpExecArray | null;
  while ((match = attr.exec(xml)) !== null) {
    const [, , name, value] = match;
    push(name!, value!);
  }

  const element = /<([A-Za-z][\w.-]*):([A-Za-z][\w.-]*)[^>]*>([^<]+)<\/\1:\2>/g;
  while ((match = element.exec(xml)) !== null) {
    const [, , name, value] = match;
    push(name!, value!);
  }

  // De-duplicate by label+value: XMP repeats names across namespaces.
  const seen = new Set<string>();
  return fields.filter((field) => {
    const key = `${field.label}|${field.value}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Human readable summary of a container amount, e.g. "APP1/Exif · 4.8 KB". */
export function describeContainer(report: ContainerReport): string {
  return `${CONTAINER_LABELS[report.kind]} · ${formatBytes(report.bytes)}`;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

export { formatBytes as formatBytesShared };

/** Search the raw bytes for an ASCII marker (used for XMP sanity checks). */
export function containsAsciiMarker(bytes: Uint8Array, marker: string): boolean {
  const needle = marker.split('').map((c) => c.charCodeAt(0));
  outer: for (let i = 0; i + needle.length <= bytes.length; i += 1) {
    for (let j = 0; j < needle.length; j += 1) {
      if (bytes[i + j] !== needle[j]) continue outer;
    }
    return true;
  }
  return false;
}

/** Extract a printable ASCII preview of a raw block (for the "raw" tab). */
export function asciiPreview(bytes: Uint8Array, offset: number, length: number, max = 240): string {
  return ascii(bytes, offset, Math.min(length, max)).replace(/[^\x20-\x7e\n]/g, '·');
}
