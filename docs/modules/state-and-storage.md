# State & Storage (`app.js`)

## Responsibility

Defines the shape of `STATE`, loads/saves it from `localStorage`, and sanitizes anything
that enters it from an untrusted source (a stored blob from an older app version, a
hand-edited backup file). Every other part of `app.js` reads/writes the module-level `STATE`
object this section owns. See [`data-model.md`](../data-model.md) for the full shape.

## Key functions

| Function | Params | Returns | Side effects |
|---|---|---|---|
| `defaultState()` | — | a fresh `STATE`-shaped object with empty roster, default season/settings | None — pure factory |
| `newGameState()` | — | a fresh per-game object (see `data-model.md` → `GAME`) | None |
| `loadState()` | — | a validated/migrated `STATE` object | Reads `localStorage`; on any parse/validation failure, logs a warning and falls back to `defaultState()` |
| `saveState()` | — | — | Writes `JSON.stringify(STATE)` to `localStorage`; on failure (quota, private mode), toasts and swallows the error |
| `sanitizeSettingsAndSeason(state)` | a state object (mutated in place) | array of correction descriptions | Clamps `season.numGames`/`desiredBenchSize` and every `settings.*` numeric via `RosterSolver.clampSetting`; drops any `settings` key `defaultState()` doesn't have; resets an unrecognised `rosterOffPriority` to its default; coerces `allowOffPreference` to a real boolean |
| `sanitizePrefs(prefs)` | raw array (possibly from an imported file) | array of valid position codes, deduped, order-preserved | None — pure |
| `sanitizeUnavailable(nums)` | raw array | array of finite positive integers | None — pure |
| `gameNums()` | — | `[1..STATE.season.numGames]` | None |
| `scheduledGameNums()` | — | `gameNums()` minus bye games | None. The engine (`computeSeasonRosterOff`, `runGeneration`) iterates this, so byes take no part in roster-off, positions or fairness. |
| `anyPlayer(id)` / `isFillInId(id)` / `playerNames(ids)` | — | regular-or-fill-in lookup / fill-in test / regular names for an id list | None. `isFillInId` is the §6 filter every fairness aggregate uses. |
| `markStale(msg?)` | — | — | `saveState()`, sets `dirtySinceGeneration`, toasts (default "Regenerate to apply.") |
| `getGame(num)` | game number | that game's state object | **Lazily creates** `STATE.games[num]` via `newGameState()` if it doesn't exist yet — this is the only accessor used anywhere for reading or writing a game |
| `ensureGamesExist()` | — | — | Calls `getGame()` for every number in `gameNums()` (materializing any missing ones), then deletes any `STATE.games` entry whose key exceeds the current `numGames` (pruning after the season was shortened) |
| `deleteGame(num)` | game number | `boolean` | Removes game `num`, shifts later games down one key, decrements `numGames`, and renumbers every `player.unavailable` entry (drops `num`, decrements higher). Returns `false` (no-op) if only one game remains or `num` is out of range. Called from the Delete-game button in the expanded schedule card, behind `confirmDialog`; played games may be deleted too. |
| `makeBye(num)` | game number | `boolean` | Resets game `num` to `newGameState()` with `isBye:true` (clears schedule, fill-ins, locks; keeps date/time/location). Returns `false` for played games (§8.1). Bye games are excluded from `computeSeasonRosterOff` and `runGeneration` (no roster-off, no fairness/missed counts) and can't be marked played. Persisted as `plan.games[n].isBye` in the JSON backup. |
| `purgePersonFromGames(id)` | player or fill-in id | — | Drops a removed person from every **unplayed** game: `fillInIds`, `rosterOffLockIds` (a lock naming only them reverts to `null`), `squadIds`/`rosteredOffIds`/`unavailableIds`, `lockedSlots`, and the schedule (their slot becomes unassigned). Played games are left untouched (§8.1) and show the id as "(removed)". |
| `dropOrphanOneOffFillIns(ids)` | fill-in ids | — | Removes any of `ids` that is a one-off (`saved:false`) and no longer assigned to any game. Called by `deleteGame`, `makeBye` and when the season is shortened. |

## Notable behavior

- **`loadState()` is a migration pass, not a raw parse.** It merges parsed JSON onto
  `defaultState()` (so new fields introduced since the save was written pick up their
  default), deletes fields retired since earlier versions
  (any `settings` key not in `defaultState().settings` — dropped by `sanitizeSettingsAndSeason`, not migrated),
  re-sanitizes every player's/fill-in's `prefs`, and validates `activeTab` against
  `VALID_TABS` (falls back to `"setup"` — an unrecognized tab would otherwise crash
  `renderMain`'s dispatch outright on next load).
- **`sanitizePrefs` exists because imported preference strings are untrusted twice
  over**: they're rendered directly into the DOM (so unfiltered input would be a stored
  XSS vector) and used as cost-matrix keys in `solver.js` (so a bogus position code would
  be meaningless to the solver). It filters to the real 7 `POSITIONS` and de-duplicates,
  keeping first occurrence — a duplicated position could otherwise inflate `prefs.length`,
  which feeds directly into the variety term's safety cap in `solver.js`.
- **`getGame(num)` never returns `undefined`.** Every caller across the codebase relies
  on this — there's no separate "does this game exist" check anywhere; existence is
  established implicitly by calling `getGame`.

## Called by

Nearly everything. `loadState()` runs exactly once, at module load
(`let STATE = loadState();`, top of the IIFE). `saveState()` is called explicitly at the
end of essentially every mutating event handler across the UI modules — there's no
autosave/debounce, so a handler that forgets to call it will silently lose that change on
reload.
