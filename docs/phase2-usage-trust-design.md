# Phase 2 — trustworthy usage status: design

Scope: make a missing/failed/stale reading visibly different from a real 0%.
No dependency upgrades, no provider endpoint changes, no account-storage
migrations, no UI rewrites. Existing main/preload/provider/renderer boundaries
kept; Task 1 cancellation work untouched.

## Root causes found in current code

| # | Where | Defect |
|---|---|---|
| 1 | `src/providers.js` `clampPct()` | `Number(undefined/null/'')` → `NaN` → returns **0**. A missing percentage becomes a green 0%. |
| 2 | `src/renderer/app.js` `updateAccountCard`, `refreshWorstAccountBadge`, `checkUsageAlerts` | `row.utilization \|\| 0` — null/absent reads as 0. |
| 3 | `src/renderer/app.js` `updateWidgetFooter` | `formatResetsAt(new Date()...)` — the "Updated" clock is taken at *render* time, so a redraw or a settings change advances it and a failed refresh leaves it looking current. |
| 4 | `main.js` `fetch-usage-data` | On error either throws (renderer keeps the old card silently) or falls back to manual with `degraded: true` — a flag `manualUsageData()` ignores, so a fallback is indistinguishable from a real Manual entry. No per-account read status and no last-success time are kept. |
| 5 | `main.js` `storeUsageHistory` | `rows[0]?.utilization ?? 0` — a failed/partial read writes fabricated 0 samples. |
| 6 | `main.js` `displayRows`, `trayTooltipLines`, `src/account-logic.js` `computeWorstAccount`/`maxRowUtilization` | `\|\| 0` again: an unknown or stale account competes as a healthy 0% and can win "worst" selection or paint a green tray badge. |
| 7 | `src/renderer/app.js` `updateAccountCard` | `const rows = normalizeRows(data); rows.push(...)` — `normalizeRows` returns `data.rows` itself, so rendering **mutates the stored provider payload**. |
| 8 | `src/renderer/app.js` `checkUsageAlerts` | `pct < WARN_THRESHOLD` resets the fired flags; a null-as-0 read therefore resets alerts as though usage fell, then re-fires on recovery. |

## Model

New shared module `src/usage-status.js`, dual-mode export (`module.exports`
when required by main, `window.UsageStatus` when loaded by a `<script>` in
`index.html`) so main and renderer share one meaning instead of drifting.

```
readPercent(value) -> number | null
  null/undefined/''/whitespace/boolean/NaN/Infinity/non-numeric -> null
  genuine 0 -> 0            (clamped and rounded to 0..100)

READ_STATUS = { LOADING, AVAILABLE, UNAVAILABLE, STALE }
```

Row shape gains one additive field; `utilization` becomes `null` when unknown:

```
{ key, label, shortLabel, windowMs, utilization: number|null, available: boolean, resets_at }
```

Per-account read state, held in main (in-memory, no storage migration):

```
usageStateByAccount[id] = { status, data, lastSuccessAt, lastAttemptAt, error }
```

`lastSuccessAt` advances **only** on a successful automatic read. Manual
entries carry `source: 'manual'`; an auto-read failure that falls back to a
manual entry additionally carries `fallback: true`, and never sets
`lastSuccessAt`.

`fetch-usage-data` keeps throwing `SessionExpired` so the existing reconnect
path is unchanged; every other failure now *resolves* with a status payload
(`status: 'stale'` + the previous values + `lastSuccessAt`, or
`status: 'unavailable'`) instead of throwing. Preload is unchanged — the
status rides on the payload the renderer already receives.

## Step order (one step per hand-over)

**Step 1 — trust core.** `src/usage-status.js`; `src/providers.js` normalizers
route every percentage through `readPercent` and mark rows
`available: false`/`utilization: null` when unknown; `manualUsageData` honours
`degraded` as `fallback: true`. Partial payloads keep their valid rows.
Regressions: true 0%, missing, null, `''`, malformed string, empty response,
partial response — both providers.

**Step 2 — main-process status.** `usageStateByAccount`, stale retention with
`lastSuccessAt`, `storeUsageHistory` writes `null` gaps and never writes on a
failed/stale/fallback read, tray (`displayRows`, `trayTooltipLines`,
`generateUnknownIcon`, `STATUS_COLORS.unknown`) and
`computeWorstAccount`/`maxRowUtilization` ignore unavailable readings.
Regressions: first-fetch failure, success → timeout → recovery, history gaps,
tray/worst selection, controlled clock for `lastSuccessAt` independence
per account. Exercised through the real IPC handler with isolated storage and
mocked providers.

**Step 3 — renderer.** Card loading/available/unavailable/stale states and an
additive status chip; footer reads `lastSuccessAt` instead of `new Date()` and
says how many accounts are stale; `checkUsageAlerts` ignores unavailable and
stale rows without resetting flags; rendering copies rows instead of pushing
into the payload. Regressions with a controlled clock: redraws and settings
changes do not advance "Updated"; per-account independence; manual/fallback
labelling.

## Excluded / reported separately

Authentication-expiry policy and runtime upgrades are out of scope. Adjacent
issues found while reading the code are listed in
`docs/phase2-adjacent-issues.md`.
