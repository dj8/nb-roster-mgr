# Netball Season Roster App - Authoritative Test Plan

Mapped to `Netball_Roster_App_Requirements.md`. This plan covers the application’s original behavior and the redesigned roster-generation algorithm: season-wide roster-off allocation (Phase 1), exact Hungarian per-quarter assignment (Phase 2a), and within-game refinement (Phase 2b). Each case references the relevant specification area where applicable. Test IDs are stable references for implementation, bug reports, and regression runs.

Unless a case says otherwise, regenerate from identical saved input when comparing settings or solver output. Automated tests should use deterministic seeds or fixtures so failures are reproducible.

---

## 1. Domain Model & Data Entry (§2)

|ID|Case|Steps|Expected|
|---|---|---|---|
|DM-1|Add player with preferences|Add player, name + ordered preference list (e.g. `["GA","GS"]`)|Player saved; preference order preserved exactly|
|DM-2|Reject duplicate name|Add two players with identical name|App blocks or requires disambiguation — no silent overwrite|
|DM-3|Player with 1 preferred position|Add player with single-position preference list|Accepted; player only ever assigned that position or off-preference (if enabled)|
|DM-4|Player with 5+ preferred positions|Add player preferring all 7 positions|Accepted|
|DM-5|Availability exception|Mark a player unavailable for game N|Player excluded from that game's squad automatically; not counted as "rostered off" (§4.1)|
|DM-6|Season setup|Set `num_games`, `roster_size`, `desired_bench_size`|Values persist and drive schedule generation|
|DM-7|`desired_bench_size` = 0, `rostered_off` = 0|Configure a game for full-squad-every-quarter (no bench)|Every player in squad each quarter is on court; app doesn't force a bench (per your Point 1)|
|DM-8|`desired_bench_size` = 4|Configure max bench per your Point 1 example|Squad = 11, bench = 4/quarter, 7 on court — accepted without warning|
|DM-9|Roster size recognition|Set team roster to N players (e.g. 9, 11, 13)|App recognises actual player count; on-court is always assumed 7; **"Desired Bench Size"** is the only bench-related input exposed — there is no separate "Target Squad Size" field or label anywhere in the UI|
|DM-10|Bench size vs. roster size validation|Set `desired_bench_size` such that `7 + desired_bench_size > roster_size`|App flags the configuration as invalid/unreachable rather than silently generating a broken schedule|

---

## 2. Roster-Off Calculation (§2.3, §3)

|ID|Case|Steps|Expected|
|---|---|---|---|
|RO-1|Standard derivation|11 regulars, `desired_bench_size`=2, 0 unavailable|`rostered_off` = 2|
|RO-2|Unavailability absorbs into rostered_off|11 regulars, `desired_bench_size`=2, 2 unavailable for a game|`rostered_off` computed as 0 additional (unavailable already covers the reduction) — no double-counting|
|RO-3|Negative rostered_off, bench draws down first|8 regulars available, `desired_bench_size`=2|Bench shrinks below 2 before anyone is force-added; team of 7+ still fielded; `rostered_off` may compute negative internally without error|
|RO-4|Exactly 7 available|7 regulars available (rest unavailable), `desired_bench_size`=2|Bench = 0, full squad on court every quarter, **no shortfall/fill-in prompt** (per your Point 4)|
|RO-5|Below 7 available|6 regulars available|Shortfall flagged (§6); fill-in recruitment offered, not forced|

---

## 3. Quarter Rotation Generation (§2.4, §3)

|ID|Case|Steps|Expected|
|---|---|---|---|
|QR-1|All 7 positions filled every quarter|Generate schedule for any valid game|Every quarter has exactly one player per position, no position empty or duplicated|
|QR-2|Bench = squad − 7|Any valid squad size ≥ 7|Bench count matches formula exactly each quarter|
|QR-3|Bench rotates within a game|Inspect one game's 4 quarters|No player benched all 4 quarters if squad size allows rotation; bench composition changes across quarters where possible|
|QR-4|No player double-booked|Any quarter|A player is never simultaneously on-court and on-bench, or in two positions|
|QR-5|Squad = 7 exactly|`desired_bench_size` effectively 0|Same 7 players on court all 4 quarters, 0 on bench — valid, not an error|

