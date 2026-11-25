#!/usr/bin/env node
/*
 * Build revision for a single UI release.
 *
 * One identifier travels through every delivery surface:
 *   - <meta name="aurum-build"> in dist/index.html (and AURUM_Workspace.html,
 *     bridge/app.html — same bytes);
 *   - dist/build.json (Cloudflare staging serves it at /build.json);
 *   - bridge/pwa/build.json (the local bridge serves a dynamic /build.json);
 *   - const VERSION in dist/sw.js (release-keyed service-worker cache).
 *
 * The id is the SHA-256 of the BUILT page as Vite produced it, before the
 * meta tag is injected — so rebuilding the same sources yields the same id
 * everywhere (CI's "committed dist matches a fresh build" check stays quiet)
 * while any real UI change (JS, CSS, markup — all inlined in one file)
 * changes it. No timestamps or wall-clock values are baked into shipped files.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** sha256 of a buffer, first 12 hex chars, prefixed with 'b'. */
export function contentId(buffer) {
  return 'b' + createHash('sha256').update(buffer).digest('hex').slice(0, 12);
}

/** Remove a previous revision injection so the content hash depends only on
 * the build itself (idempotent: stamping an already-stamped page yields the
 * same id, which is what keeps rebuild loops and CI diffs quiet). */
export function stripBuildMeta(html) {
  return html.replace(/<meta name="aurum-build(?:-git)?" content="[^"]*">/g, '');
}

/** package.json version of the workspace. */
export function appVersion(root = REPO_ROOT) {
  try {
    return JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version || null;
  } catch {
    return null;
  }
}

/** { id, version } for the built page of `distDir` — content-addressed only,
 * so a rebuild of the same sources is byte-identical everywhere (git SHA and
 * timestamps are runtime metadata: the bridge and the Worker add them when
 * serving /build.json, they are never baked into shipped files). */
export function buildRevision(distDir = join(REPO_ROOT, 'dist'), root = REPO_ROOT) {
  const html = stripBuildMeta(readFileSync(join(distDir, 'index.html'), 'utf8'));
  return { id: contentId(Buffer.from(html, 'utf8')), version: appVersion(root) };
}

/** The meta tag a revision injects into the page. */
export function buildMetaTags(rev) {
  return `<meta name="aurum-build" content="${rev.id}">`;
}

/**
 * Put the revision tags into an HTML document (idempotent: replaces a previous
 * injection instead of stacking a second copy).
 */
export function injectBuildMeta(html, rev) {
  const cleaned = stripBuildMeta(html);
  const marker = /<head[^>]*>/i;
  if (marker.test(cleaned)) return cleaned.replace(marker, (m) => m + buildMetaTags(rev));
  return buildMetaTags(rev) + cleaned;
}

/** Rewrite the service worker's cache VERSION to the release id. */
export function injectSwVersion(swSource, id) {
  return swSource.replace(/const VERSION = '[^']*';/, `const VERSION = '${VERSION_PREFIX}${id}';`);
}

export const VERSION_PREFIX = 'aurum-local-';
