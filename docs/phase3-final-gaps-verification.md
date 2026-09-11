# Phase 3 final gaps — banner relayout + Settings switch focus

Two confirmed UI acceptance gaps from the 2026-09-10 review, closed. Windows 11,
Electron 28.3.3, run from the project root with `ELECTRON_RUN_AS_NODE` cleared
before each Electron launch. Isolated storage under `%TEMP%`, synthetic
credentials throughout.

## Backup, taken and verified before any edit

`%TEMP%\usage-widget-phase3-final-followup-20260910\backup-pre-edit` — 32
entries with `sha256.json`, verified against both the copy and the live file:
**32/32, 0 mismatches**. The script refuses to run if the directory exists.

Earlier snapshots and evidence confirmed intact at the same time, and again at
the end:

```
phase2-review-20260910\before-next-task            18/18 intact
phase3-review-20260910\before-followup             20/20 intact
phase3-followup-20260910\backup-pre-edit           36/36 intact
phase3-followup-20260910\after-state               29/29 intact
phase3-final-review-20260910\before-followup       29/29 intact
```

The architect's harnesses were not modified:
`review.cjs` SHA256 `9E1C2FFA…FC264C8F` — the value stated in the review.
`extra-review.cjs` SHA256 `932CD5A8E0F39F3ACEC6F7DF726055AF94F99F1A271187950B1B9287683EFB22`.
`extra-review.cjs` was run with `REVIEW_OUTPUT` pointed at new directories, so
the review's own `banner-*.png`, `settings-keyboard.png` and
`extra-observations.json` are untouched (timestamps still 09:45).

**One piece of review evidence was overwritten, and I did not prevent it.**
`review.cjs` writes `graph-640x{480,300,240,150}.png` and `layouts.json` to
its own `__dirname`; it has no `REVIEW_OUTPUT` support, and editing it was
not permitted. I should have copied those five files before the first run
and did not, so they now hold post-fix output. What survives:

- `architect-probe.log` in that directory is **intact** (SHA256
  `55F9A4B5DC92F7EC6A49D063C03755B0D85BA9E8FD3F927A73914CBB4F39FA56`) and
  still carries the review's own numbers, including the 196.4 px account
  viewport at 640×300 that `review.md` cites;
- the review's prose in `review.md` is unchanged;
- the current post-fix copies are labelled as such in
  `evidence-after\from-review-cjs\`.

Those four screenshots were never evidence of either finding in this task —
both findings are evidenced by `extra-review.cjs` output, which is
preserved on both sides. Flagging it because it is review evidence I was
asked to preserve and did not.

## 1. Both failures reproduced first

`REVIEW_OUTPUT=…\evidence-before electron …\extra-review.cjs` on the unchanged
source: **106/109, exit 1**, with exactly the three failures described:

```
EXTRA graph survives update banner at 320   accounts 55.4 -> 13.8, graph stays 153px
EXTRA graph survives update banner at 340   accounts 55.4 -> 13.8, graph stays 173px
EXTRA keyboard settings toggle has a visible focus indicator
    input  focused=true opacity=0 0x0  outline "rgb(138,180,248) solid 1.6px"
    slider outline "rgb(232, 228, 222) none 0px"  shadow "none"
```

## 2. Finding 1 — recompute when the available height changes

`applyGraphLayout()` measured correctly; it was simply never invalidated except
by `window.resize`. Three changes in `src/renderer/app.js`:

- **`observeContentHeight()`** — a `ResizeObserver` on `#mainContent` calls the
  existing rAF-debounced `scheduleGraphLayout()`. This catches every cause of a
  content-height change, not just the two known ones, which is why it was
  preferred over invalidating at each call site.
  It cannot feed itself: `#mainContent` is `flex: 1; min-height: 0` inside a
  window-height column, so its own box is set by the window and never by the
  height the layout writes onto a child. Guarded with
  `typeof ResizeObserver !== 'function'` so the module still loads under the
  unit-test DOM shim.