---

## 4. Hungarian Algorithm Correctness (`hungarian.js`)

|ID|Case|Steps|Expected|
|---|---|---|---|
|HG-1|Optimality on small cases|Brute-force every permutation for n=3,4,5 square cost matrices (including ties and repeated values), compare to `Hungarian.solve`|Hungarian's total cost matches the brute-force optimum exactly, every time|
|HG-2|Square-matrix validation|Call `solve` with a non-square matrix|Throws, does not silently produce a wrong-length assignment|
|HG-3|Disqualified-cell handling|Include `BIG_M` sentinel cells (never true `Infinity`) representing disallowed pairings, confirm the solver avoids them whenever a feasible alternative exists|Optimal assignment never uses a `BIG_M` cell unless every feasible solution requires at least one|
|HG-4|All-disqualified row|Construct a matrix where one row is entirely `BIG_M`|Solver still returns a complete assignment (using the disqualified cell), so the caller can detect infeasibility from the returned cost rather than the solver crashing|
|HG-5|Degenerate n=0/n=1|Call `solve([])` and `solve([[5]])`|Returns `[]` and `[0]` respectively, no error|

---

## 5. Phase 2a — Exact Per-Quarter Position Assignment

|ID|Case|Steps|Expected|
|---|---|---|---|
|P2A-1|Full quarter uses Hungarian, not greedy|Generate any game, inspect that `solveQuarterPositions` builds a square cost matrix (7 positions + bench columns) and calls `Hungarian.solve`|No most-constrained-first / greedy fallback remains in the live code path|
|P2A-2|Locked slots pulled out before solving|Lock a slot (§8 manual lock), regenerate|Locked player/position pair is excluded from the matrix entirely; Hungarian solves only the remaining open positions and players|
|P2A-3|Off-preference cell cost|`allowOffPreference` on, player has no rank for a position|Cost cell = `prefs.length` (worse than every stated preference), not an arbitrary large constant, per the documented cost design|
|P2A-4|Off-preference disqualified|`allowOffPreference` off|Cell = `BIG_M`; if the optimal solution would require it, surface the explicit "no eligible player" error (same class as the original OP-5/OP-9 behavior) rather than silently assigning it|
|P2A-5|Bench cost reflects playing time|Two players tied on preference cost, one has played more quarters this season|Lower-court-time player is preferred for the open position slot (via the documented `balanceCost` term); higher-court-time player more likely lands on a bench column|
|P2A-6|Slider monotonicity holds under the new cost model|Regenerate the same dataset at every `preferenceSlider` value 0–10|Off-preference fill count is monotonically non-increasing as the slider rises (re-verify this still holds — the cost formula changed since it was last confirmed)|

---

## 6. Phase 2b — Within-Game Local-Search Refinement

|ID|Case|Steps|Expected|
|---|---|---|---|
|P2B-1|Refinement stays inside one game|Run `refineGameQuarters` on a game, inspect swap candidates considered|Every swap is between two quarters of the _same_ game — never references another game's squad or schedule|
|P2B-2|Refinement never worsens cost|Snapshot a game's total cost before and after refinement|Post-refinement total cost ≤ pre-refinement cost, always|
|P2B-3|Refinement respects locks and played status|Lock a slot within a game, or mark the game played, then run generation|Locked slot / played game's schedule is byte-for-byte unchanged after refinement|
|P2B-4|Time budget respected|Force `PHASE2B_TIME_BUDGET_MS` very low on a large squad|Refinement stops at the budget and returns the best solution found so far, does not hang|

---

## 7. Season Fairness (§4)

