# `solver.js` — `RosterSolver`

## Responsibility

The engine's actual decision-making: **Phase 1**, a season-wide search for who sits out
which whole games, and **Phase 2**, the per-quarter cost model that turns "this squad,
these settings, this season-so-far" into a Hungarian cost matrix (2a) plus a bounded
local-search polish across one game's own quarters (2b). Pure — every function takes
plain data in and returns plain data out; no DOM, no `localStorage`, no reference to
`app.js`'s `STATE`. Attached to `window.RosterSolver`.

`app.js` (specifically the functions in [`engine.md`](engine.md)) is the only caller —
it's responsible for turning live `STATE` into the plain-data shapes below and writing
the results back onto `STATE.games[...]`.

## Public API

| Function | Params (shape) | Returns | Notes |
|---|---|---|---|
| `solveSeasonRosterOff(input)` | `{players:[{id,prefs,unavailableCount}], games:[{num,availableIds,rosterOffCount,fixedOffIds,strictSpecialistPairing,allowOffPreference?}], weights:{fairness,coverage}, allowOffPreference, timeBudgetMs}` | `{rosterOffByGame:{num:[ids]}, stats:{passes,elapsedMs,finalCost,timedOut,attempts}}` | Phase 1. See below for the search itself. |
| `solveQuarterPositions(input)` | `{players:[{id,name,prefs,isFillIn}], benchSlotCount, lockedSlots:{pos:id}, cumulative, settings}` | `{onCourt:{pos:id}, bench:[ids], offPreference:{pos:true}, errors:[{position,reason}]}` | Phase 2a, one quarter. Builds a cost matrix and calls `Hungarian.solve`. |
| `refineGameQuarters(input)` | `{quarters, squadPool, cumulativeSnapshots, lockedSlotsPerQuarter, settings, timeBudgetMs}` | `{quarters, stats:{swaps,elapsedMs}}` | Phase 2b, one game's 4 quarters together. |
| `buildQuarterCostFns(cumulative, settings)` | cumulative snapshot + settings | `{positionCellCost(p,pos), benchCellCost(p)}` | The cost model, exposed directly — used by both 2a and 2b so they score identically. |
| `deriveRosterOffWeights(rosterOffPriority)` | `"fairness"`/`"balanced"`/`"coverage"` | `{fairness, coverage}` | Maps the Settings-tab three-way choice onto Phase 1's two internal weights (a lookup in `ROSTER_OFF_COVERAGE_WEIGHT`, whose keys are `ROSTER_OFF_PRIORITIES`). Anything unrecognised is treated as the default, `"fairness"`, whose coverage weight is a tie-break only (1e-6: a whole season of coverage penalties can't outweigh one step of missed-games evenness). |
| `computeCourtTargets(players, total)` | `[{id, floor, cap}]`, on-court quarters to share | `{id: target}` | Season on-court target per regular (§4 rule 2) — see the cost model below. |
| `baseBenchCap(squadSize, benchSlotCount)` | two counts | integer ≥ 1 | Fewest bench stints per game everyone can be held to (§4 rule 3). |
| `planGameBench(input)` | `{squad:[{id,isFillIn}], benchSlotCount, courtTargets, onCourtSoFar, gamesLeft, missed}` | `{benchQuota:{id:n}, benchCap:{id:n}}` | One game's bench quarters due and bench limit per squad member; goes into the `cumulative` snapshot. |
| `derivePreferenceWeights(preferenceSlider)` | 0-10 slider value | `{preference, balance}` (sum to 1) | Maps the preference slider onto the cost model's two weights: ratio geometric from `PREFERENCE_RATIO_AT_0` to `PREFERENCE_RATIO_AT_9`, balance exactly 0 at 10. |
| `isInPreference(p, pos)` | player, position | boolean | The one definition of "in-preference": the position is in the player's list, or the list is empty (a no-preference fill-in is happy anywhere, §6). Used for cost, the `offPreference` flag, and by `app.js` for coverage warnings, the off-preference log and manual-edit labels. |
| `computeMissedGamesWarning(missedByPlayer, threshold?)` | `[{id,name,missed}]` | `null` or `{spread,max,min,mostMissed,leastMissed,suggestion}` | Reports-tab informational warning; never fed back into generation. |
| `computeRosterOffAchievabilityNotes(players)` | `[{name,prefs}]` | `[{position,players,message}]` | Roster-composition note: a position with ≤1 preferrer can't be rested without risking zero coverage, independent of any setting. |
| `clampSetting(v, lo, hi, fallback)` | untrusted value + bounds | number in `[lo,hi]` | Used everywhere an untrusted numeric setting (localStorage, CSV) needs coercing — `NaN` in used to poison every downstream comparison silently. |
| `gameCoveragePenalty(squadAfterOff)` | squad remaining after roster-off | number | Rank-weighted penalty: heavy at 0 remaining covering players for a position, moderate at exactly 1. |
| `hasZeroCoverage(squadAfter)` | squad remaining | boolean | The *hard* version of the above — used to disqualify a Phase 1 move outright when `allowOffPreference` is off (a game's own `allowOffPreference` boolean, when set, overrides the season-wide value for that game's moves). |
| `variance(nums)` | array of numbers | population variance | Phase 1's fairness term. |

