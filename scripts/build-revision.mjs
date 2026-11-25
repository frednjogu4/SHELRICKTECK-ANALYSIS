#!/usr/bin/env node
/*
 * Build revision and source-commit metadata for a single UI release.
 *
 * One identifier travels through every delivery surface:
 *   - <meta name="aurum-build"> in dist/index.html (and AURUM_Workspace.html,
 *     bridge/app.html — same bytes);
 *   - dist/build.json (Cloudflare staging serves it at /build.json);
 *   - bridge/pwa/build.json (the local bridge serves /build.json);
 *   - const VERSION in dist/sw.js (release-keyed service-worker cache).
 *
 * `id` combines the deterministic content digest of the built single-file UI,
 * while `git` and `builtAt` in build.json record the exact Git commit SHA and
 * commit timestamp that produced that UI build (reused across rebuilds when
 * `id` is unchanged so CI rebuild checks and watch mode stay byte-identical,
 * and shared across Cloudflare staging and Windows ZIP installations that
 * have no `.git/` directory).
 */
import { execFileSync } from 'node:child_process';
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

/**
 * Deterministic Git commit SHA (12 lowercase hex chars) + commit ISO timestamp
 * for `root`, with CI environment fallbacks when `.git` is unavailable.
 * Never uses wall-clock `new Date()`.
 */
export function gitBuildMetadata(root = REPO_ROOT, env = process.env) {
  let git = null;
  let builtAt = null;
  try {
    const out = execFileSync('git', ['show', '-s', '--format=%H%n%cI', 'HEAD'], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    }).trim().split(/\r?\n/);
    if (out[0] && /^[0-9a-f]{7,40}$/i.test(out[0].trim())) {
      git = out[0].trim().slice(0, 12).toLowerCase();
    }
    if (out[1] && out[1].trim()) {
      builtAt = out[1].trim();
    }
  } catch { /* not a git checkout or git not installed */ }

  if (!git) {
    const fallbackSha = env.WORKERS_CI_COMMIT_SHA || env.CF_PAGES_COMMIT_SHA || env.GITHUB_SHA || '';
    if (/^[0-9a-f]{7,40}$/i.test(String(fallbackSha).trim())) {
      git = String(fallbackSha).trim().slice(0, 12).toLowerCase();
    }
  }
  return { git, builtAt };
}

/** { id, version } for the built page of `distDir` — content-addressed so
 * identical UI sources always produce the exact same `id`. */
export function buildRevision(distDir = join(REPO_ROOT, 'dist'), root = REPO_ROOT) {
  const html = stripBuildMeta(readFileSync(join(distDir, 'index.html'), 'utf8'));
  return { id: contentId(Buffer.from(html, 'utf8')), version: appVersion(root) };
}

/**
 * Full build.json manifest `{ id, version, git, builtAt }`.
 * When an existing manifest already carries the same `id` with valid `git` and
 * `builtAt` (and `AURUM_STAMP_HEAD` is not `'1'`), those fields are preserved
 * so rebuilding unchanged UI sources in CI or watch mode stays byte-identical.
 */
export function resolveBuildManifest(distDir = join(REPO_ROOT, 'dist'), root = REPO_ROOT, existing = null, env = process.env) {
  const rev = buildRevision(distDir, root);
  let prev = existing;
  if (!prev) {
    try {
      prev = JSON.parse(readFileSync(join(distDir, 'build.json'), 'utf8'));
    } catch { prev = null; }
  }
  const forceStamp = env && env.AURUM_STAMP_HEAD === '1';
  if (!forceStamp && prev && prev.id === rev.id && prev.git && /^[0-9a-f]{7,40}$/i.test(String(prev.git)) && prev.builtAt) {
    return {
      id: rev.id,
      version: rev.version,
      git: String(prev.git).slice(0, 12).toLowerCase(),
      builtAt: String(prev.builtAt)
    };
  }
  const meta = gitBuildMetadata(root, env);
  const manifest = { id: rev.id, version: rev.version };
  if (meta.git) manifest.git = meta.git;
  if (meta.builtAt) manifest.builtAt = meta.builtAt;
  return manifest;
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
