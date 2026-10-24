/**
 * Production verification against a deployed URL.
 *
 * Usage: node scripts/verify-live.mjs [url]
 * Default: https://iiiiiiiiiiiiiKK.github.io/privacy-eraser/
 */
import { chromium, devices } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const TARGET = process.argv[2] ?? 'https://iiiiiiiiiiiiiKK.github.io/privacy-eraser/';
const ALLOWED_HOST = new globalThis.URL(TARGET).hostname.toLowerCase();
const FIXTURE = (name) => join(process.cwd(), 'fixtures', name);

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` - ${detail}` : ''}`);
};

const browser = await chromium.launch();

// ---------- desktop ----------
const page = await browser.newPage({ viewport: { width: 1440, height: 940 } });
const errors = [];
const external = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text());
});
page.on('request', (r) => {
  const url = r.url();
  if (url.startsWith('data:') || url.startsWith('blob:')) return;
  try {
    const host = new globalThis.URL(url).hostname.toLowerCase();
    if (host !== ALLOWED_HOST && !host.endsWith('.github.io')) external.push(url);
  } catch {
    external.push(url);
  }
});

const resp = await page.goto(TARGET, { waitUntil: 'networkidle' });
check('页面返回 200', resp?.status() === 200, `status=${resp?.status()}`);
await page.getByTestId('empty-hero').waitFor({ timeout: 30000 });
check('空状态渲染', await page.getByTestId('empty-hero').isVisible());
check('作者 X 链接', (await page.getByTestId('author-link').getAttribute('href')) === 'https://x.com/0xkillcoin');

// EXIF + GPS fixture
await page.getByTestId('hero-file-input').setInputFiles(FIXTURE('exif-gps.jpg'));
await page.getByTestId('detail-panel').waitFor({ timeout: 30000 });
await page.waitForTimeout(800);
const rows = await page.getByTestId('meta-row').count();
check('检测到元数据字段', rows > 20, `${rows} 行`);
check('GPS 卡片出现', (await page.getByTestId('gps-card').count()) === 1);
check('GPS 纬度正确', (await page.getByTestId('gps-lat').innerText()).startsWith('37.77'), await page.getByTestId('gps-lat').innerText());

await page.getByTestId('btn-clean').click();
await page.getByTestId('result-section').waitFor({ timeout: 30000 });
await page.waitForTimeout(500);
const resultText = await page.getByTestId('result-section').innerText();
check('清理后重新解析验证通过', resultText.includes('已重新解析验证'));
check('列出了被移除的容器', (await page.getByTestId('removed-list').count()) === 1);

// download and assert on the actual bytes
const [download] = await Promise.all([page.waitForEvent('download'), page.getByTestId('btn-download').click()]);
const path = await download.path();
const bytes = readFileSync(path);
check('下载文件名为 -clean.jpg', /-clean\.jpg$/.test(download.suggestedFilename()), download.suggestedFilename());
check('导出字节不含 Exif\\0\\0 标记', !bytes.includes(Buffer.from('Exif\0\0')));
check('导出字节不含 XMP 命名空间', !bytes.includes(Buffer.from('http://ns.adobe.com/xap')));
check('导出仍是合法 JPEG 头尾', bytes[0] === 0xff && bytes[1] === 0xd8 && bytes.subarray(-2).equals(Buffer.from([0xff, 0xd9])));

check('无 JS 运行时错误', errors.length === 0, errors.slice(0, 3).join(' | '));
check('无第三方外部请求', external.length === 0, external.slice(0, 3).join(' | '));
await page.close();

// ---------- iPhone ----------
const mobile = await browser.newPage({ ...devices['iPhone 13'] });
await mobile.goto(TARGET, { waitUntil: 'networkidle' });
await mobile.getByTestId('empty-hero').waitFor({ timeout: 30000 });
const overflow = await mobile.evaluate(() => {
  const vw = document.documentElement.clientWidth;
  const off = [];
  document.querySelectorAll('*').forEach((el) => {
    const r = el.getBoundingClientRect();
    if (r.width > 0 && r.right > vw + 1) off.push(`${el.tagName}.${el.className}`.slice(0, 50));
  });
  return { doc: document.documentElement.scrollWidth, vw, off: off.slice(0, 5) };
});
check('iPhone 无横向溢出', overflow.doc <= overflow.vw + 1 && overflow.off.length === 0, JSON.stringify(overflow));

await mobile.getByTestId('hero-file-input').setInputFiles(FIXTURE('transparent.png'));
await mobile.getByTestId('detail-panel').waitFor({ timeout: 30000 });
await mobile.waitForTimeout(800);
await mobile.getByTestId('btn-clean').tap();
await mobile.getByTestId('result-section').waitFor({ timeout: 30000 });
check('iPhone 清理流程可用', (await mobile.getByTestId('result-section').count()) === 1);
check('iPhone 作者 X 链接可见', await mobile.getByTestId('author-link').isVisible());
await mobile.screenshot({ path: 'docs/assets/11-live-mobile.png' });
await mobile.close();

await browser.close();

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
