/* ================================================================
 * One reading per finished 5-minute candle.
 *
 * The code is in server/lib/closedcandles.js, beside the analysis it feeds
 * (analyzer.js, localdecision.js). The page, the read-only Worker and the PC's
 * own server all read a market through it, and the PC's server folder has to
 * be complete on its own: nothing under server/ may need a file from src/
 * (tests/platform/pc-package.test.mjs).
 *
 * This file keeps the name the page and the Worker import it by.
 * ================================================================ */
export * from '../server/lib/closedcandles.js';
