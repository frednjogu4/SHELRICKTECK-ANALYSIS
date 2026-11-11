/*
 * Brand and WhatsApp sharing — the values every device starts with.
 *
 * Scope: the built-in Shelricktech name, tagline and logo, the icon files the
 * browser and the phone home screen use, and the WhatsApp number the share
 * buttons open.
 *
 * The application tests boot the real bundle in jsdom with a stub API that
 * answers only the routes a test names. WebSocket never connects, nothing
 * reaches the network, and window.open is recorded instead of followed. The
 * headline and calendar entries used here are test fixtures with no trading
 * direction; no assertion looks at an analysis result.
 */
import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateSync } from 'node:zlib';
import { build } from 'esbuild';
import { JSDOM, VirtualConsole } from 'jsdom';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const indexHtml = readFileSync(join(root, 'index.html'), 'utf8');
const mainJs = readFileSync(join(root, 'src', 'main.js'), 'utf8');
const MODULE_TAG = '<script type="module" src="/src/main.js"></script>';

const BRAND_NAME = 'Shelricktech';
const BRAND_TAGLINE = 'INVESTMENT';
const WHATSAPP_NUMBER = '254721752212';

/* ---------------------------------------------------------------- image helpers */

/** Header and compressed pixel data of a PNG file. */
function readPng(buffer) {
  assert.deepEqual([...buffer.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10], 'PNG signature');
  let header = null;
  const data = [];
  for (let offset = 8; offset < buffer.length;) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('latin1', offset + 4, offset + 8);
    const body = buffer.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      header = { width: body.readUInt32BE(0), height: body.readUInt32BE(4), bitDepth: body[8], colourType: body[9], interlace: body[12] };
    }
    if (type === 'IDAT') data.push(body);
    offset += 12 + length;
  }
  assert.ok(header, 'PNG has a header');
  return { ...header, data: Buffer.concat(data) };
}

/** Decoded pixels of an 8-bit RGB (colour type 2) or RGBA (colour type 6) PNG. */
function pngPixels(png) {
  assert.equal(png.bitDepth, 8);
  assert.equal(png.interlace, 0);
  assert.ok(png.colourType === 2 || png.colourType === 6, 'RGB or RGBA');
  const channels = png.colourType === 6 ? 4 : 3;
  const stride = png.width * channels;
  const raw = inflateSync(png.data);
  const out = Buffer.alloc(stride * png.height);
  for (let y = 0; y < png.height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = y * (stride + 1) + 1;
    for (let i = 0; i < stride; i++) {
      const left = i >= channels ? out[y * stride + i - channels] : 0;
      const up = y > 0 ? out[(y - 1) * stride + i] : 0;
      const upLeft = y > 0 && i >= channels ? out[(y - 1) * stride + i - channels] : 0;
      let value = raw[line + i];
      if (filter === 1) value += left;
      else if (filter === 2) value += up;
      else if (filter === 3) value += (left + up) >> 1;
      else if (filter === 4) {
        const estimate = left + up - upLeft;
        const dLeft = Math.abs(estimate - left), dUp = Math.abs(estimate - up), dUpLeft = Math.abs(estimate - upLeft);
        value += dLeft <= dUp && dLeft <= dUpLeft ? left : dUp <= dUpLeft ? up : upLeft;
      } else assert.equal(filter, 0, 'known PNG filter');
      out[y * stride + i] = value & 255;
    }
  }
  return (x, y) => [...out.subarray((y * png.width + x) * channels, (y * png.width + x + 1) * channels)];
}

/** Pixel size of a JPEG file, from its frame header. */
function jpegSize(buffer) {
  assert.equal(buffer.readUInt16BE(0), 0xffd8, 'JPEG start marker');
  for (let offset = 2; offset + 9 < buffer.length;) {
    assert.equal(buffer[offset], 0xff, 'JPEG segment marker');
    const marker = buffer[offset + 1];
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: buffer.readUInt16BE(offset + 5), width: buffer.readUInt16BE(offset + 7) };
    }
    offset += 2 + buffer.readUInt16BE(offset + 2);
  }
  throw new Error('JPEG frame header not found');
}

