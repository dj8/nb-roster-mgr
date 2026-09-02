# Schedule Tab (`app.js`)

## Responsibility

The biggest and trickiest UI surface: triggers season generation, lists every game as a
collapsible card, renders each game's rotation grid, and hosts every manual-override
dialog (roster-off, fill-in assignment, per-slot edits). This is where availability,
roster-off, and position-assignment concerns actually meet in the UI — see
[`flows.md`](../flows.md) for the two sequence diagrams covering this tab's trickiest
interactions.

## Module-level view state

```js
let scheduleUiState = { openGame: null, filter: "all" };  // "all" | "attention" | "played"
let dirtySinceGeneration = false;                          // see gotchas.md
```

Neither is persisted — see [`gotchas.md`](../gotchas.md#global--module-level-state).

## Top-level render

| Function | Returns | Notes |
|---|---|---|
| `renderSchedule(root)` | — | Generate/Rebalance buttons (disabled if the roster is invalid or empty), the stale-schedule banner (`dirtySinceGeneration && hasAnyGenerated`), the filter control (All / Needs attention / Played), then `renderGamesList`. |
| `renderGamesList(el)` | — | Filters `gameNums()` by `scheduleUiState.filter` ("attention" = not played AND (error OR shortfall OR coverage warnings OR not yet generated)), renders each as a card via `renderGameCard`, wires each via `wireGameCard`. |
| `statusPillsForGame(game)` | HTML string | Builds the small pill row shown in a card's header: "Played & locked", a short generic "Error"/"Shortfall" pill (full text is a `title` attribute — the full message lives in the card *body* instead, not the header, to avoid squeezing/wrapping the header on mobile), "Generated"/"Not yet generated", and one pill per coverage warning. |
| `renderGameCard(num)` | HTML string | Collapsed: game number, a one-line summary ("Off: Amy, Bea · 2 fill-in(s)") when collapsed and non-empty, status pills, Details/Hide toggle (`aria-expanded`). Expanded: calls `renderGameBody`. |
| `renderGameBody(num)` | HTML string | The full per-game editor — see below. |
| `renderRotationGrid(num)` | HTML string | The quarter × position table — see below. |
| `wireGameCard(el, num)` | — | Attaches every event handler for one card: toggle, roster-off override input, "Set roster-off manually", "Protect position coverage" checkbox, "Assign a fill-in", fill-in-chip removal, "Mark as played" toggle, and per-cell click/keyboard handlers on the rotation grid. Early-returns before wiring the body's internals if this card isn't the currently-open one. |

`renderGameBody`'s three-column detail row (Rostered off / Unavailable / Roster-off count
override) reads live from `planGameAvailability(num)` and `getGame(num)` — it's always
in sync with `STATE`, it just may be **stale relative to the actual rotation grid** until
the next Generate/Rebalance if a roster-off override or checkbox was just changed (see
[`gotchas.md`](../gotchas.md#roster-off-dirty-flag-asymmetry)).

## Rotation grid rendering

`renderRotationGrid(num)`:
- No schedule yet → an empty state, wording branches on whether `game.error` is set
  ("Couldn't be scheduled — resolve the issue above" vs. "Not generated yet").
- Schedule present → one row per quarter, one cell per position (`.grid-cell.cell-oncourt`,
  plus `.cell-fillin`/`.cell-offpref`/`.cell-locked` modifiers as applicable), plus a
  bench cell. Cells are only made interactive (`.cell-clickable`, `tabindex="0"`,
  `role="button"`) when the game **isn't** played — a locked/played game's cells render
  `.cell-readonly` instead, so they don't visually invite a click `openSlotEditDialog`
  would just reject.

## Manual override dialogs

| Function | Opens from | Params | Writes | Regenerate needed? |
|---|---|---|---|---|
| `expectedRosterOffCount(num)` | (helper, not a dialog) | game number | — | Recomputes the auto-derivation formula *ignoring any existing lock*, purely so `openRosterOffDialog` can show a "Selected X of Y expected" target. |
| `openRosterOffDialog(num)` | "Set roster-off manually" | game number | `game.rosterOffLockIds` and `game.rosteredOffIds` (synced immediately on Save); both `null` on "Clear (auto)" | Yes, for the rotation grid — but does **not** set `dirtySinceGeneration` (see gotchas). |
| `openAssignFillInDialog(num)` | "Assign a fill-in" | game number | `game.fillInIds` | Yes, implicitly (a new fill-in only appears in the squad after the next generation) — also does not set `dirtySinceGeneration`. |
| `openSlotEditDialog(num, qi, pos)` | clicking/activating a grid cell | game, quarter index, position | `game.schedule.quarters[qi]` and `game.lockedSlots`, via `commitSlotEdit` | No — this *is* the schedule; it's a direct hand-edit, not a setting that needs re-solving. |
| `openFillVacancyDialog(num, qi, vacantPos, displacedPid, qDraft, lockedSlotsDraft)` | automatically, from `openSlotEditDialog`, when moving an on-court player vacates a *different* slot | — | same as above, via `commitSlotEdit` | No |

See [`flows.md`](../flows.md#2-manual-slot-edit--the-swap-cascade) for exactly which
`openSlotEditDialog` selection triggers the `openFillVacancyDialog` cascade vs. commits
directly.

## Slot-edit support functions

| Function | Purpose |
|---|---|
| `refreshOffPreferenceFlag(q, pos)` | Recomputes `q.offPreference[pos]` from whoever currently occupies it (or clears the flag if empty) — called after every manual slot change so the flag never goes stale relative to the actual occupant. |
| `clearStaleLock(lockedSlotsDraft, qi, pos, expectedPid)` | Drops a locked-slot entry if it was locked to a player who's no longer actually there (a lock pointing at a player who's just been moved elsewhere would otherwise force them back on the next rebalance). |
| `finishSlotEdit(num)` / `commitSlotEdit(num, qi, qDraft, lockedSlotsDraft)` | The single write-back point for a slot edit — `commitSlotEdit` writes the draft quarter and locked-slots map onto `STATE`, then `finishSlotEdit` saves, closes the modal, and re-renders with this game's card left open. Every dialog above funnels through this. |

## Called by

`renderSchedule` is one of `renderMain`'s tab entry points. `openFillInDialog` (from
[`ui-setup-and-fillins.md`](ui-setup-and-fillins.md)) is called *into* from
`openAssignFillInDialog`'s "+ New fill-in" button, with a `contextGameNum` so the new
fill-in auto-assigns back to the game it was created from.
