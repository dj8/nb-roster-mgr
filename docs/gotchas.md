# Global State, Persistence, and Gotchas

Things that aren't obvious from reading any single function — collected here so a new
contributor doesn't have to rediscover them by breaking something.

## Global / module-level state

Everything below is a top-level `let`/`const` inside `app.js`'s single IIFE — there's no
state-management library, no reactive framework, no event bus. Every UI event handler
mutates one of these directly and then explicitly calls `saveState()` and/or a
`render*()` function; nothing re-renders automatically.

| Variable | Persisted? | Purpose |
|---|---|---|
| `STATE` | Yes (`localStorage`) | The entire app: players, fill-ins, season, settings, games. Reassigned wholesale in a couple of places — CSV import (rollback-on-failure pattern) and "Clear all data" (`STATE = defaultState()`) — not just mutated in place. |
| `STATE._lastGeneratedAt`, `STATE._lastGenerationMs` | Yes, incidentally | Set by `runGeneration()`, read by `exportFullCsv()`'s filename and (previously) a UI hint. They're plain properties on `STATE`, so they ride along in the `localStorage` JSON blob even though they're derived/telemetry data, not season data. Harmless — `loadState()`'s merge doesn't validate unknown fields — but not intentionally part of the persisted schema either. |
| `scheduleUiState` (`{openGame, filter}`) | No | Which game card is expanded and which Schedule-tab filter is active. Purely a view-state convenience; lost on reload. |
| `dirtySinceGeneration` | **No, deliberately** | True whenever a setting/override has changed since the last Generate/Rebalance — drives the persistent "stale schedule" banner. Explicitly *not* saved: it describes drift between `STATE` and the last engine run *within this session*, not a fact about the season. A page reload resets it to `false` even if the schedule genuinely doesn't reflect current settings. |
| `_modalReturnFocus`, `_modalTitleSeq` | No | Modal focus-management bookkeeping (`openModal`/`closeModal`). |

## Persistence & sync

- **One `localStorage` key**, `netballRosterApp_v1` (`STORAGE_KEY`), holding the entire
  `STATE` as JSON. There is no server and no cross-device sync — a season lives in one
  browser's storage on one device.
- **CSV is the only way to move data between devices/coaches**, and it's a fully manual,
  explicit action (`exportFullCsv` / `importFullCsv` on the Data tab). XLSX export is
  one-way (report output only, not re-importable).
- **`loadState()` runs a migration pass on every load**, not just a raw `JSON.parse`:
  merges parsed data onto `defaultState()` (so a field added in a later version gets its
  default for old saves), deletes fields that have since been retired
  (`settings.strictSpecialistMode`, `fairnessWeights.missed`, `fairnessWeights.onCourt`),
  re-sanitizes every player's/fill-in's `prefs`, clamps season/settings numerics via
  `sanitizeSettingsAndSeason`, and falls back `activeTab` to `"setup"` if it's not a
  recognized tab. **Adding a new `STATE` field means updating `defaultState()`** so old
  saves pick up the default via the `Object.assign` merge — it won't otherwise appear on
  a season saved before your change.
- **No debouncing** — `saveState()` is called synchronously, once per user action, right
  in the event handler that made the change. If `localStorage.setItem` throws (quota
  exceeded, private browsing), `saveState()` catches it and shows a toast, but the change
  stays live in memory only — it will be lost on reload with no further warning.
- **`STATE.theme`** is persisted and also mirrored onto `<html data-theme>` by `render()`
  on every full render; `styles.css` reads that attribute for every color token. Light
  and dark are tuned as separate token sets (not derived from one another) — see the
  `html[data-theme="light"]` / `html[data-theme="dark"]` blocks in `styles.css`.

## Design decisions & gotchas

### Played games are a hard freeze (§8.1)
`planGameAvailability()` checks `game.isPlayed` **before** any shortfall/lock/override
logic, and returns the game's *already-stored* `rosteredOffIds`/`unavailableIds`
untouched — it never recomputes from live `STATE.players` data. This is deliberate: if it
read current availability instead, editing a player's availability *after* a game was
played could silently rewrite that game's historical record. Every place that might touch
a played game (`computeSeasonRosterOff`, `runGeneration`) checks `isPlayed` again and
skips the write, so the invariant holds even if a future change adds a new write path —
but a new write path still has to remember to add that check itself; nothing enforces it
structurally.

### `rosterOffLockIds`: `null` vs `[]` are different, on purpose
`planGameAvailability()` uses `Array.isArray(game.rosterOffLockIds)`, not a
truthy/length check. `null` means "no manual lock, auto-derive"; `[]` means "an explicit
manual choice: roster nobody off this game." A length check would treat both the same —
saving the roster-off dialog with nothing ticked would silently fall through to
auto-derivation instead of honoring "nobody off." (Regression test: `MANUAL-ROSTEROFF-EMPTY-1`.)

### Roster-off "dirty" flag asymmetry
Two different ways to override roster-off for one game leave `STATE` in different states
of freshness, and only one of them tells the coach:

- **Override count** (`rosterOffOverride` field) and the **"Protect position coverage"**
  checkbox both set `dirtySinceGeneration = true` — the persistent Schedule/Settings
  banner appears.
