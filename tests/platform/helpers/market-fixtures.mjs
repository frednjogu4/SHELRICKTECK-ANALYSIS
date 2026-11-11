/*
 * Shared fixtures for the data-loading tests.
 *
 * Everything here is a TEST FIXTURE, not market data: prices are generated
 * from a fixed formula so that the analysis code has well-formed candles to
 * work on. No test asserts a particular signal, direction or level; the tests
 * check where data came from, how it is labelled and which state it is in.
 */
import { INSTRUMENTS } from '../../../server/lib/symbols.js';

/** The instruments the "No data" report was about: every built-in market with a Deriv public feed. */
export const DERIV_INSTRUMENTS = INSTRUMENTS.filter((instrument) => instrument.deriv);
/** The index CFDs: no Deriv feed, read from Yahoo daily data by the AURUM cloud. */
export const INDEX_INSTRUMENTS = INSTRUMENTS.filter((instrument) => !instrument.deriv);

export const nowSec = () => Math.floor(Date.now() / 1000);

/**
 * Candle rows in the shape Deriv sends them ({ epoch, open, high, low, close }).
 * `end` is the moment the newest candle belongs to; `base` moves the price
 * level so that two markets never share a series.
 */
export function derivCandleRows({ count = 120, granularity = 60, end = nowSec(), base = 100 } = {}) {
  const newest = Math.floor(end / granularity) * granularity;
  const rows = [];
  for (let i = 0; i < count; i++) {
    const mid = base * (1 + 0.0004 * i + 0.002 * Math.sin(i / 7));
    const open = mid * 0.9998;
    const close = mid * 1.0002;
    rows.push({
      epoch: newest - (count - 1 - i) * granularity,
      open: Number(open.toFixed(6)),
      high: Number((close * 1.0004).toFixed(6)),
      low: Number((open * 0.9996).toFixed(6)),
      close: Number(close.toFixed(6))
    });
  }
  return rows;
}

/** A price level per Deriv market code, so every instrument gets its own series. */
export function basePriceFor(code) {
  const index = DERIV_INSTRUMENTS.findIndex((instrument) => instrument.deriv === code);
  return 50 + (index < 0 ? 0 : index) * 13;
}

/** Yahoo chart JSON with 80 daily bars, as the Worker's index reader expects it. */
export function yahooChartFixture() {
  const timestamp = [], open = [], high = [], low = [], close = [];
  const now = nowSec();
  for (let i = 0; i < 80; i++) {
    const c = 4000 + i * 2;
    timestamp.push(now - (79 - i) * 86400);
    open.push(c - 1); high.push(c + 3); low.push(c - 2); close.push(c);
  }
  return { chart: { result: [{ timestamp, indicators: { quote: [{ open, high, low, close, volume: close.map(() => 1000) }] } }] } };
}

/**
 * A stand-in for the browser's WebSocket class.
 *
 * Every instance is recorded in `sockets`. By default a socket opens on the
 * next microtask; `onRequest(socket, message)` is called for each JSON
 * message the page sends, and answers with `socket.reply(payload)`.
 *   autoOpen: false  -> the socket stays in CONNECTING until `socket.open()`
 *   failOnConnect    -> the socket reports an error instead of opening
 */
export function fakeSocketClass({ onRequest = null, autoOpen = true, failOnConnect = false } = {}) {
  const sockets = [];
  class FakeSocket {
    constructor(url) {
      this.url = String(url);
      this.readyState = 0;
      this.sent = [];
      this.closedByPage = false;
      sockets.push(this);
      if (failOnConnect) queueMicrotask(() => this.fail());
      else if (autoOpen) queueMicrotask(() => this.open());
    }
    open() {
      if (this.readyState !== 0) return;
      this.readyState = 1;
      if (this.onopen) this.onopen({});
    }
    send(raw) {
      const message = JSON.parse(raw);
      this.sent.push(message);
      if (onRequest) onRequest(this, message);
    }
    close() { this.closedByPage = true; this.readyState = 3; }
    /** The server answers. */
    reply(payload) { if (this.onmessage) this.onmessage({ data: typeof payload === 'string' ? payload : JSON.stringify(payload) }); }
    /** The connection fails (error event). */
    fail() { this.readyState = 3; if (this.onerror) this.onerror({}); }
    /** The server closes the connection. */
    drop(code = 1006) { this.readyState = 3; if (this.onclose) this.onclose({ code }); }
  }
  return { FakeSocket, sockets };
}
