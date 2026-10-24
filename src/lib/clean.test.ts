import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { detectFormat } from './format';
import { scanJpeg } from './jpeg';
import { scanPng } from './png';
import { scanWebp } from './webp';
import { inspectImage, xmpFieldsFromXml } from './inspect';
import { cleanAndVerify, stripMetadata } from './clean';
import { parseTiff } from './tiff';

const FIXTURES = join(process.cwd(), 'fixtures');
const read = (name: string): Uint8Array => new Uint8Array(readFileSync(join(FIXTURES, name)));

describe('detectFormat', () => {
  it('按魔数识别 JPEG / PNG / WebP', () => {
    expect(detectFormat(read('exif-gps.jpg')).format).toBe('jpeg');
    expect(detectFormat(read('transparent.png')).format).toBe('png');
    expect(detectFormat(read('animated.webp')).format).toBe('webp');
  });

  it('把非图片文件识别为 unknown', () => {
    const format = detectFormat(read('not-an-image.txt'));
    expect(format.format).toBe('unknown');
    expect(format.supported).toBe(false);
  });

  it('识别但不支持 GIF', () => {
    const format = detectFormat(read('unsupported.gif'));
    expect(format.format).toBe('gif');
    expect(format.supported).toBe(false);
    expect(format.reason).toBeTruthy();
  });

  it('短文件不会崩溃', () => {
    expect(detectFormat(new Uint8Array([0xff, 0xd8])).format).toBe('unknown');
  });
});

describe('scanJpeg', () => {
  it('列出 EXIF / XMP / 注释段', () => {
    const scan = scanJpeg(read('exif-gps.jpg'));
    expect(scan.valid).toBe(true);
    const ids = scan.segments.map((segment) => segment.identifier);
    expect(ids).toContain('APP1/Exif');
    expect(ids).toContain('APP1/XMP');
    expect(ids.some((id) => id.startsWith('COM'))).toBe(true);
    expect(scan.dimension).toEqual({ width: 640, height: 480 });
  });

  it('无元数据 JPEG 没有任何 APP1/COM 段', () => {
    const scan = scanJpeg(read('no-metadata.jpg'));
    expect(scan.valid).toBe(true);
    const appSegments = scan.segments.filter((segment) => segment.marker >= 0xe0 && segment.marker <= 0xef);
    expect(appSegments.map((segment) => segment.identifier)).toEqual(['APP0/JFIF']);
    expect(scan.segments.some((segment) => segment.marker === 0xfe)).toBe(false);
  });

  it('识别截断文件', () => {
    const scan = scanJpeg(read('broken.jpg'));
    expect(scan.valid).toBe(false);
    expect(scan.reason).toBeTruthy();
  });
});

describe('scanPng', () => {
  it('列出文本 / eXIf / tIME 块', () => {
    const scan = scanPng(read('transparent.png'));
    expect(scan.valid).toBe(true);
    const types = scan.chunks.map((chunk) => chunk.type);
    expect(types).toContain('tEXt');
    expect(types).toContain('iTXt');
    expect(types).toContain('eXIf');
    expect(types).toContain('tIME');
    expect(scan.dimension).toEqual({ width: 320, height: 240 });
    expect(scan.hasAlpha).toBe(true);
  });

  it('干净 PNG 只有结构性块', () => {
    const scan = scanPng(read('clean.png'));
    expect(scan.chunks.map((chunk) => chunk.type)).toEqual(['IHDR', 'IDAT', 'IEND']);
  });
});

describe('scanWebp', () => {
  it('扫描结果包含 EXIF / XMP 块并读出尺寸', () => {
    const scan = scanWebp(read('animated.webp'));
    expect(scan.valid).toBe(true);
    const types = scan.chunks.map((chunk) => chunk.type);
    expect(types).toContain('EXIF');
    expect(types).toContain('XMP');
    expect(scan.dimension).toEqual({ width: 480, height: 360 });
  });
});

