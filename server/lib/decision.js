/* ================================================================
 * AURUM — multi-AI decision layer (Claude + ChatGPT + Perplexity)
 *
 * Keys arrive from Settings (x-ai-* headers) or server env. Engines
 * without keys are skipped; if NO engine has a key, the technical
 * engine still runs on REAL Deriv candles (labelled 'technical', not
 * AI). Cost gate applies to all paid calls together (daily budget).
 *
 * Perplexity's role: news/event context injected into every prompt
 * ("what is expected on this news") when a news brief is supplied.
 * ================================================================ */

import { formatAnalysis } from './analyzer.js';
import { localDecision } from './localdecision.js';

const PRICING = { // approx USD per 1M tokens, for budget accounting
  opus: { in: 15, out: 75 }, sonnet: { in: 3, out: 15 }, haiku: { in: 0.8, out: 4 },
  openai: { in: 2.5, out: 10 },          // gpt-4o-class default
  perplexity: { in: 1, out: 1 }          // sonar-class, ~$1/M + request fee
};
function tierOf(model = '') {
  if (/haiku/i.test(model)) return 'haiku';
  if (/sonnet/i.test(model)) return 'sonnet';
  if (/opus/i.test(model)) return 'opus';
  if (/gpt-4o-mini|gpt-4\.1-mini|mini/i.test(model)) return { in: 0.15, out: 0.6 };
  if (/gpt/i.test(model)) return 'openai';
  if (/sonar/i.test(model)) return 'perplexity';
  return 'opus';
}
const priceOf = (model) => { const t = tierOf(model); return typeof t === 'string' ? PRICING[t] : t; };

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** Which engines are usable given request+env keys. */
export function availableEngines(config, reqKeys = {}) {
  const out = [];
  const claudeKey = config.apiKey || reqKeys.claude || '';
  const openaiKey = config.openaiKey || reqKeys.openai || '';
  const perpKey = config.perplexityKey || reqKeys.perplexity || '';
  if (claudeKey) out.push('claude');
  if (openaiKey) out.push('chatgpt');
  return { engines: out, perpKey, claudeKey, openaiKey };
}

export function sanitizeDecision(raw, det, sentiment) {
  const base = localDecision(det);
  if (!raw || typeof raw !== 'object') return base;
  const d = Object.assign({}, base);
  if (['BUY', 'SELL', 'WAIT'].includes(raw.signal)) d.signal = raw.signal;
  const conf = num(raw.confidence);
  if (conf !== null) d.confidence = Math.round(clamp(conf, 0, 100));
  const tp = (v, fb) => { const n = num(v); return n !== null && n > 0 ? n : fb; };
  d.entry = tp(raw.entry, base.entry);
  d.stop_loss = tp(raw.stop_loss, base.stop_loss);
  d.tp1 = tp(raw.tp1, base.tp1);
  d.tp2 = tp(raw.tp2, base.tp2);
  const risk = Math.abs(d.entry - d.stop_loss);
  d.rrr = risk > 0 ? Math.round((Math.abs(d.tp1 - d.entry) / risk) * 100) / 100 : null;
  if (typeof raw.rationale === 'string' && raw.rationale.trim()) d.rationale = raw.rationale.trim().slice(0, 600);
  if (typeof raw.technical_summary === 'string' && raw.technical_summary.trim()) d.technical_summary = raw.technical_summary.trim().slice(0, 800);
  if (typeof raw.next_watch === 'string' && raw.next_watch.trim()) d.next_watch = raw.next_watch.trim().slice(0, 400);
  if (Array.isArray(raw.risks)) {
    const risks = raw.risks.filter((r) => typeof r === 'string' && r.trim()).map((r) => r.trim().slice(0, 240)).slice(0, 5);
    if (risks.length) d.risks = risks;
  }
  return d;
}

