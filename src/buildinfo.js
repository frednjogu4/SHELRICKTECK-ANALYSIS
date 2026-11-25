/*
 * Build revision, update detection and delivery diagnostics.
 *
 * One content-addressed id (scripts/build-revision.mjs) is stamped into the
 * page (<meta name="aurum-build">), into /build.json (served by the local
 * bridge and by Cloudflare staging) and into the service-worker cache name.
 * This module compares them so the running screen can say:
 *   - which release it is (Settings · Build & delivery), and
 *   - that a NEWER release is ready (non-intrusive banner + safe refresh).
 *
 * Safety rules for the automatic refresh (never interrupt the user):
 *   - never while the document is hidden, a form is submitting, an editable
 *     field is focused or has unsubmitted input, or a modal is open;
 *   - only once per session, after a grace period, and only when a poll
 *     actually observed a different build id (no blind reload loops);
 *   - in-flight bridge/API traffic is not broken: the refresh happens only
 *     when none of the busy signals above are present, and the banner always
 *     offers a manual Refresh/Later choice instead.
 *
 * Everything here is dependency-injected so tests run without a browser.
 */

const DEFAULT_INTERVAL_MS = 30000;
const AUTO_REFRESH_GRACE_MS = 4000;
const FIRST_POLL_DELAY_MS = 8000;

/** The release id stamped into the current page, or null (unbuilt dev page). */
export function pageBuildMeta(doc) {
  const el = (doc || document).querySelector('meta[name="aurum-build"]');
  return (el && el.content) || null;
}

/** True when the remote release differs from the one on screen.
 * Accepts the id string (normal path) or a build-info object. */
export function idsDiffer(current, remote) {
  const rid = (remote && typeof remote === 'object') ? remote.id : remote;
  if (!rid) return false;
  if (!current || current === 'dev') return rid !== 'dev';
  return current !== rid;
}

/** Which environment this screen is served from. */
export function buildEnvironment(hostname) {
  const h = String(hostname || '');
  if (/\.workers\.dev$/.test(h) || h === 'cloudflare-staging.frednjogu4.workers.dev') return 'STAGING (Cloudflare)';
  if (h === '127.0.0.1' || h === 'localhost' || h === '::1') return 'LOCAL';
  if (/^192\.168\./.test(h) || /^10\./.test(h)) return 'LOCAL (LAN)';
  return h ? 'LOCAL (' + h + ')' : 'LOCAL';
}

function editableFocused(doc) {
  const a = doc.activeElement;
  if (!a) return false;
  const tag = String(a.tagName || '').toLowerCase();
  if (tag === 'input' || tag === 'textarea' || tag === 'select') return true;
  return a.isContentEditable === true;
}

function hasUnsubmittedInput(doc) {
  const nodes = (doc || document).querySelectorAll('input, textarea, select');
  for (const n of nodes) {
    if (n.disabled || n.readOnly) continue;
    if (n.type === 'checkbox' || n.type === 'radio' || n.type === 'file' || n.type === 'password') continue;
    /* 'touched' is set only by real 'input' events this session — populated
       default values never count as unsaved user input. */
    if (n.dataset && n.dataset.aurumTouched === '1' && n.value !== '') return true;
  }
  return false;
}

/**
 * Can the page auto-refresh right now without interrupting the user?
 * @param {{doc?: Document, submitting?: boolean, graceUntil?: number, now?: number}} state
 */
export function safeToRefresh(state = {}) {
  const now = typeof state.now === 'number' ? state.now : Date.now();
  if (state.graceUntil && now < state.graceUntil) return false;
  if (state.submitting) return false;
  const doc = state.doc;
  if (!doc) return false;
  if (doc.hidden) return false;
  if (doc.querySelector && doc.querySelector('.modal-overlay.open')) return false;
  if (editableFocused(doc)) return false;
  if (hasUnsubmittedInput(doc)) return false;
  return true;
}

/** GET /build.json without any caching; { ok:false } on failure. */
export async function fetchBuildInfo(fetchImpl, url) {
  try {
    const r = await (fetchImpl || fetch)(url || '/build.json', { cache: 'no-store' });
    if (!r || !r.ok) return { ok: false, status: r ? r.status : 0 };
    const j = await r.json();
    const out = { ok: true, id: j && j.id ? String(j.id) : null, version: j && j.version ? String(j.version) : null,
      git: (j && j.git) || null, builtAt: (j && (j.builtAt || j.updatedAt)) || null,
      mode: (j && j.mode) || null, service: (j && j.service) || null };
    if (j && j.installedAt) out.installedAt = String(j.installedAt);
    return out;
  } catch {
    return { ok: false, status: 0 };
  }
}

