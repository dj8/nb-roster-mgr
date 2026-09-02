# Data Model

Everything lives in one JSON-serializable object, `STATE` (see
[`modules/state-and-storage.md`](modules/state-and-storage.md)). This diagram shows its
shape as entities and relationships — it's a description of nested plain-JS-object
structure, not a real database schema (there's no DB; this *is* the `localStorage` blob).

```mermaid
erDiagram
    STATE ||--o{ PLAYER : "players[]"
    STATE ||--o{ FILLIN : "fillIns[]"
    STATE ||--|| SEASON : season
    STATE ||--|| SETTINGS : settings
    STATE ||--o{ GAME : "games{gameNum}"

    STATE {
        number version
        string theme "dark | light"
        string activeTab "one of VALID_TABS"
    }

    PLAYER {
        string id PK "e.g. p_xxxxx"
        string name
        string_array prefs "ordered position codes, best first"
        number_array unavailable "game numbers this player can't attend"
    }

    FILLIN {
        string id PK "e.g. fi_xxxxx"
        string name
        string_array prefs "optional, may be empty (flexible guest)"
        boolean saved "false = one-off, scoped to the game it was created for"
    }

    SEASON {
        number numGames "1-60"
        number desiredBenchSize "0-20"
    }

    SETTINGS {
        number preferenceSlider "0-10, fairness <-> strict preference"
        boolean allowOffPreference
        boolean topTwoOnly "soft nudge, not a hard cutoff"
        number rosterOffWeight "0-10, fairness <-> position coverage"
        object fairnessWeights "bench 1-10, positionPurity 1-10"
    }

    GAME {
        string gameNum PK "object key, e.g. STATE.games['3']"
        boolean isPlayed "true = frozen historical fact, never regenerated"
        number rosterOffOverride "manual roster-off COUNT, or null for auto"
        string_array rosterOffLockIds FK "manual roster-off SELECTION -> PLAYER.id, or null"
        string_array rosteredOffIds FK "-> PLAYER.id, computed unless isPlayed"
        string_array unavailableIds FK "-> PLAYER.id, computed from PLAYER.unavailable"
        string_array squadIds FK "-> PLAYER.id | FILLIN.id, this game's on-court+bench pool"
        string_array fillInIds FK "-> FILLIN.id, assigned to this game"
        object lockedSlots "'qi-pos' -> playerId|fillInId, manual per-slot lock"
        boolean strictSpecialistPairing "per-game coverage-protection toggle"
        boolean shortfall "available regulars + fill-ins < 7"
        number minFillIns
        number recommendedFillIns
        boolean noBenchOnly "squad==7, no shortfall: valid, no bench that game"
        boolean generated
        string error "coach-facing message; null if schedulable"
    }

    GAME ||--o| SCHEDULE : "schedule (null until generated)"

    SCHEDULE {
        array quarters "always length 4"
    }

    SCHEDULE ||--|{ QUARTER : "quarters[0..3]"

    QUARTER {
        object onCourt "position code -> playerId|fillInId, up to 7 keys"
        string_array bench "playerId|fillInId, in no particular order"
        object offPreference "position code -> true, only for off-pref fills"
    }

    QUARTER }o--|| POSITION : "onCourt is keyed by position code"
    PLAYER   }o--o{ QUARTER : "occupies onCourt/bench slots"
    FILLIN   }o--o{ QUARTER : "occupies onCourt/bench slots"

    POSITION {
        string code PK "GS GA WA C WD GD GK"
        string label "e.g. Goal Shooter"
    }
```

## Notes on the relationships

- **`GAME` is keyed by game number, not id.** `STATE.games` is an object
  `{ "1": GameState, "2": GameState, ... }`, not an array — `getGame(num)` does
  lazy-create-on-read (`STATE.games[key] = STATE.games[key] || newGameState()`).
  `ensureGamesExist()` also *prunes* any game number beyond the current
  `season.numGames` after the season length is shortened.
- **`onCourt` has at most 7 keys**, one per `POSITION` — never more, sometimes fewer (an
  unfilled slot from a manual edit, or entirely absent before generation).
- **`bench.length` is not fixed** — it's `squad.length - 7` for that specific game (squad
  size varies with roster-off/unavailability/fill-ins), and can be `0` (`noBenchOnly`).
- **A player never appears twice across `onCourt` + `bench` in the same quarter.** This
  invariant is maintained by construction in every write path (`solveQuarterPositions`,
  `refineGameQuarters`, and the manual-edit dialogs in `ui-schedule.md`) — CSV import is
  the one place it's re-checked defensively (`sanitizeImportedState`), since an
  externally-edited file could violate it.
- **`PLAYER` and `FILLIN` share an id-space concept but not a table.** A quarter's
  `onCourt`/`bench` ids can be either a `PLAYER.id` or a `FILLIN.id` — resolving one
  always means `byId(STATE.players,id) || byId(STATE.fillIns,id)`. Fill-ins are excluded
  from every season-fairness computation (missed-games counts, cumulative on-court/bench
  totals) even though they occupy real slots.
- **A `FILLIN` with `saved:false`** is a genuine one-off: still stored in
  `STATE.fillIns` (so its `id` resolves normally), but filtered out of the "assign a
  fill-in" candidate list for any game other than the one it was created for.
- **`SCHEDULE.quarters` is always exactly length 4** — hardcoded throughout the engine
  (`for(let q=0;q<4;q++)` in `runGeneration`), not derived from any setting.
