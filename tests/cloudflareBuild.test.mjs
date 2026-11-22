import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');

test('Cloudflare PR preview uses the built dist assets and explicitly selects the Worker config', () => {
  const pkg = JSON.parse(read('../package.json'));
  const config = read('../wrangler.jsonc');
  const docs = read('../README.md');
  assert.equal(pkg.scripts['cf:preview'], 'npm run build && wrangler preview --config ./wrangler.jsonc');
  assert.match(config, /"directory":\s*"\.\/dist"/);
  assert.match(docs, /Root directory.*repository root/s);
  assert.match(docs, /Preview command.*npm run cf:preview/s);
});
