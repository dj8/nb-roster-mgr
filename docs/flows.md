# Key Flows

Sequence diagrams for the flows most likely to trip up a new contributor — full season
generation (where availability, roster-off, and position assignment all interact), the
manual slot-edit cascade, the manual roster-off override, and CSV import. Function names
match `app.js`/`solver.js`/`hungarian.js` exactly; see [`modules/`](modules/) for what
each one does in isolation.

## 1. Season generation ("Generate season" / "Rebalance remaining games")

The flow that ties everything together: Phase 1 decides *who* sits out each whole game
(season-wide), then Phase 2 decides, per game, *which position* everyone plays each
quarter — Phase 2's input (`planGameSquad`) depends on Phase 1's output, so Phase 1 must
finish completely, for every game, before Phase 2 starts on any game.

```mermaid
sequenceDiagram
    actor Coach
    participant UI as renderSchedule (app.js)
    participant Gen as runGeneration (app.js)
    participant P1 as computeSeasonRosterOff (app.js)
    participant Solver as RosterSolver (solver.js)
    participant Hung as Hungarian.solve (hungarian.js)
    participant State as STATE (in-memory)

    Coach->>UI: click "Generate season"
    UI->>UI: disable buttons, label "Generating…"
    UI->>Gen: setTimeout(runGeneration, 0)  note: lets the busy state paint first

    rect rgb(240,240,250)
    note over Gen,Solver: Phase 1 — season-wide, once for the whole season
    Gen->>P1: computeSeasonRosterOff()
    loop each game number
        P1->>State: planGameAvailability(num)
        note right of P1: played game → return frozen facts unchanged (§8.1)<br/>shortfall game → fixedOffIds=[] (roster nobody off)<br/>manual lock (rosterOffLockIds) → fixedOffIds=lock<br/>override count set → rosterOffCount=override<br/>else → rosterOffCount = available-(7+benchSize)
    end
    P1->>Solver: solveSeasonRosterOff({players, games, weights, allowOffPreference})
    Solver->>Solver: buildSeed() — greedy, fairness-first, coverage-aware tie-break
    loop refine() until no improving move or time budget hit
        Solver->>Solver: single-game swap (off↔on within one game)
        Solver->>Solver: paired cross-game exchange (fairness-neutral)
        Solver->>Solver: chained exchange (through an intermediary, isolates the gain to the most/least-missed pair)
    end
    Solver->>Solver: restart with reshuffled game order (deterministic PRNG) if time remains and objective isn't ~0
    Solver-->>P1: {rosterOffByGame, stats}
    P1->>State: write rosteredOffIds, unavailableIds, shortfall,<br/>coverageWarnings, noBenchOnly, squadIds onto every game
    end

    rect rgb(240,250,240)
    note over Gen,Hung: Phase 2 — per game, in game-number order
    loop each unplayed game
        Gen->>State: planGameSquad(num) — Phase 1's roster-off + fill-ins → concrete squad
        alt squad.length < 7
            Gen->>State: game.error = "Not enough players…", schedule=null
        else squad is playable
            loop quarter 0..3 (Phase 2a)
                Gen->>Solver: solveQuarterPositions({squad, benchSlotCount, lockedSlots, cumulative snapshot, settings})
                Solver->>Solver: buildQuarterCostFns() — preference rank + purity + bench-balance cost per cell
                Solver->>Hung: solve(costMatrix)
                Hung-->>Solver: assignment (row→column)
                Solver-->>Gen: {onCourt, bench, offPreference, errors}
                Gen->>Gen: fold this quarter into running cumulative totals immediately
            end
            alt any quarter had an unfillable position (allowOffPreference=off, no candidate)
                Gen->>State: undo this game's cumulative fold, game.error set, schedule=null
            else all 4 quarters filled
                Gen->>Solver: refineGameQuarters({quarters, cumulativeSnapshots, lockedSlotsPerQuarter, settings}) — Phase 2b
                Solver->>Solver: cross-quarter swaps within this game only, until no improvement or time budget hit
                Solver-->>Gen: refined quarters
                Gen->>State: undo pre-refinement fold, re-fold refined outcome (keeps later games' Phase 2a in sync)
                Gen->>State: game.schedule={quarters}, generated=true, error=null
            end
        end
    end
    end

    Gen->>State: saveState() (persists to localStorage)
    Gen-->>UI: {elapsedMs, phase1Stats, cumulative, ...}
    UI->>UI: dirtySinceGeneration = false
    UI->>Coach: toast summary, re-render Schedule tab
```

A played game (`isPlayed`) is skipped by Phase 2 entirely and only contributes its
already-frozen schedule to the running `cumulative` totals — its `rosteredOffIds`,
`unavailableIds`, and `schedule` are never touched by generation, no matter what else
changes (see [`gotchas.md`](gotchas.md)).

## 2. Manual slot edit — the swap cascade

Clicking an on-court cell opens `openSlotEditDialog`. What happens next depends on what
the coach picks — three branches commit immediately, one cascades into a second dialog.
This is the trickiest interaction in the UI layer because moving one player can vacate a
*different* slot that also needs a decision.

