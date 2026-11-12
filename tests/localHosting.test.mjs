import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { normalizeBridgeUrl, sameOriginBridgeWs } from '../src/bridge.js';

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
  const mt5Start = text('../bridge/START_MT5_IF_CLOSED.ps1');
  const auto = text('../bridge/AUTO_START.bat');
  const apiStart = text('../START_LOCAL_API.bat');
  assert.match(setup, /START_ALL_LOCAL\.bat/);
  assert.match(launch, /bridge\\SETUP_AND_RUN\.bat/);
  assert.match(launch, /Start-Transcript/);
  assert.match(launch, /local-startup-/);
  for (const s of [bridgeSetup, auto]) assert.match(s, /http:\/\/127\.0\.0\.1:4100/);
  assert.match(bridgeSetup, /LOCAL_HOST_ONLY\.txt[\s\S]*?Local API did not start[\s\S]*?NOT fall back to Railway/);
  assert.match(bridgeSetup, /START_MT5_IF_CLOSED\.ps1/);
  assert.match(bridgeSetup, /AURUM_MT5_PATH/);
  assert.match(bridgeSetup, /wait_for_local_bridge/);
  assert.match(bridgeSetup, /local_bridge_ready/);
  assert.ok(bridgeSetup.includes("'http://127.0.0.1:8788/ready'"));
  assert.ok(bridgeSetup.includes('start "" "http://127.0.0.1:8788/app"'));
  assert.match(bridgeSetup, /--new-tab "http:\/\/127\.0\.0\.1:8788\/app"/);
  assert.match(auto, /--new-tab "http:\/\/127\.0\.0\.1:8788\/app"/);
  assert.match(bridgeSetup, /fresh local app tab in Chrome/);
  assert.match(bridgeSetup, /browser is not force-closed/);
  assert.match(bridgeSetup, /start "Fredrick TRADING - Exness MT5 Bridge"/);
  assert.match(mt5Start, /Get-Process -Name 'terminal64', 'terminal'/);
  assert.match(mt5Start, /MT5 is already running; leaving the existing terminal untouched/);
  assert.match(mt5Start, /Start-Process -FilePath/);
  assert.doesNotMatch(mt5Start, /Stop-Process|taskkill/i, 'MT5 launcher must never terminate a running terminal');
  assert.match(auto, /LOCAL_HOST_ONLY\.txt[\s\S]*?START_LOCAL_API\.bat[\s\S]*?if errorlevel 1 exit \/b 1/);
  assert.match(apiStart, /Installing production Node dependencies\. First run needs internet/);
  assert.doesNotMatch(apiStart, /echo[^\r\n]*Installing production Node dependencies \(/);
  assert.match(auto, /START_MT5_IF_CLOSED\.ps1/);
  assert.match(auto, /-NoPrompt/);
  assert.match(mt5Start, /Read-Host 'Enter the number to start, or press Enter to skip'/);
  assert.doesNotMatch(launch, /netsh\s+interface\s+portproxy/i);
});

test('local bridge URL corrects accidental HTTP scheme only for private/local hosts', () => {
  assert.equal(normalizeBridgeUrl('http://127.0.0.1:8787'), 'ws://127.0.0.1:8787');
  assert.equal(normalizeBridgeUrl('http://localhost:8787/'), 'ws://localhost:8787');
  assert.equal(normalizeBridgeUrl('https://192.168.1.20:8787'), 'wss://192.168.1.20:8787');
  assert.equal(normalizeBridgeUrl('http://public.example:8787'), 'http://public.example:8787');
});

test('local app uses its same-origin port 8788 for bridge HTTP and WebSocket', () => {
  assert.equal(sameOriginBridgeWs('http://127.0.0.1:8788/app'), 'ws://127.0.0.1:8788');
  assert.equal(sameOriginBridgeWs('http://localhost:8788/app'), 'ws://localhost:8788');
  assert.equal(sameOriginBridgeWs('http://192.168.1.20:8788/app'), 'ws://192.168.1.20:8788');
  assert.equal(sameOriginBridgeWs('https://app.example.com/app'), '');
  assert.equal(sameOriginBridgeWs('http://public.example.com:8788/app'), '');
});

test('local bridge token auto-fill is restricted to a same-origin loopback browser session', () => {
  const app = text('../src/main.js');
  const bridge = text('../bridge/mt5_bridge.py');
  assert.match(app, /hydrateLoopbackBridgeToken/);
  assert.match(app, /fetch\('\/local-config'/);
  assert.match(app, /sessionStorage\.setItem\('aurum_local_api_token'/);
  assert.match(app, /cfg&&cfg\.exnessServer/);
  assert.match(bridge, /path == "\/local-config"/);
  assert.match(bridge, /path == "\/ready"/);
  assert.match(bridge, /peer_loopback and host in allowed_hosts/);
  assert.match(bridge, /origin == expected_origin/);
  assert.match(bridge, /"Cache-Control", "no-store"/);
});

test('local API port is not advertised as a LAN host and no secrets are packaged', () => {
  const setup = text('../LOCAL_HOSTING_README.md');
  const runner = text('../RUN_LOCAL_API.bat');
  assert.match(setup, /127\.0\.0\.1:4100/);
  assert.match(setup, /Do \*\*not\*\* forward ports/);
  assert.match(runner, /HOST=127\.0\.0\.1/);
  assert.doesNotMatch(setup, /service_role|sb_secret_|DERIV_API_TOKEN\s*=/i);
});