/** GET /update-check on the local bridge (read-only upstream release comparison). */
export async function fetchUpstreamCheck(fetchImpl, url) {
  try {
    const r = await (fetchImpl || fetch)(url || '/update-check', { cache: 'no-store' });
    if (!r || !r.ok) return { ok: false, offline: true };
    const j = await r.json();
    const localId = (j && (j.localId || j.installedId)) || null;
    if (!j || !j.ok) return { ok: false, offline: true, localId };
    return {
      ok: true,
      localId,
      localGit: j.localGit || j.installedGit || null,
      remoteId: j.remoteId || j.upstreamId || null,
      remoteGit: j.remoteGit || j.upstreamGit || null,
      remoteBuiltAt: j.remoteBuiltAt || j.upstreamBuiltAt || null,
      updateAvailable: j.updateAvailable === true
    };
  } catch {
    return { ok: false, offline: true };
  }
}

/** The release-keyed VERSION of the served service-worker file. */
export async function serviceWorkerVersion({ fetchImpl } = {}) {
  try {
    const r = await (fetchImpl || fetch)('/sw.js', { cache: 'no-store' });
    if (!r || !r.ok) return null;
    const m = (await r.text()).match(/const VERSION = '([^']+)'/);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

/**
 * Non-intrusive update banner + guarded auto-refresh.
 * Returns { dispose } and accepts injected collaborators for tests.
 */
export function initBuildUpdateWatch(options = {}) {
  const {
    doc = typeof document !== 'undefined' ? document : null,
    win = typeof window !== 'undefined' ? window : null,
    fetchImpl = typeof fetch !== 'undefined' ? fetch : null,
    intervalMs = DEFAULT_INTERVAL_MS,
    graceMs = AUTO_REFRESH_GRACE_MS,
    firstPollDelayMs = FIRST_POLL_DELAY_MS,
    reload = null,
    setIntervalImpl = setInterval,
    clearIntervalImpl = clearInterval,
    setTimeoutImpl = setTimeout,
    clearTimeoutImpl = clearTimeout
  } = options;
  if (!doc || !win) return { dispose() {}, whenSafe() {} };

  let banner = null;
  let shown = false;
  let autoRefreshScheduled = false;
  let autoRefreshed = false;
  let submitting = false;
  let disposed = false;
  let lastRemote = null;
  const pageId = pageBuildMeta(doc);

  const markTouched = (e) => {
    const t = e && e.target;
    if (t && t.dataset) t.dataset.aurumTouched = '1';
  };
  doc.addEventListener('input', markTouched, true);
  const onSubmit = () => { submitting = true; setTimeoutImpl(() => { submitting = false; }, 4000); };
  doc.addEventListener('submit', onSubmit, true);

  function removeBanner() { if (banner) { banner.remove(); banner = null; } }

  function showBanner(info) {
    if (banner || shown) return;
    shown = true;
    banner = doc.createElement('div');
    banner.id = 'updateBanner';
    banner.setAttribute('role', 'status');
    banner.innerHTML = '<b>NEW VERSION AVAILABLE</b><span>Your application interface has been updated.</span>' +
      '<span class="ub-actions"><button type="button" class="btn primary sm ub-refresh">Refresh</button>' +
      '<button type="button" class="btn ghost sm ub-later">Later</button></span>';
    const style = doc.createElement('style');
    style.id = 'updateBannerStyle';
    style.textContent = '#updateBanner{position:fixed;right:16px;bottom:16px;z-index:1200;display:flex;gap:10px;align-items:center;flex-wrap:wrap;' +
      'max-width:min(440px,calc(100vw - 32px));padding:12px 14px;border:1px solid var(--line,#2a3648);border-radius:10px;' +
      'background:#0f1724;box-shadow:0 12px 32px rgba(0,0,0,.45);font-size:13px}' +
      '#updateBanner b{display:block;width:100%;font-size:12px;letter-spacing:.06em;color:#e8b96a}' +
      '#updateBanner .ub-actions{display:flex;gap:8px;margin-left:auto}';
    if (!doc.getElementById('updateBannerStyle')) doc.head.appendChild(style);
    doc.body.appendChild(banner);
    const doReload = () => { removeBanner(); (reload || win.location.reload.bind(win.location))(); };
    banner.querySelector('.ub-refresh').addEventListener('click', doReload);
    banner.querySelector('.ub-later').addEventListener('click', () => { removeBanner(); autoRefreshScheduled = false; });
    if (!autoRefreshed && !autoRefreshScheduled) {
      autoRefreshScheduled = true;
      setTimeoutImpl(() => {
        if (disposed || autoRefreshed) return;
        if (safeToRefresh({ doc, submitting, graceUntil: 0 })) {
          autoRefreshed = true;
          doReload();
        } else {
          /* Not safe now: keep the banner for a manual choice; never loop. */
          autoRefreshScheduled = false;
        }
      }, graceMs);
    }
  }

  async function poll() {
    if (disposed) return;
    const info = await fetchBuildInfo(fetchImpl, (win.location && win.location.origin || '') + '/build.json');
    if (!info.ok || !info.id) return;
    lastRemote = info;
    if (idsDiffer(pageId, info.id)) showBanner(info);
  }

  const timer = setIntervalImpl(poll, intervalMs);
  const first = setTimeoutImpl(poll, firstPollDelayMs);

  return {
    get lastRemote() { return lastRemote; },
    get bannerVisible() { return !!banner; },
    /** Re-run the safety gate (used by the banner's auto-refresh timer). */
    whenSafe(callback) {
      const attempt = (tries) => {
        if (disposed) return;
        if (safeToRefresh({ doc, submitting, graceUntil: 0 })) { callback(); return; }
        if (tries > 0) setTimeoutImpl(() => attempt(tries - 1), 1500);
      };
      attempt(5);
    },
    dispose() {
      disposed = true;
      clearIntervalImpl(timer);
      clearTimeoutImpl(first);
      removeBanner();
    }
  };
}

/**
 * Packaged-mode upstream release notice on LOCAL: polls /update-check softly and
 * shows a non-intrusive controlled-update notice when GitHub main has a newer
 * approved build than the local package folder. Never runs shell commands.
 */
export function initUpstreamReleaseNotice(options = {}) {
  const {
    doc = typeof document !== 'undefined' ? document : null,
    win = typeof window !== 'undefined' ? window : null,
    fetchImpl = typeof fetch !== 'undefined' ? fetch : null,
    intervalMs = 300000,
    firstDelayMs = 12000,
    setIntervalImpl = setInterval,
    clearIntervalImpl = clearInterval,
    setTimeoutImpl = setTimeout,
    clearTimeoutImpl = clearTimeout
  } = options;
  if (!doc || !win) return { dispose() {} };
  const env = buildEnvironment(win.location ? win.location.hostname : '');
  if (env === 'STAGING (Cloudflare)') return { dispose() {} };

  let notice = null;
  let dismissedId = null;
  let disposed = false;

  function showUpstreamBanner(res) {
    if (!res || !res.updateAvailable || !res.remoteId || res.remoteId === dismissedId) return;
    if (doc.getElementById('updateBanner')) return;
    if (!notice) {
      notice = doc.createElement('div');
      notice.id = 'upstreamUpdateBanner';
      notice.setAttribute('role', 'status');
      const style = doc.createElement('style');
      style.id = 'upstreamUpdateBannerStyle';
      style.textContent = '#upstreamUpdateBanner{position:fixed;right:16px;bottom:16px;z-index:1195;display:flex;gap:10px;align-items:center;flex-wrap:wrap;' +
        'max-width:min(460px,calc(100vw - 32px));padding:12px 14px;border:1px solid var(--line,#2a3648);border-radius:10px;' +
        'background:#0f1724;box-shadow:0 12px 32px rgba(0,0,0,.45);font-size:12.5px;line-height:1.45}' +
        '#upstreamUpdateBanner b{display:block;width:100%;font-size:11.5px;letter-spacing:.06em;color:#e8b96a}' +
        '#upstreamUpdateBanner .ub-actions{display:flex;gap:8px;margin-left:auto}';
      if (!doc.getElementById('upstreamUpdateBannerStyle')) doc.head.appendChild(style);
      doc.body.appendChild(notice);
    }
    const gitLabel = res.remoteGit ? ' (git ' + String(res.remoteGit).slice(0, 8) + ')' : '';
    notice.innerHTML = '<b>APPROVED UPDATE AVAILABLE · ' + String(res.remoteId) + gitLabel + '</b>' +
      '<span>Run <code>UPDATE_LOCAL_APP.bat</code> on this PC for a backed-up update with automatic rollback, then reload.</span>' +
      '<span class="ub-actions"><button type="button" class="btn ghost sm ub-dismiss">Dismiss</button></span>';
    notice.querySelector('.ub-dismiss').addEventListener('click', () => {
      dismissedId = res.remoteId;
      if (notice) { notice.remove(); notice = null; }
    });
  }

  async function check() {
    if (disposed) return;
    const origin = (win.location && win.location.origin) || '';
    const res = await fetchUpstreamCheck(fetchImpl, origin + '/update-check');
    if (res.ok && res.updateAvailable) showUpstreamBanner(res);
  }

  const first = setTimeoutImpl(check, firstDelayMs);
  const timer = setIntervalImpl(check, intervalMs);
  return {
    check,
    dispose() {
      disposed = true;
      clearTimeoutImpl(first);
      clearIntervalImpl(timer);
      if (notice) { notice.remove(); notice = null; }
    }
  };
}

/** Fill Settings · Build & delivery with the facts of this release. */
export async function fillDiagnostics(options = {}) {
  const {
    doc = typeof document !== 'undefined' ? document : null,
    loc = typeof location !== 'undefined' ? location : null,
    nav = typeof navigator !== 'undefined' ? navigator : null,
    fetchImpl = typeof fetch !== 'undefined' ? fetch : null,
    bridgeStatus = null,
    forceUpstream = false
  } = options;
  if (!doc) return {};
  const set = (id, text) => { const el = doc.getElementById(id); if (el) el.textContent = text; };
  const origin = loc ? loc.origin : '';
  const info = await fetchBuildInfo(fetchImpl, origin + '/build.json');
  const pageId = pageBuildMeta(doc);
  const env = buildEnvironment(loc ? loc.hostname : '');

  set('diagAppVersion', info.ok && info.version ? info.version : '—');
  set('diagGit', info.ok && info.git ? info.git : '— (not a git checkout)');
  set('diagBuildId', pageId || (info.ok && info.id) || '—');
  set('diagBuildTime', info.ok && info.builtAt ? info.builtAt : (info.ok ? 'release ' + (info.id || '') : '—'));
  set('diagEnv', env);
  set('diagSourceRev', pageId || (info.ok && info.id) || '—');

  const swv = await serviceWorkerVersion({ nav, fetchImpl }).catch(() => null);
  set('diagSw', swv || '—');

  /* API health: GET /api/health on this origin — the local Express API behind
     the bridge, or the Worker on staging. A non-network error still proves the
     API answered; only a thrown network error counts as unreachable. */
  let api = 'unreachable';
  try {
    const r = await (fetchImpl || fetch)(origin + '/api/health', { cache: 'no-store' });
    api = r && r.status ? `HTTP ${r.status}` : 'unreachable';
  } catch { api = 'unreachable'; }
  set('diagApi', api);

  let bridge = '—';
  try {
    if (bridgeStatus) {
      const s = bridgeStatus();
      bridge = (s && s.status) || 'unknown';
    } else if (info.ok && info.mode) {
      bridge = String(info.mode);
    }
  } catch { bridge = 'unknown'; }
  set('diagBridge', bridge);

  set('diagLastUpdate', (info.ok && (info.installedAt || info.builtAt || info.id)) || pageId || '—');

  if (env === 'STAGING (Cloudflare)') {
    set('diagUpstream', 'Canonical Cloudflare staging release');
  } else {
    const up = await fetchUpstreamCheck(fetchImpl, origin + '/update-check' + (forceUpstream ? '?force=1' : ''));
    if (up.ok) {
      set('diagUpstream', up.updateAvailable
        ? `Update available: ${up.remoteId} (run UPDATE_LOCAL_APP.bat)`
        : `Up to date (${up.remoteId || pageId || 'verified'})`);
    } else {
      set('diagUpstream', 'Offline or unchecked');
    }
  }
  return { info, env, pageId };
}