```mermaid
sequenceDiagram
    actor Coach
    participant Grid as Rotation grid cell (app.js)
    participant Edit as openSlotEditDialog
    participant Vacancy as openFillVacancyDialog
    participant Commit as commitSlotEdit
    participant State as STATE

    Coach->>Grid: click/Enter on an on-court cell (game, quarter, position)
    Grid->>Edit: openSlotEditDialog(num, qi, pos)
    Edit->>Edit: build player options from game.squadIds — deep-clone the quarter (qDraft), nothing touches STATE yet
    Coach->>Edit: pick a player + Save

    alt picked the same player (lock toggle only)
        Edit->>Commit: commitSlotEdit(qDraft, lockedSlotsDraft)
    else picked "— unassigned —"
        Edit->>Edit: old occupant (if any) moves to qDraft.bench
        Edit->>Commit: commitSlotEdit(qDraft, lockedSlotsDraft)
    else picked a bench player
        Edit->>Edit: straight swap — bench player onto court, old occupant to bench
        Edit->>Commit: commitSlotEdit(qDraft, lockedSlotsDraft)
    else picked a player already on-court at a DIFFERENT position this quarter
        Edit->>Edit: qDraft.onCourt[pos] = chosen — find otherPos (their old slot), qDraft.onCourt[otherPos] = null
        Edit->>Edit: clearStaleLock(otherPos) if it was locked to the now-moved player
        Edit->>Vacancy: openFillVacancyDialog(num, qi, otherPos, displacedPlayer, qDraft, lockedSlotsDraft)
        Vacancy->>Vacancy: offer the displaced player (default) or any bench player to fill otherPos
        Coach->>Vacancy: pick + Save (or Cancel)
        alt Save
            Vacancy->>Vacancy: chosen player fills otherPos — anyone left over goes to qDraft.bench
            Vacancy->>Commit: commitSlotEdit(qDraft, lockedSlotsDraft)
        else Cancel / dismiss
            Vacancy--xState: nothing written — qDraft/lockedSlotsDraft are discarded with the modal
        end
    end

    Commit->>State: game.schedule.quarters[qi] = qDraft, game.lockedSlots = lockedSlotsDraft
    Commit->>State: saveState() — reopen this game's card, re-render
```

**Why the draft/commit split matters:** every branch above builds `qDraft` and
`lockedSlotsDraft` as copies and only `commitSlotEdit` ever writes to live `STATE`. A
Cancel, a backdrop click, or Escape at *any* point — including abandoning the follow-up
vacancy dialog — leaves the schedule byte-for-byte unchanged, because nothing was mutated
in place to begin with. (This replaced an earlier version that mutated `STATE` directly
before opening the follow-up dialog, which had no Cancel button — dismissing it left a
real gap in the quarter with the partial state already persisted. See the comment above
`openSlotEditDialog` in `app.js`.)

## 3. Manual roster-off override

Two different ways to override roster-off for one game, with two different consistency
guarantees:

```mermaid
sequenceDiagram
    actor Coach
    participant Body as renderGameBody
    participant Dialog as openRosterOffDialog
    participant State as STATE

    Coach->>Body: type a number into "Roster-off count override"
    Body->>State: game.rosterOffOverride = N, rosteredOffIds = null, rosterOffLockIds = null
    Body->>State: dirtySinceGeneration = true
    Body->>Coach: toast "Roster-off override set. Regenerate to apply."
    note right of State: the actual WHO is not known until the next<br/>Generate/Rebalance re-runs Phase 1 with the new count

    Coach->>Body: click "Set roster-off manually"
    Body->>Dialog: openRosterOffDialog(num)
    Dialog->>Dialog: expectedRosterOffCount(num) — mirrors the auto-derivation formula, ignoring any existing lock, purely to show a target
    Dialog->>Coach: checkbox list + live "Selected X of Y expected" counter
    Coach->>Dialog: check players, Save
    Dialog->>State: game.rosterOffLockIds = ids, game.rosteredOffIds = ids.slice()
    note right of State: rosteredOffIds is synced immediately — the<br/>"Rostered off" line, coverage warnings, and player-summary<br/>missed-game counts reflect it right away, with NO<br/>dirtySinceGeneration flag set (see gotchas.md)
```

The override-*count* path and the manual-*selection* path leave `STATE` in different
states of freshness — see [`gotchas.md`](gotchas.md#roster-off-dirty-flag-asymmetry).

## 4. Full CSV import (Data tab)

```mermaid
sequenceDiagram
    actor Coach
    participant UI as renderData
    participant Import as importFullCsv
    participant Sanitize as sanitizeImportedState
    participant P1 as computeSeasonRosterOff(preserveExisting=true)
    participant State as STATE

    Coach->>UI: choose file → "Import full CSV"
    UI->>Import: importFullCsv(text)
    Import->>Import: parseCsv() → split into #SECTION blocks (META/SEASON/SETTINGS/PLAYERS/FILLINS/GAMES/SCHEDULE)
    Import->>Import: build a fresh `ns` state object from the sections
    Import->>Sanitize: sanitizeImportedState(ns)
    Sanitize->>Sanitize: drop unknown/duplicate player & fill-in rows,<br/>strip dangling id references from locks/schedule/bench,<br/>clamp season/settings numerics
    Sanitize-->>Import: warnings[]
    Import->>Import: sanitizeSettingsAndSeason(ns) — same numeric clamp used everywhere else
    Import->>State: previousState = STATE, then STATE = ns (swap happens BEFORE the re-solve below)
    Import->>P1: computeSeasonRosterOff(true)
    alt throws
        Import->>State: STATE = previousState (rollback)
        Import--xCoach: toast "Import failed…"
    else succeeds
        note right of P1: preserveExisting=true means an unplayed game's<br/>imported rosteredOffIds is kept as-is instead of being<br/>overwritten by a fresh Phase 1 pick — §9's exact<br/>round-trip requirement. Played games are frozen<br/>facts regardless, same as always.
        Import->>State: saveState()
        Import->>Coach: render() — toast with player/game counts + warning count
    end
```
