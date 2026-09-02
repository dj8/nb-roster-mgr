# CSV / XLSX Import-Export (`app.js`)

## Responsibility

Every way data moves in or out of the app besides direct UI edits: two independent CSV
paths (players-only, on the Setup tab; full-state, on the Data tab) plus a one-way XLSX
report export. No server involved — everything is generated client-side and downloaded
via a Blob URL.

## Data tab container

`renderData(root)` — the Data tab itself: three cards (full CSV export/import, XLSX
export, "Clear all data") that wire up the functions documented below. The reset button
is a `confirmDialog(..., {confirmLabel:"Clear all data", danger:true})` that runs
`STATE = defaultState(); saveState(); render();` — a full wipe, not a soft reset.

## CSV parsing primitives

| Function | Purpose |
|---|---|
| `parseCsv(text)` | Minimal RFC4180-ish parser — handles quoted fields, embedded commas/newlines, `""`-escaped quotes. Returns an array of rows (arrays of strings), dropping fully-blank rows. |
| `toCsvField(v)` | Quotes a value if it contains a comma, quote, or newline. |
| `guardCsvText(v)` / `unguardCsvText(v)` | Formula-injection guard (OWASP-recommended): a free-text field starting with `= + - @` gets a leading `'` prepended on export (so Excel/LibreOffice treats it as text, not a formula) and stripped back off on import — but only when what follows the leading quote is itself one of those characters, so a name that genuinely starts with a literal apostrophe round-trips correctly. Applied only to free-text name fields, not every field `toCsvField` touches. |

## Full-state CSV (Data tab)

| Function | Direction | Notes |
|---|---|---|
| `exportFullCsv()` | out | Writes `#META`/`#SEASON`/`#SETTINGS`/`#PLAYERS`/`#FILLINS`/`#GAMES`/`#SCHEDULE` sections. `lockedSlots` serializes as `key=value` pairs joined by `\|`; array fields (`prefs`, `unavailable`, `rosterOffLockIds`, etc.) join with `\|`. |
| `importFullCsv(text)` | in | Parses into named sections, builds a fresh state object (`ns`), runs it through `sanitizeImportedState` then `sanitizeSettingsAndSeason`, swaps it in as `STATE`, then re-runs `computeSeasonRosterOff(true)` to recompute display-only derived fields **without** overwriting the imported `rosteredOffIds` (see [`engine.md`](engine.md)). If the re-solve throws, `STATE` is rolled back to its pre-import value before the error propagates — an import can fail loudly without corrupting the live app state. |
| `sanitizeImportedState(ns)` | — | Defensive pass over freshly-parsed data: drops player/fill-in rows with a missing/duplicate id or (for players) no recognized preference; strips locked-slot/roster-off/fill-in/schedule references to ids that don't exist; removes a player appearing twice in one quarter's on-court+bench. Returns a list of what it corrected (surfaced via `console.warn` + a toast, not silently). |

See [`flows.md`](../flows.md#4-full-csv-import-data-tab) for the sequence, and
[`gotchas.md`](../gotchas.md#csv-cant-distinguish-explicit-empty-lock-from-no-lock) for
the one known lossy edge in the round-trip.

## Players-only CSV (Setup tab)

`importPlayersCsv(text)` — a much narrower path, documented in
[`ui-setup-and-fillins.md`](ui-setup-and-fillins.md). Tolerant of a missing header
(assumes `name,preferences`), additive (skips existing names), and doesn't touch
games/settings/schedule at all. **Not the same format or code path as the full import** —
see [`gotchas.md`](../gotchas.md#two-different-csv-imports-easy-to-conflate).

## XLSX export

`exportXlsx()` — one-way report generation via the vendored SheetJS library (global
`XLSX`, checked for `undefined` in case the script failed to load). Builds three sheets
from the same aggregation functions the Reports tab uses
([`engine.md`](engine.md#report-aggregations)):

| Sheet | Source |
|---|---|
| Rotation Grid | every game's `schedule.quarters`, one row per game×quarter |
| Player Summary | `computePlayerSummaries()` |
| Short-Staffed Notes | every shortfall game, via `fillInGapSuggestions()` |
| Off-Preference Log | `computeOffPrefLog()` + `describeOffPrefReason()` |

Not re-importable — this is a report artifact for sharing, not a backup format (that's
what the full CSV export is for).

## Shared download mechanism

`downloadBlob(filename, blob)` — creates an object URL, synthesizes an `<a download>`
click, revokes the URL after 1s. Used by both `exportFullCsv` and (indirectly, via
`XLSX.writeFile`) `exportXlsx`.

## Called by

`importPlayersCsv` ← Setup tab file input. `exportFullCsv`/`importFullCsv`/`exportXlsx` ←
Data tab buttons ([`ui-reports-and-settings.md`](ui-reports-and-settings.md) covers the
rest of that tab's siblings, but these three live in `renderData`, documented for scope
reasons in this file instead since they're I/O, not report display).
