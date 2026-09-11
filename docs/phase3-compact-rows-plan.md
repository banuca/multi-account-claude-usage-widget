# Phase 3 — compact, accurate usage rows: plan and record

Scope: close the two Phase 2 review gaps, then apply the approved minimal
visual design. No dependency upgrades, no provider endpoint changes, no
authentication-policy changes, no broad rewrites. Existing history is left
exactly as it is.

Baseline evidence captured before any edit (isolated storage, synthetic
credentials, mocked readers, real main + real renderer):
`before-480.png`, `before-640.png`, `before-800.png`, `before-640-short.png`.

Baseline defects the screenshots confirm:

| # | Observed | Where |
|---|---|---|
| A | A `seven_day`-only Claude response renders `session 73%` / `weekly —` in the real card, and stores `{session:73, weekly:null}` | array-position row mapping |
| B | The footer is pushed out of the window (`footerVisible: false`) once several accounts are listed at 640×560 | `#accountsContainer` scrolls but the footer is not pinned |
| C | `.col-elapsed` clips its own heading (`49px` of text in a `40px` column) at every width | fixed 6-column grid |
| D | `.row-pct` asks for Geist Mono 700; only Mono 400/500 exist, so the browser synthesises bold. Geist 500 is never used | typography |

## Step 1 — map readings by semantic key (review gap 1)

One shared selector, so main, the tray path and the renderer cannot drift:

```
src/usage-status.js
  ROW_SLOTS = { SESSION: 'session', WEEKLY: 'weekly' }
  selectRow(rows, slot) -> row | null
    - match on row.key                      (order-independent)
    - slot 'session' also accepts key 'manual'   (manual/fallback entries have
      always been reported in the session slot, and carry no window)
    - rows with no key at all keep the old positional order (defensive: an
      older payload shape)
```

Consumers changed from index to slot:

- `main.js` `historyValue(rows, slot, legacySection)` → `storeUsageHistory`
  writes `session: selectRow(rows,'session')`, `weekly: … 'weekly'`.
- `src/account-logic.js` `rowReading(data, slot, legacySection)` →
  `computeWorstAccount` reports `sessionPct` / `weeklyPct` by key.
- `src/renderer/app.js` `updateAccountCard` / `refreshAllCardTimers` fill the
  session and weekly row slots by key, hiding a slot with no row.

Spend-control is untouched: `normalizeChatGPTUsage` already emits it with
`key: 'session'`, so it lands in the session slot exactly as before.

Regressions added: weekly-only and reversed row order, both providers, through
the real IPC handler / history and through `computeWorstAccount`; manual and
spend-control keep the session slot.

## Step 2 — smoke readiness (review gap 2)

`test/electron-usage-status-smoke.js` and `test/electron-cancel-smoke.js`
replace their fixed startup sleeps (3000 ms / 2500 ms) with
`waitForRenderer(expectedCards, timeoutMs)`: poll for the `index.html` window,
`webContents` not loading, `document.readyState === 'complete'`, the expected
number of `.account-block` cards painted, and the renderer's own
`appInitializing` flag gone false — that last condition is what makes it a real
readiness check, since the flag only clears after `init()` has awaited the
first poll of every account, which is what the DOM assertions read. On timeout
the suite records a clearly-named FAIL carrying the last observed state rather
than silently skipping the renderer checks.

## Step 3 — the minimal design

Elapsed circles removed completely:
- card template: `Elapsed` heading, both `.row-ring` blocks and the reserved
  grid column;
- expanded rows: the `.mini-timer` SVG and its `.usage-elapsed-group` cell;
- `updateRing` / `elapsedFraction` / `RING_CIRCUMFERENCE` and the ring styles
  (`.row-ring`, `.ring-track`, `.ring-fill`, `.timer-bg`, `.timer-progress`,
  `.mini-timer`) removed. `updateTimer` keeps its text output and loses its
  circle argument. Unrelated loading indicators (`.spinner`, `.step-icon`) are
  untouched.

Compact account block:
- header = account name (14px/600) + quiet provider label + only the state that
  is not a clean read (manual / stale / unavailable / fallback / closest);
- one row per reading: label, thin 6px bar, percentage, compact countdown;
- reset detail consolidated — the countdown stays in the row, the exact reset
  date/time moves to the row's `title` tooltip, still formatted by the existing
  `timeFormat` / `weeklyDateFormat` settings;
- manual rows render no reset cell at all (no empty column, no placeholder);
- `12px` outer padding, `6–8px` internal gaps, `28px` rows, one hairline
  between accounts with no accumulated margins;
- footer pinned: `#accountsContainer` scrolls, `.widget-footer` does not.

Typography: bundled Geist everywhere in the card list, the footer and the
expanded rows, at the weights that exist (400/500/600 — nothing asks for
Mono 700 any more), `font-variant-numeric: tabular-nums` on every numeric
cell, no monospace label tracking, no uppercase, 13px body / 14px account name
/ 11–12px secondary. No glow, no pulse. The `@font-face` declarations are left
as they are — an unused face costs nothing and dropping one risks a synthesised
weight somewhere else.

Phase 2 meaning preserved: genuine 0, unavailable, stale, manual and fallback
stay distinct, each carrying text (not colour alone); no error is concealed and
no timestamp is advanced to tidy the layout.

## Verification

`npm test`, `node --check` on every changed JS file, both Electron smoke
suites, and the real renderer captured at 480 / 640 / 800 px plus a short
window, after `document.fonts.ready`. Results, and the two extra defects the
captures exposed (the footer pushed off-screen, and the graph panel drawing
outside itself), are recorded in `docs/phase3-verification.md`.

Decisions taken while building, for the record:

- The per-account `USED / ELAPSED / RESETS IN / RESETS AT` header row was
  removed entirely, not just its `Elapsed` cell. It repeated once per account,
  was the source of the only clipped text in the baseline, and carried exactly
  the tiny wide-spaced uppercase monospace labels the typography brief rules
  out. The rows are self-describing: label, bar, %, countdown.
- Session/weekly are mapped by key in the RENDERER too, not only in history
  and tray selection. The baseline captures show the same defect there (a
  weekly-only account printed `73%` on its session line), and one shared
  `selectRow` is what keeps the three consumers from drifting again.
- The footer was moved to be the last child of the content column so it is
  genuinely a footer, rather than sitting between the account list and the
  graph.
