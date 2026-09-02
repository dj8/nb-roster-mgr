# Setup & Fill-ins Tabs (`app.js`)

## Responsibility

Two of the six tabs, grouped here because they're structurally similar: each manages one
list of people (regular players / fill-ins) through the same add/edit-dialog +
list-row-with-Edit/Remove pattern from
[`ui-shell-and-modals.md`](ui-shell-and-modals.md).

## Setup tab

| Function | Params | Returns | Side effects |
|---|---|---|---|
| `renderSetup(root)` | mount point | — | Renders season-parameter inputs (`numGames`, `desiredBenchSize`) and the player list card. Wires `onchange` handlers that clamp the value, call `ensureGamesExist()` (for `numGames`), `saveState()`, and re-render. |
| `renderPlayerList(el)` | mount point | — | Renders `STATE.players` as list rows (ranked preference badges, "Out: G3, G7" pill if unavailable) or an empty state. Wires Edit → `openPlayerDialog(id)`, Remove → `confirmDialog(..., {confirmLabel:"Remove <name>", danger:true})`. |
| `openPlayerDialog(playerId)` | `null` for add, an id for edit | — (opens a modal) | Deep-clones the existing player (or builds a blank draft), lets the coach build an ordered `prefs` list by clicking position buttons (chip UI, click-to-add/×-to-remove), validates on Save (name required, no duplicate name, ≥1 preference — via `showFieldError`), then either `Object.assign`s onto the existing player or pushes a new one, `saveState()`, closes, re-renders. |
| `importPlayersCsv(text)` | raw CSV text | — | **Setup tab's "Import CSV" button.** Players-only, additive: parses `name,preferences` rows (tolerant of no header), skips a name already on the roster, skips a row with no recognized preference. Distinct from the Data tab's full-state import — see [`csv-xlsx-io.md`](csv-xlsx-io.md) and [`gotchas.md`](../gotchas.md#two-different-csv-imports-easy-to-conflate). |

A player **must** have ≥1 stated preference to be saved (enforced in the dialog, not just
the engine) — unlike a fill-in, a permanent roster player has no real identity for the
solver without one.

## Fill-ins tab

| Function | Params | Returns | Side effects |
|---|---|---|---|
| `renderFillIns(root)` | mount point | — | Renders `STATE.fillIns` as list rows — a "One-off" pill (and which game it's scoped to) for `saved:false` entries, an "Used in N game(s)" pill otherwise. Wires Edit/Remove the same way as the player list. |
| `openFillInDialog(fillInId, contextGameNum?, onSaved?)` | `fillInId`: `null` to add; `contextGameNum`: the game this was opened from (only set when launched via the Schedule tab's "+ New fill-in", see [`ui-schedule.md`](ui-schedule.md)); `onSaved`: callback instead of the default re-render | — (opens a modal) | Same chip-based preference builder as the player dialog, but preferences are optional (a fill-in can be "flexible"). Only asks the save-for-reuse-vs-one-off question (`fiSaved` checkbox) when *creating* (not editing) a fill-in. On Save: validates name only, and if this is a brand-new one-off created *from* a specific game (`contextGameNum` set, `saved:false`), auto-assigns it to that game's `fillInIds` so the coach doesn't also have to check it in the assign list. |

## Called by

Both tabs are entry points from `renderMain`'s `{tab: renderFn}` dispatch. `openFillInDialog`
is also called directly from the Schedule tab's "Assign a fill-in" dialog (see
[`ui-schedule.md`](ui-schedule.md)) when creating a fill-in in context — this is the one
place a "major module" boundary is crossed by a direct function call rather than only
through shared state.