function taskJson() {
  return `RESPOND WITH VALID JSON ONLY — no markdown:
{"signal":"BUY|SELL|WAIT","confidence":<0-100>,"entry":<n>,"stop_loss":<n>,"tp1":<n>,"tp2":<n>,"rationale":"<2-3 sentences>","technical_summary":"<one line>","key_levels":{"support":[<n>],"resistance":[<n>]},"risks":["...","...","..."],"next_watch":"<condition>"}`;
}

function buildPrompt(det, symbol, sentiment, newsBrief) {
  return `You are a professional trading analyst working on LIVE market data. Analyze the multi-timeframe setup and return a trading decision.

SYMBOL: ${symbol}

1M:
${formatAnalysis(det.analyses.m1)}
5M:
${formatAnalysis(det.analyses.m5)}
1H:
${formatAnalysis(det.analyses.h1)}

MTF CONFIRMATION: ${det.mtfSignal}
SENTIMENT: ${sentiment.score}/100 (${sentiment.bias})
${newsBrief ? 'NEWS / EXPECTED OUTCOMES:\n' + newsBrief + '\n' : ''}
Rules: entry/stop start from the ATR-derived levels given; two take-profits, minimum 1:1.5 R:R; confidence 0-100; top 3 risks; one next-watch condition.
${taskJson()}`;
}

/* ---------- paid engine callers ---------- */
async function callClaude(prompt, key, model, timeoutMs) {
  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  const client = new Anthropic({ apiKey: key, timeout: timeoutMs });
  const msg = await client.messages.create({
    model, max_tokens: 800,
    messages: [{ role: 'user', content: prompt }]
  });
  const text = (msg.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n');
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) throw new Error('claude: no JSON');
  const u = msg.usage || {};
  return { name: 'claude', raw: JSON.parse(m[0]), tokens_in: u.input_tokens || 0, tokens_out: u.output_tokens || 0, model };
}

async function callChatGPT(prompt, key, model, timeoutMs) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      signal: ctrl.signal,
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + key },
      body: JSON.stringify({
        model, temperature: 0.2,
        messages: [{ role: 'system', content: 'You are a precise trading analyst. Output valid JSON only.' },
          { role: 'user', content: prompt }],
        response_format: { type: 'json_object' }
      })
    });
    if (!res.ok) throw new Error('openai ' + res.status + ' ' + (await res.text()).slice(0, 120));
    const data = await res.json();
    const raw = JSON.parse(data.choices[0].message.content);
    const u = data.usage || {};
    return { name: 'chatgpt', raw, tokens_in: u.prompt_tokens || 0, tokens_out: u.completion_tokens || 0, model };
  } finally { clearTimeout(t); }
}

/** Perplexity: news + expected outcomes brief (not a signal engine). */
export async function newsBriefViaPerplexity(symbol, perpKey, model = 'sonar', timeoutMs = 20000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch('https://api.perplexity.ai/chat/completions', {
      method: 'POST',
      signal: ctrl.signal,
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + perpKey },
      body: JSON.stringify({
        model,
        messages: [{ role: 'system', content: 'You summarize market-moving news for traders: current drivers, what upcoming events are expected to do, and risk warnings. Max 120 words, plain text.' },
          { role: 'user', content: 'Latest news, expected event outcomes and outlook for ' + symbol + ' right now.' }]
      })
    });
    if (!res.ok) throw new Error('perplexity ' + res.status);
    const data = await res.json();
    const text = data.choices?.[0]?.message?.content || '';
    const u = data.usage || {};
    return { text, tokens_in: u.prompt_tokens || 0, tokens_out: u.completion_tokens || 0, model };
  } finally { clearTimeout(t); }
}