|ID|Case|Steps|Expected|
|---|---|---|---|
|FR-1|Even games-missed|Generate a full season|Spread of (rostered-off + unavailable) counts across players is minimized; no player misses markedly more than peers absent similar availability constraints|
|FR-2|Unavailability reduces need for rostered-off|Player unavailable for 1 game|That player is rostered off less often in remaining games than a peer with no unavailability, converging toward the same total missed-games|
|FR-3|Even on-court quarters|Generate a full season|Players who attend the same number of games have on-court quarter counts within a small tolerance of each other|
|FR-4|Even bench quarters|Generate a full season|Same tolerance check for bench quarters among players attending the same number of games|
|FR-5|Top-2 preference mode|Enable "prefer top 2 only" toggle (§4.4)|Players assigned only their top 2 listed positions except when required by shortfall/off-preference logic|
|FR-6|Full-preference balance mode|Disable the toggle|Players' on-court time spread across their _entire_ preference list, not concentrated on preference #1|
|FR-7|No back-to-back bench (soft)|Inspect any single game|Same player benched in consecutive quarters only when unavoidable given squad size|
|FR-8|Priority weights are adjustable|Change weight/priority order for §4 rules 1–4|Regenerated schedule reflects new priority order (e.g. position-purity weighted above bench evenness produces a measurably different schedule)|

---

## 8. Phase 1 — Season-Wide Roster-Off Allocation

|ID|Case|Steps|Expected|
|---|---|---|---|
|P1-1|Games processed together, not sequentially committed|Inspect `solveSeasonRosterOff`|Builds a full-season seed across all decidable games before any refinement pass runs — no game's roster-off is "final" before the others are considered|
|P1-2|Seed respects missed-count ordering strictly|Any dataset|No candidate with a strictly lower cumulative missed-count is ever passed over in favor of one with a higher count, in the seed step|
|P1-3|**Seed tie-break is weight-aware** _(regression for the bug found this round)_|Build a roster with asymmetric preference overlap (not identical lists), sweep the roster-off weight slider 0→10, inspect which players the _seed_ picks (before refinement runs)|Seed's tie-break score changes with the slider — at the "roster-off fairness" end, coverage impact stops influencing which tied player is picked; confirm by diffing seed output at slider=0 vs slider=10 on the same dataset|
|P1-4|Refinement pass is weight-aware|Same sweep, inspect the refined (final) output|`fairnessWeight`/`coverageWeight` visibly change which swaps the refinement pass accepts|
|P1-5|**`allowOffPreference` reaches Phase 1** _(regression for the bug found this round)_|Toggle "Allow off-preference positions" on and off with everything else identical, regenerate|The roster-off split changes between the two states on a dataset constructed to have a real coverage/fairness conflict — confirm this by asserting the two runs produce _different_ `rosterOffByGame` results, not just checking neither errors|
|P1-6|Off toggle makes zero-coverage a hard disqualification|`allowOffPreference` off, construct a case where a naive fairness-first pick would zero out a position|Phase 1 never selects that combination, in either the seed or refinement — confirm no game in the output leaves a position at 0 in-preference cover|
|P1-7|On toggle keeps it a soft penalty|Same dataset, `allowOffPreference` on|Phase 1 may allow a thin/zero-coverage outcome if the fairness gain justifies it under the current weight, since Phase 2 has a fallback available|
|P1-8|Time budget respected, best-so-far returned|Force `PHASE1_TIME_BUDGET_MS` very low on a large synthetic season|Search stops at budget, returns the best solution found rather than failing or hanging|

---

## 9. New Setting — Roster-Off Weight Slider

|ID|Case|Steps|Expected|
|---|---|---|---|
|SLD-1|Slider exists and persists|Locate the new slider in Settings, change it, reload|Value persists via existing `STATE.settings` persistence, same as other sliders|
|SLD-2|Monotonic effect on missed-games variance|Sweep 0→10 on a dataset with a real fairness/coverage conflict, regenerate at each step|Missed-games variance across the roster is monotonically non-increasing as the slider moves toward the "roster-off fairness" end|
|SLD-3|Reaches the actual solver call|Inspect the `RosterSolver.solveSeasonRosterOff(...)` call site in `app.js`|`weights: {fairness, coverage}` and `allowOffPreference` are computed from live settings and passed on every call — not hardcoded, not omitted|
|SLD-4|Default reproduces prior behavior|Fresh install / default settings, generate a season|Roster-off outcome matches (or closely approximates) the previous hardcoded `1:4` fairness:coverage ratio, so existing users don't see a surprise change on upgrade|
|SLD-5|Hint text accuracy|Read the hint under the new slider|States that the slider has little effect when the roster has good depth at every position — matches actual algorithm behavior (see REG-1 below), not generic copy|

