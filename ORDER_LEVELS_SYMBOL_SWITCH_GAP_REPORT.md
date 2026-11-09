# Chart ticket stop/target mismatch — audit and local fix

## User-visible evidence
The screenshot shows the XAU/USD chart around 4,102 while the Stop-loss and Take-profit fields contain prices around 1.34. The note says there is no confirmed XAU/USD setup, so those fields are not current Gold levels.

## Verified source cause
- `setChartSymbol()` changed the selected instrument and reset only the `levelsForSym` marker; it did not clear the prior instrument's SL/TP1/TP2 inputs.
- `autofillLevels()` intentionally leaves inputs unchanged when the selected instrument has no confirmed BUY/SELL setup, so stale values remained visible beside the new chart.
- A delayed scan for the previous symbol could also complete after a switch and overwrite the current ticket.

## Fix completed locally
On a real symbol change (unless `keepLevels` is explicitly true for a selected Analyzer setup), the ticket now clears SL, TP1, and TP2 immediately and recalculates displayed risk. Levels only reappear when the selected symbol returns a current confirmed setup. A monotonically increasing request guard ignores late scan responses for a previous symbol. The deliberate keep-levels path for an applied Analyzer setup is preserved.

## Verification
- `npm test`: passed — 376 smoke assertions and 228 Node tests. New smoke checks cover immediate clearing, current-symbol-only levels, and delayed stale-response rejection.
- `npm run build`: passed.
- `node --check src/main.js`: passed.
- `git -c core.whitespace=cr-at-eol diff --check`: passed.
- Refreshed the 9-file local bridge ZIP and standalone app export; ZIP integrity and embedded app match were verified.

No orders or deployments were made. The Windows bridge package was not run on Windows in this session.
