/**
 * End-to-end browser test for a running CodePair session.
 *
 * It drives real Chrome instances (not jsdom) so keystrokes, Monaco, xterm.js
 * and Yjs behave exactly as they do for a user. Two independent browser
 * contexts act as two collaborators, plus a mobile-sized page for layout checks.
 *
 *   cd e2e && npm install
 *   CODE_PAIR_URL='http://localhost:5180/room/ab12-cd34#token=...' \
 *   CODE_PAIR_FILE='README.md' \
 *   CODE_PAIR_PROJECT=/path/to/project \
 *   CODE_PAIR_TOKEN='...' \
 *   node browser.mjs
 *
 * CODE_PAIR_FILE is a project-relative path used for the editing tests, and
 * CODE_PAIR_PROJECT is the Host root, used to prove edits hit real disk.
 * The file is recreated before each run so results are repeatable.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import puppeteer from 'puppeteer-core';

const CHROME =
  process.env.CHROME_PATH ??
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const SESSION_URL = process.env.CODE_PAIR_URL;
const PROJECT = process.env.CODE_PAIR_PROJECT;
const RELATIVE_FILE = process.env.CODE_PAIR_FILE ?? 'README.md';
const TOKEN = process.env.CODE_PAIR_TOKEN;

if (!SESSION_URL || !PROJECT || !TOKEN) {
  console.error('Set CODE_PAIR_URL, CODE_PAIR_PROJECT and CODE_PAIR_TOKEN. See the file header.');
  process.exit(2);
}

const BASE = new URL(SESSION_URL).origin;
const HOST_FILE = path.join(PROJECT, RELATIVE_FILE);
const FIXTURE = `# codepair e2e\n\nA throwaway project used to verify CodePair end to end.\n\n- Open a file from the explorer.\n- Edit it from two browsers and watch the cursors converge.\n`;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

await fs.mkdir(path.dirname(HOST_FILE), { recursive: true });
await fs.writeFile(HOST_FILE, FIXTURE, 'utf8');
await sleep(600); // let the Host watcher settle before clients connect

const results = [];
const check = (name, pass, detail = '') => {
  results.push({ name, pass });
  const suffix = detail ? ` — ${String(detail).replace(/\s+/g, ' ').slice(0, 260)}` : '';
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${suffix}`);
};

async function waitFor(fn, timeout = 15000, interval = 200) {
  const start = Date.now();
  let last;
  while (Date.now() - start < timeout) {
    try {
      last = await fn();
      if (last) return last;
    } catch (error) {
      last = error;
    }
    await sleep(interval);
  }
  throw new Error(`timeout: ${last}`);
}

async function openRoom(page) {
  await page.goto(SESSION_URL, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.app', { timeout: 20000 });
}

async function openFile(page, name) {
  const clicked = await page.evaluate((target) => {
    const button = [...document.querySelectorAll('button')].find(
      (candidate) => (candidate.textContent ?? '').trim() === target,
    );
    if (!button) return false;
    button.click();
    return true;
  }, name);
  if (!clicked) throw new Error(`file not found in explorer: ${name}`);
  await page.waitForSelector('.monaco-editor .view-lines', { timeout: 20000 });
  await sleep(1200); // allow the document sync to settle before typing
}

async function editorText(page) {
  return page.evaluate(() => {
    const lines = [...document.querySelectorAll('.view-lines .view-line')].map((line) => line.textContent ?? '');
    const buffer = document.querySelector('.monaco-editor textarea.inputarea')?.value ?? '';
    return `${lines.join('\n')}\n---\n${buffer}`;
  });
}

async function typeAtEnd(page, text) {
  await page.evaluate(() => document.querySelector('.monaco-editor textarea.inputarea')?.focus());
  await page.keyboard.down('Meta');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.up('Meta');
  await page.keyboard.press('End');
  await page.keyboard.type(text);
}

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  args: ['--no-first-run', '--no-default-browser-check'],
});

try {
  const contextA = await browser.createBrowserContext();
  const pageA = await contextA.newPage();
  await pageA.setViewport({ width: 1440, height: 900 });
  const consoleErrors = [];
  const pageErrors = [];
  pageA.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  pageA.on('pageerror', (error) => pageErrors.push(error.message.split('\n')[0]));

  await openRoom(pageA);
  const header = await pageA.$eval('header', (el) => el.innerText.replace(/\n/g, ' | '));
  check('session shell renders', /Ready|Connected/.test(header) && header.length > 0, header);

  await openFile(pageA, RELATIVE_FILE);
  const initial = await editorText(pageA);
  check('editor loads the file from the Host disk', initial.includes('throwaway project'), initial.slice(0, 90));

  const markerA = `A-${Date.now()}`;
  await typeAtEnd(pageA, `\n${markerA}`);
  await sleep(2000);
  check('typing edits the document', (await editorText(pageA)).includes(markerA));
  const onDisk = await fs.readFile(HOST_FILE, 'utf8');
  check('the edit is persisted to the Host filesystem', onDisk.includes(markerA), onDisk.slice(-100));

  const contextB = await browser.createBrowserContext();
  const pageB = await contextB.newPage();
  await pageB.setViewport({ width: 1280, height: 800 });
  await openRoom(pageB);
  await openFile(pageB, RELATIVE_FILE);

  const presence = await waitFor(async () => {
    const avatars = await pageA.evaluate(() =>
      [...document.querySelectorAll('.presence__avatar')].map((el) => el.getAttribute('title')),
    );
    return avatars.length > 0 ? avatars : false;
  }).catch(() => false);
  check('a second client appears in presence', Boolean(presence), JSON.stringify(presence));

  const markerB = `B-${Date.now()}`;
  await typeAtEnd(pageB, `\n${markerB}`);
  const received = await waitFor(async () =>
    (await editorText(pageA)).includes(markerB) ? true : false,
  ).catch(() => false);
  check('a remote edit reaches the other client', Boolean(received));

  const cursor = await waitFor(async () => {
    const state = await pageA.evaluate(() => {
      const head = document.querySelector('[class*="yRemoteSelectionHead-"]');
      const css = [...document.querySelectorAll('style[data-codepair-cursors]')]
        .map((el) => el.textContent ?? '')
        .join('');
      return {
        head: Boolean(head),
        css: /yRemoteSelectionHead-\d+/.test(css),
        label: head ? getComputedStyle(head, '::after').content : null,
      };
    });
    return state.head && state.css ? state : false;
  }, 10000).catch(() => false);
  check('the remote cursor and name tag render', Boolean(cursor), JSON.stringify(cursor));

  await pageA.evaluate(() => document.querySelector('.monaco-editor textarea.inputarea')?.focus());
  await pageB.evaluate(() => document.querySelector('.monaco-editor textarea.inputarea')?.focus());
  await Promise.all([
    pageA.keyboard.type('alpha', { delay: 20 }),
    pageB.keyboard.type('beta', { delay: 20 }),
  ]);
  await sleep(3500);
  const mergedA = await editorText(pageA);
  const mergedB = await editorText(pageB);
  const letters = ['a', 'b', 'e', 'h', 'l', 'p', 't'];
  const keptEveryLetter = letters.every((letter) => mergedA.includes(letter));
  check(
    'simultaneous typing converges with nothing lost',
    mergedA === mergedB && keptEveryLetter,
    JSON.stringify({ converged: mergedA === mergedB, tail: mergedA.slice(-70) }),
  );

  const errorsBeforeProbes = [...consoleErrors];
  const terminalButton = await pageA.$('[aria-label="Toggle terminal"]');
  if (terminalButton) {
    await terminalButton.click();
    await pageA.waitForSelector('.xterm-helper-textarea', { timeout: 15000 });
    await sleep(1200);
    await pageA.click('.xterm-helper-textarea').catch(() => {});
    await pageA.keyboard.type('node --version');
    await pageA.keyboard.press('Enter');
    const output = await waitFor(async () => {
      const text = await pageA.$eval('.xterm-rows', (el) => el.innerText);
      return /v\d+\.\d+\.\d+/.test(text.split('node --version')[1] ?? '') ? text : false;
    }, 20000).catch(() => '');
    check('the terminal runs a real command on the Host', /v\d+\.\d+\.\d+/.test(output.split('node --version')[1] ?? ''), output.slice(-90));
  } else {
    check('the terminal runs a real command on the Host', false, 'terminal control missing');
  }

  const anonymous = await pageA.evaluate(async (base) => {
    const response = await fetch(`${base}/api/tree`);
    return response.status;
  }, BASE);
  check('unauthenticated API calls are rejected', anonymous === 401, `status ${anonymous}`);

  const traversal = await pageA.evaluate(
    async (base, token) => {
      const response = await fetch(`${base}/api/file?path=${encodeURIComponent('../../etc/passwd')}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      return { status: response.status, body: (await response.text()).slice(0, 120) };
    },
    BASE,
    TOKEN,
  );
  check('path traversal is rejected', traversal.status === 400 || traversal.status === 403, JSON.stringify(traversal));

  await pageA.evaluate(() => {
    const button = [...document.querySelectorAll('button')].find((candidate) => /^share$/i.test((candidate.textContent ?? '').trim()));
    button?.click();
  });
  const share = await waitFor(async () => {
    const dialog = await pageA.$('[role="dialog"]');
    if (!dialog) return false;
    const info = await dialog.evaluate((el) => ({
      qr: Boolean(el.querySelector('canvas, svg')),
      link: el.querySelector('input')?.value ?? el.innerText.match(/https?:\/\/\S+/)?.[0] ?? '',
    }));
    return info.qr ? info : false;
  }, 10000).catch(() => false);
  check('the share dialog shows a QR code and session link', Boolean(share) && share.link.includes('/room/'), JSON.stringify(share));
  await pageA.keyboard.press('Escape');

  const mobile = await browser.newPage();
  await mobile.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  await openRoom(mobile);
  await openFile(mobile, RELATIVE_FILE).catch(() => {});

  const layout = await mobile.evaluate(() => {
    const editor = document.querySelector('.monaco-editor')?.getBoundingClientRect();
    const sidebar = document.querySelector('aside')?.getBoundingClientRect();
    const offscreen = [...document.querySelectorAll('button')].filter((button) => {
      const rect = button.getBoundingClientRect();
      return rect.width > 0 && rect.right > window.innerWidth + 1;
    }).length;
    return {
      scrollWidth: document.documentElement.scrollWidth,
      innerWidth: window.innerWidth,
      editorWidth: Math.round(editor?.width ?? 0),
      editorHeight: Math.round(editor?.height ?? 0),
      drawer: Boolean(document.querySelector('[aria-label="Toggle file explorer"]')),
      sidebarVisible: Boolean(sidebar && sidebar.width > 40 && sidebar.right > 0),
      minimapWidth: Math.round(document.querySelector('.minimap')?.getBoundingClientRect().width ?? -1),
      offscreen,
      terminalButton: Boolean(document.querySelector('[aria-label="Toggle terminal"]')),
    };
  });
  check('mobile: no horizontal overflow', layout.scrollWidth <= layout.innerWidth + 1, JSON.stringify(layout));
  check('mobile: explorer collapses behind a drawer', layout.drawer && !layout.sidebarVisible);
  check('mobile: editor fills the viewport height', layout.editorWidth > 300 && layout.editorHeight > 300);
  check('mobile: minimap is disabled', layout.minimapWidth === 0);
  check('mobile: no controls pushed off-screen', layout.offscreen === 0);
  check('mobile: terminal control is reachable', layout.terminalButton);

  await mobile.setViewport({ width: 844, height: 390, isMobile: true, hasTouch: true });
  await sleep(900);
  const landscape = await mobile.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    innerWidth: window.innerWidth,
    editorHeight: Math.round(document.querySelector('.monaco-editor')?.getBoundingClientRect().height ?? 0),
  }));
  check('landscape: layout stays usable', landscape.scrollWidth <= landscape.innerWidth + 1 && landscape.editorHeight > 120, JSON.stringify(landscape));

  const unexpected = errorsBeforeProbes.filter((line) => !/api\/session.*ERR_ABORTED/.test(line));
  check('no console errors while editing', unexpected.length === 0, unexpected.slice(0, 2).join(' || '));
  check('no uncaught page errors', pageErrors.length === 0, pageErrors.slice(0, 2).join(' || '));

  if (process.env.CODE_PAIR_SCREENSHOTS) {
    await pageA.screenshot({ path: process.env.CODE_PAIR_SCREENSHOTS + '/desktop.png' });
    await mobile.screenshot({ path: process.env.CODE_PAIR_SCREENSHOTS + '/mobile.png' });
  }

  const failed = results.filter((result) => !result.pass);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  process.exitCode = failed.length ? 1 : 0;
} catch (error) {
  console.error('e2e aborted:', error);
  process.exitCode = 2;
} finally {
  await browser.close();
}