---

## 10. Slider Transparency — End Labels

|ID|Case|Steps|Expected|
|---|---|---|---|
|LBL-1|All four sliders labeled|Open Settings tab|Preference slider, new roster-off weight slider, bench weight, position-purity weight each show a left-end and right-end label describing what moving that direction changes|
|LBL-2|Labels match actual code behavior|For each labeled slider, move it to each extreme and inspect the generated output|The generated result changes in the direction the label claims — e.g. moving toward "Position coverage" measurably protects thin positions more than moving toward "Roster-off fairness" does, on a dataset built to show the difference|
|LBL-3|Reusable component, not four bespoke blocks|Inspect the Settings tab markup/JS|One shared labeled-slider helper is used for all four, not four independently duplicated implementations|
|LBL-4|Consistent visual styling|Visual check across all four sliders|Label placement, font, and color are consistent with each other and with the existing dark/light CSS variable system|

---

## 11. Coverage-Achievability Reporting

|ID|Case|Steps|Expected|
|---|---|---|---|
|WARN-1|Warning fires on genuine scarcity|Construct a roster where one position has exactly 1 preferring player, generate a season|Reports tab shows a note naming that player and position, explaining perfectly even roster-off isn't reachable for them|
|WARN-2|Warning silent on adequate depth|Use the real-roster fixture (REG-1 below), generate a season|No "not mathematically achievable" note appears — depth is sufficient everywhere|
|WARN-3|Existing missed-games spread warning still independent|Re-check `computeMissedGamesWarning` / `MISSED_GAMES_WARNING_SPREAD` behavior|Still fires correctly on a lopsided _result_ (regardless of cause) — this is a different, still-needed check from WARN-1/WARN-2, which flag _structural_ impossibility before generation even runs|

---

## 12. Off-Preference Handling (§5)

|ID|Case|Steps|Expected|
|---|---|---|---|
|OP-1|Off-preference logged|Force a scenario where a scarce position's specialists are all unavailable/benched|Assignment made to a non-specialist; log entry created with game, quarter, player, position, and the specialist(s) unavailable|
|OP-2|Season-level off-preference report|Generate a full season|Report shows count and % of on-court slots that were off-preference|
|OP-3|Strict mode reduces off-preference|Enable "no two scarce-position specialists off/benched together" mode|Off-preference count for that season run is ≤ the count from the default run on the same data|
|OP-4|Strict mode trade-off visible|Compare strict vs. default mode outputs|App surfaces the fairness cost (e.g. bench/rest evenness delta) alongside the off-preference reduction, not just one number|
|OP-5|Zero eligible players even with fill-ins|Construct a squad where a position has no eligible player at all, including fill-ins|App raises an explicit error requiring coach action; does not silently skip or leave the quarter incomplete|
|**OP-6**|**Preference-priority slider takes effect**|**Set the preferred-position priority slider to its maximum (10) on a dataset where off-preference fills occur at a lower setting**|**Off-preference count decreases (or a clear reason is shown why it cannot go lower, e.g. a genuine §5/OP-5 zero-eligible-player case) — slider value must measurably change the generated schedule, not just accept input silently**|
|**OP-7**|**Slider regression sweep**|**Regenerate the same season at each slider value 0–10**|**Off-preference count is monotonically non-increasing as the slider value increases (higher priority on preference ⇒ never more off-preference fills than a lower setting on the same data)**|
|**OP-8**|**"Allow off-preference positions" toggle exists and defaults sensibly**|**Locate the toggle in settings**|**A dedicated on/off toggle is present, separate from the priority slider**|
|**OP-9**|**Toggle OFF forces preference-only assignment**|**Set "allow off-preference positions" to OFF, generate a season (including one with a scarce-position gap as in OP-1)**|**No player is ever assigned a position outside their stated preference list. Where no eligible in-preference player exists for a position/quarter, the app raises the OP-5 explicit error instead of falling back to an off-preference fill**|
|**OP-10**|**Toggle ON restores fallback behaviour**|**Set "allow off-preference positions" to ON, regenerate the same OP-9 dataset**|**Off-preference fills resume as the fallback for genuinely unfillable slots, per OP-1**|
|**OP-11**|**Toggle is independent of the slider**|**Toggle OFF, then move the priority slider through its full range**|**Slider has no effect while toggle is OFF (no off-preference assignments occur regardless of slider value); toggle, not the slider, is the hard on/off control**|

