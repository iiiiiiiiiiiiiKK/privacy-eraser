// Capture README screenshots against the local preview server (:4213).
import { chromium, devices } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

const OUT = 'docs/assets';
mkdirSync(OUT, { recursive: true });
const FIXTURE = (name) => join(process.cwd(), 'fixtures', name);

const scrollBody = (page, top) =>
  page.evaluate((value) => {
    const body = document.querySelector('.detail-body');
    if (body) body.scrollTop = value;
  }, top);

const browser = await chromium.launch();

// ---------- desktop ----------
const page = await browser.newPage({ viewport: { width: 1440, height: 940 }, deviceScaleFactor: 2 });
await page.goto('http://127.0.0.1:4213/', { waitUntil: 'networkidle' });
await page.waitForTimeout(500);
await page.screenshot({ path: join(OUT, '01-empty.png') });

await page.getByTestId('hero-file-input').setInputFiles(FIXTURE('exif-gps.jpg'));
await page.getByTestId('detail-panel').waitFor({ timeout: 25000 });
await page.waitForTimeout(900);
await page.screenshot({ path: join(OUT, '02-inspect.png') });

await scrollBody(page, 430);
await page.waitForTimeout(400);
await page.screenshot({ path: join(OUT, '03-gps.png') });

await scrollBody(page, 0);
await page.getByTestId('btn-clean').click();
await page.getByTestId('result-section').waitFor({ timeout: 25000 });
await page.waitForTimeout(800);
await page.getByTestId('result-section').scrollIntoViewIfNeeded();
await page.waitForTimeout(400);
await page.screenshot({ path: join(OUT, '04-cleaned.png') });

// batch: add two more through the main (hidden) input
await page.getByTestId('file-input').setInputFiles([FIXTURE('transparent.png'), FIXTURE('animated.webp')]);
await page.getByTestId('file-row').nth(2).waitFor({ timeout: 25000 });
await page.waitForTimeout(1500);
await page.getByTestId('btn-clean-all').click();
await page.waitForTimeout(3000);
await scrollBody(page, 0);
await page.waitForTimeout(300);
await page.screenshot({ path: join(OUT, '05-batch.png') });

// boundary table
await page.getByTestId('boundary-table').scrollIntoViewIfNeeded();
await page.waitForTimeout(400);
await page.screenshot({ path: join(OUT, '06-boundary.png') });

// dark theme
await page.getByTestId('btn-theme').click();
await scrollBody(page, 0);
await page.waitForTimeout(500);
await page.screenshot({ path: join(OUT, '07-dark.png') });
await page.getByTestId('btn-theme').click();
await page.close();

// ---------- iPhone ----------
const mobile = await browser.newPage({ ...devices['iPhone 13'], deviceScaleFactor: 3 });
await mobile.goto('http://127.0.0.1:4213/', { waitUntil: 'networkidle' });
await mobile.waitForTimeout(500);
await mobile.screenshot({ path: join(OUT, '08-mobile-empty.png') });

await mobile.getByTestId('hero-file-input').setInputFiles(FIXTURE('exif-gps.jpg'));
await mobile.getByTestId('detail-panel').waitFor({ timeout: 25000 });
await mobile.waitForTimeout(900);
await mobile.screenshot({ path: join(OUT, '09-mobile-inspect.png') });

await mobile.getByTestId('btn-clean').tap();
await mobile.getByTestId('result-section').waitFor({ timeout: 25000 });
await mobile.waitForTimeout(800);
await mobile.getByTestId('result-section').scrollIntoViewIfNeeded();
await mobile.waitForTimeout(400);
await mobile.screenshot({ path: join(OUT, '10-mobile-cleaned.png') });
await mobile.close();

await browser.close();
console.log('screenshots written to', OUT);