/** Claude text brief (Anthropic messages API — text mode, not the JSON signal call). */
export async function newsBriefViaClaude(symbol, claudeKey, model = 'claude-opus-4-1', timeoutMs = 20000) {
  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  const client = new Anthropic({ apiKey: claudeKey, timeout: timeoutMs });
  const msg = await client.messages.create({
    model, max_tokens: 400,
    system: 'You summarize market-moving news for traders: current drivers, what upcoming events are expected to do, which markets are affected, and risk warnings. Max 120 words, plain text.',
    messages: [{ role: 'user', content: 'Latest news, expected event outcomes and outlook for ' + symbol + ' right now.' }]
  });
  const text = (msg.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
  if (!text) throw new Error('claude: empty brief');
  const u = msg.usage || {};
  return { text, tokens_in: u.input_tokens || 0, tokens_out: u.output_tokens || 0, model, engine: 'claude' };
}

/** ChatGPT text brief (OpenAI chat completions). */
export async function newsBriefViaChatGPT(symbol, openaiKey, model = 'gpt-4o-mini', timeoutMs = 20000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      signal: ctrl.signal,
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + openaiKey },
      body: JSON.stringify({
        model, temperature: 0.3, max_tokens: 400,
        messages: [{ role: 'system', content: 'You summarize market-moving news for traders: current drivers, what upcoming events are expected to do, which markets are affected, and risk warnings. Max 120 words, plain text.' },
          { role: 'user', content: 'Latest news, expected event outcomes and outlook for ' + symbol + ' right now.' }]
      })
    });
    if (!res.ok) throw new Error('openai ' + res.status);
    const data = await res.json();
    const text = (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content || '').trim();
    if (!text) throw new Error('openai: empty brief');
    const u = data.usage || {};
    return { text, tokens_in: u.prompt_tokens || 0, tokens_out: u.completion_tokens || 0, model, engine: 'chatgpt' };
  } finally { clearTimeout(t); }
}

/** Translate raw provider errors into plain language (never leak JSON blobs). */
export function translateAiError(engine, err) {
  const m = String((err && err.message) || err);
  if (/authentication_error|invalid x-api-key|401|invalid api key|incorrect api key/i.test(m)) {
    return engine === 'claude'
      ? 'Claude key rejected (invalid or revoked). Re-copy it from console.anthropic.com - it starts with sk-ant- and must be the API key, with no spaces.'
      : engine === 'chatgpt'
        ? 'ChatGPT key rejected (invalid or revoked). Re-copy it from platform.openai.com - it starts with sk-.'
        : 'Perplexity key rejected (invalid or revoked). Re-copy it from perplexity.ai settings.';
  }
  if (/429|rate/i.test(m)) return engine + ' is rate-limiting this key - try again shortly.';
  if (/timeout|abort|ETIMEDOUT/i.test(m)) return engine + ' took too long to answer.';
  if (/empty brief|no JSON/i.test(m)) return engine + ' returned an unusable response.';
  return engine + ' failed (' + m.slice(0, 80) + ').';
}

/** Pick an engine explicitly, or auto. TRUE FAILOVER: if an engine's key fails
    (e.g. invalid 401), the next available engine is tried before giving up. */
export async function newsBriefAny(symbol, keys, timeoutMs = 20000) {
  const senders = {
    perplexity: () => newsBriefViaPerplexity(symbol, keys.perplexity, keys.perplexityModel || 'sonar', timeoutMs).then((r) => Object.assign(r, { engine: 'perplexity' })),
    claude: () => newsBriefViaClaude(symbol, keys.claude, keys.claudeModel || 'claude-opus-4-1', timeoutMs).then((r) => Object.assign(r, { engine: 'claude' })),
    chatgpt: () => newsBriefViaChatGPT(symbol, keys.openai, keys.openaiModel || 'gpt-4o-mini', timeoutMs).then((r) => Object.assign(r, { engine: 'chatgpt' }))
  };
  let order = ['perplexity', 'claude', 'chatgpt'];
  if (keys.engine && keys.engine !== 'auto') order = [keys.engine];
  const available = order.filter((eng) => (eng === 'perplexity' && keys.perplexity) || (eng === 'claude' && keys.claude) || (eng === 'chatgpt' && keys.openai));
  if (!available.length) throw new Error('no_ai_key');
  const errors = [];
  for (const eng of available) {
    try { return await senders[eng](); }
    catch (e) { errors.push(translateAiError(eng, e)); }
  }
  const e = new Error(errors.join(' | '));
  e.friendly = true;
  throw e;
}