const isWhite = (pixel) => pixel[0] >= 250 && pixel[1] >= 250 && pixel[2] >= 250;
const icon = (name) => readPng(readFileSync(join(root, 'public', 'icons', name)));

/** The built-in brand as written in src/main.js. */
function builtInBrand() {
  const match = mainJs.match(/const BRAND_DEFAULT=\{name:'([^']*)',tag:'([^']*)',logo:'(data:image\/jpeg;base64,[A-Za-z0-9+/=]+)'\}/);
  assert.ok(match, 'BRAND_DEFAULT is defined in src/main.js');
  return { name: match[1], tag: match[2], logo: match[3] };
}

/* ---------------------------------------------------------------- files */

test('the built-in brand is Shelricktech with a small square logo', () => {
  const brand = builtInBrand();
  assert.equal(brand.name, BRAND_NAME);
  assert.equal(brand.tag, BRAND_TAGLINE);
  const jpeg = Buffer.from(brand.logo.split(',')[1], 'base64');
  const size = jpegSize(jpeg);
  assert.equal(size.width, size.height, 'the logo is square');
  assert.ok(size.width >= 152, 'sharp enough for the 76 px login logo on a high-density screen');
  assert.ok(jpeg.length < 20 * 1024, `the logo travels inside the page, so it stays small (${jpeg.length} bytes)`);
});

test('the source artwork the icons are generated from is kept in the repository', () => {
  const file = join(root, 'branding', 'shelricktech-logo.jpg');
  assert.ok(existsSync(file), 'branding/shelricktech-logo.jpg exists');
  const size = jpegSize(readFileSync(file));
  assert.equal(size.width, size.height);
  assert.ok(size.width >= 512);
  assert.ok(existsSync(join(root, 'scripts', 'make-brand-assets.py')), 'the generator script exists');
});

