#!/usr/bin/env node
/*
 * Verify that dist/ is a complete, deployable build of the UI.
 *
 * Why this exists: dist/ is what Cloudflare serves as static assets. A dist/
 * that holds only the two tracked HTML files (no service worker, manifest,
 * icons or _headers) still deploys "successfully" but ships a broken PWA with
 * no security headers. This check turns that silent failure into a loud one.
 *
 * It is run by `npm run build` (after Vite), by `npm run verify:dist`, and by
 * Wrangler itself before `wrangler dev` / `wrangler deploy` (see the `build`
 * entry in wrangler.jsonc). It only reads files; it never writes or deletes.
 *
 * Usage: node scripts/verify-dist.mjs [distDir]
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Files every deployable build must contain (paths relative to dist/). */
export const REQUIRED_FILES = Object.freeze([
  'index.html',
  'AURUM_Workspace.html',
  'sw.js',
  'manifest.webmanifest',
  '_headers',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/icon-maskable-512.png',
  'icons/apple-touch-icon.png',
  'icons/favicon-32.png'
]);

/** Response headers that dist/_headers must set for the static assets. */
export const REQUIRED_ASSET_HEADERS = Object.freeze([
  'X-Content-Type-Options',
  'X-Frame-Options',
  'Referrer-Policy',
  'Strict-Transport-Security',
  'Permissions-Policy',
  'Content-Security-Policy'
]);

/* Everything in dist/ is published to the internet. These names must never be in it. */
const FORBIDDEN_NAME = /^(\.env(\..*)?|\.dev\.vars(\..*)?|.*\.pem|.*\.key|.*\.p12|.*\.pfx|id_rsa.*|bridge_token\.txt|.*\.map)$/i;

/* Cloudflare Workers static assets: 25 MiB per file. */
const MAX_ASSET_BYTES = 25 * 1024 * 1024;

function listFiles(root) {
  const out = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else out.push(relative(root, full).split(sep).join('/'));
    }
  };
  walk(root);
  return out.sort();
}

/**
 * @param {string} distDir directory to check
 * @returns {{ ok: boolean, problems: string[], files: string[] }}
 */
export function verifyDist(distDir = join(REPO_ROOT, 'dist')) {
  const problems = [];
  if (!existsSync(distDir) || !statSync(distDir).isDirectory()) {
    return { ok: false, problems: [`${distDir} does not exist. Run "npm run build" first.`], files: [] };
  }
  const files = listFiles(distDir);
  const present = new Set(files);
  const read = (name) => readFileSync(join(distDir, name), 'utf8');

  for (const name of REQUIRED_FILES) {
    if (!present.has(name)) problems.push(`missing ${name}`);
    else if (statSync(join(distDir, name)).size === 0) problems.push(`${name} is empty`);
  }

  for (const name of files) {
    const base = name.slice(name.lastIndexOf('/') + 1);
    if (FORBIDDEN_NAME.test(base)) problems.push(`${name} must not be published (secret, key or source-map file name)`);
    const size = statSync(join(distDir, name)).size;
    if (size > MAX_ASSET_BYTES) problems.push(`${name} is ${size} bytes; Cloudflare static assets are limited to ${MAX_ASSET_BYTES} bytes per file`);
  }

  if (present.has('index.html')) {
    const html = read('index.html');
    if (/<script[^>]+src=["']\/src\/main\.js["']/.test(html)) {
      problems.push('index.html still references /src/main.js — this is the unbuilt source page, not a Vite build');
    }
    if (!/<script\b[^>]*type=["']module["'][^>]*>[\s\S]{1000,}?<\/script>/.test(html)) {
      problems.push('index.html does not contain the inlined application bundle');
    }
    if (present.has('AURUM_Workspace.html') && read('AURUM_Workspace.html') !== html) {
      problems.push('AURUM_Workspace.html differs from index.html — it is stale; rebuild with "npm run build"');
    }
  }

  if (present.has('manifest.webmanifest')) {
    try {
      const manifest = JSON.parse(read('manifest.webmanifest'));
      for (const icon of Array.isArray(manifest.icons) ? manifest.icons : []) {
        const src = String((icon && icon.src) || '').replace(/^\//, '');
        if (src && !present.has(src)) problems.push(`manifest icon ${icon.src} is not in the build`);
      }
    } catch (error) {
      problems.push(`manifest.webmanifest is not valid JSON (${error.message})`);
    }
  }

  if (present.has('_headers')) {
    const headers = read('_headers');
    for (const header of REQUIRED_ASSET_HEADERS) {
      if (!new RegExp('^\\s+' + header + '\\s*:', 'mi').test(headers)) problems.push(`_headers does not set ${header}`);
    }
  }

  return { ok: problems.length === 0, problems, files };
}

const invokedDirectly = process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (invokedDirectly) {
  const distDir = resolve(process.argv[2] || join(REPO_ROOT, 'dist'));
  const result = verifyDist(distDir);
  if (result.ok) {
    console.log(`dist verified: ${result.files.length} files in ${distDir}`);
  } else {
    console.error(`dist verification FAILED for ${distDir}:`);
    for (const problem of result.problems) console.error('  - ' + problem);
    console.error('Run "npm run build" to produce a complete build. Nothing was deployed.');
    process.exit(1);
  }
}