- **Manual roster-off selection** (`openRosterOffDialog`'s Save) writes
  `rosteredOffIds` **immediately** (so the "Rostered off" line, coverage warnings, and
  player-summary counts update right away) but does **not** set `dirtySinceGeneration`.

In both cases the rotation *grid* (who plays which position) is stale until the next
Generate/Rebalance — Phase 2 hasn't re-run. The banner just doesn't fire for the second
case. See [`flows.md`](flows.md#3-manual-roster-off-override).

### Fill-ins are invisible to season fairness
A fill-in can occupy a real on-court or bench slot, but every fairness computation
(`applyQuarterToCumulative`, `foldGameIntoCumulative`, `computePlayerSummaries`) explicitly
filters them out via `STATE.fillIns.some(f=>f.id===pid)` checks. This is intentional (§6)
but easy to forget when adding a new aggregate — a new stat that iterates a quarter's
`onCourt`/`bench` without this check will silently include guests in season totals.

### "Coverage gaps" can mean "exactly one," not "zero"
`fillInGapSuggestions()` (used on a shortfall game) flags a position whenever
`coverage <= 1` — zero **or** one covering player among those available. A coach reading
"Coverage gaps: GS" reasonably assumes nobody covers GS; it may mean there's exactly one
specialist and no backup. Known, discussed, not changed (see
`Codebase_Review_Handoff.md`) — the underlying logic is arguably correct, the label is
just ambiguous and (unlike the similarly-themed coverage-warning pills elsewhere) doesn't
name the lone specialist.

### A squad of exactly 7 has no bench, by design
When a shortfall game's available regulars + assigned fill-ins add up to exactly 7,
`noBenchOnly` is `true` and every player is on court every quarter — there's no bench
slot to rotate through. If there's also no positional slack, the same lineup can
legitimately repeat every quarter with nothing to swap against. This is tested,
documented behavior (`RO-4`/`QR-5`), not a bug, but it reads as "rotation isn't working"
to a coach who doesn't expect it.

### CSV can't distinguish "explicit empty lock" from "no lock"
The `#GAMES` section's `rosterOffLockIds` column is a `|`-joined string; both `null`
(no lock) and `[]` (explicit "nobody off," see above) serialize to an empty string. An
explicit-empty lock survives a CSV export/reimport as if it had never been set. This
distinction round-trips correctly through `localStorage` (real JSON, `null` vs `[]` are
distinguishable) — it's specifically the CSV interchange format that collapses it.
Documented inline in `importFullCsv`.

### Hardcoded season shape: 4 quarters, 7 on-court positions
Neither is a setting. `for(let q=0;q<4;q++)` in `runGeneration`, the `qIdx>3` bounds
check in CSV import, and every `7 + desiredBenchSize` squad-size calculation all assume
exactly 4 quarters and exactly the 7 `POSITIONS`. Changing either would touch the engine,
the CSV format, and the rotation-grid rendering — not a config flag anywhere.

### `BIG_M`, not `Infinity`, marks a disqualified Hungarian cell
`hungarian.js`'s potential-based algorithm (`u`/`v` arrays) does arithmetic on cost
values as it runs; a real `Infinity` poisons that arithmetic (`Infinity - Infinity =
NaN`). `solver.js` uses a large finite sentinel (`BIG_M = 1e9`) instead, and
`solveQuarterPositions` explicitly checks `matrix[rowIdx][colIdx] >= BIG_M` after solving
to detect "this assignment only happened because nothing else was legal" and bench that
player instead of committing an off-preference assignment that should have been
disallowed.

### Phase 1's restarts are deterministic, not random
`solveSeasonRosterOff`'s restart loop reorders games between attempts using a seeded PRNG
(`mulberry32(PHASE1_RESTART_SEED)`), never `Math.random()`. This is purely to give the
greedy seed a different construction order (helps escape local optima the local-search
moves alone can't reach) — it never influences *who* gets rostered off directly. The
fixed seed keeps every run — and every test that asserts an exact result
(`PHASE1-DETERMINISTIC-1`) — reproducible.

### The preference/fairness cost model is deliberately weight-bounded
In `buildQuarterCostFns`, the purity and balance/bench cost terms are capped well below
1 relative to a candidate's own preference-rank gap, specifically so that raising a
fairness/purity/bench slider can **never** make an off-preference candidate look cheaper
than an in-preference one — that's what makes "higher preference slider never increases
off-preference fills" (tested: `SLIDER-SWEEP-REALISTIC-1`, `BENCH-MAXSLIDER-1`) hold.
Retuning these constants without preserving that bound risks silently breaking that
guarantee — it won't throw, it'll just start being wrong in a way only the slider-sweep
tests catch.

### `app.js` exports nothing — tests patch it at load time
There is no `module.exports` anywhere in `app.js` itself (it's a browser-only IIFE).
`tests/harness.js` reads the file's source as text, splices a `module.exports = {...}`
block in just before the closing `})();`, and runs the patched source in a Node `vm`
sandbox with stubbed `document`/`localStorage`/`Blob`/`URL`. **A new top-level function
that needs a unit test must be added to the export list in `tests/harness.js`**, not
exported from `app.js` — and nothing enforces that the two stay in sync besides tests
failing to find the function.

### Two different CSV imports, easy to conflate
- **Setup tab → "Import CSV"** (`importPlayersCsv`): players only, additive — skips a
  name that's already on the roster, doesn't touch games/settings/schedule.
- **Data tab → "Import full CSV"** (`importFullCsv`): full state — replaces `STATE`
  wholesale (players, fill-ins, season, settings, every game and its schedule).

They read different (though overlapping) CSV shapes and are not interchangeable.
