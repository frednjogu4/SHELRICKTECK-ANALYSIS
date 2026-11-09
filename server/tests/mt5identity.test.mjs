import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MT5_IDENTITY_KEY, readMt5Identity, saveMt5Identity, forgetMt5Identity } from '../../src/mt5identity.js';

function memoryStorage() {
  const data = new Map();
  return {
    getItem: (key) => data.has(key) ? data.get(key) : null,
    setItem: (key, value) => data.set(key, String(value)),
    removeItem: (key) => data.delete(key),
    raw: data,
  };
}

test('MT5 tab-session identity stores only account login and server', () => {
  const storage = memoryStorage();
  saveMt5Identity('  123456  ', ' Exness-Server ', storage);
  assert.deepEqual(readMt5Identity(storage), { login: '123456', server: 'Exness-Server' });
  const saved = JSON.parse(storage.getItem(MT5_IDENTITY_KEY));
  assert.deepEqual(Object.keys(saved).sort(), ['login', 'server']);
  assert.equal(storage.raw.size, 1);
});

test('MT5 identity can be explicitly forgotten; clearing both values removes the record', () => {
  const storage = memoryStorage();
  saveMt5Identity('123456', 'Exness-Server', storage);
  forgetMt5Identity(storage);
  assert.deepEqual(readMt5Identity(storage), { login: '', server: '' });
  saveMt5Identity('  ', '', storage);
  assert.equal(storage.getItem(MT5_IDENTITY_KEY), null);
});

test('default browser storage is sessionStorage, not persistent localStorage', () => {
  const storage = memoryStorage();
  const prior = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage');
  Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: storage });
  try {
    saveMt5Identity('123456', 'Exness-Server');
    assert.deepEqual(readMt5Identity(), { login: '123456', server: 'Exness-Server' });
    assert.equal(storage.raw.size, 1);
  } finally {
    if (prior) Object.defineProperty(globalThis, 'sessionStorage', prior);
    else delete globalThis.sessionStorage;
  }
});

test('malformed session identity fails closed to empty fields', () => {
  const storage = memoryStorage();
  storage.setItem(MT5_IDENTITY_KEY, '{bad json');
  assert.deepEqual(readMt5Identity(storage), { login: '', server: '' });
});