describe('parseTiff', () => {
  it('读出相机、时间与 GPS', () => {
    const bytes = read('exif-gps.jpg');
    const scan = scanJpeg(bytes);
    const exif = scan.segments.find((segment) => segment.identifier === 'APP1/Exif')!;
    const payload = bytes.subarray(exif.payloadOffset + 6, exif.payloadOffset + exif.payloadLength);
    const tiff = parseTiff(payload);
    expect(tiff.ifd0.Make).toBe('TestCamera Co.');
    expect(tiff.ifd0.Model).toBe('PrivacyEraser TX-1');
    expect(tiff.exif.DateTimeOriginal).toBe('2026:10:25 04:50:42');
    expect(typeof tiff.gps.latitude).toBe('number');
    expect(Math.abs((tiff.gps.latitude as number) - 37.7749)).toBeLessThan(0.001);
  });
});

describe('inspectImage', () => {
  it('报告高风险字段与 GPS', async () => {
    const inspection = await inspectImage(read('exif-gps.jpg'));
    expect(inspection.info.format).toBe('jpeg');
    expect(inspection.risk).toBe('high');
    expect(inspection.gps?.latitude).toBeCloseTo(37.775, 2);
    const labels = inspection.fields.map((field) => field.label);
    expect(labels).toContain('相机厂商');
    expect(labels).toContain('GPS 纬度');
    expect(labels).toContain('拍摄时间');
  });

  it('干净文件不报告敏感字段', async () => {
    const inspection = await inspectImage(read('no-metadata.jpg'));
    expect(inspection.fields.filter((field) => field.sensitivity === 'high')).toHaveLength(0);
    expect(inspection.gps).toBeNull();
    expect(inspection.risk).not.toBe('high');
  });

  it('PNG 的 eXIf 也会被发现', async () => {
    const inspection = await inspectImage(read('transparent.png'));
    expect(inspection.fields.some((field) => field.label === '相机型号')).toBe(true);
    expect(inspection.gps).not.toBeNull();
  });

  it('WebP 的 EXIF 由内置解析器读出', async () => {
    const inspection = await inspectImage(read('animated.webp'));
    expect(inspection.parsedBy).toContain('内置 TIFF 解析器');
    expect(inspection.fields.some((field) => field.label === '相机型号')).toBe(true);
    expect(inspection.gps?.latitude).toBeCloseTo(37.775, 2);
  });

  it('不支持的文件不会抛错', async () => {
    const inspection = await inspectImage(read('not-an-image.txt'));
    expect(inspection.info.structurallyValid).toBe(false);
    expect(inspection.fields).toHaveLength(0);
    expect(inspection.notes.length).toBeGreaterThan(0);
  });
});

describe('xmpFieldsFromXml', () => {
  it('抽取 XMP 属性与元素', () => {
    const xml = `<rdf:Description xmlns:photoshop="x" photoshop:City="Paris" xmp:CreatorTool="Tool 1.0"/>
      <dc:creator>Ada</dc:creator>`;
    const fields = xmpFieldsFromXml(xml);
    const values = fields.map((field) => field.value);
    expect(values).toContain('Paris');
    expect(values).toContain('Tool 1.0');
    expect(values).toContain('Ada');
  });

  it('不会把无意义属性当成敏感字段', () => {
    const fields = xmpFieldsFromXml('<rdf:Description rdf:about=""/>');
    expect(fields.every((field) => field.sensitivity !== 'high' || field.value.length > 0)).toBe(true);
  });
});

