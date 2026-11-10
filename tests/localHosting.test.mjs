import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { normalizeBridgeUrl } from '../src/bridge.js';

const text = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');

test('local API host is configurable and local runner pins it to loopback', () => {
  const server = text('../server/server.js');
  const runner = text('../RUN_LOCAL_API.bat');
  const main = text('../src/main.js');
  assert.match(runner, /logs\\local-api\.log/);
  assert.match(server, /process\.env\.HOST\s*\|\|\s*'0\.0\.0\.0'/);
  assert.match(server, /httpServer\.listen\(config\.port,\s*listenHost/);
  assert.match(runner, /HOST=127\.0\.0\.1/);
  assert.match(runner, /PORT=4100/);
  assert.match(main, /x-aurum-local-api-token/);
  assert.match(main, /sessionStorage\.setItem\('aurum_local_api_token'/);
  assert.doesNotMatch(main, /localStorage\.setItem\('aurum_local_api_token'/);
});

test('single local launcher runs setup with a diagnostic log and stays private', () => {
  const setup = text('../SETUP_AND_RUN_LOCAL.bat');
  const launch = text('../START_ALL_LOCAL.bat');
  const bridgeSetup = text('../bridge/SETUP_AND_RUN.bat');
  const auto = text('../bridge/AUTO_START.bat');
  assert.match(setup, /START_ALL_LOCAL\.bat/);
  assert.match(launch, /bridge\\SETUP_AND_RUN\.bat/);
  assert.match(launch, /Start-Transcript/);
  assert.match(launch, /local-startup-/);
  for (const s of [bridgeSetup, auto]) assert.match(s, /http:\/\/127\.0\.0\.1:4100/);
  assert.match(bridgeSetup, /LOCAL_HOST_ONLY\.txt[\s\S]*?Local API did not start[\s\S]*?NOT fall back to Railway/);
  assert.match(auto, /LOCAL_HOST_ONLY\.txt[\s\S]*?START_LOCAL_API\.bat[\s\S]*?if errorlevel 1 exit \/b 1/);
  assert.doesNotMatch(launch, /netsh\s+interface\s+portproxy/i);
});

test('local bridge URL corrects accidental HTTP scheme only for private/local hosts', () => {
  assert.equal(normalizeBridgeUrl('http://127.0.0.1:8787'), 'ws://127.0.0.1:8787');
  assert.equal(normalizeBridgeUrl('http://localhost:8787/'), 'ws://localhost:8787');
  assert.equal(normalizeBridgeUrl('https://192.168.1.20:8787'), 'wss://192.168.1.20:8787');
  assert.equal(normalizeBridgeUrl('http://public.example:8787'), 'http://public.example:8787');
});

test('local API port is not advertised as a LAN host and no secrets are packaged', () => {
  const setup = text('../LOCAL_HOSTING_README.md');
  const runner = text('../RUN_LOCAL_API.bat');
  assert.match(setup, /127\.0\.0\.1:4100/);
  assert.match(setup, /Do \*\*not\*\* forward ports/);
  assert.match(runner, /HOST=127\.0\.0\.1/);
  assert.doesNotMatch(setup, /service_role|sb_secret_|DERIV_API_TOKEN\s*=/i);
});
