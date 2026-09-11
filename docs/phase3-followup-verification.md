# Phase 3 follow-up — short-window graph + visual refinement

Two things, in this order: the confirmed completion blocker (the graph hiding
the account list and footer in a short window), then the approved visual
direction (warm charcoal surfaces, self-hosted IBM Plex Mono, flat controls).

Windows 11, Electron 28.3.3, run from the project root. Isolated storage under
`%TEMP%`, synthetic credentials throughout.

## Backup, taken and verified before any edit

`%TEMP%\usage-widget-phase3-followup-20260910\backup-pre-edit` — 36 entries
(every source, test and doc file this task touches, plus the pre-existing
`assets/fonts` contents) with `sha256.json`. Re-verified against both the copy
and the live file: **36/36, 0 mismatches**. The script refuses to run if the
directory already exists, so nothing earlier can be overwritten.

The architect's snapshots were confirmed untouched at the same time:
`before-next-task` 18/18 intact, `before-followup` 20/20 intact. Their review
harness overwrites its own `graph-640x*.png` and `layouts.json` when re-run, so
copies of the originals were preserved first in
`%TEMP%\usage-widget-phase3-followup-20260910\architect-baseline`.

## 1. Reproduced first

`electron "$env:TEMP\usage-widget-phase3-review-20260910\review.cjs"` on the
unchanged source: **45/51, exit 1**, with exactly the six failures the review
describes — account viewport `0` and footer bottom `318.8` in a 300px, 240px
and 151px viewport.

## 2. The fix

`.graph-section` reserved 220px and refused to shrink, so the account list
absorbed the shortage, collapsed to zero and the footer was pushed out. The
panel now takes only what is left over:

```
src/renderer/app.js
  graphVisible      the user's preference. Persisted. Changed ONLY by the
                    graph button.
  graphSuppressed   derived from the window size. Never persisted. Cleared as
                    soon as the window grows.

  GRAPH_MAX_HEIGHT   220   design height, used whenever it fits
  GRAPH_MIN_HEIGHT   140   below this the chart is too thin to read
  ACCOUNTS_MIN_HEIGHT 56   two compact rows stay visible and scrollable

  applyGraphLayout()   measures .content's real client height, subtracts the
                       account minimum, the footer, the expand panel and the
                       graph's own margin, then either sets an explicit px
                       height on the panel or suppresses it.
  scheduleGraphLayout() one rAF-debounced re-run per resize; reloads the chart
                       when the panel returns from suppression.
```

Called from: the graph button, `window.addEventListener('resize', …)`, startup
restore, and account removal. `_saveViewState()` is untouched, so suppression
can never write the setting.

The graph button keeps showing the preference and gains a `.suppressed` state
plus the tooltip *"Usage graph hidden — the window is too short. Make it taller
to show it again."* No new panel and no new control; `MIN_WINDOW_WIDTH` /
`MIN_WINDOW_HEIGHT` in `main.js` are unchanged.

Two related bugs in the same area were fixed as part of making it work:
`showMainContent()` set `display: block` on the flex content column, and
`graphSection.style.display` was set to `block` over a `flex` rule — both are
now `flex`.

## 3. Visual refinement

Within the existing architecture — no markup restructuring beyond what the
type change needed.

- **Type.** One self-hosted family for the whole app: IBM Plex Mono, in the
  three weights whose files are actually bundled (400 / 500 / 600), so nothing
  is synthesised. `assets/fonts/ibm-plex-mono-{400,500,600}.woff2` with
  `assets/fonts/IBM-PLEX-MONO-OFL.txt` (SIL OFL 1.1, Copyright 2017 IBM Corp.,
  Reserved Font Name "Plex"), fetched from `@ibm/plex-mono@1.1.0` on jsDelivr.
  Both `--font-ui` and `--font-mono` now resolve to it, which is what carries
  the change into the settings overlay as well. 13px body, 14px account names,
  11–12px secondary, normal letter spacing, no uppercase tracking anywhere.
- **Chart labels.** `chartTheme()` reads the stylesheet's own custom properties
  and hands them to Chart.js, so ticks, grid, series and tooltip use the same
  family and colours as the widget instead of Chart.js defaults.
