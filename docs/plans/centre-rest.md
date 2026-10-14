# Plan: Centre quarters setting + new default workloads (handoff for implementation)

Status: **draft for approval (rev 2).** Branch: `centre-rest` off an up-to-date `main`.
Read `CLAUDE.md`, `docs/gotchas.md` and §4 / §5 / §11 of `docs/Netball_Roster_App_Requirements.md` first.

Two changes, one branch, two commits (A then B):

- **A. New default position workloads** (small, standalone).
- **B. "Centre quarters per game" setting.**

---

## A. New default position workloads

New `DEFAULT_POSITION_LOAD` in `solver.js`:

| GS | GA | WA | C | WD | GD | GK |
|---|---|---|---|---|---|---|
| 0.55 | **0.85** | **0.7** | 1 | **0.7** | **0.85** | 0.55 |

(Was GA/GD 0.7, WA/WD 0.85. Now the order is Centre heaviest, then GA/GD, then WA/WD, then GS/GK.)

Steps:
1. Change the constant. `defaultState()` already copies it; "Reset to defaults" already reads it.
2. **Existing saves:** in `loadState()` and `importBackup()`, if a stored `positionLoad` exactly
   equals the *old* defaults (all seven values), replace it with the new defaults. Any other
   values are the coach's own edits and are kept. Keep the old table as a private
   `PREVIOUS_DEFAULT_POSITION_LOAD` constant next to the new one, with a one-line comment on why it exists.
   No `BACKUP_SCHEMA_VERSION` bump (the field's meaning is unchanged; only its default changed).
3. Update hardcoded defaults in docs and copy: §4 rule 2 ("centre heaviest, then WA/WD, then
   GA/GD…" becomes "then GA/GD, then WA/WD"), the §11 table row, `docs/modules/*.md`, the
   example file in `docs/modules/csv-xlsx-io.md`, and any UI hint text that lists the defaults.
4. Tests: fix only the `LOAD-*` / sweep expectations that hardcode the old numbers. Add **LOAD-n**:
   old-default saves migrate to the new defaults, edited saves don't. Run `npm run test:settings`
   and check the workload sweep still passes SET-7. If it doesn't, stop and report.

---

## B. Centre quarters per game

### 1. Goal

A Settings control with **four settings**: *aim for each player to play Centre in at most
**1 / 2 / 3 / 4** quarters a game.* It's a goal, not a hard cap.

| Setting | What the engine aims for, per player per game |
|---|---|
| **1** | One Centre quarter each. Needs 4 Centres in the squad; with fewer, it falls back to the shapes below. |
| **2** | At most 2 Centre quarters, **never back-to-back** (Q1+Q3, Q2+Q4, Q1+Q4). |
| **3** | At most 3, **never 3 in a row**: the break falls in Q2 or Q3 (`C · C C` / `C C · C`). |
| **4** | No limit. This is today's behaviour exactly, and it's the **default**. |

Shapes get worse in this order: alternating < one back-to-back pair < three in a row < four in a row.
So at any setting, if the squad forces someone over the target, they still get the least-bad shape.

**Rest quarters.** A *rest quarter* is the quarter directly after one of the player's Centre quarters.
- **Positions are ordered by workload, not by the player's own ranking.** Among the positions
  the player listed (never off their list), the lowest-workload one is preferred. With the new
  defaults that's GS/GK first, then WA/WD, then GA/GD. The order uses the coach's own workload
  weights (`positionLoad`), regardless of the workload slider. Positions with equal weight are
  ordered by the player's ranking.
- **The bench is the best rest of all**, and a player gets a better chance of it the more Centre
  quarters they've played in the game. Someone on their 3rd Centre quarter is a stronger bench
  candidate than someone on their 2nd. This only decides who takes the bench seats court-time
  evenness already hands out; it doesn't create extra ones.

Applies per game only, to everyone in the game, fill-ins included (it's player welfare, not season
fairness, like `gameBenchSoFar`). It's independent of the workload slider: that slider decides
*who* rests over the season, this one decides *how a game's quarters are arranged*. Both can be on.

### 2. Priority (§4)

Insert as **rule 3a** (lettered, so the existing `§4 rule 3/5` citations in code don't need renumbering):

> **3a. Centre quarters per game (optional, §11).** Aim for each player's Centre quarters in a
> game to stay within the coach's target (1–4) and not run back-to-back. A rest quarter after Centre
> goes to the lightest position the player listed, or the bench, which is likelier the more Centre
> they've played. Below rules 0–3 (never off-preference, never moves court-time evenness or the
> bench limit). Above preference rank and variety.

Guarantees that must hold **structurally** (not just through tuning):
- Never makes an off-preference fill: every new cost stays far below `OFF_PREFERENCE_LAST_RESORT`.
- Never disqualifies a cell: every new cost is finite, never `BIG_M`. A lone Centre still plays all
  four quarters, with no error.
- At setting 4 the generated season is **byte-identical** to today's.

### 3. Cost model

Every new cost goes on the **position side** of the cell and is multiplied by `prefWeight` (like
rank and variety). That's what keeps the rule below court-time evenness at every preference-slider
value. Don't make these flat costs (add this to `docs/gotchas.md`).

New per-game state, carried in each quarter's `cumulative` snapshot the same way as `gameBenchSoFar` / `benchedLastQuarter`:
- `centreSoFar: {pid: n}`: Centre quarters `pid` has played earlier in this game.
- `centreRun: {pid: n}`: consecutive Centre quarters ending with the previous quarter (only the last Centre has one, and it's > 0).

Setting: `centreQuarters`, an integer 1–4, default 4 (`DEFAULT_SETTINGS.centreQuarters = 4`).

New constants in `solver.js` (starting values; see §6 for tuning):

| Constant | Start | Meaning |
|---|---|---|
| `CENTRE_OVER_TARGET_COST` | 7 (`POSITIONS.length`) | Each Centre quarter beyond the target. Above the widest in-preference rank gap (6) + variety (<1). |
| `CENTRE_BACK_TO_BACK_COST` | 7 | Centre right after Centre, when target ≤ 2. |
| `CENTRE_THIRD_IN_ROW_COST` | 14 | Centre when the run is already ≥ 2, when target ≤ 3. Added to the above. |
| `CENTRE_FATIGUE_COST` | 0.5 | Added to **every on-court cell** (Centre included) per Centre quarter already played this game, when target < 4. The same amount on every position, so it never changes *which* position the player gets, only court vs bench. |

Worked example at target 2: `C·C·` = 0; `C·CC` = 7 (over) + 7 (b2b) = 14; `CCC·` = 7 + 7 + 7 + 14 = 35.

In `buildQuarterCostFns(cumulative, settings)`:

```js
const centreTarget = centreQuartersOf(settings);        // 1..4, rounds + clamps, default 4
const restOrderOf = centreTarget<4 ? restOrderFor(settings) : null; // pos -> raw load (cleanPositionLoad), lighter = better rest
function centreCost(p,pos){            // 0 whenever centreTarget===4
  if(centreTarget===4) return 0;
  const soFar = (cumulative.centreSoFar||{})[p.id]||0, run = (cumulative.centreRun||{})[p.id]||0;
  let cost = CENTRE_FATIGUE_COST*soFar;
  if(pos!=="C") return cost;
  if(soFar>=centreTarget) cost += CENTRE_OVER_TARGET_COST*(soFar-centreTarget+1);
  if(run>=1 && centreTarget<=2) cost += CENTRE_BACK_TO_BACK_COST;
  if(run>=2 && centreTarget<=3) cost += CENTRE_THIRD_IN_ROW_COST;
  return cost;
}
```

Rest-quarter ordering: in `preferenceCost`, when `centreTarget<4`, the player was in Centre last
quarter (`run>=1`), `pos!=="C"` and `pos` is in-preference, return the position's index in the
player's **non-Centre in-preference positions sorted by load ascending** (stable on the player's
ranking) instead of `prefRank`. Same 0..6 scale, so variety and the off-preference costs are
untouched. Players with no list (fill-ins) stay at `NO_PREFERENCE_COST`.

`positionCellCost` becomes `lastResort + prefWeight*(pc + varietyTerm + centreCost)`, with
`centreCost` added only after the `BIG_M` check. `benchCellCost` is unchanged: fatigue makes court
cells dearer, so the bench gets relatively cheaper.

Why "previous quarters only": both phases price every quarter with the same cell functions, so
Phase 2b's game total is exactly what Phase 2a priced. Fatigue also makes 2b prefer benching a
3-Centre player *after* their Centre quarters (that saves the most), which is the behaviour asked for.

Refactor: pull the raw-load step out of `derivePositionLoads` into a shared helper
(e.g. `rawPositionLoads(settings)`) used by both.

### 4. Implementation steps

1. **`solver.js`**: constants and default; `centreQuartersOf`, `rawPositionLoads`; `centreCost`
   plus the rest-quarter ordering in `buildQuarterCostFns` (update its doc comment's `cumulative`
   shape); `refineGameQuarters.gameCost()` re-derives `centreSoFar`/`centreRun` from the candidate
   lineup per quarter, like `gameBenchSoFar`/`benchedLastQuarter` (fill-ins included). Export the
   new constants in `CONSTANTS` and any new helpers. No Phase 1 change.
2. **`app.js`**
   - `defaultState()` and the settings comment (~line 39).
   - `sanitizeSettingsAndSeason`: an integer clamped to 1–4, default 4.
   - Generation loop (~line 599): keep `centreSoFar` and `centreRun`, copy both into each
     `snapshot`, update both after each quarter from `result.onCourt.C`.
   - Settings tab: a new **"Centre quarters"** card after "Position workload". It's a 4-stop range
     (`min 1 max 4 step 1`) with tick labels "1 · 2 · 3 · 4 (no limit)", using the same
     `labelledSliderHtml` wiring. Add it to the slider list.
     - Sub: "How many quarters a player should play in Centre in one game, and how they rest in between."
     - End labels: left "Centres play 1 quarter a game", right "No limit on Centre quarters".
     - Hint: "At 2, a Centre plays alternate quarters (Q1 & Q3 or Q2 & Q4). At 3, they get a break in
       Q2 or Q3. A rest quarter goes to the lightest position the player listed (by the workloads
       above), or the bench, which is likelier the more Centre they've played. It's a goal: with too
       few Centres in the squad someone plays more, but never off-preference, and it never changes
       who sits out how often."
   - Settings-tab metrics (~lines 737 and 2044): "Back-to-back Centre quarters" (season total of
     adjacent same-player Centre pairs) and "Games with a player over the Centre target", both with
     `moves:"centre quarters"`.
   - Backup: add `centreQuarters` to `buildBackup` and `importBackup`, validated as an integer 1–4.
     It's optional, so no schema bump. Update the example in `docs/modules/csv-xlsx-io.md`.
   - Bump `BUILD_NUMBER` in every commit.
3. **Tests (`tests/run.js`, new IDs `CQ-*`, and a new section in the test plan)**
   - CQ-1 `centreCost` table: 0 at setting 4; over-target, back-to-back and third-in-row apply at the
     right targets; fatigue is the same on every position; never ≥ `BIG_M`.
   - CQ-2 Setting 4 is a no-op: a full season is identical to one with `centreQuarters` absent.
   - CQ-3 Target 2, two Centres who are both on court: every game alternates (no adjacent pair, nobody over 2).
   - CQ-4 Target 2 or 3, one Centre benched for a quarter so the other must play 3: the break falls in Q2 or Q3.
   - CQ-5 Target 1, four Centres: each plays Centre once. Target 1 with two Centres: both play 2, alternating.
   - CQ-6 Lone Centre (off-preference off) at target 1: plays all 4, no error, no off-preference fill.
   - CQ-7 Rest ordering: a Centre listing [C, GA, WA, GS] rests at GS. With GS removed, at WA (ignoring rank).
     With edited weights it follows the coach's weights.
   - CQ-8 Bench as rest: same court-time due, the player with 3 Centre quarters takes the bench over the one with 2.
   - CQ-9 Safety across the four sweep fixtures, target 1 vs 4: off-preference count unchanged; per-game
     bench-cap overruns and missed-games unchanged.
   - CQ-10 Phase 2b never raises a game's back-to-back count above its Phase 2a input.
   - CQ-11 Backup round-trip keeps the value; missing means 4; out-of-range or non-integer values are clamped or ignored.
   - CQ-12 A coach locking Centre for one player in Q1 and Q2 still generates, with the locks kept.
4. **`tests/settings-sweep.js`**: metric `centreB2B` (back-to-back Centre quarters, season total,
   `min:1`) and `centreOver` (player-games over target, `min:1`). Entry `centreQuarters`,
   `values:[4,3,2,1]`, `intent:[["centreB2B",-1],["centreOver",-1]]`,
   `side:["top1","playSd","offPref","errors"]`, `contexts:[{}, {preferenceSlider:5}, {loadBalance:10}]`.
   Hard check: `offPref` never rises. Note: `centreOver` is measured against each step's own target,
   so read it with care, or measure against a fixed target of 2. The implementer picks one and documents it.
5. **`tests/ui-smoke.js`**: the control renders with 4 stops and its labels, and persists across reload.
6. **Docs**: §4 rule 3a; §5 Phase 2a cell-cost bullet; §11 table row ("Centre quarters | 1–4,
   default 4 | Centres play 1 quarter a game | No limit | Phase 2a/2b cost model"); test plan section
   plus a §20 mapping; `docs/modules/solver.md`, `engine.md` (snapshot shape), `ui-reports-and-settings.md`,
   `data-model.md`; a `docs/gotchas.md` entry covering the position-side scaling, rest ordering by raw
   load rather than blended load, and "previous quarters only".

### 5. Out of scope

- The same rule for other positions (could generalise later to "max quarters per position per game").
- Season-level Centre limits (the variety and workload sliders already cover that).
- Any Phase 1 change.
- Marking back-to-back Centre cells on the schedule grid (a possible follow-up).

### 6. Tuning protocol

Run `npm test` and `npm run test:settings -- --detail`. Expected results:
- `centreB2B` and `centreOver` fall as the target drops 4→1 on `deep11`/`small9`.
- `thin10` (few Centres) may plateau. That's the roster, not a bug.

Only `CENTRE_*` constants are in scope for tuning. `CENTRE_FATIGUE_COST` is the one most likely to
need adjusting: it should visibly shift who gets the bench (CQ-8) without `playSd` moving by its
noticeable threshold (0.5 pt). If `playSd`, bench-cap overruns or the workload sweep move noticeably,
**stop and report** rather than retuning `COURT_TIME_WEIGHT` / `BENCH_CAP_PENALTY`.

---

## Pre-merge (per `CLAUDE.md`)

Lint, `npm test`, `test:ui` and `test:settings` all clean → `/simplify` → `/code-review` → re-run
the checks → PR to `main`.