`CONSTANTS` (exported object) holds every tunable — weights, time budgets, penalty
magnitudes — for tests and anyone retuning the model to reference by name instead of a
magic number.

## Phase 1 — season-wide roster-off search

**Input framing:** each game is either *decidable* (Phase 1 picks who's off) or *fixed*
(`fixedOffIds != null` — played, shortfall, or manually locked; still counts toward the
fairness objective, just not touched). Objective =
`fairnessWeight * variance(totalMissedGamesPerPlayer) + Σ coverageWeight(game) * gameCoveragePenalty(game)`.

1. **Greedy seed** (`buildSeed`) — walk games in order, at each game greedily pick
   whoever's currently least-missed with the smallest resulting coverage penalty
   (disqualifying zero-coverage picks outright when `allowOffPreference` is off).
2. **Local search** (`refine`), repeated in passes until no move improves or the time
   budget (`PHASE1_TIME_BUDGET_MS`, default 3s) is hit:
   - **Move 1 — single-game swap**: within one game, swap one off-player for one
     on-player if it lowers the objective.
   - **Move 2 — paired cross-game exchange**: player A (off in g1, on in g2) trades
     rest-games with player B (off in g2, on in g1). Leaves both totals unchanged —
     purely a coverage-penalty move, and it's what escapes local optima where the two
     single-game swaps that would get there each look like a fairness regression *on
     their own*.
   - **Move 3 — chained exchange**: the current most-missed (H) and least-missed (L)
     players trade through an intermediary X (H's off-slot in game A goes to X; X's own
     off-slot in a different game B goes to L). X's total is unchanged, so the fairness
     gain is isolated to H (−1) / L (+1) — closes gaps neither move above can reach alone.
3. **Restarts**: if time remains and the objective isn't ~0, reshuffle game order (fixed
   PRNG seed — see [`gotchas.md`](../gotchas.md#phase-1s-restarts-are-deterministic-not-random))
   and rebuild the seed + refine again, keeping the best result. Stops after
   `PHASE1_STAGNANT_ATTEMPTS_LIMIT` (25) non-improving restarts in a row.

`strictSpecialistPairing` (a per-game flag) boosts *that game's own* coverage weight
(`effectiveCoverageWeight`) without touching the season-wide weight used for every other
game — a bounded, local deviation from strict fairness ordering.

## Phase 2a — per-quarter cost model (`buildQuarterCostFns`)

One cost per `(player, column)` cell, where a column is either a position or a bench
slot:

- **`preferenceCost(p, pos)`** — the player's rank in their own `prefs` list (0 = their
  #1 choice); off-preference costs the flat `OFF_PREFERENCE_COST` (7) for every player
  — above any in-preference cell, and independent of list length, so a short-list
  player is never the cheap off-preference fill — or `null` (→ `BIG_M`, disqualified)
  when `allowOffPreference` is off. A player with an *empty* list (a no-preference
  fill-in, §6) is in-preference everywhere (`isInPreference`) and costs
  `NO_PREFERENCE_COST` (1) at every position, whatever the toggle says.
- **`varietyTerm(p, pos)`** — a penalty for a position the player's already played a
  lot this season, scaled by `settings.positionVariety` (0 = none). Capped relative to
  the player's *own* list (`prefs.length - idx`), so a favourite can lose ground to a
  lower choice but an in-preference cell always stays below `OFF_PREFERENCE_COST`.
- **`positionCellCost`** = `preference * (preferenceCost + variety)`, plus
  `OFF_PREFERENCE_LAST_RESORT` (1e5) on an off-preference cell — far above anything the
  bench side can total, far below `BIG_M` — so off-preference is used only when a quarter
  can't be filled in-preference, at every slider value (§4 rule 0). There is no per-player
  court-time term here: each player takes exactly one cell a quarter, so it would only be
  the bench cost with the sign flipped.
- **`benchCellCost(p)`** = `balance * COURT_TIME_WEIGHT * (benchedThisGame + 4 − quota +
  overCap * BENCH_CAP_PENALTY + backToBack)`. `quota` (`cumulative.benchQuota[id]`) is the
  bench quarters this player is due in this game; `overCap` is how far this stint would
  take them past `cumulative.benchCap[id]`. Scaled by the `balance` weight, so it's exactly
  0 at slider=10. Never negative.

`computeCourtTargets(players, total)` gives each regular's season on-court target: one
common level, clamped to `[floor, cap]` per player (quarters already played in frozen
games; those plus every quarter of every game still to come) so the targets sum to
`total`. `planGameBench(input)` turns the targets into one game's `benchQuota`
(`4 − courtStillDue / gamesLeft`, which is what makes a player who misses more games sit
out less; a fill-in gets an even share of that game's bench) and `benchCap`:
`baseBenchCap(squadSize, benchSlots)` (`max(1, ceil(4·bench / squad))`), plus 1 for
players who miss fewer games than the most-missing regular *in that game's squad* (§4 rule 3). `runGeneration`
re-derives the targets and calls it at the start of each game with the live on-court
totals, so a game that fails to schedule leaves no phantom quarters behind.

`solveQuarterPositions` builds the `(squad) × (open positions + bench slots)` matrix from
these, calls `Hungarian.solve`, and maps the result back — any cell that only got
assigned because it was `≥ BIG_M` (i.e. every real option was disqualified) is reported
as an `error` and the player is benched instead of committed to an illegal position.

## Phase 2b — within-game refinement (`refineGameQuarters`)

Cross-quarter pairwise swaps *within one game's own 4 quarters only*, scored on the whole
game's cost. Season-level signals (position counts, bench quota/cap) come from the
**fixed** snapshots captured at the start of each quarter during the Phase 2a forward
pass; the within-game ones (`gameBenchSoFar`, `benchedLastQuarter`) are re-derived from
the candidate lineup, so a swap that benches someone past their cap is priced as that.
Locked slots (`lockedSlotsPerQuarter`) are never touched. Runs until no swap improves or
`PHASE2B_TIME_BUDGET_MS` (500ms) is hit.

## Callers

Everything here is called from `app.js`'s engine layer — see [`engine.md`](engine.md):

- `computeSeasonRosterOff()` → `solveSeasonRosterOff()`
- `runGeneration()` → `solveQuarterPositions()` (once per quarter) then
  `refineGameQuarters()` (once per game)
- `computeMissedGamesWarningForReports()` → `computeMissedGamesWarning()`
- `computeRosterOffAchievabilityNotesForReports()` → `computeRosterOffAchievabilityNotes()`