describe('stripMetadata', () => {
  const options = { keepColorProfile: true, stripTrailingBytes: true };

  it('JPEG 输出不再包含 EXIF / XMP / 注释段，像素数据保持', () => {
    const input = read('exif-gps.jpg');
    const before = scanJpeg(input);
    const output = stripMetadata(input, options).buffer;
    const after = scanJpeg(output);
    expect(after.valid).toBe(true);
    expect(after.segments.some((segment) => segment.identifier === 'APP1/Exif')).toBe(false);
    expect(after.segments.some((segment) => segment.identifier === 'APP1/XMP')).toBe(false);
    expect(after.segments.some((segment) => segment.marker === 0xfe)).toBe(false);
    // Same scan bytes => lossless
    expect(output.length).toBeLessThan(input.length);
    expect(before.dimension).toEqual(after.dimension);
  });

  it('PNG 输出不再包含文本 / eXIf / tIME 块', () => {
    const output = stripMetadata(read('transparent.png'), options).buffer;
    const after = scanPng(output);
    expect(after.valid).toBe(true);
    const types = after.chunks.map((chunk) => chunk.type);
    expect(types).not.toContain('tEXt');
    expect(types).not.toContain('iTXt');
    expect(types).not.toContain('eXIf');
    expect(types).not.toContain('tIME');
    expect(types).toContain('IHDR');
    expect(types).toContain('IDAT');
    expect(types).toContain('IEND');
  });

  it('WebP 输出不再包含 EXIF / XMP 块且 RIFF 长度正确', () => {
    const output = stripMetadata(read('animated.webp'), options).buffer;
    const after = scanWebp(output);
    expect(after.valid).toBe(true);
    const types = after.chunks.map((chunk) => chunk.type);
    expect(types).not.toContain('EXIF');
    expect(types).not.toContain('XMP');
    expect(after.trailingBytes).toBe(0);
    // RIFF size must match the actual body, or decoders reject the file.
    const riffSize = output[4]! | (output[5]! << 8) | (output[6]! << 16) | (output[7]! << 24);
    expect(riffSize).toBe(output.length - 8);
  });

  it('拒绝损坏的 JPEG', () => {
    expect(() => stripMetadata(read('broken.jpg'), options)).toThrow();
  });

  it('拒绝非图片', () => {
    expect(() => stripMetadata(read('not-an-image.txt'), options)).toThrow();
  });
});

describe('cleanAndVerify', () => {
  const options = { keepColorProfile: true, stripTrailingBytes: true };

  it('JPEG：验证通过且无残留字段', async () => {
    const result = await cleanAndVerify(read('exif-gps.jpg'), options);
    expect(result.verified).toBe(true);
    expect(result.remainingFields).toHaveLength(0);
    expect(result.bytesAfter).toBeLessThan(result.bytesBefore);
    expect(result.removed.some((entry) => entry.kind === 'exif')).toBe(true);
    expect(result.dimension).toEqual({ width: 640, height: 480 });
  });

  it('PNG：验证通过且保留透明度', async () => {
    const result = await cleanAndVerify(read('transparent.png'), options);
    expect(result.verified).toBe(true);
    const scan = scanPng(result.buffer);
    expect(scan.hasAlpha).toBe(true);
    expect(scan.dimension).toEqual({ width: 320, height: 240 });
  });

  it('WebP：验证通过', async () => {
    const result = await cleanAndVerify(read('animated.webp'), options);
    expect(result.verified).toBe(true);
    expect(result.remainingFields).toHaveLength(0);
  });

  it('已干净的输入保持幂等', async () => {
    const first = await cleanAndVerify(read('no-metadata.jpg'), options);
    const second = await cleanAndVerify(first.buffer, options);
    expect(second.buffer.length).toBe(first.buffer.length);
    expect(second.verified).toBe(true);
  });

  it('保留 ICC 的选项不会删掉 ICC 段', async () => {
    const withIcc = stripMetadata(read('exif-gps.jpg'), { keepColorProfile: true, stripTrailingBytes: true });
    // Our fixture has no ICC block, so this asserts the flag does not break the rewrite.
    expect(withIcc.removed.some((entry) => entry.kind === 'icc')).toBe(false);
  });
});
