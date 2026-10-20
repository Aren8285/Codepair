/**
 * Cross-device layout audit.
 *
 * Loads the running session at a matrix of phone / tablet / desktop viewports
 * and measures what CSS alone cannot prove: horizontal overflow, controls that
 * sit outside the viewport, tap targets too small for touch, and whether the
 * terminal overlay still leaves the editor usable.
 *
 *   cd e2e && npm install
 *   CODE_PAIR_URL='http://localhost:5180/room/ab12-cd34#token=...' node devices.mjs
 */
import puppeteer from 'puppeteer-core';

const CHROME =
  process.env.CHROME_PATH ??
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const SESSION_URL = process.env.CODE_PAIR_URL;

if (!SESSION_URL) {
  console.error('Set CODE_PAIR_URL. See the file header.');
  process.exit(2);
}

/** name, width, height, touch */
const VIEWPORTS = [
  ['small phone', 320, 568, true],
  ['android phone', 360, 800, true],
  ['iphone se', 375, 667, true],
  ['iphone 14', 390, 844, true],
  ['iphone pro max', 430, 932, true],
  ['phone landscape', 844, 390, true],
  ['tablet portrait', 768, 1024, true],
  ['tablet landscape', 1024, 768, true],
  ['laptop', 1280, 800, false],
  ['desktop', 1440, 900, false],
  ['wide', 1920, 1080, false],
];

const MIN_TAP = 40; // px; WCAG 2.5.5 AAA is 44, 2.5.8 AA is 24

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  args: ['--no-first-run', '--no-default-browser-check'],
});

const results = [];
let failed = 0;
let skipped = 0;

try {
  for (const [name, width, height, touch] of VIEWPORTS) {
    const page = await browser.newPage();
    const pageErrors = [];
    page.on('pageerror', (error) => pageErrors.push(error.message.split('\n')[0]));
    await page.setViewport({
      width,
      height,
      isMobile: touch,
      hasTouch: touch,
      deviceScaleFactor: 2,
    });
    await page.goto(SESSION_URL, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.app, .gate', { timeout: 20000 }).catch(() => {});

    const report = await page.evaluate(async (minTap) => {
      const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const root = document.querySelector('.app');
      if (!root) return { boot: true };

      // Open the first file so the editor, tabs and status bar are laid out.
      const file = [...document.querySelectorAll('button')].find((button) =>
        /\.md$|\.txt$|\.json$/.test((button.textContent ?? '').trim()),
      );
      file?.click();
      await sleep(1200);

      const visible = (el) => {
        const style = getComputedStyle(el);
        if (style.visibility === 'hidden' || style.display === 'none' || style.opacity === '0') return false;
        const rect = el.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      };

      // The mobile drawer sits off-canvas when closed; its controls are not
      // reachable, so they must not count as off-screen or as tap targets.
      const inClosedDrawer = (el) => {
        const sidebar = el.closest('.sidebar');
        if (sidebar && !sidebar.classList.contains('is-open')) return true;
        return Boolean(el.closest('.sidebar-scrim:not(.is-open)'));
      };

      const overflow = document.documentElement.scrollWidth - window.innerWidth;
      const offscreen = [];
      const small = [];
      for (const el of document.querySelectorAll('button, a, input, [role="button"]')) {
        if (!visible(el)) continue;
        if (inClosedDrawer(el)) continue;
        const rect = el.getBoundingClientRect();
        if (rect.right > window.innerWidth + 1 || rect.left < -1) {
          offscreen.push(`${el.tagName.toLowerCase()}.${(el.className || '').toString().split(' ')[0]} [${Math.round(rect.left)}..${Math.round(rect.right)}]`);
        }
        if (rect.width < minTap || rect.height < minTap) {
          small.push(`${el.getAttribute('aria-label') || (el.textContent ?? '').trim().slice(0, 16) || el.tagName.toLowerCase()} ${Math.round(rect.width)}×${Math.round(rect.height)}`);
        }
      }

      const editor = document.querySelector('.monaco-editor')?.getBoundingClientRect();
      const statusbar = document.querySelector('.statusbar')?.getBoundingClientRect();
      const topbar = document.querySelector('.topbar')?.getBoundingClientRect();

      return {
        overflow,
        offscreen: offscreen.slice(0, 6),
        small: small.slice(0, 8),
        smallCount: small.length,
        editor: editor ? `${Math.round(editor.width)}×${Math.round(editor.height)}` : null,
        statusbar: statusbar ? Math.round(statusbar.bottom) : null,
        topbar: topbar ? Math.round(topbar.height) : null,
        heightFits: statusbar ? statusbar.bottom <= window.innerHeight + 1 : false,
      };
    }, MIN_TAP);

    if (report.boot) {
      skipped += 1;
      results.push([`${name} ${width}×${height}`, 'SKIP', 'app did not render (check CODE_PAIR_URL / token)']);
      await page.close();
      continue;
    }

    // Second pass: terminal open, worst case for a short viewport.
    await page.click('[aria-label="Toggle terminal"]').catch(() => {});
    await page.waitForSelector('.xterm-helper-textarea', { timeout: 8000 }).catch(() => {});
    const withTerminal = await page.evaluate(() => {
      const editor = document.querySelector('.monaco-editor')?.getBoundingClientRect();
      const panel = document.querySelector('.terminalPanel')?.getBoundingClientRect();
      const statusbar = document.querySelector('.statusbar')?.getBoundingClientRect();
      return {
        editorHeight: editor ? Math.round(editor.height) : 0,
        panelVisible: Boolean(panel && panel.height > 0),
        overflow: document.documentElement.scrollWidth - window.innerWidth,
        statusbarFits: statusbar ? statusbar.bottom <= window.innerHeight + 1 : true,
      };
    });

    const problems = [];
    if (report.overflow > 1) problems.push(`overflow-x ${report.overflow}px`);
    if (report.offscreen.length > 0) problems.push(`offscreen: ${report.offscreen.join(', ')}`);
    if (touch && report.smallCount > 0) problems.push(`${report.smallCount} tap targets < ${MIN_TAP}px (${report.small.slice(0, 3).join('; ')})`);
    if (!report.heightFits) problems.push('status bar below the fold');
    if (report.editor === null) problems.push('editor missing');
    if (withTerminal.overflow > 1) problems.push(`overflow-x with terminal ${withTerminal.overflow}px`);
    if (!withTerminal.statusbarFits) problems.push('terminal pushes status bar off-screen');
    if (pageErrors.length > 0) problems.push(`page errors: ${pageErrors[0]}`);

    const label = `${name} ${width}×${height}${touch ? ' touch' : ''}`;
    if (problems.length === 0) {
      results.push([label, 'PASS', `editor ${report.editor}, topbar ${report.topbar}px, terminal editor ${withTerminal.editorHeight}px`]);
    } else {
      failed += 1;
      results.push([label, 'FAIL', problems.join(' | ')]);
    }
    await page.close();
  }
} finally {
  await browser.close();
}

for (const [label, state, detail] of results) {
  console.log(`${state}  ${label} — ${detail}`);
}
const measured = results.length - skipped;
console.log(`\n${measured - failed}/${measured} viewports clean${skipped ? ` (${skipped} skipped)` : ''}`);
process.exitCode = failed || skipped ? 1 : 0;
