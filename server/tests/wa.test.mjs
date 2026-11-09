import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createStore } from '../lib/store.js';
import { createApp, configFromEnv } from '../app.js';
import { translateAiError } from '../lib/decision.js';

/* WhatsApp endpoints: honest when unconfigured, masked status, validated push. */

let server, base, tmpDir;
before(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), 'aurum-wa-'));
  const store = createStore(join(tmpDir, 'store.json'));
  const config = Object.assign(configFromEnv({ ANTHROPIC_API_KEY: '', DAILY_BUDGET_USD: '5' }), { apiKey: '' });
  delete process.env.WA_PHONE_NUMBER_ID; delete process.env.WA_TOKEN; delete process.env.WA_TO;
  const app = createApp({ store, config, feed: { symbols: {}, fetchCandles: async () => { throw new Error('down'); } } });
  await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => { server && server.close(); tmpDir && rmSync(tmpDir, { recursive: true, force: true }); });

test('wa/status honest when unconfigured; nothing leaked', async () => {
  const j = await (await fetch(base + '/api/wa/status')).json();
  assert.equal(j.configured, false);
  assert.equal(j.auto, false);
  assert.ok(j.hint.includes('WA_PHONE_NUMBER_ID'));
  assert.ok(!JSON.stringify(j).includes('Bearer'));
});

test('wa/push 503 honest when unconfigured; 400 on empty text', async () => {
  const r = await fetch(base + '/api/wa/push', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: 'hello' }) });
  assert.equal(r.status, 503);
  const j = await r.json();
  assert.equal(j.error, 'wa_not_configured');
  const r2 = await fetch(base + '/api/wa/push', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: '' }) });
  assert.equal(r2.status, 400);
});

test('translateAiError: anthropic 401 becomes human guidance, no JSON blobs', () => {
  const out = translateAiError('claude', new Error('401 {"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"},"request_id":"req_x"}'));
  assert.ok(out.includes('console.anthropic.com'));
  assert.ok(out.includes('sk-ant-'));
  assert.ok(!out.includes('request_id'));
  assert.ok(translateAiError('chatgpt', new Error('openai 401')).includes('platform.openai.com'));
  assert.ok(translateAiError('perplexity', new Error('429')).toLowerCase().includes('rate'));
});
