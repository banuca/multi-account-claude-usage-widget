# Phase 3 — verification record

> **Corrected 2026-09-10 after architect review.** Three statements in the
> original version of this file were wrong; they are struck through and fixed
> in place below, and the reasons are listed in
> `docs/phase3-followup-verification.md`. The corrections are:
>
> 1. `test/usage-reading.test.js` runs **31** scenarios, not 33.
> 2. The claim that **both** smoke suites mock their provider readers was
>    false. The usage suite does; the cancellation suite deliberately drives
>    the real detection path and was, at the time this file was written,
>    relying on that navigation failing rather than on any interception. It
>    now installs its own test-only block and asserts it.
> 3. The delivered diff was **1639** lines, not 1590 — the figure was taken
>    before the last documentation edits.
>
> The commands and results recorded below were real at the time; the
> follow-up's own record supersedes the counts.

Everything below was run on this machine (Windows 11, Electron 28.3.3,
Node 18 bundled with Electron) from the project root. Every storage path is
isolated under `%TEMP%` and all credentials are synthetic strings.

Provider traffic, stated precisely: the **usage** suite replaces both provider
readers with in-process mocks, so no provider URL is reached. The
**cancellation** suite does *not* mock them — exercising the real
credential-detection path is the point of that suite — so it really starts a
navigation to `https://claude.ai`. At the time this file was first written
nothing intercepted that navigation; it merely failed. See the follow-up
record for the test-only block that now stops it and asserts that it stopped.

Diff baseline: the architect's pre-task snapshot at
`%TEMP%\usage-widget-phase2-review-20260910\before-next-task`, verified against
its own `sha256.json` (all 18 entries `snapshot-intact`). The snapshot also
confirms which files this task did NOT touch: `src/providers.js`,
`src/fetch-via-window.js`, `preload.js`, `package.json`,
`test/provider-cancellation.test.js`.

Reviewable diff: `%TEMP%\usage-widget-phase3-20260910\phase3.diff` — **1639**
lines.
Screenshots: `%TEMP%\usage-widget-phase3-20260910\screenshots`.

## Commands and results

| Command | Result |
|---|---|
| `node --check` on all 9 changed JS files | exit 0 each |
| `npm test` | exit 0 — account-logic, 14/14 add-account-flow, provider-cancellation, usage-reading (**31** scenarios — the original "33" was wrong), 12/12 renderer |
| `electron test/electron-usage-status-smoke.js` | **37/37 passed, exit 0** (was 22/23 + 4 architect failures, exit 1) |
| `electron test/electron-cancel-smoke.js` | **13/13 passed, exit 0** |
| Renderer captures at 480 / 640 / 800 px + 640×300 + graph open | exit 0, sizes verified per capture |
| The architect's own probe, `electron "$env:TEMP\usage-widget-phase2-review-20260910\review-electron.cjs"` | **41/41 passed, exit 0** (was 27/31, exit 1) |

The architect's probe is the decisive one for review gap 1 — it is their
code, not mine. All four of their REVIEW checks now pass:

```
REVIEW claude  weekly-only stays weekly in tray     sessionPct=null weeklyPct=73
REVIEW claude  weekly-only stays weekly in history  {session:null, weekly:73}
REVIEW chatgpt weekly-only stays weekly in tray     sessionPct=null weeklyPct=73
REVIEW chatgpt weekly-only stays weekly in history  {session:null, weekly:73}
[review-fonts] Geist 400/500/600 loaded; Geist Mono 400/500 unloaded;
               .row-pct is "Geist" weight 600  (was Geist Mono weight 700,
               a weight with no face, so the browser synthesised it)
```

Its `await sleep(3000)` substitution no longer finds a match, because that
sleep is gone; the suite's own bounded wait covers it and the probe's appended
checks run unchanged. Running the probe overwrites that folder's
`current-640.png` with a fresh capture — the architect's original baseline was
copied to `current-640.baseline.png` first.

