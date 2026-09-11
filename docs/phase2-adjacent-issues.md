# Phase 2 — adjacent issues found, not changed

Recorded 2026-09-09 while making usage status trustworthy. None of these is
part of the Phase 2 scope; each is reported here rather than fixed.

## 1. History written before Phase 2 still contains fabricated zeroes

Every sample written by the old `storeUsageHistory` used `?? 0`, so a failed or
partial read was recorded as a real 0%. Those samples are **preserved as they
are** (the phase requires existing history to be kept), which means the graph
can still show a historical dip to 0% that never happened. Only samples written
from now on carry `null` gaps.

Options if this matters: leave it (the data ages out after
`HISTORY_RETENTION_DAYS` = 8 days), or add a one-off migration that rewrites
suspicious `0` pairs as gaps — a storage migration, explicitly out of scope
here.

## 2. `fetchMultipleViaWindow` takes no AbortSignal

`src/fetch-via-window.js` — `fetchViaWindow` is cancellation-aware (Task 1), but
`fetchMultipleViaWindow`, which is what the Claude usage read actually uses
(`fetchClaudeUsage` in `main.js`), accepts no signal. A Claude usage read
therefore cannot be cancelled, and its window/timeout handling is the older
uninstrumented version: `win.close()` and `reject()` inline, with the same
unguarded `win.loadURL` pattern that was fixed in `fetchViaWindow`.

Not touched because the usage-read path is not the account-flow cancellation
path and changing it would alter fetch behaviour beyond this phase.

## 3. Authentication-expiry policy is unchanged and still asymmetric

`handleProviderError` treats a Cloudflare block as a dead Claude credential
(reconnect) but only `AuthRequired` as a dead ChatGPT credential. A Cloudflare
challenge for Claude therefore drops the credential where a ChatGPT hiccup does
not. Explicitly excluded from this phase's scope; flagged because the new stale
handling makes the difference more visible (one provider goes to Reconnect, the
other to `stale`).

## 4. `clampPct` is still exported but no longer used for provider parsing

`src/providers.js` keeps `clampPct` (exported, and still covered by its own
callers/tests) but every provider percentage now goes through
`readPercent`. `clampPct` remains a legitimate clamp for an already-known-good
number; it is a trap for anyone who reaches for it to parse a payload, which is
why it now carries a comment saying so. Removing it would be an API change to a
module other code imports.

## 5. The tray badge can show two different confidence levels at once

If the worst account has a readable weekly figure but an unreadable session
figure, the weekly badge shows a number and the session badge shows the neutral
dash. That is accurate but can look odd side by side. No behaviour change made;
noted in case a single combined badge state is preferred.

## 6. `buildExtraRows` keeps its previous rows when a response carries no
extra-usage sections

`if (!hasAnyExtendedData && elements.extraRows.children.length > 0) return;`
deliberately leaves the last-known extra rows on screen. Those rows now render
unreadable percentages as a dash, but the "keep what we had" behaviour itself
means the expanded section can hold values older than the card above it, with
no stale marking of its own. The expanded section has no status chip; adding one
would be a UI change beyond this phase.
