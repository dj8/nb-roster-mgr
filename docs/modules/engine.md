# Engine Orchestration (`app.js`)

## Responsibility

The bridge between `STATE` and the pure `RosterSolver`/`Hungarian` functions: turns live
application state into the plain-data shapes the solver expects, calls it, and writes the
results back onto `STATE.games[...]`. Also owns the season-wide "cumulative" running
totals (on-court/bench/missed counts per player) that Phase 2's cost model depends on for
fairness, and the report aggregations the Reports tab reads. This is the largest
conceptual module but not a separate file — it's interleaved with everything else in
`app.js`.

## Availability & squad planning

| Function | Params | Returns | Notes |
|---|---|---|---|
| `regularRosterInvalid()` | — | error string or `null` | True when `7 + desiredBenchSize` exceeds the roster size — disables Generate/Rebalance |
| `isUnavailable(player, gameNum)` | player, game number | boolean | `player.unavailable.includes(gameNum)` |
| `planGameAvailability(gameNum)` | game number | `{shortfall, minFillIns, recommendedFillIns, availableRegularIds, unavailableIds, rosterOffCount, fixedOffIds}` | **The single source of truth for "what do we know about this game before deciding who's off."** See below. |
| `planGameSquad(gameNum)` | game number | everything from `planGameAvailability` plus `{rosteredOffIds, squad, noBenchOnly}` | The *concrete* squad: available regulars minus whoever's actually off, plus assigned fill-ins. Used both for display and as Phase 2's direct input. |
| `computeCoverageWarnings(plan)` | a `planGameSquad` result | `[{position, count, causedBy}]` | Positions left with ≤1 covering player after roster-off, purely informational |
| `fillInGapSuggestions(gameNum)` | game number | array of position codes | For a shortfall game: positions with ≤1 covering player among those *available* (see [`gotchas.md`](../gotchas.md#coverage-gaps-can-mean-exactly-one-not-zero) for the wording caveat) |

**`planGameAvailability`'s branches, in priority order:**

1. `game.isPlayed` → return the game's *stored* `unavailableIds`/`rosteredOffIds`
   unchanged, computed from nothing live. This must be the first check — see
   [`gotchas.md`](../gotchas.md#played-games-are-a-hard-freeze-§81).
2. `availableRegulars.length < 7` → `shortfall = true`, `fixedOffIds = []` (roster
   nobody off; §6 short-staffed handling).
3. `Array.isArray(game.rosterOffLockIds)` → `fixedOffIds` = that array, filtered to
   currently-available players. (`null` vs `[]` matters — see
   [`gotchas.md`](../gotchas.md#rosteroffLockids-null-vs--are-different-on-purpose).)
4. `Number.isFinite(game.rosterOffOverride)` → `rosterOffCount` = the override, clamped.
5. Otherwise → `rosterOffCount = max(0, available - (7 + desiredBenchSize))` (the default
   auto-derivation).

`fixedOffIds !== null` means Phase 1 doesn't decide this game at all; it's handed to
`solveSeasonRosterOff` as a fixed input that still counts toward the season-wide fairness
objective.

## Cumulative totals

Running per-player counts, folded quarter-by-quarter as generation proceeds, and read
back by `solver.js`'s cost functions to know "how much has this player already played."

| Function | Params | Returns | Notes |
|---|---|---|---|
| `emptyCumulative()` | — | `{missed:{}, onCourt:{}, bench:{}, posCount:{}}` | Fresh accumulator |
| `applyQuarterToCumulative(cumulative, q, sign)` | accumulator, `{onCourt,bench}`, `+1`/`-1` | — (mutates `cumulative`) | Add or *remove* one quarter's contribution — the `-1` direction is what lets Phase 2b's refinement be reconciled without recomputing from scratch (see `runGeneration` below) |
| `foldGameIntoCumulative(cumulative, rosteredOffIds, unavailableIds, schedule)` | — | — (mutates) | A whole game's contribution — missed counts always, on-court/bench counts only if `schedule` is non-null (a `null` schedule, e.g. an errored game, still counts as missed for those who were off/unavailable) |
| `buildOffPrefLog(gameNum, quarterIdx, pos, playerId, squadIds, benchIds)` | — | one log entry `{game,quarter,playerId,playerName,position,unavailableSpecialists,benchedSpecialists}` | Explains *why* an off-preference fill happened — who else prefers that position and why they weren't available (unavailable/rostered-off vs. benched this specific quarter) |

Fill-ins are excluded from all of this — see
[`gotchas.md`](../gotchas.md#fill-ins-are-invisible-to-season-fairness).

## Generation entry points

| Function | Params | Returns | Side effects |
|---|---|---|---|
| `computeSeasonRosterOff(preserveExisting?)` | optional boolean | Phase 1 `stats` object | **Phase 1 only.** Builds `RosterSolver.solveSeasonRosterOff` input from every game's `planGameAvailability`, calls it, writes `rosteredOffIds`/`unavailableIds`/`shortfall`/`minFillIns`/`recommendedFillIns`/`coverageWarnings`/`noBenchOnly`/`squadIds` onto every non-played game. `preserveExisting=true` (used only by CSV import) treats a non-played, non-locked game that already has a non-empty `rosteredOffIds` as fixed, so re-deriving display fields after a CSV load doesn't silently pick a different roster-off set than what was exported. |
| `runGeneration()` | — | `{invalid, offPrefLog, phase1Stats, elapsedMs, cumulative}` | **The full pipeline** — see [`flows.md`](../flows.md#1-season-generation-generate-season--rebalance-remaining-games). Calls `computeSeasonRosterOff()`, then for every non-played game: `planGameSquad` → 4× `RosterSolver.solveQuarterPositions` (folding cumulative after each) → `RosterSolver.refineGameQuarters` → reconcile cumulative → write `game.schedule`/`generated`/`error`. Ends with `saveState()`. This is fully synchronous and can take several seconds — the caller (`renderSchedule`) defers it one tick via `setTimeout(fn, 0)` so a "Generating…" busy state can actually paint first. |

## Report aggregations

Read by the Reports tab ([`ui-reports-and-settings.md`](ui-reports-and-settings.md)) and
by `exportXlsx` ([`csv-xlsx-io.md`](csv-xlsx-io.md)). All derived **fresh from stored
schedules on every call** — never cached — specifically so a manual slot edit or a CSV
import (neither of which goes through `runGeneration`) can't leave these disagreeing with
what's actually in `STATE.games[...].schedule`.

| Function | Returns |
|---|---|
| `computePlayerSummaries()` | one row per player: `{onCourt, bench, missed, gamesPlayedIn, positions:{pos:count}, offPrefPositions:{pos:count}, offPrefTotal}` |
| `computeOffPrefLog()` | every off-preference fill across the whole season, via `buildOffPrefLog` |
| `describeOffPrefReason(o)` | one readable sentence from a log entry — shared by the Reports table and the XLSX export so wording never drifts between them |
| `computeOffPrefRate()` | `{count, totalSlots, rate}` |
| `computeMissedGamesWarningForReports()` | delegates to `RosterSolver.computeMissedGamesWarning` |
| `computeRosterOffAchievabilityNotesForReports()` | delegates to `RosterSolver.computeRosterOffAchievabilityNotes` |

## Callers

`runGeneration()` and `computeSeasonRosterOff()` are called from the Schedule tab
(`renderSchedule`'s Generate/Rebalance buttons) and from `importFullCsv`. The
availability/squad planners (`planGameAvailability`, `planGameSquad`,
`fillInGapSuggestions`) are read constantly by the Schedule tab's rendering and dialogs to
display current facts without needing a fresh generation. The report functions are called
only from `renderReports` and `exportXlsx`.
