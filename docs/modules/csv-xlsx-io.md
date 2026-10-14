# Backup / CSV / XLSX Import-Export (`app.js`)

## Responsibility

Every way data moves in or out of the app besides direct UI edits: the full-state JSON
backup (Data tab), a players-only CSV import (Setup tab) and a one-way XLSX report export.
No server involved — everything is generated client-side and downloaded via a Blob URL.

## Data tab container

`renderData(root)` — the Data tab itself: three cards (JSON backup export/import, XLSX
export, "Clear all data") that wire up the functions documented below. The reset button
is a `confirmDialog(..., {confirmLabel:"Clear all data", danger:true})` that runs
`STATE = defaultState(); saveState(); render();` — a full wipe, not a soft reset.

## Full-state JSON backup (Data tab)

The one format for backing up, restoring and sharing a season. Fields are keyed by name
(never by position), arrays and `null` are native, and ids are stable strings.

```jsonc
{
  "format": "netball-roster-backup",
  "schemaVersion": 2,            // v2: settings reduced to the four below. v1 files still import, but their retired settings are ignored (not migrated)
  "buildNumber": 38,             // informational
  "exportedAt": "2026-10-10T…Z",
  "plan": {                      // everything the coach enters
    "season": {"numGames": 11, "desiredBenchSize": 2},
    "settings": {"preferenceSlider": 8, "allowOffPreference": false,
                 "positionVariety": 1, "rosterOffPriority": "fairness",
                 "loadBalance": 0,     // optional (added build 61); missing -> default
                 "positionLoad": {"GS": 0.55, "GA": 0.7, "WA": 0.85, "C": 1, "WD": 0.85, "GD": 0.7, "GK": 0.55}},
    "players": [{"id", "name", "prefs": ["GS","GA"], "unavailable": [3]}],
    "fillIns": [{"id", "name", "prefs": [], "saved": true}],
    "games": {"1": {"isPlayed", "date", "time", "location", "rosterOffOverride",
                    "rosterOffLockIds", "fillInIds", "lockedSlots", "strictSpecialistPairing",
                    "allowOffPreference"}}
  },
  "results": {                   // what the engine produced (and frozen facts for played games)
    "games": {"1": {"rosteredOffIds": [], "unavailableIds": [], "error": null,
                    "schedule": {"quarters": [{"onCourt": {"GS": "id"}, "bench": [], "offPreference": {}}]}}}
  }
}
```

Device-only state (`theme`, `activeTab`) is deliberately not exported; importing keeps the
current device's theme.

| Function | Direction | Notes |
|---|---|---|
| `buildBackup()` | — | Builds the object above from `STATE`. |
| `exportBackup()` | out | `JSON.stringify(buildBackup(), null, 2)` → `netball-roster-season-[draft-]YYYY-MM-DD.json` via `downloadBlob`. |
| `importBackup(text)` | in | `JSON.parse`, then rejects anything without `format: "netball-roster-backup"` or with a `schemaVersion` newer than `BACKUP_SCHEMA_VERSION` (toast, state untouched). Otherwise type-checks every field into a fresh `ns` state (wrong-typed values fall back to defaults; only `^[1-9]\d{0,2}$` game keys and well-formed `q-POS` lock keys are accepted, so `__proto__` etc. are ignored), runs `sanitizeImportedState` then `sanitizeSettingsAndSeason`, swaps it in as `STATE`, then re-runs `computeSeasonRosterOff(true)` to recompute display-only derived fields **without** overwriting each unplayed game's imported roster-off. Rolls back on throw. |
| `sanitizeImportedState(ns)` | — | Defensive pass over freshly-parsed data: drops player/fill-in rows with a missing/duplicate id or (for players) no recognized preference; strips locked-slot/roster-off/fill-in/schedule references to ids that don't exist; removes a player appearing twice in one quarter; clamps `numGames`/`desiredBenchSize`. Returns a list of what it corrected (logged to the console and counted in the toast). |

Because the file is real JSON, an explicit-empty `rosterOffLockIds` (`[]`, "nobody off")
stays distinct from no lock (`null`) across a round-trip, and a played game's
`unavailableIds` is preserved with its `rosteredOffIds`.

See [`flows.md`](../flows.md#4-backup-import-data-tab) for the sequence. Adding a field to
the backup: see the checklist in `CLAUDE.md`.

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
| Rotation Grid | every game's `schedule.quarters`, one row per game×quarter (with Date, Time and Location columns; the Short-Staffed Notes and Off-Preference Log sheets carry them too) |
| Player Summary | `computePlayerSummaries()` |
| Short-Staffed Notes | every shortfall game, via `fillInGapSuggestions()` |
| Off-Preference Log | `computeOffPrefLog()` + `describeOffPrefReason()` |

Not re-importable — this is a report artifact for sharing, not a backup format (that's
what the JSON backup is for).

## Shared download mechanism

`downloadBlob(filename, blob)` — creates an object URL, synthesizes an `<a download>`
click, revokes the URL after 1s. Used by both `exportBackup` and (indirectly, via
`XLSX.writeFile`) `exportXlsx`.

## Called by

`importPlayersCsv` ← Setup tab file input. `exportBackup`/`importBackup`/`exportXlsx` ←
Data tab buttons ([`ui-reports-and-settings.md`](ui-reports-and-settings.md) covers the
rest of that tab's siblings, but these three live in `renderData`, documented for scope
reasons in this file instead since they're I/O, not report display).
