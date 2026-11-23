# MT5 sizing / exposure discrepancy — root-cause report

**Product:** Shelricktech Market Command Centre · **Date:** 23 November 2026
**Scope:** read-only diagnostic + simulated (paper) sizing repair. No execution flag, order path,
close path, or risk limit was enabled, weakened, or invoked. Nothing was merged or deployed.

---

## 1. Root cause (what actually happened)

The report mixed four numbers. Each was traced to its exact source:

| Reported | Source | Verdict |
|---|---|---|
| Min exposure ≈ **$3,684.79** | `planPosition` → `minNotional = volumeMin × contractSize × entry`, `entry` = **live ask 3,684.79** (BUY basis) | **Correct.** The $0.76 gap vs the observed ~3,684.03 is ask-vs-bid/quote timing, not a formula error. The panel now shows the exact price basis and its timestamp. |
| Min stop risk **$31.50** | `minRiskAtMinLot = volumeMin × |entry − SL| × contractSize` = 0.01 × 31.50 × 100 | **Correct** for the $31.50 stop distance used. |
| Exposure cap **$716.70** | bridge `_mt5_order_plan`: `notional_cap = max(amount × 1.5, equity × 10)` = 71.67 × 10 | **Correct value.** Until PR #48 this cap also refused the broker-minimum floor — that was the reported *"broker minimum exceeds the allowed exposure"* refusal. PR #48 (already on main) exempts the floor; the panel now shows the cap **with** the exemption. |
| Risk budget **$0.36** | `equity × 0.5 %` = 71.67 × 0.005 (bridge `MT5_MAX_RISK_PCT = 0.5`) | **Correct — and binding.** $31.50 min-lot risk ≫ $0.36 (≈ $0.29 after the bridge's ×1.25 buffer). The BLOCK is the risk guard doing its job; controls were **not** relaxed. |

**Primary root causes of the *confusion* (all fixed on this branch):**

1. **UI eligibility ≠ bridge eligibility.** The sizer sized against the raw 0.5 % budget while the
   bridge enforces `stop loss × 1.25 ≤ 0.5 % equity` — the panel could say OK for a size the bridge
   would refuse, and its blocked message did not mention the buffer or the exposure cap's floor
   exemption.
2. **Stale-quote coercion defect.** `Number(null) === 0`: a missing/`null` entry or stop was treated
   as price `0`, mislabelling an UNKNOWN (stale quote) as *"Invalid stop"* instead of INCOMPLETE.
3. **Cross-currency unit mixing.** The blocked message printed account-currency values with
   order-currency symbols; `riskBudgetAccount` duplicated `riskBudget`; the conversion-rate label
   ("KES→USD rate") contradicted its own placeholder (129 = KES per 1 USD).
4. **Round-up epsilon.** `roundToStep` used `floor(x + 1e-9)`, which could size a hair **above** the
   permitted risk at a step boundary.
5. **Missing broker metadata / provenance.** The quote reply carried no tick size/value, point,
   stop level, instrument class, or source/timestamp — the panel could not show *where* specs came
   from or their age, and nothing marked UNKNOWN.

Instrument: **XAUUSD — commodity CFD (gold)**, Exness, `trade_contract_size = 100`, `volume_min =
0.01`, `volume_max = 200`, `volume_step = 0.01`, profit currency USD, account USD, leverage 1:400.
Bridge and UI agree: no leverage-based minimum-exposure inference exists anywhere (grep-verified).

## 2. Corrected formulas (now implemented and unit-tested)

Order currency (OC) = instrument profit currency (USD here). Account currency (AC) = equity currency.
`conversionRate` = **AC units per 1 OC unit** (e.g. 129 KES per 1 USD) — user-supplied, never assumed.

```
riskBudgetAccount = equity × risk% / 100                     (AC)
riskBudget        = riskBudgetAccount / conversionRate       (OC)
riskBudgetBuffered= riskBudget / riskBuffer                  (OC; riskBuffer = 1.25 on the Exness bridge)
lossPerLot        = |entry − SL| × contractSize              (OC)
lotsRaw           = riskBudgetBuffered / lossPerLot          (normalised to 12 significant digits)
lots              = floor_to_step(lotsRaw), clamped to [volumeMin, volumeMax]
                    invariant: lots × lossPerLot ≤ riskBudgetBuffered  (strict floor — never rounds up)
minNotional       = volumeMin × contractSize × entry         (OC)
minRiskAtMinLot   = volumeMin × lossPerLot                   (OC, raw)
marginEstimate    = (lots × contractSize × entry / conversionRate) / leverage   (AC)
notional-cap      = max(amount × 1.5, equity × 10)           (bridge; broker MINIMUM LOT EXEMPT)
bridge risk guard = broker order_calc_profit × 1.25 ≤ equity × 0.5 %            (unchanged)
```

- Broker `order_calc_profit` / `order_calc_margin` remain authoritative in the bridge preview/send
  revalidation; the UI numbers are labelled estimates.
- Missing inputs → `INCOMPLETE` (reason lists each missing field); stale/absent quote →
  **UNKNOWN — simulated eligibility blocked**; nothing is substituted or cached-in.
- If the smallest permitted contract exceeds the permitted risk/exposure → `BLOCKED` with the exact
  min-lot risk, notional, budget, buffered allowance and the fix options (verified by tests).

## 3. Files changed

| File | Change |
|---|---|
| `src/sizer.js` | Unit-explicit budget chain (AC → OC → buffered), bridge-buffer parity input `riskBuffer`, strict round-down + float normalisation, floor-exempt `maxNotional` check, null-price → INCOMPLETE, corrected conversion-rate semantics, buffer-aware blocked message. |
| `src/main.js` | Transparent risk panel: account type (DEMO/REAL verified), instrument + broker class, **specification source + tick timestamp + age**, contract/volume specs, minimum volume + notional, tick/stop specs, live entry basis, exposure limit (floor exempt), budget **and** buffered budget, estimated margin (incl. at minimum size), UNKNOWN state for missing/stale specs; `riskBuffer:1.25` + `max(amount×1.5, 10× equity)` parity inputs; responsive wrap rows. |
| `bridge/mt5_bridge.py` | `handle_quote` now returns `point, tick_size, tick_value, trade_stops_level, currency_margin, volume_limit, path, description, category, spec_source, spec_at`. (Order/preview/close/risk logic untouched.) |
| `tests/sizingMatrix.test.mjs` *(new)* | 18 hand-calculated cases: gold/forex/silver/oil/index/crypto, contract sizes 1…100 000, USD/EUR accounts, leverage 5…400, min-volume and step boundaries, vmax clamp, floor exemption, missing metadata, stop-distance sweeps, float-grid "never exceeds budget" property, fixed-risk venue. |
| `server/tests/sizer.test.mjs` | Cross-currency example corrected to the documented convention (129 KES per 1 USD, budget asserted in both currencies). |
| `tests/smoke.mjs` | Round **20v**: sizer/bridge parity inputs, panel rows, quote metadata, floor-exemption + risk-guard strings. |
| `tests/test_mt5_bridge_readonly.py` | Quote test asserts the full spec block incl. `spec_source`/`spec_at`/`category`. |
| `scripts/screenshot-size-plan.mjs` *(new)* | Screenshot harness (in-transit instrumentation only; never modifies source files). |
| `docs/screenshots/size-plan-{desktop,mobile}.png`, `size-plan-panel.txt` | Deliverable captures + extracted panel text. |
| `SIZING_EXPOSURE_DIAGNOSTIC.md` | This report. |
| `dist/*`, `bridge/app.html`, both update ZIPs | Rebuilt/refreshed (`npm run build`, `refresh --refresh` → `--check` in sync). |

## 4. Test results (all executed on this branch)

| Suite | Result |
|---|---|
| `node --test tests/sizingMatrix.test.mjs` | **18 / 18 pass** |
| `node --test server/tests/sizer.test.mjs` (+ matrix) | **27 / 27 pass** |
| `npm test` (smoke **395 checks ALL GOOD** + node suites) | **910 tests, 0 fail, 1 skipped** |
| `python3 -m unittest discover -s tests -p 'test_*.py'` | **72 / 72 pass** (incl. REAL/DEMO mocked fills, quote-metadata test) |
| `npm run test:worker` | **14 / 14 pass** |
| `npx wrangler deploy --dry-run` | **OK** |
| `scripts/refresh_local_update_packages.py --check` | **both archives in sync** |

## 5. Screenshots

| View | File |
|---|---|
| Desktop (1440 px viewport, panel column) | `docs/screenshots/size-plan-desktop.png` |
| Mobile (390 × 844 @2×) | `docs/screenshots/size-plan-mobile.png` |
| Extracted panel text (accessibility/verification) | `docs/screenshots/size-plan-panel.txt` |

Both captures show the reported case end-to-end: equity 71.67 USD · 1:400 · DEMO badge ·
Gold spot/Exness MT5/Metal CFD · spec source + tick time · 100 contract · 0.01–200 lots ·
min volume 0.01 lots ≈ $3,684.79 · tick specs · live ask 3,684.79 · exposure limit $716.70
(floor exempt) · BLOCKED with $31.50 vs $0.36/$0.29 budgets · margin at min size ≈ $9.21.

*Capture method:* the harness runs the real app in headless Chromium (Vite dev, source-level),
enters through the real Guest flow, and injects a broker snapshot — no live terminal exists in
this sandbox, so the broker snapshot is simulated and labelled as such.

## 6. Remaining limitations

1. **No live-terminal verification.** Bridge preview/send math is covered by mocked-MT5 tests
   only (REAL fill included as a mock); the numbers above were not validated against a live Exness
   terminal in this environment.
2. **Cross-currency notional cap (bridge).** `exposure` (profit currency) is compared to
   `equity × 10` (account currency) without conversion — no FX rate is available and one is never
   invented. Risk and margin guards use broker calculations in account currency and remain correct;
   the cap is intent-only. Documented, not changed.
3. **UI margin is an estimate** (`notional ÷ leverage`); the broker's `order_calc_margin` in the
   preview is authoritative.
4. **Screenshots use an injected snapshot** (no MT5 in the sandbox); the harness is reproducible
   via `scripts/screenshot-size-plan.mjs`.
5. The 0.5 % per-order risk cap (≈ $0.36 on $71.67) still makes normal gold/forex stops
   impossible on this account size — that is the reviewed control operating as designed; the panel
   now states the exact budget, buffered allowance and remedies.

## 7. Scope / change control

- Branch: `arena/a3c9e72d-shelrickteck-analysis` — **PR opened, not merged, not deployed.**
- No change to: execution flags, order/close handlers, guard thresholds (0.5 %, 1.25 buffer,
  1.2 R:R, 80 % margin, 2 % daily), Sniper block, or any credential handling.
- `package.json` / lockfile unchanged; screenshot tooling installed with `--no-save`.