- **`writeGraphPanel()`** — the panel's last applied `display`/`height` is
  remembered and re-writes are skipped when the decision is unchanged, so an
  invalidation that changes nothing performs no DOM mutation. `usageChart.resize()`
  is called only when the panel actually changed size, so a burst of callbacks
  cannot cause repeated chart work.
- **Explicit invalidation** at the two banner transitions
  (`checkForUpdate()`'s reveal and the dismiss handler) so the behaviour is
  deterministic even where `ResizeObserver` is unavailable.

`graphVisible` / `graphSuppressed` separation, `_saveViewState()`, the minimum
window dimensions, the thresholds and the reading states are all untouched. No
control was added.

## 3. Finding 2 — focus on the visible switch

`src/renderer/styles.css`: each switch hides its checkbox (`opacity: 0`, zero
size) so the pill can be styled, so the global `:focus-visible` ring was
landing on something invisible. Two rules move it to the slider:

```css
.toggle-switch input:focus-visible { outline: none; }
.toggle-switch input:focus-visible + .toggle-slider {
    outline: 2px solid var(--focus);
    outline-offset: 2px;
}
```

One rule covers all five switches, since they share the
`label > input + .toggle-slider` shape. Keyboard operation is unchanged — the
checkbox still owns focus and Space.

Also in the same rule block: the slider knob's two remaining hard-coded colours
(`#9a9a9a`, `#000`) now use `var(--muted)` and `var(--accent-ink)`. They were
left over from the pre-charcoal palette; nothing else about the switch changed.

## 4. Commands and results

| Command | Result |
|---|---|
| `node --check src/renderer/app.js`, `test/electron-usage-status-smoke.js`, `test/electron-cancel-smoke.js` | exit 0 each |
| `npm test` | **exit 0** — account-logic, 14/14 add-account-flow, provider-cancellation, 31 usage-reading scenarios, 12/12 renderer |
| `electron test/electron-usage-status-smoke.js` | **138/138, exit 0** (was 106/106; 32 new checks) |
| `electron test/electron-cancel-smoke.js` | **16/16, exit 0** |
| `electron …\phase3-final-review-20260910\review.cjs` | **152/152, exit 0** |
| `electron …\review.cjs --cancel` | **16/16, exit 0** |
| `REVIEW_OUTPUT=…\evidence-after electron …\extra-review.cjs` | **141/141, exit 0** (was 106/109, exit 1) |

`extra-review.cjs` was then run **five more times** back to back:
**141/141, exit 0 on all five** (logs in
`…\phase3-final-followup-20260910\stability3\run{1..5}.log`). That repetition
matters — see below.

The three EXTRA checks now report:

```
EXTRA graph survives update banner at 320
  accounts 55.4 -> 174.8, graph flex 153px -> none, pref true, suppressed true
EXTRA graph survives update banner at 340
  accounts 55.4 -> 194.8, graph flex 173px -> none, pref true, suppressed true
EXTRA keyboard settings toggle has a visible focus indicator
  input outline "rgb(0,0,0) none 0px"; slider outline "rgb(138,180,248) solid 1.6px"
```

## 5. New durable regressions

`test/electron-usage-status-smoke.js`, sections 16 and 17, against the real
renderer. 32 checks.

**Section 16 — available content height.** For 640×320 and 640×340, with the
graph preference on and the window stationary:

- the banner is revealed by calling the real renderer `checkForUpdate()`
  (test-only IPC stub, no update server contacted) and then dismissed by
  clicking the real `#updateBannerDismiss` — no resize and no extra click in
  either direction;
- each state asserts the invariant: account viewport ≥ 28 CSS px, a whole
  *visible* row fits it, the list still scrolls (it is scrolled to the bottom
  and put back), the footer is inside the viewport, any visible canvas is
  inside its panel and the panel inside the viewport, no horizontal overflow;
- the pre-banner state is asserted to have no banner, so the comparison cannot
  be silently corrupted;
- `graphVisible` and the **stored** `graphVisible` are checked before and after
  both transitions — suppression must never write the setting.

**Section 17 — Settings switches.** For each of the five switches
(`autoStartToggle`, `minimizeToTrayToggle`, `alwaysOnTopToggle`,
`showTrayStatsToggle`, `usageAlertsToggle`), driven with real `Tab` and `Space`
key events:

- Tab reaches it and `input.matches(':focus-visible')` is true;
- **the ring is on the visible slider**: the sibling is `.toggle-slider`, its
  computed `outline-style` is `solid` with a non-zero width, and its rectangle
  is non-empty and inside the viewport. Checking `:focus-visible` on the
  invisible input is explicitly not accepted as the indicator;
- Space flips `checked`, and a second Space restores it;
- each switch is asserted to be left exactly as found;
- moving focus on clears the ring from the switch it left
  (`outline-style` back to `none`);
- the panel is closed **without** the Done button — which is the only thing
  that writes settings — and the stored settings are asserted byte-identical to
  before, so no real OS startup or taskbar preference is written.

### Four problems found while building these tests, and what each was

Recorded in full because two of them were real product behaviour and two were
faults in my own test. **No assertion was relaxed to make anything pass.**

1. **My measurement was wrong (test).** The section-16 invariant took
   `querySelector('.account-block .usage-row')` as "the first row". That row is
   legitimately `display: none` at that point in the suite — account 1 is on a
   weekly-only reading, so its session row is hidden — so the check failed on a
   correct layout. It now filters to visible rows, which *tightens* the meaning
   ("a whole row the user can see fits the viewport"); a hidden row was never
   reachable.

2. **My test raced the app (test).** `init()` schedules a `checkForUpdate()`
   2 s after every renderer load and section 15 reloads the renderer, so a
   background check raised the banner during section 16's "before"
   measurement. The update stub is now gated on a flag the test owns, and is
   installed suite-wide right after `require('../main.js')`, so only an update
   the test asks for is ever reported.

3. **One painted frame still showed the squeezed list (product).** After
   replacing the fixed `sleep(420)` with polling, the banner checks failed
   *consistently* with `accounts=13.8` — the original defect value. The cause
   was real: the banner transitions invalidated the layout through the
   rAF-debounced `scheduleGraphLayout()`, so between the banner becoming
   visible and the next frame there was one frame in which it had taken the
   account list's space. The 420 ms sleep had been hiding it.
   Fixed properly rather than by waiting longer: `relayoutGraphNow()` applies
   the layout synchronously, and the two banner transitions call it directly,
   so the change and its relayout land in the same task and no such frame is
   ever painted. `scheduleGraphLayout()` remains the coalesced path for event
   streams (drag-resize, observer bursts).

4. **My baseline measured my own click (test).** Turning the graph on calls
   `_saveViewState()`, which is **debounced**, so reading the stored preference
   immediately afterwards returned the pre-click value. The
   "suppression never changes the saved preference" check was therefore
   comparing this test's own write, not the behaviour under test — and it
   failed reproducibly. `storedPrefSettled(true)` now waits (bounded) for that
   write to land before the baseline is taken, and two new checks assert the
   precondition explicitly. The assertion across the banner transitions is
   unchanged and just as strict.

**On the one unexplained run.** Before these fixes, one `extra-review.cjs` run
reported 126/139 while five others reported 139/139, and I did not capture its
output. Problems 3 and 4 both produce exactly that kind of intermittency — a
frame-timing race and a debounce race — and with both fixed the probe has now
run 141/141 five times consecutively. I cannot prove that was the cause,
because the log is gone; I am reporting it rather than claiming the flake is
explained.

The tests no longer depend on guessed delays. `settled()` polls until two
consecutive measurements are identical and *then* asserts — deliberately
neutral, so a layout that settles on a wrong answer still fails; `tabTo()`
confirms focus has moved before the next Tab; `spaceAndAwaitChecked()` polls
for the state change. Each is bounded and reports its last observation on
timeout.

## 6. Verification wording corrected

All four items from the review:

1. **The Node HTTPS update checker.** The previous claim that nothing in the
   suites triggers it was **wrong** — `init()` schedules a check 2 s after every
   load and `main.js` answers it with `https.request`, which Electron's
   `webRequest` layer cannot intercept. Both suites now replace that IPC handler
   with a test-only stub immediately after `require('../main.js')`, before the
   timer can fire, so the Node path never executes. The corrected statement is
   in `docs/phase3-followup-verification.md` §7.
2. **`font-display: swap`** does not guarantee fonts are loaded before first
   paint; the earlier text implied it did. Waiting on `document.fonts.ready`
   establishes loaded-font captures only. Corrected in the same file's
   "Not verified" section, along with the note that late-font relayout is an
   unreproduced risk that the new content-size observation would now catch.
3. **The stale "1590 lines"** sentence in `docs/phase3-verification.md` is gone;
   the file now says 1639 consistently.
4. **Run-specific measurements are now separated from the invariant.**
   `docs/phase3-followup-verification.md` §9 states the acceptance invariant
   explicitly and records that the architect's 196.4 px, the smoke's 141 px
   panel and the screenshot harness's suppression at 640×300 are three
   different starting states producing three correct outcomes of one rule.
5. Additionally corrected, though listed under "Inspected and verified" rather
   than as a wording item: the renderer reload in section 15 is described as a
   **renderer reload, not a full Electron process restart**.

## 7. Visual evidence

Before/after from the architect's own probe, captured after
`document.fonts.ready`:

```
evidence-before\banner-320.png   evidence-after\banner-320.png
evidence-before\banner-340.png   evidence-after\banner-340.png
evidence-before\settings-keyboard.png   evidence-after\settings-keyboard.png
evidence-before\extra-observations.json evidence-after\extra-observations.json
```

`banner-320.png` before shows the banner, one account name and the chart, with
**no usage row on screen at all**. After, the graph has stepped aside and five
usage rows are visible and scrollable with the footer in place.
`settings-keyboard.png` before shows the "Launch at startup" pill with no
indicator; after, it carries the focus ring.

## 8. Diff and final hashes

`%TEMP%\usage-widget-phase3-final-followup-20260910\phase3-final-gaps.diff`,
against this task's verified backup:

```
src/renderer/app.js                    +61     -13
src/renderer/styles.css                +11     -2
test/electron-usage-status-smoke.js    +389    -0
test/electron-cancel-smoke.js          +21     -0
docs/phase3-verification.md            +4      -4
docs/phase3-followup-verification.md   +43     -11
```

Plus this file, added, which the diff carries as a new text file. 1047 lines
across 7 files, in `C:\Users\KIRINDE\AppData\Local\Temp\usage-widget-phase3-final-followup-20260910\phase3-final-gaps.diff`.

Untouched and confirmed by hash: `main.js`, `preload.js`, `package.json`,
`src/renderer/index.html`, `src/usage-status.js`, `src/account-logic.js`,
`src/providers.js`, `src/fetch-via-window.js`, every unit test, all fonts and
licences, `README.md`, `QUICKSTART.md`. No authentication, dependency,
provider-endpoint or storage-policy change; no markup change at all.

`…\after-state\sha256.json` covers every delivered source, test, asset and
documentation file and was regenerated after the final documentation edit.

## 9. Not verified

- **Windows 11 only.** Linux, macOS and packaged builds untested.
- **No live authenticated provider workflow.** Every reading is synthetic and
  the cancellation suite's provider navigation is deliberately refused
  (`ERR_BLOCKED_BY_CLIENT`). Successful real login is not shown.
- **The real update flow is not exercised** anywhere — the handler is stubbed in
  both suites. Whether `main.js`'s GitHub check itself works is out of scope and
  untested here.
- **`ResizeObserver` is not exercised by `npm test`** — the shimmed DOM has no
  such constructor, so `observeContentHeight()` returns early there. Its
  behaviour is covered only in the Electron suites, against the real renderer.
- **Only the update banner was used to change the content height without a
  resize.** The expand panel is the other in-column element; it is unreachable
  from the current UI, so that path is covered by the observer's generality
  rather than by a test.
- **`GRAPH_MIN_HEIGHT = 140` and `ACCOUNTS_MIN_HEIGHT = 56`** remain
  judgements, not measured thresholds.
- **Late font-swap relayout** is still unreproduced; see §6 item 2.