/* ---------- merge ---------- */
function mergeEngineResults(results, det) {
  const decs = results.map((r) => sanitizeDecision(r.raw, det, { score: 50 }));
  if (decs.length === 1) {
    return Object.assign({}, decs[0], { model: results[0].name + ':' + results[0].model, engines: results.map((r) => r.name) });
  }
  /* majority signal, mean confidence, prices from the higher-confidence engine */
  const votes = { BUY: 0, SELL: 0, WAIT: 0 };
  decs.forEach((d) => votes[d.signal]++);
  const signal = Object.entries(votes).sort((a, b) => b[1] - a[1])[0][0];
  const conf = Math.round(decs.reduce((s, d) => s + d.confidence, 0) / decs.length);
  const lead = decs.slice().sort((a, b) => b.confidence - a.confidence)[0];
  return Object.assign({}, lead, {
    signal, confidence: conf,
    model: results.map((r) => r.name).join('+'),
    engines: results.map((r) => r.name),
    rationale: decs.map((d, i) => '[' + results[i].name + '] ' + d.rationale).join(' — '),
    disagreement: votes[signal] < decs.length
  });
}

/**
 * Main entry. opts.reqKeys: {claude, openai, perplexity} from client vault.
 * opts.newsBrief: pre-fetched Perplexity brief (optional).
 */
export async function makeDecision({ det, symbol, sentiment, config, store, user, reqKeys = {}, newsBrief = '' }) {
  const cap = config.dailyBudgetUsd;
  /* Budget is DEVICE-WIDE: one ledger under 'local' no matter which
     session name (Live/Deriv/Exness) is active — switching modes must not
     reset the $5/day cap. The session name rides along as provenance. */
  const stats = store.statsToday('local');
  const { engines, claudeKey, openaiKey } = availableEngines(config, reqKeys);

  if (stats.cost >= cap) {
    return { decision: localDecision(det), meta: { mode: 'technical', reason: 'budget_exceeded', spent: stats.cost, cap, engines: [] } };
  }

  const results = [];
  const failures = [];
  const spendBefore = stats.cost;

  const run = async (name, fn, model) => {
    try {
      const r = await fn();
      const p = priceOf(r.model || model);
      const cost = (r.tokens_in / 1e6) * p.in + (r.tokens_out / 1e6) * p.out;
      store.recordUsage({ user: 'local', session: user, model: r.model || model, tokens_in: r.tokens_in, tokens_out: r.tokens_out, cost, endpoint: '/api/signals/analyze', engine: name });
      results.push(r);
      return cost;
    } catch (e) {
      failures.push(name + ':' + String(e.message || e).slice(0, 100));
      store.recordUsage({ user: 'local', session: user, model: model || name, tokens_in: 0, tokens_out: 0, cost: 0, endpoint: '/api/signals/analyze', engine: name, error: String(e.message || e).slice(0, 200) });
      return 0;
    }
  };

  const prompt = buildPrompt(det, symbol, sentiment, newsBrief);
  let spentNow = 0;
  if (engines.includes('claude')) spentNow += await run('claude', () => callClaude(prompt, claudeKey, config.model, config.timeoutMs), config.model);
  if (engines.includes('chatgpt') && spendBefore + spentNow < cap) {
    spentNow += await run('chatgpt', () => callChatGPT(prompt, openaiKey, config.openaiModel, config.timeoutMs), config.openaiModel);
  }

  const spent = Math.round((spendBefore + spentNow) * 10000) / 10000;

  if (!results.length) {
    const reason = engines.length === 0 ? 'no_keys' : 'engine_error';
    return { decision: localDecision(det), meta: { mode: 'technical', reason, spent, cap, engines: [], failures } };
  }
  const decision = mergeEngineResults(results, det);
  decision.sentiment_score = sentiment.score;
  return {
    decision,
    meta: { mode: 'ai', engines: results.map((r) => r.name), spent, cap, failures, duration_ms: undefined }
  };
}