- **Surfaces.** Warm charcoal (`--bg #1a1917`, `--surface #221f1d`), soft white
  text (`--text #e8e4de`), subtle gray dividers (`--line rgba(232,228,222,.09)`).
- **Controls.** Flat: no fill of their own, a subtle one on hover, 5px radius.
- **Focus.** One `:focus-visible` rule near the top of the stylesheet — a 2px
  `#8ab4f8` ring with a 2px offset — so every control gets it without opting in.
- **Status.** Provider name, `manual`, `stale`, `unavailable` and `fallback`
  are now quiet text rather than bordered chips. The word still carries the
  meaning, so no state depends on colour.
- **Unchanged on purpose.** The compact rows (label, thin bar, percentage,
  reset countdown), the fixed 80% / 95% thresholds and their three colours, and
  every truthful reading state.
- The Geist and Source Serif files stay on disk with their licences, now
  unreferenced. They were not deleted: removing pre-existing assets was not
  asked for.

## 4. Commands and results

| Command | Result |
|---|---|
| `node --check` on the 5 changed JS files | exit 0 each |
| `npm test` | **exit 0** — account-logic, 14/14 add-account-flow, provider-cancellation, 31 usage-reading scenarios, 12/12 renderer |
| `electron test/electron-usage-status-smoke.js` | **106/106, exit 0** (was 37/37; 69 new checks) |
| `electron test/electron-cancel-smoke.js` | **16/16, exit 0** (was 13/13; 3 new checks) |
| `electron "$env:TEMP\usage-widget-phase3-review-20260910\review.cjs"` | **120/120, exit 0** (was 45/51, exit 1) |
| `electron "…\review.cjs" --cancel` | **16/16, exit 0** |

The architect's harness was not edited. Its `require('../main.js');` marker and
its unique `const failed = results.filter` marker are both intact, and its
appended block still runs after this suite's own checks.

All six previously failing layout assertions now pass, at the measured bounds
their harness sets:

```
640x480  graph 220px   accounts 148.4  footer bottom 467.2 / viewport 480
640x300  graph 141px   accounts  47.4  footer bottom 287.2 / viewport 300
640x240  suppressed    accounts 136.4  footer bottom 227.2 / viewport 240
640x150  suppressed    accounts  47.6  footer bottom 138.4 / viewport 151
```

## 5. New regression coverage

`test/electron-usage-status-smoke.js` section 15, against the real renderer at
bounds read back from `getBounds()`:

- **12 window sizes** — widths 480 / 640 / 800 × heights 480 / 300 / 240 / 150
  (the supported minimum), graph preference ON — each asserting five things:
  the footer stays inside the viewport; the account list keeps at least 28 CSS
  px, actually scrolls (the list is scrolled to the bottom and put back) and
  still has rows; a visible chart stays inside its panel and the panel inside
  the viewport; no horizontal overflow and all five title-bar controls remain
  on screen; the graph preference survives the resize.
- **Shrink then grow** — 560 → 240 suppresses and keeps `pref === true`,
  `.suppressed` on the button and the "too short" tooltip; `getSettings()`
  still reports `graphVisible: true`, proving suppression does not write the
  setting; 240 → 560 brings the panel and the chart back with no further click.
- **Toggling** — off is recorded as a preference change (`pref false`,
  `suppressed false`), not as suppression; on restores it.
- **Account switching** — clicking a different graph chip at a normal height
  changes the active chip and leaves a chart with a non-zero canvas.
- **Saved graph preference re-applied in a short window** — the setting is
  saved through the real IPC, the window is set to 640×240 and the renderer is
  reloaded, which re-runs `init()`. The panel comes back suppressed with the
  setting intact; growing the window then shows it without a click.
  This is a **renderer reload, not a full Electron process restart** — the main
  process, its store instance and its in-memory usage state stay live. It
  covers the renderer's startup restore path and nothing beyond it.
- The section restores the graph setting to off, reloads once more and puts the
  original bounds back, so the checks after it — and the architect's appended
  block — start from the state they expect.

## 6. Renderer readiness — now observed, not assumed

`app.js` sets `document.documentElement.dataset.startupComplete = 'true'` as
the last statement of `init()`, after the cards are rendered, every account has
been polled once, the saved graph preference has been applied and the window
has been sized. Both suites require `startupComplete === true`; a missing or
unreadable marker keeps waiting and then fails with the last observed state.
The previous `!== false` test, which accepted an unknown flag, is gone.

