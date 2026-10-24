import { test, expect } from '@playwright/test';
import { join } from 'node:path';

const FIXTURE = (name: string) => join(process.cwd(), 'fixtures', name);

/**
 * iPhone layout + touch behaviour.
 *
 * Runs under Playwright's real `iPhone 13` metrics: 390×844 CSS px, DPR 3,
 * touch input. The assertions target what actually breaks on a phone:
 * horizontal overflow, unreachable actions, and tap targets that are too small.
 */
test.describe('Privacy Eraser — 手机端（iPhone 13）', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await expect(page.getByTestId('empty-hero')).toBeVisible();
  });

  test('没有横向溢出', async ({ page }) => {
    const overflow = await page.evaluate(() => {
      const vw = document.documentElement.clientWidth;
      const off: string[] = [];
      document.querySelectorAll('*').forEach((el) => {
        const rect = el.getBoundingClientRect();
        if (rect.width > 0 && rect.right > vw + 1) off.push(`${el.tagName}.${el.className}`.slice(0, 60));
      });
      return { doc: document.documentElement.scrollWidth, vw, off: off.slice(0, 5) };
    });
    expect(overflow.doc).toBeLessThanOrEqual(overflow.vw + 1);
    expect(overflow.off).toEqual([]);
  });

  test('选择图片后仍无横向溢出，且能完成清理', async ({ page }) => {
    await page.getByTestId('hero-file-input').setInputFiles(FIXTURE('exif-gps.jpg'));
    await expect(page.getByTestId('detail-panel')).toBeVisible({ timeout: 25_000 });

    const overflow = await page.evaluate(() => {
      const vw = document.documentElement.clientWidth;
      const off: string[] = [];
      document.querySelectorAll('*').forEach((el) => {
        const rect = el.getBoundingClientRect();
        if (rect.width > 0 && rect.right > vw + 1) off.push(`${el.tagName}.${el.className}`.slice(0, 60));
      });
      return { doc: document.documentElement.scrollWidth, vw, off: off.slice(0, 5) };
    });
    expect(overflow.doc).toBeLessThanOrEqual(overflow.vw + 1);
    expect(overflow.off).toEqual([]);

    await page.getByTestId('btn-clean').tap();
    await expect(page.getByTestId('result-section')).toBeVisible({ timeout: 25_000 });
  });

  test('作者 𝕏 链接可见且可点', async ({ page }) => {
    const link = page.getByTestId('author-link');
    await expect(link).toBeVisible();
    await expect(link).toHaveAttribute('href', 'https://x.com/0xkillcoin');
    const box = await link.boundingBox();
    expect(box?.width ?? 0).toBeGreaterThan(20);
    expect(box?.height ?? 0).toBeGreaterThan(20);
  });

  test('主要按钮触点不小于 28px', async ({ page }) => {
    for (const id of ['btn-add', 'btn-theme', 'btn-shortcuts', 'author-link']) {
      const box = await page.getByTestId(id).boundingBox();
      expect(box?.height ?? 0, `${id} height`).toBeGreaterThanOrEqual(28);
    }
  });

  test('手机上可以完成批处理并打包', async ({ page }) => {
    await page.getByTestId('hero-file-input').setInputFiles([FIXTURE('exif-gps.jpg'), FIXTURE('clean.png')]);
    await expect(page.getByTestId('file-row')).toHaveCount(2, { timeout: 30_000 });
    await page.getByTestId('btn-clean-all').tap();
    await expect.poll(async () => page.locator('.status-dot.cleaned').count(), { timeout: 40_000 }).toBe(2);
    await expect(page.getByTestId('btn-batch-download')).toBeEnabled();
  });
});
