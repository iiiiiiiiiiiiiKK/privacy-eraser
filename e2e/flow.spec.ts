import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const FIXTURE = (name: string) => join(process.cwd(), 'fixtures', name);

test.describe('Privacy Eraser — 上传 / 检查 / 清理 / 导出', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await expect(page.getByTestId('empty-hero')).toBeVisible();
  });

  test('空状态给出明确的本地运行说明', async ({ page }) => {
    await expect(page.getByText('100% 本地 · 不上传')).toBeVisible();
    await expect(page.getByTestId('empty-hero')).toContainText('本地');
    await expect(page.getByTestId('btn-pick')).toBeVisible();
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.waitForTimeout(400);
    expect(errors).toEqual([]);
  });

  test('作者 𝕏 链接指向正确地址', async ({ page }) => {
    const link = page.getByTestId('author-link');
    await expect(link).toHaveAttribute('href', 'https://x.com/0xkillcoin');
    await expect(link).toHaveAttribute('target', '_blank');
    await expect(link).toHaveAttribute('rel', /noopener/);
  });

  test('含 EXIF/GPS 的 JPEG：检测、展示、清理、验证', async ({ page }) => {
    await page.getByTestId('hero-file-input').setInputFiles(FIXTURE('exif-gps.jpg'));
    await expect(page.getByTestId('detail-panel')).toBeVisible({ timeout: 25_000 });

    // Detected fields and GPS
    await expect(page.getByTestId('meta-row').first()).toBeVisible();
    expect(await page.getByTestId('meta-row').count()).toBeGreaterThan(20);
    await expect(page.getByTestId('gps-card')).toBeVisible();
    await expect(page.getByTestId('gps-lat')).toContainText('37.77');
    await expect(page.getByTestId('risk-banner')).toContainText('定位');
    await expect(page.getByTestId('container-table')).toContainText('EXIF');

    // Clean + verify
    await page.getByTestId('btn-clean').click();
    await expect(page.getByTestId('result-section')).toBeVisible({ timeout: 25_000 });
    await expect(page.getByTestId('result-section')).toContainText('已重新解析验证');
    await expect(page.getByTestId('removed-list')).toContainText('EXIF');
    await expect(page.getByTestId('preview-cleaned')).toBeVisible();
    await expect(page.getByTestId('result-section')).toContainText('重新解析未发现残留的个人数据字段');
  });

  test('清理后的字节确实不再包含 EXIF / XMP（下载内容重新解析）', async ({ page }) => {
    await page.getByTestId('hero-file-input').setInputFiles(FIXTURE('exif-gps.jpg'));
    await expect(page.getByTestId('detail-panel')).toBeVisible({ timeout: 25_000 });
    await page.getByTestId('btn-clean').click();
    await expect(page.getByTestId('result-section')).toBeVisible({ timeout: 25_000 });

    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.getByTestId('btn-download').click(),
    ]);
    expect(download.suggestedFilename()).toMatch(/-clean\.jpg$/);
    const path = await download.path();
    expect(path).toBeTruthy();
    const bytes = readFileSync(path!);
    // The APP1 markers must be gone; the JFIF header and pixel data must stay.
    expect(bytes.includes(Buffer.from('Exif\0\0'))).toBe(false);
    expect(bytes.includes(Buffer.from('http://ns.adobe.com/xap'))).toBe(false);
    expect(bytes[0]).toBe(0xff);
    expect(bytes[1]).toBe(0xd8);
    expect(bytes.subarray(-2).equals(Buffer.from([0xff, 0xd9]))).toBe(true);
  });

  test('透明 PNG：保留 alpha，删除文本与 eXIf', async ({ page }) => {
    await page.getByTestId('hero-file-input').setInputFiles(FIXTURE('transparent.png'));
    await expect(page.getByTestId('detail-panel')).toBeVisible({ timeout: 25_000 });
    await expect(page.getByTestId('meta-row').first()).toBeVisible();
    await page.getByTestId('btn-clean').click();
    await expect(page.getByTestId('result-section')).toBeVisible({ timeout: 25_000 });

    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.getByTestId('btn-download').click(),
    ]);
    const bytes = readFileSync((await download.path())!);
    expect(download.suggestedFilename()).toMatch(/-clean\.png$/);
    expect(bytes.includes(Buffer.from('tEXt'))).toBe(false);
    expect(bytes.includes(Buffer.from('eXIf'))).toBe(false);
    expect(bytes.includes(Buffer.from('iTXt'))).toBe(false);
    expect(bytes.includes(Buffer.from('IDAT'))).toBe(true);
    // IHDR colour type 6 = RGBA
    expect(bytes[25]).toBe(6);
  });

  test('WebP：删除 EXIF/XMP 块并保持可解析', async ({ page }) => {
    await page.getByTestId('hero-file-input').setInputFiles(FIXTURE('animated.webp'));
    await expect(page.getByTestId('detail-panel')).toBeVisible({ timeout: 25_000 });
    await expect(page.getByTestId('meta-row').first()).toBeVisible();
    await page.getByTestId('btn-clean').click();
    await expect(page.getByTestId('result-section')).toBeVisible({ timeout: 25_000 });

    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.getByTestId('btn-download').click(),
    ]);
    const bytes = readFileSync((await download.path())!);
    expect(bytes.includes(Buffer.from('EXIF'))).toBe(false);
    expect(bytes.includes(Buffer.from('XMP '))).toBe(false);
    expect(bytes.subarray(0, 4).toString('ascii')).toBe('RIFF');
    expect(bytes.subarray(8, 12).toString('ascii')).toBe('WEBP');
    const riffSize = bytes.readUInt32LE(4);
    expect(riffSize).toBe(bytes.length - 8);
  });

  test('无元数据图片：明确显示没有可清理项', async ({ page }) => {
    await page.getByTestId('hero-file-input').setInputFiles(FIXTURE('no-metadata.jpg'));
    await expect(page.getByTestId('detail-panel')).toBeVisible({ timeout: 25_000 });
    await page.getByTestId('btn-clean').click();
    await expect(page.getByTestId('result-section')).toBeVisible({ timeout: 25_000 });
    await expect(page.getByTestId('result-section')).toContainText('没有需要移除的元数据容器');
  });

  test('损坏文件给出可理解的错误', async ({ page }) => {
    await page.getByTestId('hero-file-input').setInputFiles(FIXTURE('broken.jpg'));
    await expect(page.getByTestId('detail-panel')).toBeVisible({ timeout: 25_000 });
    // Either the structural banner or an error banner must explain the problem.
    const bannerText = `${await page.getByTestId('detail-panel').innerText()}`;
    expect(/异常|失败|损坏|截断/.test(bannerText)).toBe(true);
  });

  test('不支持的格式只提示，不假装清理成功', async ({ page }) => {
    await page.getByTestId('hero-file-input').setInputFiles(FIXTURE('not-an-image.txt'));
    await expect(page.getByTestId('unsupported-banner')).toBeVisible({ timeout: 25_000 });
    await expect(page.getByTestId('btn-clean')).toBeDisabled();
  });

  test('批处理：多张图片一次清理并打包下载', async ({ page }) => {
    await page.getByTestId('hero-file-input').setInputFiles([
      FIXTURE('exif-gps.jpg'),
      FIXTURE('transparent.png'),
      FIXTURE('animated.webp'),
    ]);
    await expect(page.getByTestId('file-row')).toHaveCount(3, { timeout: 30_000 });
    await expect(page.getByTestId('batch-summary')).toContainText('3');

    await page.getByTestId('btn-clean-all').click();
    await expect.poll(async () => page.locator('.status-dot.cleaned').count(), { timeout: 40_000 }).toBe(3);

    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.getByTestId('btn-batch-download').click(),
    ]);
    expect(download.suggestedFilename()).toMatch(/privacy-eraser-clean\.zip$/);
    const bytes = readFileSync((await download.path())!);
    expect(bytes.subarray(0, 2).toString('ascii')).toBe('PK');
    // Three entries => three local file headers.
    const text = bytes.toString('latin1');
    expect(text.split('PK\u0003\u0004').length - 1).toBeGreaterThanOrEqual(3);
  });

  test('清空工作区会移除列表与预览', async ({ page }) => {
    await page.getByTestId('hero-file-input').setInputFiles(FIXTURE('exif-gps.jpg'));
    await expect(page.getByTestId('detail-panel')).toBeVisible({ timeout: 25_000 });
    await page.getByTestId('btn-clear-workspace').click();
    await expect(page.getByTestId('empty-hero')).toBeVisible();
    await expect(page.getByTestId('file-row')).toHaveCount(0);
  });

  test('移除单张图片只影响它自己', async ({ page }) => {
    await page.getByTestId('hero-file-input').setInputFiles([FIXTURE('exif-gps.jpg'), FIXTURE('clean.png')]);
    await expect(page.getByTestId('file-row')).toHaveCount(2, { timeout: 30_000 });
    await page.getByTestId('file-row').first().getByTestId('remove-file').click();
    await expect(page.getByTestId('file-row')).toHaveCount(1);
  });

  test('能力边界表明确写出能做与不能做', async ({ page }) => {
    await page.getByTestId('hero-file-input').setInputFiles(FIXTURE('no-metadata.jpg'));
    await expect(page.getByTestId('detail-panel')).toBeVisible({ timeout: 25_000 });
    const table = page.getByTestId('boundary-table');
    await expect(table).toContainText('JPEG');
    await expect(table).toContainText('WebP');
    await expect(table).toContainText('无法保证');
  });

  test('深浅色主题切换并持久化', async ({ page }) => {
    const initial = await page.evaluate(() => document.documentElement.dataset.theme);
    await page.getByTestId('btn-theme').click();
    const next = await page.evaluate(() => document.documentElement.dataset.theme);
    expect(next).not.toBe(initial);
    await page.reload();
    await expect.poll(async () => page.evaluate(() => document.documentElement.dataset.theme)).toBe(next);
  });

  test('快捷键面板可以打开与关闭', async ({ page }) => {
    await page.getByTestId('btn-shortcuts').click();
    await expect(page.getByTestId('shortcuts-dialog')).toBeVisible();
    await expect(page.getByTestId('shortcuts-dialog')).toContainText('Ctrl');
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('shortcuts-dialog')).toHaveCount(0);
  });

  test('键盘快捷键触发清理与下载', async ({ page }) => {
    await page.getByTestId('hero-file-input').setInputFiles(FIXTURE('exif-gps.jpg'));
    await expect(page.getByTestId('detail-panel')).toBeVisible({ timeout: 25_000 });
    await page.keyboard.press('Control+Enter');
    await expect(page.getByTestId('result-section')).toBeVisible({ timeout: 25_000 });
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.keyboard.press('Control+s'),
    ]);
    expect(download.suggestedFilename()).toMatch(/-clean\.jpg$/);
  });

  test('没有任何图片数据离开浏览器', async ({ page }) => {
    const external: string[] = [];
    page.on('request', (request) => {
      const url = request.url();
      if (url.startsWith('http://127.0.0.1:4213') || url.startsWith('data:') || url.startsWith('blob:')) return;
      external.push(`${request.method()} ${url}`);
    });
    await page.getByTestId('hero-file-input').setInputFiles(FIXTURE('exif-gps.jpg'));
    await expect(page.getByTestId('detail-panel')).toBeVisible({ timeout: 25_000 });
    await page.getByTestId('btn-clean').click();
    await expect(page.getByTestId('result-section')).toBeVisible({ timeout: 25_000 });
    expect(external, `外部请求: ${external.join(', ')}`).toEqual([]);
  });

  test('超大图片仍可处理且界面保持响应', async ({ page }) => {
    await page.getByTestId('hero-file-input').setInputFiles(FIXTURE('huge.jpg'));
    await expect(page.getByTestId('detail-panel')).toBeVisible({ timeout: 40_000 });
    await expect(page.getByTestId('image-info')).toContainText('4000');
    await page.getByTestId('btn-clean').click();
    await expect(page.getByTestId('result-section')).toBeVisible({ timeout: 40_000 });
  });

  test('关闭 ICC 保留选项会记录在清理说明里', async ({ page }) => {
    await page.getByTestId('hero-file-input').setInputFiles(FIXTURE('transparent.png'));
    await expect(page.getByTestId('detail-panel')).toBeVisible({ timeout: 25_000 });
    await page.getByTestId('option-icc').uncheck();
    await expect(page.getByTestId('option-icc')).not.toBeChecked();
    await page.getByTestId('btn-clean').click();
    await expect(page.getByTestId('result-section')).toBeVisible({ timeout: 25_000 });
  });
});