---

## 13. Short-Staffed Games & Fill-Ins (§6)

|ID|Case|Steps|Expected|
|---|---|---|---|
|SS-1|Shortfall detection|Set unavailability so available regulars < 7|App flags shortfall, does not silently generate an invalid/incomplete quarter|
|SS-2|Fill-in count recommendation|Trigger shortfall with e.g. 6 available regulars|App recommends minimum fill-ins to reach 7, plus a buffer suggestion for 1 or 2 bench rotations|
|SS-3|Fill-in position guidance|Trigger shortfall|Suggested fill-in position(s) reflect actual gaps in remaining regulars' preference lists for that game|
|SS-4|Fill-in scoped to one game by default|Add a fill-in for game N|Fill-in does not automatically appear in other games' squads|
|SS-5|Fill-in reusable across games|Reuse a saved fill-in in game M|Fill-in available for selection in future games without full re-entry (per your Point 3)|
|SS-6|Fill-ins excluded from fairness totals|Generate season stats after using a fill-in in multiple games|Fill-in's on-court/bench time does not affect regular players' fairness calculations or appear in season fairness balancing targets|
|SS-7|Exactly 7 available, no unavailability-driven shortfall|7 regulars available|Flagged as "no bench" per RO-4/SS-1 boundary, but **not** routed through the fill-in-required shortfall flow — optional fill-in offer only|
|**SS-8**|**Fill-in dialog Cancel button**|**Open the fill-in creation/edit dialog, enter some data, click Cancel**|**Dialog closes with no fill-in created/modified and no partial data saved; underlying roster/schedule state is unchanged from before the dialog was opened**|
|**SS-9**|**Cancel does not consume the dialog's next open**|**After SS-8, reopen the fill-in dialog**|**Dialog opens fresh (empty/default state), not pre-filled with the cancelled entry, and is fully interactive (regression against a "cancel leaves dialog in a broken state" class of bug)**|

---

## 14. Output / Reporting (§7)

|ID|Case|Steps|Expected|
|---|---|---|---|
|OUT-1|Rotation grid completeness|Generate season, view grid|One row per game+quarter; all 7 position columns + bench column populated per §7.1|
|OUT-2|Visual distinction|View grid|Rostered-off/unavailable, bench, off-preference, and fill-in slots are each visually distinguishable from each other|
|OUT-3|Player summary accuracy|Cross-check one player's summary against raw schedule data|On-court quarters, bench quarters, games missed, and position breakdown all match actual generated schedule|
|OUT-4|Short-staffed game notes|View notes for a flagged shortfall game|Shows who's unavailable, fill-in recommendation + rationale, and expected regular-player positions|
|OUT-5|XLSX export structure|Export season|Separate sheets/tabs present for rotation grid, player summary, and shortfall notes|
|OUT-6|XLSX opens cleanly|Open exported file in Excel/LibreOffice/Google Sheets|No corruption, formatting errors, or missing data|
|**OUT-7**|**Off-preference data appears in Player Summary**|**Generate a season containing at least one off-preference fill (OP-1), open Player Summary for the affected player**|**The off-preference position(s) and their count appear in that player's position breakdown — a position played off-preference must not be dropped, hidden, or merged silently into "0" for that player**|
|**OUT-8**|**Player Summary off-preference count matches log**|**Sum off-preference occurrences for a player from the season-level log (OP-2), compare to Player Summary**|**Counts match exactly — no discrepancy between the raw log and the summarised view**|

---

## 15. Editing & Recalculation (§8)

