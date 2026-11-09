import test from 'node:test';
import assert from 'node:assert/strict';
import { dedupeBody } from '../lib/limits.js';

const mk = (body) => ({ req: { body }, res: { statusCode: 0, payload: null, status(c) { this.statusCode = c; return this; }, json(o) { this.payload = o; return this; } } });

test('dedupeBody: no once key -> passes straight through (repeat orders never blocked)', () => {
  const mw = dedupeBody({ windowMs: 60000 });
  let called = 0;
  for (let i = 0; i < 5; i++) {
    const { req, res } = mk({ amount: 5, symbol: 'R_100' });
    mw(req, res, () => called++);
    assert.equal(res.statusCode, 0);
  }
  assert.equal(called, 5);
});

test('dedupeBody: SAME once key twice -> 409 duplicate_request; different key passes', () => {
  const mw = dedupeBody({ windowMs: 60000, name: 'test' });
  let called = 0;
  const a = mk({ amount: 5, once: 'intent-1' });
  mw(a.req, a.res, () => called++);
  assert.equal(called, 1); assert.equal(a.res.statusCode, 0);
  const b = mk({ amount: 5, once: 'intent-1' });
  mw(b.req, b.res, () => called++);
  assert.equal(called, 1, 'next() must NOT run for a replayed intent');
  assert.equal(b.res.statusCode, 409);
  assert.equal(b.res.payload.error, 'duplicate_request');
  const c = mk({ amount: 5, once: 'intent-2' });
  mw(c.req, c.res, () => called++);
  assert.equal(called, 2); assert.equal(c.res.statusCode, 0);
});