## 7. Provider traffic — what is mocked, what is blocked, what is untested

| Suite | Provider readers | Network | Evidence |
|---|---|---|---|
| `electron-usage-status-smoke.js` | both replaced with in-process mocks | nothing attempted | the architect's guard logged `[review-network] []` |
| `electron-cancel-smoke.js` | **not** mocked — the real detection path is the thing under test | blocked, test-only | see below |

The cancellation suite now installs its own block before `main.js` loads:

- `session.webRequest.onBeforeRequest` cancels every `http(s)` request on every
  session as it is created;
- `did-start-navigation` / `did-fail-load` record what was attempted and how
  it ended; `did-navigate` records the HTTP status a navigation came back with.

Three assertions: **no provider navigation ever returned an HTTP response**,
**the real detection path did attempt one** (so the behaviour under test really
ran), and **a deliberate `loadURL('https://claude.ai/')` is refused** — which
came back `ERR_BLOCKED_BY_CLIENT (-20)`. The last one is what makes the claim
verifiable inside the run rather than inferred from a counter.

The first version of this check used `did-finish-load` as the "we reached the
server" signal and failed: a blocked navigation still commits an error document
and fires `did-finish-load` with the requested URL in place, which reads as a
successful load when it is the opposite. A non-zero `httpResponseCode` on
`did-navigate` is the signal that actually distinguishes the two.

Electron allows only one `onBeforeRequest` listener per session, so when this
suite runs under the architect's harness their guard replaces this one and this
suite's own counter reads 0. Blocking still happens — their
`[review-network]` log recorded both `https://claude.ai` mainFrame requests as
cancelled, and the deliberate probe still returned `ERR_BLOCKED_BY_CLIENT`. The
outcome assertions are written to hold either way.

**The update checker — stated precisely.** `main.js` answers
`check-for-update` with a Node `https.request` to GitHub. That is a different
stack from Electron's session/`webRequest` layer, so **no Electron-level
network guard can intercept it**, and the renderer schedules a check 2s after
every load (`init()`), which means it *would* fire during both suites.

The earlier version of this file said "nothing in this task's suites triggers
it". That was wrong. Both suites now replace that IPC handler with a test-only
stub immediately after `require('../main.js')` — before the 2s timer can fire
— so the Node path never executes. The stub is gated on a flag so the
banner tests can ask for an update on demand.

With that in place the claim is: no outbound request of any kind is dispatched
by either suite — Electron-level requests are cancelled by the in-suite guard
and asserted, and the one Node-level request the app can make is stubbed out at
its handler.

## 8. Delivered diff and final hashes

`%TEMP%\usage-widget-phase3-followup-20260910\phase3-followup.diff` — 1320 lines against the
task-owned pre-edit backup:

```
src/renderer/app.js                    +152  -20
src/renderer/styles.css                +110 -112
test/electron-usage-status-smoke.js    +233  -12
test/electron-cancel-smoke.js          +112  -11
test/usage-status-renderer.test.js      +17    0
test/add-account-flow.test.js            +3    0
docs/phase3-verification.md             +41  -13
README.md                                +2   -2
QUICKSTART.md                            +3    0
```

Added, so not in the diff: `docs/phase3-followup-verification.md`,
`assets/fonts/ibm-plex-mono-{400,500,600}.woff2` and
`assets/fonts/IBM-PLEX-MONO-OFL.txt`.

Untouched, and confirmed so by hash: `main.js`, `preload.js`,
`package.json`, `src/providers.js`, `src/fetch-via-window.js`,
`src/usage-status.js`, `src/account-logic.js`,
`test/usage-reading.test.js`, `test/provider-cancellation.test.js`,
`test/account-logic.test.js`. No dependency, authentication,
provider-endpoint or storage-policy change.

`%TEMP%\usage-widget-phase3-followup-20260910\after-state\sha256.json` covers
every delivered source, test, asset and documentation file (29 entries), and
was regenerated **after** the final documentation edit — the stale-manifest
problem the review raised. Verified **29/29** against both the copy and the
live file.

Re-checking the pre-edit backup's 36 entries against the live tree afterwards
shows exactly **9 changed** and **27 unchanged**, the same set the diff lists
— including `main.js` unchanged, so the minimum window dimensions really are
untouched, and `src/renderer/index.html` unchanged, so the visual work needed
no markup change.