|ID|Case|Steps|Expected|
|---|---|---|---|
|ED-1|Manual reassignment|Change a player/position/bench slot manually|Change is applied and persists|
|ED-2|Lock manual edit|Lock an edited slot, then trigger re-balance|Locked slot is unchanged after re-balance; rest of season adjusts around it|
|ED-3|Re-balance improves fairness|Make several manual edits that skew fairness, then re-balance|Post-rebalance fairness metrics (§4) are measurably better than the skewed state, for all non-locked games|
|ED-4|Re-balance doesn't touch past/locked games|Lock all games up to game N, edit game N+1, re-balance|Games ≤ N unchanged|
|**ED-5**|**Mark a game as "played" / locked**|**Select a completed game, mark it played/locked**|**Game's lineup (all quarters, all positions, bench) becomes read-only in the UI; a clear locked indicator is shown**|
|**ED-6**|**Generate/rebalance skips played games**|**Lock game N as played, then run Generate for the season or Rebalance for remaining games**|**Game N's data is byte-for-byte unchanged after the operation; only unplayed/unlocked games are affected**|
|**ED-7**|**Played-game lock survives fairness recalculation**|**Lock game N, generate several subsequent games, check season fairness totals**|**Game N's actual (locked) assignments are still correctly counted toward season fairness totals (§4) — locking excludes it from _being changed_, not from _counting_**|
|**ED-8**|**Unlock a played game**|**Unlock a previously locked game, edit it, regenerate**|**Game becomes editable again and participates normally in rebalancing once unlocked**|

---

## 16. CSV Import / Export (Non-functional note)

|ID|Case|Steps|Expected|
|---|---|---|---|
|CSV-1|Export completeness|Export roster data|File includes players, game bench sizes, preferences, availability exceptions, fill-ins, manual locks, and generated schedule — not just the display grid|
|CSV-2|Round-trip fidelity|Export, then import into a fresh instance|All data reconstructed identically (byte-for-byte on structured fields, not just visually similar)|
|CSV-3|Import into mid-session state|User B imports User A's export, makes edits|User B can continue editing/regenerating without needing User A's original session|
|CSV-4|Malformed CSV handling|Import a corrupted/hand-edited CSV with missing fields|App rejects with a clear error, does not crash or silently produce a partial/broken roster|
|CSV-5|Player-list-only CSV import|Import a CSV containing just names + preferences (§9 persistence use case)|Players created correctly without requiring a full schedule/export file|
|**CSV-6**|**Rostered-off fields survive export/import**|**Generate a season with non-zero rostered-off values on multiple games, export, then import into a fresh instance**|**Each game's rostered-off player list/value matches the pre-export state exactly — must NOT reset to zero/empty after import**|
|**CSV-7**|**Rostered-off fields survive re-export**|**Import a file per CSV-6, immediately re-export without editing**|**Re-exported file's rostered-off data still matches the original — rules out a display-only bug masking bad underlying import data**|
|**CSV-8**|**Locked/played-game status included in export**|**Lock a game (ED-5), export, import into a fresh instance**|**Imported game retains its locked/played status and unchanged lineup (regression coverage for the same class of bug as CSV-6, applied to game-lock state)**|

---

## 17. Client-Only Architecture (Non-functional)

|ID|Case|Steps|Expected|
|---|---|---|---|
|ARCH-1|No network calls|Load app, generate/edit a full season, with network disabled/offline|App functions fully offline (aside from initial page load)|
|ARCH-2|Persistence survives reload|Generate a season, refresh the browser|Data persists via `localStorage`/`IndexedDB` without re-entry|
|ARCH-3|No cross-device sync assumed|Open app in a second browser/device without CSV import|Confirms no data present — validates that CSV is in fact the only sharing path, per the non-functional note|
|ARCH-4|Performance|Generate a full season (11–15 games × 4 quarters, ~10–15 players)|Schedule generation completes interactively (sub-second to low seconds), no visible freeze|

---

## 18. Real-Roster Regression Fixture

This exact roster surfaced the two real bugs this round (seed ignoring the weight; `allowOffPreference` never reaching Phase 1) and should be a permanent fixture in the test suite, not a one-off manual check.

```
Liv:     GA, GS
Poppy:   GS, GA, WA, C, WD
Mabel:   WA, GA, C, GS, WD
Izzy:    WA, WD
Layla:   WA, WD
Ella:    C, GA, WA
Zara:    C, WA, WD
Maddie:  WD, WA
Abby:    GD, WD, GK
Avalon:  GD, GK
Savanah: GK, GD
```