`npm test` and both smoke suites were re-run after the line-ending
normalisation described below, so the numbers above are for the delivered
bytes.

## What the smoke suites now prove

New checks, all through the real `fetch-usage-data` IPC handler, the real
history writer and the real `computeWorstAccount`:

```
claude:  a weekly-only response is one weekly row, not a session row
claude:  a weekly-only response selects the tray badges by slot
claude:  a weekly-only response is stored as session=null, weekly=73
chatgpt: a weekly-only response is one weekly row, not a session row
chatgpt: a weekly-only response selects the tray badges by slot
chatgpt: a weekly-only response is stored as session=null, weekly=73
         reversed rows keep each reading in its own slot        (session=21, weekly=64)
         reversed rows are stored in their own slots, not by position
         a manual override keeps the session slot and claims no weekly reading
         the widget renderer becomes ready within its budget    (both suites)
```

Unit-level slot regressions in `test/usage-reading.test.js`: weekly-only
(both providers), session-only, reversed order, manual, manual fallback,
spend-control-only, an unreadable weekly row, and unkeyed rows keeping the old
positional order.

## Renderer readiness (review gap 2)

Both suites replaced their fixed startup sleeps (3000 ms and 2500 ms) with
`waitForRenderer(expectedCards, 30000)`, which polls until the `index.html`
window exists, `webContents` is not loading, `document.readyState` is
`complete`, one `.account-block` per configured account is painted, and
startup has completed. On timeout the suite records
`the widget renderer becomes ready within its budget` as a FAIL carrying the
last observed state, instead of silently skipping the renderer checks.

**Superseded:** this version read the private `appInitializing` variable and
accepted `startupComplete !== false`, so an unreadable flag counted as ready.
The follow-up added an explicit marker
(`document.documentElement.dataset.startupComplete`) and requires it to be
observed as `true`.

Waiting only for the cards to exist was tried first and was not enough: two
DOM checks failed because the first poll had not finished.

## Real-renderer evidence

Seven synthetic accounts, one per state, driven through two refresh passes so
account 3 has a good reading to go stale from. Captured after
`document.fonts.ready`.

| Account | State | Card |
|---|---|---|
| Personal | available | `44%` / `61%`, countdowns `3h 23m` / `6d 6h` |
| Work — engineering platform team (long name) | available, worst | `82%` orange / `96%` red, "Closest to limit" |
| Research | stale | `stale` chip, previous `88%` / `92%` kept |
| Manual | manual override | `manual` tag, `30%`, no reset column |
| Fallback | manual fallback | `manual` + `fallback` chips, `9%` |
| Dead session | unavailable | `unavailable` chip, `—`, no bar width |
| Weekly only | weekly-only response | session row **hidden**, weekly row `73%` — was `session 73%` before |

Measured in the live renderer:

```
rings (.row-ring/.ring-track/.ring-fill/.mini-timer)  0
"Elapsed" headings                                    0  (whole header row removed)
clipped elements inside .account-block                0  (was 7 x .col-elapsed 49>40)
document horizontal overflow                          false at 480/640/800
footer visible                                        true at 480/640/800 and at 640x300
elements still using Geist Mono in the card list,
  footer or expanded rows                             0
fonts                                                 Geist 400/500/600 loaded
.account-name    Geist w600 14px
.row-label       Geist w400 13px  rgb(184,184,184)
.row-pct         Geist w600 13px  tabular-nums
.row-reset       Geist w500 12px  rgb(143,143,143)  tabular-nums
.account-*-tag   Geist 11px  text-transform: none
.widget-footer   Geist 11px  rgb(154,154,154)
.usage-row       28px
.content         12px padding
```

Reset consolidation, read from the live DOM:

```
Personal    row titles: "Current session resets 4:25 AM (in 3h 23m)"
                        "Weekly limit resets Sep 16 (in 6d 6h)"
Weekly only row titles: session row display:none
                        "Weekly limit resets Sep 14 (in 3d 23h)"
Manual      no-resets class: true, reset cell: "" (empty, not a dash)
```

Errors are still reachable, not concealed — status-chip tooltips read back as:

```
Research      "Refresh failed — showing the last successful reading ·
               Error: Request timeout · Last successful read 1:01 AM"
Fallback      "Automatic read failed — showing your manual entry ·
               Error: Missing credentials"
Dead session  "No usable reading · Error: ReadFailed"
```

Preserved controls: all five title-bar buttons (`settingsBtn`, `refreshBtn`,
`graphBtn`, `minimizeBtn`, `closeBtn`) are real `<button>` elements, visible and
focusable; all 8 resize grips present. The graph opens from its button
(`606x165` canvas), the account list stays scrollable, the footer stays
visible, and there is no horizontal overflow.

## Two extra defects found and fixed

Neither was in the brief; both were in the way of the requirement they sit
under, so they are in the diff.

1. **The footer was off-screen.** `showMainContent()` set
   `#mainContent.style.display = 'block'`, overriding the `.content` flex
   column, so `#accountsContainer` grew to its content height and pushed the
   footer below the window (`footerVisible: false` with 7 accounts at
   640×560). Now `'flex'`, so the list is the only thing that scrolls. Three
   test assertions expected the literal `'block'` and were updated.

2. **The graph panel drew outside itself.** `.graph-section` is a fixed 220px
   box that contained an account-chip row *and* a canvas forced to
   `height: 100%`, and the chip row wrapped to four lines on a long account
   name. Opening the graph therefore painted the chart over the footer. The
   panel is now a flex column (chips on one truncating line, canvas takes the
   rest) and `graphSection.style.display` is `'flex'` rather than `'block'`.

## Line endings

The project's tracked files use LF. My patch scripts rewrote them as CRLF,
which turned the first diff into a whole-file rewrite (17006 lines). Every
file this task touched was normalised back to LF and every suite re-run; the
diff came down to 1639 lines. `src/usage-status.js` and `src/account-logic.js`
were never converted.

## Not verified / not done

- **Windows 11 only.** Nothing was run on macOS or Linux. The changes are CSS,
  markup and renderer JS with no platform branches, but the claim is untested
  there.
- **`buildExtraRows()` is unreachable from the current UI** — nothing calls it
  (the expand panel is retained for a future feature). Its de-ringed rows were
  verified by invoking the function directly in the live renderer: 4 rows
  built, 0 SVG elements, countdown `6d 6h`, an unreadable row rendering `—`
  rather than `0%`, and the extra-usage row rendering `$3.50/$10.00`. Clicking
  `#expandToggle` did not open the panel, which is pre-existing and untouched.
- ~~**Chart.js draws its own axis labels** with its own font config.~~ Closed
  by the follow-up: `chartTheme()` reads the stylesheet's own tokens and hands
  them to Chart.js, so the ticks, grid and tooltip match the widget.
- ~~**The settings overlay still uses Geist Mono** for some labels.~~ Closed
  by the follow-up: the whole app, settings and chart labels included, is now
  one self-hosted IBM Plex Mono family.
- **No "before" capture of the 640×300 short window.** `setSize` is ignored on
  this window (`resizable: false`), which was only noticed after the source had
  changed; the harness now uses `setBounds` and asserts the resulting size. The
  before/after pairs at 480 / 640 / 800 are sound.
- **No backup was taken before editing** and the project is not a git
  repository. The architect's snapshot turned out to be a complete and
  hash-verified copy of the pre-task state, so the diff is still exact, but
  that was luck rather than process.
- **Existing history was not touched.** No migration, no rewriting of old
  zeroes; `storeUsageHistory` still only appends, and the smoke suite checks
  the seeded sample `{session:12, weekly:34}` survives.