test('every icon file has the pixel size its name and the manifest promise', () => {
  const expected = { 'favicon-32.png': 32, 'icon-192.png': 192, 'icon-512.png': 512, 'icon-maskable-512.png': 512, 'apple-touch-icon.png': 180 };
  for (const [name, side] of Object.entries(expected)) {
    const png = icon(name);
    assert.deepEqual([png.width, png.height], [side, side], name);
  }
  const manifest = JSON.parse(readFileSync(join(root, 'public', 'manifest.webmanifest'), 'utf8'));
  assert.ok(manifest.icons.length >= 3);
  for (const entry of manifest.icons) {
    const file = join(root, 'public', entry.src.replace(/^\//, ''));
    assert.ok(existsSync(file), `${entry.src} exists`);
    const png = readPng(readFileSync(file));
    assert.equal(`${png.width}x${png.height}`, entry.sizes, `${entry.src} matches its declared size`);
    assert.equal(entry.type, 'image/png');
  }
});

test('tab and install icons are rounded tiles: transparent corners, opaque edges', () => {
  for (const name of ['favicon-32.png', 'icon-192.png', 'icon-512.png']) {
    const png = icon(name);
    assert.equal(png.colourType, 6, `${name} carries transparency`);
    const pixel = pngPixels(png);
    const last = png.width - 1;
    for (const [x, y] of [[0, 0], [last, 0], [0, last], [last, last]]) {
      assert.equal(pixel(x, y)[3], 0, `${name}: corner ${x},${y} is transparent`);
    }
    const middle = png.width >> 1;
    /* Opaque up to the edge: a see-through tile would lose dark lettering on the app's dark surfaces. */
    for (const [x, y] of [[middle, 0], [middle, last], [0, middle], [last, middle], [middle, middle]]) {
      assert.equal(pixel(x, y)[3], 255, `${name}: ${x},${y} is opaque`);
    }
  }
});

test('home-screen icons are opaque, and the Android icon keeps all artwork inside the safe zone', () => {
  /* iOS paints transparency black and Android crops a maskable icon, at worst
     to a circle 80% of its width. Both therefore need a full-bleed opaque
     picture, and the Android one needs nothing but background outside that
     circle. */
  assert.equal(icon('apple-touch-icon.png').colourType, 2, 'apple-touch-icon has no alpha channel');

  const maskable = icon('icon-maskable-512.png');
  assert.equal(maskable.colourType, 2, 'maskable icon has no alpha channel');
  const pixel = pngPixels(maskable);
  const centre = (maskable.width - 1) / 2;
  const safeRadius = maskable.width * 0.40;
  let outside = 0;
  let artworkInside = 0;
  for (let y = 0; y < maskable.height; y++) {
    for (let x = 0; x < maskable.width; x++) {
      const inSafeZone = Math.hypot(x - centre, y - centre) <= safeRadius;
      const white = isWhite(pixel(x, y));
      if (!inSafeZone && !white) outside++;
      if (inSafeZone && !white) artworkInside++;
    }
  }
  assert.equal(outside, 0, 'no artwork outside the safe zone');
  assert.ok(artworkInside > maskable.width * maskable.height * 0.05, 'the logo itself is drawn inside the safe zone');
});

test('the page as shipped names the brand before any script runs', () => {
  const page = new JSDOM(indexHtml).window.document;
  assert.equal(page.title, `${BRAND_NAME} — Trading Workspace`);
  assert.equal(page.getElementById('brandName').textContent, BRAND_NAME);
  assert.equal(page.getElementById('brandTag').textContent, BRAND_TAGLINE);
  assert.equal(page.getElementById('waNumber').getAttribute('placeholder'), WHATSAPP_NUMBER);
  for (const href of ['/icons/favicon-32.png', '/icons/apple-touch-icon.png']) {
    assert.ok(page.querySelector(`link[href="${href}"]`), `${href} is linked`);
  }
});

/* ---------------------------------------------------------------- the running application */

const PC_ORIGIN = 'http://127.0.0.1:8788';
const HOSTED_ORIGIN = 'https://aurum-test.workers.dev';
let bundleCode = '';

before(async () => {
  const bundle = await build({
    entryPoints: [join(root, 'src', 'main.js')], bundle: true, write: false, format: 'iife',
    absWorkingDir: root, define: { 'import.meta.env': '{}' }, logLevel: 'silent'
  });
  bundleCode = bundle.outputFiles[0].text;
});

/* Boots the real application bundle in jsdom.
     storage  values already saved on the device, e.g. { settings: { wa: '…' } }
     api      answers for same-origin API paths: { '/api/x': { status, body } };
              every other path gets a 404, and nothing leaves the page. */
async function bootApp({ origin = PC_ORIGIN, storage = {}, api = {} } = {}) {
  const problems = [];
  const opened = [];
  let closing = false;
  const consoleLines = new VirtualConsole();
  consoleLines.on('jsdomError', (error) => problems.push('jsdomError: ' + ((error.detail && error.detail.stack) || error.message)));
  consoleLines.on('error', (...args) => problems.push('console.error: ' + args.join(' ')));

  /* Function replacement: a string replacement would expand `$&`-style sequences inside the bundle. */
  const html = indexHtml.replace(MODULE_TAG, () => '<script>' + bundleCode + '</' + 'script>');
  assert.ok(!html.includes(MODULE_TAG), 'module tag replaced by the bundle');

  const dom = new JSDOM(html, {
    runScripts: 'dangerously', pretendToBeVisual: true, virtualConsole: consoleLines, url: origin + '/',
    beforeParse(window) {
      window.matchMedia = (query) => ({ matches: false, media: query, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
      window.Element.prototype.scrollIntoView = function () {};
      window.scrollTo = function () {};
      for (const [key, value] of Object.entries(storage)) window.localStorage.setItem('aurum_' + key, JSON.stringify(value));
      window.open = (url) => { opened.push(String(url)); return null; };
      /* A socket that never connects: no feed, no ticks, no authorisation. */
      window.WebSocket = function () {
        this.readyState = 0;
        this.send = () => {};
        this.close = () => { this.readyState = 3; };
        this.addEventListener = () => {};
        this.removeEventListener = () => {};
      };
      window.fetch = async (input) => {
        const url = new URL(String(input), origin);
        if (url.origin !== origin) throw new TypeError('network is disabled in tests');
        if (closing) return new Promise(() => {});
        const answer = api[url.pathname] || { status: 404, body: { error: 'not_part_of_this_test' } };
        return new Response(JSON.stringify(answer.body), { status: answer.status || 200, headers: { 'content-type': 'application/json' } });
      };
    }
  });
  const { window } = dom;
  const doc = window.document;
  const waitFor = async (condition, label, timeoutMs = 5000) => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (condition()) return;
      if (Date.now() > deadline) throw new Error('timed out waiting for: ' + label + '\n' + problems.join('\n'));
      await new Promise((r) => setTimeout(r, 25));
    }
  };
  await waitFor(() => window.__aurumAppStarted === true, 'application start marker');
  return {
    window, doc, opened, problems, waitFor,
    click: (id) => doc.getElementById(id).dispatchEvent(new window.MouseEvent('click', { bubbles: true })),
    type(id, value) {
      const field = doc.getElementById(id);
      field.value = value;
      field.dispatchEvent(new window.Event('input', { bubbles: true }));
    },
    toastTitles: () => [...doc.querySelectorAll('#toasts .toast b')].map((el) => el.textContent),
    /* Past the login screen without any account ("live markets, no trading"), then into Settings. */
    async openSettings() {
      doc.getElementById('guestBtn').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
      await waitFor(() => doc.getElementById('authScreen').classList.contains('hidden'), 'workspace after the login screen');
      doc.querySelector('.nav-item[data-view="settings"]').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
      await waitFor(() => doc.getElementById('brandNameInput').__wired === true, 'Settings view with the brand fields wired');
    },
    /* The WhatsApp link most recently opened: the number it addresses and the message it carries. */
    lastShare() {
      const url = new URL(opened[opened.length - 1]);
      return { host: url.host, number: url.pathname.slice(1), text: url.searchParams.get('text') };
    },
    /* Teardown: stop answering requests, let resumed application code finish
       its current microtasks, then close the window (which cancels its timers). */
    async close() {
      closing = true;
      await new Promise((r) => setTimeout(r, 50));
      window.close();
    }
  };
}

const CALENDAR = { status: 200, body: { day: '2026-01-05', source: 'test calendar', events: [{ time_utc: '12:30', impact: 'High', country: 'USD', event: 'Test release' }] } };
const HEADLINES = { status: 200, body: { note: '', items: [{ title: 'Test headline', link: 'https://example.test/story', source: 'Test wire' }] } };

for (const [place, origin] of [['the PC app', PC_ORIGIN], ['the Cloudflare site', HOSTED_ORIGIN]]) {
  test(`a new device on ${place} shows the Shelricktech name, tagline and logo`, async () => {
    const app = await bootApp({ origin });
    try {
      const { logo } = builtInBrand();
      assert.equal(app.doc.getElementById('brandName').textContent, BRAND_NAME);
      assert.equal(app.doc.getElementById('brandTag').textContent, BRAND_TAGLINE);
      assert.equal(app.doc.querySelector('#brandMark img').getAttribute('src'), logo, 'sidebar mark');
      assert.equal(app.doc.getElementById('authLogo').getAttribute('src'), logo, 'login screen logo');
      assert.equal(app.doc.title, `${BRAND_NAME} — Trading Workspace`);
      assert.equal(app.doc.getElementById('waNumber').value, WHATSAPP_NUMBER, 'Settings shows the number in use');
      assert.deepEqual(app.problems, [], 'no uncaught error and no console.error during startup');
    } finally {
      await app.close();
    }
  });
}

test('a name and logo saved on a device still win; text left over from the previous built-in brand does not', async () => {
  const ownLogo = 'data:image/png;base64,iVBORw0KGgo=';
  const custom = await bootApp({ storage: { settings: { brand: { name: 'Desk Seven', tag: 'TRADING', logo: ownLogo } } } });
  try {
    assert.equal(custom.doc.getElementById('brandName').textContent, 'Desk Seven');
    assert.equal(custom.doc.getElementById('brandTag').textContent, BRAND_TAGLINE, 'the old built-in tagline is not a custom value');
    assert.equal(custom.doc.querySelector('#brandMark img').getAttribute('src'), ownLogo);
    assert.equal(custom.doc.getElementById('authLogo').getAttribute('src'), ownLogo);
  } finally {
    await custom.close();
  }

  const leftover = await bootApp({ storage: { settings: { brand: { name: 'FREDRICK', tag: 'TRADING' } } } });
  let afterFirstStart;
  try {
    assert.equal(leftover.doc.getElementById('brandName').textContent, BRAND_NAME);
    assert.equal(leftover.doc.getElementById('brandTag').textContent, BRAND_TAGLINE);
    assert.equal(leftover.doc.querySelector('#brandMark img').getAttribute('src'), builtInBrand().logo);
    afterFirstStart = JSON.parse(leftover.window.localStorage.getItem('aurum_settings'));
    assert.deepEqual(afterFirstStart.brand, {}, 'the leftover text is removed from the device, not just hidden');
  } finally {
    await leftover.close();
  }

  /* The clean-up runs once. A tagline typed afterwards is the owner's choice, even
     if it is the word the old brand used, and it survives the next start. */
  const typed = await bootApp({ storage: { settings: afterFirstStart } });
  try {
    await typed.openSettings();
    typed.type('brandTagInput', 'TRADING');
    assert.equal(typed.doc.getElementById('brandTag').textContent, 'TRADING');
    afterFirstStart = JSON.parse(typed.window.localStorage.getItem('aurum_settings'));
  } finally {
    await typed.close();
  }
  const restarted = await bootApp({ storage: { settings: afterFirstStart } });
  try {
    assert.equal(restarted.doc.getElementById('brandName').textContent, BRAND_NAME);
    assert.equal(restarted.doc.getElementById('brandTag').textContent, 'TRADING', 'a typed tagline is kept across restarts');
  } finally {
    await restarted.close();
  }
});

test('Reset in Settings brings back the built-in name, tagline and logo', async () => {
  const app = await bootApp({ storage: { settings: { brandMigrated: 1, brand: { name: 'Desk Seven', tag: 'ROOM 2', logo: 'data:image/png;base64,iVBORw0KGgo=' } } } });
  try {
    assert.equal(app.doc.getElementById('brandName').textContent, 'Desk Seven');
    assert.equal(app.doc.getElementById('brandTag').textContent, 'ROOM 2');
    await app.openSettings();
    assert.equal(app.doc.getElementById('brandNameInput').value, 'Desk Seven', 'Settings shows the saved name');
    app.click('brandReset');
    assert.equal(app.doc.getElementById('brandName').textContent, BRAND_NAME);
    assert.equal(app.doc.getElementById('brandTag').textContent, BRAND_TAGLINE);
    assert.equal(app.doc.querySelector('#brandMark img').getAttribute('src'), builtInBrand().logo);
    assert.equal(app.doc.getElementById('authLogo').getAttribute('src'), builtInBrand().logo);
    assert.deepEqual(JSON.parse(app.window.localStorage.getItem('aurum_settings')).brand, {});
  } finally {
    await app.close();
  }
});

test('sharing a signal from a device with no saved number opens WhatsApp for the Shelricktech number', async () => {
  const app = await bootApp({ api: { '/api/news/feed': HEADLINES, '/api/news/calendar': CALENDAR } });
  try {
    app.click('newsFeedBtn');
    await app.waitFor(() => app.doc.querySelector('#newsFeed .news-wa'), 'headline with a share button');
    app.doc.querySelector('#newsFeed .news-wa').dispatchEvent(new app.window.MouseEvent('click', { bubbles: true }));
    await app.waitFor(() => app.opened.length === 1, 'WhatsApp link for the headline');
    let share = app.lastShare();
    assert.equal(share.host, 'wa.me');
    assert.equal(share.number, WHATSAPP_NUMBER);
    assert.ok(share.text.startsWith(`🚨 ${BRAND_NAME} trading signal\n`), share.text);
    assert.ok(share.text.includes('Headline: Test headline'));

    app.click('newsCalShare');
    await app.waitFor(() => app.opened.length === 2, "WhatsApp link for today's brief");
    share = app.lastShare();
    assert.equal(share.host, 'wa.me');
    assert.equal(share.number, WHATSAPP_NUMBER);
    assert.ok(share.text.startsWith(`📅 ${BRAND_NAME} — today (UTC)\n`), share.text);
    assert.ok(share.text.includes('12:30 HIGH · USD Test release'));
    assert.ok(!/FREDRICK/i.test(app.opened.join(' ')), 'the previous brand name is gone from shared messages');
  } finally {
    await app.close();
  }
});

test('a number typed in Settings replaces the built-in one on that device, and clearing it brings the built-in one back', async () => {
  const app = await bootApp({ api: { '/api/news/calendar': CALENDAR } });
  try {
    app.type('waNumber', '+254 700 111 222');
    assert.equal(JSON.parse(app.window.localStorage.getItem('aurum_settings')).wa, '+254700111222', 'saved on the device');
    app.click('newsCalShare');
    await app.waitFor(() => app.opened.length === 1, 'share to the typed number');
    assert.equal(app.lastShare().number, '254700111222');

    app.type('waNumber', '');
    app.click('newsCalShare');
    await app.waitFor(() => app.opened.length === 2, 'share after clearing the field');
    assert.equal(app.lastShare().number, WHATSAPP_NUMBER);
  } finally {
    await app.close();
  }
});

test('a number saved before this update is still the one that is used', async () => {
  const app = await bootApp({ storage: { settings: { wa: '254700111222' } }, api: { '/api/news/calendar': CALENDAR } });
  try {
    assert.equal(app.doc.getElementById('waNumber').value, '254700111222');
    app.click('newsCalShare');
    await app.waitFor(() => app.opened.length === 1, 'share to the saved number');
    assert.equal(app.lastShare().number, '254700111222');
  } finally {
    await app.close();
  }
});

test('a half-typed number is refused instead of being sent to the wrong person', async () => {
  const app = await bootApp({ api: { '/api/news/calendar': CALENDAR } });
  try {
    app.type('waNumber', '2547');
    app.click('newsCalShare');
    await app.waitFor(() => app.toastTitles().includes('WhatsApp number missing'), 'refusal notice');
    assert.deepEqual(app.opened, []);
  } finally {
    await app.close();
  }
});

for (const [why, answer] of [
  ['the calendar feed is down (502)', { status: 502, body: { error: 'calendar_unavailable' } }],
  ['the host has no calendar route (501)', { status: 501, body: { error: 'cloudflare_route_not_migrated' } }],
  ['the answer carries no event list', { status: 200, body: {} }]
]) {
  test(`today's brief is not shared as "no events" when ${why}`, async () => {
    const app = await bootApp({ api: { '/api/news/calendar': answer } });
    try {
      app.click('newsCalShare');
      await app.waitFor(() => app.toastTitles().includes('Calendar unavailable'), 'calendar notice');
      assert.deepEqual(app.opened, [], 'nothing is sent to WhatsApp');
    } finally {
      await app.close();
    }
  });
}

test('a calendar that loaded with nothing scheduled is shared as such', async () => {
  const app = await bootApp({ api: { '/api/news/calendar': { status: 200, body: { events: [] } } } });
  try {
    app.click('newsCalShare');
    await app.waitFor(() => app.opened.length === 1, 'share of an empty day');
    assert.ok(app.lastShare().text.includes('No high/medium events listed today.'));
  } finally {
    await app.close();
  }
});
