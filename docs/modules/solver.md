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
| `solveSeasonRosterOff(input)` | `{players:[{id,prefs,unavailableCount}], games:[{num,availableIds,rosterOffCount,fixedOffIds,strictSpecialistPairing}], weights:{fairness,coverage}, allowOffPreference, timeBudgetMs}` | `{rosterOffByGame:{num:[ids]}, stats:{passes,elapsedMs,finalCost,timedOut,attempts}}` | Phase 1. See below for the search itself. |
| `solveQuarterPositions(input)` | `{players:[{id,name,prefs,isFillIn}], benchSlotCount, lockedSlots:{pos:id}, cumulative, settings}` | `{onCourt:{pos:id}, bench:[ids], offPreference:{pos:true}, errors:[{position,reason}]}` | Phase 2a, one quarter. Builds a cost matrix and calls `Hungarian.solve`. |
| `refineGameQuarters(input)` | `{quarters, squadPool, cumulativeSnapshots, lockedSlotsPerQuarter, settings, timeBudgetMs}` | `{quarters, stats:{swaps,elapsedMs}}` | Phase 2b, one game's 4 quarters together. |
| `buildQuarterCostFns(cumulative, settings)` | cumulative snapshot + settings | `{positionCellCost(p,pos), benchCellCost(p), isDisqualified(p,pos)}` | The cost model, exposed directly — used by both 2a and 2b so they score identically. |
| `deriveRosterOffWeights(rosterOffWeight)` | 0-10 slider value | `{fairness, coverage}` | Maps the single Settings-tab slider onto Phase 1's two internal weights. |
| `computeMissedGamesWarning(missedByPlayer, threshold?)` | `[{id,name,missed}]` | `null` or `{spread,max,min,mostMissed,leastMissed,suggestion}` | Reports-tab informational warning; never fed back into generation. |
| `computeRosterOffAchievabilityNotes(players)` | `[{name,prefs}]` | `[{position,players,message}]` | Roster-composition note: a position with ≤1 preferrer can't be rested without risking zero coverage, independent of any setting. |
| `clampSetting(v, lo, hi, fallback)` | untrusted value + bounds | number in `[lo,hi]` | Used everywhere an untrusted numeric setting (localStorage, CSV) needs coercing — `NaN` in used to poison every downstream comparison silently. |
| `gameCoveragePenalty(squadAfterOff)` | squad remaining after roster-off | number | Rank-weighted penalty: heavy at 0 remaining covering players for a position, moderate at exactly 1. |
| `hasZeroCoverage(squadAfter)` | squad remaining | boolean | The *hard* version of the above — used to disqualify a Phase 1 move outright when `allowOffPreference` is off. |
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
  #1 choice); off-preference costs `max(1, prefs.length)` (never 0 — an empty
  preference list must never look cheaper than a real rank-0 specialist), or `null`
  (→ `BIG_M`, disqualified) when `allowOffPreference` is off.
- **`purityAndVarietyTerm(p, pos)`** — a small penalty for a position the player's
  already played a lot this season (`purityWeight`), plus an extra nudge away from a
  3rd+-ranked position when `topTwoOnly` is on. Capped relative to the player's *own*
  gap to their off-preference fallback (`prefs.length - idx`), so it can never flip an
  in-preference rank into losing against an off-preference candidate.
- **`balanceCost(p)`** — this player's season-so-far on-court *rate* (not raw count —
  rate is what keeps a coach mid-way through an 11-game season and one three games into
  a 20-game season judged the same way), scaled by `benchWeight`.
- **`positionCellCost`** = `sliderNorm * (preferenceCost + purity) + (1-sliderNorm) * balanceCost`,
  where `sliderNorm = preferenceSlider/10`. At slider=10 this is pure preference cost;
  lower values blend in fairness/balance.
- **`benchCellCost(p)`** — scaled by the *same* `(1-sliderNorm)` factor (so it's exactly
  0 at slider=10 — bench pressure can never outcompete preference once the coach asks
  for strict preference), plus an unscaled small back-to-back-bench penalty (a tie-break,
  not part of the preference/fairness trade-off).

`solveQuarterPositions` builds the `(squad) × (open positions + bench slots)` matrix from
these, calls `Hungarian.solve`, and maps the result back — any cell that only got
assigned because it was `≥ BIG_M` (i.e. every real option was disqualified) is reported
as an `error` and the player is benched instead of committed to an illegal position.

## Phase 2b — within-game refinement (`refineGameQuarters`)

Cross-quarter pairwise swaps *within one game's own 4 quarters only*, scored against
**fixed** cumulative snapshots captured at the start of each quarter during the Phase 2a
forward pass (not re-propagated through downstream quarters — keeps it fast and simple).
Locked slots (`lockedSlotsPerQuarter`) are never touched. Runs until no swap improves or
`PHASE2B_TIME_BUDGET_MS` (500ms) is hit.

## Callers

Everything here is called from `app.js`'s engine layer — see [`engine.md`](engine.md):

- `computeSeasonRosterOff()` → `solveSeasonRosterOff()`
- `runGeneration()` → `solveQuarterPositions()` (once per quarter) then
  `refineGameQuarters()` (once per game)
- `computeMissedGamesWarningForReports()` → `computeMissedGamesWarning()`
- `computeRosterOffAchievabilityNotesForReports()` → `computeRosterOffAchievabilityNotes()`
