/** One-off: dump element geometry at small touch viewports. Usage: node probe.mjs */
import puppeteer from 'puppeteer-core';

const CHROME = process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const URL = process.env.CODE_PAIR_URL;
if (!URL) { console.error('set CODE_PAIR_URL'); process.exit(2); }

const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--no-first-run'] });
try {
  for (const [w, h] of [[320, 568], [390, 844]]) {
    const page = await browser.newPage();
    await page.setViewport({ width: w, height: h, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
    await page.goto(URL, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.app', { timeout: 15000 });
    await page.evaluate(() => {
      const file = [...document.querySelectorAll('button')].find((b) => /\.md$|\.txt$/.test((b.textContent ?? '').trim()));
      file?.click();
    });
    await new Promise((r) => setTimeout(r, 1200));
    const out = await page.evaluate(() => {
      const r = (el) => { const b = el.getBoundingClientRect(); const c = (typeof el.className === 'string' ? el.className : el.getAttribute('class') || '').split(' ')[0]; return `${el.tagName.toLowerCase()}.${c} [${Math.round(b.left)}..${Math.round(b.right)}] ${Math.round(b.width)}×${Math.round(b.height)}`; };
      const rows = [];
      const doc = document.documentElement;
      rows.push(`viewport=${window.innerWidth} scrollWidth=${doc.scrollWidth}`);
      rows.push('-- topbar children --');
      document.querySelectorAll('.topbar > div').forEach((el) => rows.push('  ' + r(el)));
      document.querySelectorAll('.topbar__actions > *').forEach((el) => rows.push('    ' + r(el) + ' ' + (el.getAttribute('aria-label') || el.textContent.trim().slice(0, 12))));
      rows.push('-- tabs --');
      document.querySelectorAll('.tablist, .tabs, .tab, .tab__select, .tabs__add').forEach((el) => rows.push('  ' + r(el)));
      rows.push('-- statusbar --');
      document.querySelectorAll('.statusbar > *, .statusbar__right > *, .statusbar__left > *').forEach((el) => rows.push('  ' + r(el)));
      rows.push('-- all overflows (right > vw) --');
      for (const el of document.querySelectorAll('*')) {
        const b = el.getBoundingClientRect();
        if (b.width > 0 && b.right > window.innerWidth + 1) {
          const style = getComputedStyle(el);
          if (style.visibility === 'hidden' || style.display === 'none') continue;
          if (el.closest('.sidebar') && !el.closest('.sidebar')?.classList.contains('is-open')) continue;
          rows.push('  ' + r(el) + (el.children.length === 0 ? ` "${(el.textContent ?? '').trim().slice(0, 20)}"` : ''));
        }
      }
      return rows.join('\n');
    });
    console.log(`\n===== ${w}×${h} =====\n${out}`);
    await page.close();
  }
} finally { await browser.close(); }