## 9. Visual evidence

`%TEMP%\usage-widget-phase3-followup-20260910\screenshots`, all captured after
`document.fonts.ready`, seven synthetic accounts covering available, worst,
stale, manual, fallback, unavailable and weekly-only, one with a deliberately
long name:

```
after-480.png  after-640.png  after-800.png          normal heights
after-640-short.png                                   short window, graph off
after-graph-640x560.png                                graph shown, 220px panel
after-graph-640x300.png  after-graph-640x240.png       graph suppressed
after-graph-480x300.png  after-graph-800x300.png       suppressed at other widths
after-graph-640x150.png                                supported minimum height
after-keyboard-focus.png                               real Tab-key focus ring
after-640-panels.png                                   expanded rows + graph
```

Measured in the live renderer with the graph preference ON:

```
640x560  graph flex 220px  accounts 212.4  footer 524.0-547.2 / 560
640x300  graph none        accounts 180.4  footer 264.0-287.2 / 300
640x240  graph none        accounts 120.4  footer 204.0-227.2 / 240
480x300  graph none        accounts 180.4  footer 264.0-287.2 / 300
800x300  graph none        accounts 180.4  footer 264.0-287.2 / 300
640x150  graph none        accounts  31.6  footer 115.2-138.4 / 151
horizontal overflow: false at every size
```

**Run-specific numbers, not acceptance criteria.** Every measurement in this
section is one observation of one run. The panel is suppressed at 300px here
but shrinks to 141px in the smoke at the same height, because the screenshot
harness also has the expanded-rows panel open and its height counts against the
reservation; the architect measured 196.4px of account viewport at 640×300 in
their run. All three are the same rule producing different numbers from
different starting states.

What is being asserted — and all that should be read as a pass condition — is
the invariant: **the account list keeps at least 28 CSS px with a whole visible
row reachable, the footer stays inside the viewport, any visible chart stays
inside its panel, there is no horizontal overflow, and the saved graph
preference is never written by suppression.** The exact panel height, and
whether the panel shrinks or is suppressed at a given size, are outcomes of the
available space in that particular run.

Type and palette, read back from the live renderer:

```
fonts loaded          IBM Plex Mono 400, 500, 600   (no other family declared)
elements in the card list, footer or toolbar
  not using IBM Plex Mono                        0
.account-name         IBM Plex Mono w600 14px
.row-label            IBM Plex Mono w400 13px
.row-pct              IBM Plex Mono w600 13px  tabular-nums
.row-reset            IBM Plex Mono w500 12px  tabular-nums
container background  rgb(26, 25, 23)
clipped elements inside .account-block            0
```

Keyboard focus, driven with real `Tab` key events rather than `.focus()`:
`settingsBtn`, `refreshBtn`, `graphBtn`, `minimizeBtn` each reported
`matches(':focus-visible') === true` with `outline: solid 1.6px rgb(138, 180, 248)`.

## 10. Not verified

- **Windows 11 only.** Linux, macOS and packaged builds are untested.
- **Real authenticated provider workflows are untested** — every reading in
  every suite is synthetic, and the cancellation suite's provider navigation is
  deliberately blocked. That the login capture *succeeds* against a live
  provider is not shown by any of this.
- **`buildExtraRows()` is still unreachable** from the current UI; it is
  exercised by direct invocation only.
- **The chart itself renders empty in the screenshots** — the synthetic history
  holds one or two samples, so there is no line to draw. Axes, labels, grid and
  containment are what the captures demonstrate.
- **`GRAPH_MIN_HEIGHT` is a judgement, not a measurement.** 140px was chosen as
  the point below which the chart stops being worth the space; it has not been
  validated with users.
- **Late font loading is not covered.** `font-display: swap` controls what is
  painted while a face is still loading; it does **not** guarantee the face is
  loaded before first paint, and the earlier version of this file implied it
  did. The screenshots wait for `document.fonts.ready`, which establishes that
  the captures show loaded fonts — not that first paint used them. A late
  swap-in that changed row heights is a plausible relayout trigger; it has not
  been reproduced, and the content-size observation added in the final
  follow-up would now catch it if it changed the content box.