Full-list position coverage: GS=3, GA=4, WA=7, C=4, WD=7, GD=3, GK=3.

|ID|Case|Steps|Expected|
|---|---|---|---|
|REG-1|Exact even split, all four setting combinations|11 players, 11 games, no unavailability, desired bench size 2 (→ `rosterOffCount=2`/game). Generate at: {slider=0, off}, {slider=0, on}, {slider=10, off}, {slider=10, on}|**Every player ends up with exactly 2 missed games in all four runs.** Coverage math (min depth 3, max 2 rostered off per game) makes this deterministically achievable — treat any other result as a failing test, not "close enough"|
|REG-2|No coverage warning on this roster|Run WARN-1/WARN-2 check against this fixture|No structural-impossibility note appears in Reports, in any of the four combinations above|
|REG-3|Toggle visibly changes output on a thinner variant|Tighten the fixture (e.g. drop Mabel's GS/GA/WD entries to isolate GS/GD/GK back down to 2 coverers each), regenerate with the toggle on vs. off|`rosterOffByGame` output differs between the two toggle states — this is the direct regression check for the "toggling off-preference does nothing" bug|
|REG-4|Regression against original test plan|Re-run DM-1–DM-10, RO-1–RO-5, QR-1–QR-5, FR-1–FR-8, OP-1–OP-11, SS-1–SS-9, OUT-1–OUT-8, ED-1–ED-8, CSV-1–CSV-8, ARCH-1–ARCH-4 from the original test plan against the redesigned solver|All still pass — the algorithm rewrite must not regress any previously-verified behavior|

---

## 19. Performance

|ID|Case|Steps|Expected|
|---|---|---|---|
|PERF-1|Realistic season completes within budget|12 players, 15 games, no unusual constraints, generate|Total generation time (Phase 1 + Phase 2a × all quarters + Phase 2b × all games) is reported (console or UI) and completes within a few seconds, consistent with "speed is not a priority, but shouldn't hang"|
|PERF-2|Large/pathological input doesn't hang|Push toward the upper end of realistic sizes (e.g. 20 players, 20 games) or a deliberately conflict-heavy dataset|Phase 1 and Phase 2b both respect their time budgets and return best-so-far rather than running indefinitely|

---

## 20. Targeted Regression Mappings

Run the full suite for releases. Use this table for focused verification of previously reported defects and redesign risks.

|Reported issue or risk|Covering test IDs|
|---|---|
|"Target Squad Size" terminology / player-count recognition|DM-9, DM-10|
|Off-preference assignments occur regardless of priority slider value|OP-6, OP-7, P2A-3, P2A-4, P2A-6, HG-1|
|Off-preference toggle has no effect|OP-8–OP-11, P1-5–P1-7, REG-3|
|Off-preference positions missing from Player Summary|OUT-7, OUT-8|
|Fill-in dialog Cancel button not working|SS-8, SS-9|
|Rostered-off fields zeroed after CSV import|CSV-6, CSV-7|
|Played games change during Generate or rebalance|ED-5–ED-8, CSV-8, P2B-3|
|Only one roster generated or settings do not change output|SLD-2, SLD-3, P1-3, P1-4|
|Cross-game swaps from the superseded refinement design|P2B-1|
|Roster-off ignores position coverage|P1-3–P1-7, WARN-1|
|Exact 11-player/11-game/two-missed split incorrectly deemed unreachable|P1-3, REG-1, REG-2|
|Sliders lack useful explanations or behave contrary to labels|LBL-1–LBL-4, SLD-5|
|Roster-off fairness versus coverage cannot be tuned|SLD-1–SLD-5|
|Algorithm redesign regresses established behavior|REG-4|

## 21. Out of Scope

- Multi-user concurrent editing; the client-only application has no server-backed collaboration.
- Cross-browser or cross-device automatic sync; CSV remains the supported sharing mechanism.
- Load or stress testing beyond the realistic squad and season sizes covered by ARCH-4 and PERF-1/PERF-2.
