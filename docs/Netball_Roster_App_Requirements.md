# Netball Season Roster App - Requirements Specification (v2)

## Revision notes

This supersedes the original requirements spec. It's a full rewrite, not a diff, read it standalone. The changes since v1 fall into four groups, each reflected throughout the document below:

1. **Priority order changed.** Preference-honouring and optimal position placement — per game _and_ across the whole season — is now the dominant objective. Missed-games evenness is a real, weighted, season-wide goal pursued on a best-effort basis, not a strict rule that overrides everything else. See §4.
2. **The assignment algorithm was redesigned.** Per-quarter position assignment is now an exact solve (Hungarian / minimum-cost bipartite matching), not a heuristic. Roster-off allocation is now a genuine season-wide search, not a sequential per-game pick. See §5.
3. **Performance is explicitly not a priority.** A generation pass may take several seconds. See §9.
4. **The single-HTML-file constraint was dropped.** The app may be split across multiple static files. See §9.

---

## 1. Purpose

A tool for a netball team coach/manager to build a fair, position-aware roster for a season: who plays which position each quarter of each game, who is on the bench, who is rostered off entirely, and how to handle games where regular players are unavailable and fill-in players are needed.

This spec is derived from an iterative conversation designing a season roster by hand, and from a subsequent round of algorithm design and bug-fixing conducted directly against a working implementation. It captures the domain rules that emerged from both, not just a feature list.

## 2. Domain Model

### 2.1 Player

- `name` (string, unique)
- `position_preferences`: ordered list of positions, best first (e.g. `["GA", "GS"]`). A player may prefer as few as 2 or as many as 5+ positions. Not every player prefers every position — some positions may only be preferred by 2–3 players on the roster.
- `availability_exceptions`: list of specific games a player is unavailable for (e.g. "away game 7"). Distinct from being _rostered off_ — this is unavailability, not a rotation choice.

### 2.2 Position

The 7 standard netball positions: `GS, GA, WA, C, WD, GD, GK`. Exactly one player occupies each position on court at any time — 7 players on court total. This is fixed, not configurable (see §10).

### 2.3 Game

- `game_number`
- `roster_off_count`: number of players fully excluded from the game squad (not just benched). Default: `available_regular_players - (7 + desired_bench_size)`. Configurable for the season, and overridable per game.
    - **`desired_bench_size` is the only bench/squad-size input exposed to the coach.** There is no separate "target squad size" concept or label anywhere in the UI or data model — it is always derived as `7 + desired_bench_size` internally, never entered directly.
    - `roster_off_count` may be negative in practice: if `available_regular_players` is less than `7 + desired_bench_size`, the bench shrinks below `desired_bench_size` first, before any shortfall/fill-in logic is triggered (see §6). A team of 7 or more is still fielded normally.
    - **Validation**: if `7 + desired_bench_size > roster_size` (the bench target can never be met even at full attendance), the app must flag this configuration as invalid/unreachable rather than silently generating a schedule that can't honor it.
- `squad`: the players available for this game (full roster minus rostered-off minus unavailable players).
- `is_played` (boolean, default false): see §8.1. When true, this game's lineup is locked and excluded from Generate/Rebalance operations, but still counts toward season fairness totals (§4).
- `strict_specialist_pairing` (boolean, default false, **per-game**): when on, roster-off selection for this specific game is allowed a small, bounded deviation from strict missed-games-fairness ordering if doing so meaningfully protects position coverage that would otherwise be put at real risk. Off (default) never makes this trade for this game. See §5.5. This is distinct from the season-wide coverage-awareness that applies by default to every game — see §5.4.

### 2.4 Quarter (within a game)

- `on_court`: mapping of each of the 7 positions to exactly one player from the squad
- `bench`: the remaining squad members not on court this quarter (squad size − 7)
- Bench membership should rotate quarter to quarter within a game — not the same players benched every quarter.

### 2.5 Season

- `num_games` (e.g. 11)
- `roster_size` (e.g. 11 players)
- Derived totals used for fairness checks (see §4).
- `settings`: the season-wide tunable knobs described in §5 and summarized in §11 — preference slider, roster-off fairness/coverage slider, allow-off-preference toggle, top-2-only toggle, bench weight, position-purity weight.

## 3. Core Workflow

1. Coach enters the player list with each player's ordered position preferences.
2. Coach sets season parameters: number of games, `desired_bench_size` (on-court count is always assumed to be 7); `roster_off_count` is derived per §2.3 unless availability/fill-ins override it. Coach also sets the tunable settings described in §5/§11 — sensible defaults are provided (see §11), so this step can be skipped entirely for a first pass.
3. Coach flags any game-specific availability exceptions (players away for a specific game), and optionally enables strict specialist pairing (§5.5) for any individual game where it's needed.
4. App generates a full season roster in two phases (see §5 for full detail):
    - **Phase 1 — season-wide roster-off allocation**: across all games together (not committed one game at a time), decides who is rostered off each game, balancing missed-games evenness against position-coverage retention per the tunable weight in §5.4, gated by the off-preference toggle (§5.2).
    - **Phase 2 — per-game position assignment**: for each game's resulting squad, each quarter's on-court and bench assignment is solved exactly (Phase 2a), then a within-game refinement pass (Phase 2b) considers swaps between that game's own quarters to improve on the sequential per-quarter result. This phase never moves a player between different games — squad membership per game is fixed by Phase 1.
    - For each game, if the resulting squad is smaller than 7, flags a **shortfall** and estimates how many fill-in players are needed (see §6).
    - Any game marked `is_played = true` is skipped entirely — its existing lineup is left untouched (see §8.1), though its actual results still count toward season fairness totals.
5. App reports the plan (see §7) including any positions filled off-preference and why, and any note about roster-off fairness being structurally unreachable for a given player/position (see §5.4).
6. Coach can review, manually override specific assignments, and re-run fairness balancing for the rest of the season.

## 4. Priority Order

These are the goals the engine optimizes for, in priority order. This order changed materially from the original design — preference-honouring now sits above missed-games evenness, not below it.

1. **Preference-honouring and optimal position placement — per game and across the whole season.** This is the dominant objective. The engine actively pursues the best season-long preference outcome, not just a sequence of locally-good decisions per quarter.
2. **Roster-off (missed games) evenness, given known unavailability — a real, weighted, season-wide goal, pursued on a best-effort basis.** It is _not_ a strict rule that blocks or overrides objective 1. When a genuine conflict exists (e.g. a position only a few players cover), the app surfaces this to the coach rather than silently forcing perfect evenness at the cost of preference quality — see §5.4. A player who is unavailable for a game (§2.1 `availability_exceptions`) counts that toward their "missed games" total, and should generally need fewer additional roster-off games elsewhere to stay even with teammates.
3. **On-court time (quarters played) evenness** for players who attend the same number of games.
4. **Bench time (quarters benched, within games actually played) evenness.**
5. **Position variety / balance**: where a player prefers multiple positions, preference their top 2 positions, and use their other preferenced positions only if needed. This is a configurable toggle: top-2-only vs. balance across the player's entire preference list.
6. **Within-game polish**: avoid benching the same player in back-to-back quarters where avoidable, and avoid one player being benched noticeably more than others in that same game.

The app exposes the tunable parts of this ordering as sliders/toggles rather than hard-coding them — see §5 and the settings reference table in §11.

Fairness calculations for a game marked `is_played = true` use that game's actual (locked) lineup as ground truth — locking a game excludes it from being _changed_ by Generate/Rebalance, not from _counting_ toward season totals.

## 5. Position Assignment & Roster-Off Allocation

The engine runs in two phases, described in §3. This section defines both in detail.

### Phase 1 — Season-wide roster-off allocation

Deciding who is rostered off for which game is treated as a genuinely season-wide search: all games are considered together, not committed one at a time in isolation. The search balances two things, both described fully in §5.4: missed-games evenness (objective 2 in §4) and position-coverage retention (in service of objective 1). Both the initial allocation and any subsequent refinement of it must respond to the same tunable weight — a setting that only influences part of this decision pipeline is a defect, not a partial implementation (this was a real bug found and fixed during development, and is now covered explicitly by regression tests — see the accompanying test plan).

### Phase 2a — Exact per-quarter position assignment

For each game's squad (as fixed by Phase 1), each quarter's on-court and bench assignment is solved as an exact minimum-cost bipartite matching (Hungarian algorithm) over a cost matrix of squad players × (7 positions + bench slots). This guarantees the mathematically optimal assignment for that quarter given the current cost model — not a heuristic approximation. Locked slots (manual overrides, §8) are pulled out of the matrix before solving and never revisited by it.

Cost per (player, position) cell:

- **Preference cost**: the player's rank for that position if it's in their preference list (0 = top choice); if it's not in their list, a cost of "one worse than their whole list" (comparable in scale to a real rank, not an arbitrary large constant) — unless the off-preference toggle (§5.2) is off, in which case this cell is disqualified entirely.
- **Balance cost**: how many quarters they've played _overall_ this season so far — under-used players cost less, regardless of position.
- **Position-variety term**: how many times they've already played that exact position this season, tunable via the position-purity weight (§11) — spreads a player across their own preferred positions rather than always giving them the same favorite.

Cost per (player, bench-slot) cell: based on how much bench time they've already had this season and this game — lower cost for players who've had less.

### Phase 2b — Within-game refinement

Solving each quarter exactly in sequence is still myopic _within_ a game: each quarter's solve is optimal given what's happened earlier in that game, but the sequence of four quarters together isn't automatically jointly optimal. After Phase 2a solves all four quarters, a local-search pass considers swapping two players' assigned slots _between two quarters of that same game_ if it strictly reduces the game's total cost. This never touches a different game — a player cannot be moved from one game into another, since squad membership per game is fixed by Phase 1 and only players available for a given game are ever candidates for it. Season-level fairness and variety are still pursued, but through cumulative cost signals (on-court time, position-play counts, bench time) carried forward from game to game in sequence — not by any cross-game swapping.

### 5.1 Preference priority slider

- A single slider/weight controls the trade-off between **preference cost** and **balance cost** in the Phase 2 cost model described above — not simply "how much off-preference is penalized." At the low end, balance cost can legitimately outweigh preference cost, meaning an under-used player can win a position even over a more-preferring but heavily-played specialist, and — if the off-preference toggle allows it — a fresh off-preference candidate can occasionally beat an overplayed specialist. At the high end, preference cost dominates: off-preference fills only occur when no in-preference candidate is eligible at all.
- **The slider must have a monotonic, verifiable effect on the generated schedule**: increasing the slider toward "strict preference" must never _increase_ the number of off-preference fills for the same input data, and should generally decrease it.
- The default should favour preference strongly, reflecting §4's priority reframing — this is a change from the original default, which was closer to neutral.

### 5.2 "Allow off-preference positions" toggle

- A **separate, hard on/off toggle**, independent of the priority slider above.
- **When OFF**: no player may ever be assigned a position outside their stated preference list, under any circumstance, in Phase 2. If a quarter's position cannot be filled by any eligible in-preference player (including fill-ins), the app must raise an explicit error requiring coach action instead of falling back to an off-preference fill.
- **This toggle must also reach Phase 1, not just Phase 2** — this was a real gap found and fixed during development: roster-off allocation previously had no awareness of this setting at all, so toggling it had zero effect on the roster-off split. When off, Phase 1 must treat a candidate roster-off combination that would drop any position to zero in-preference coverage as a **hard disqualification**, not a soft penalty — since handing Phase 2 a squad with a zero-coverage position under this toggle is unsolvable by construction. When on, Phase 1 may still allow a thin/zero-coverage outcome if the fairness gain justifies it under the current weight (§5.4), since Phase 2 has a fallback available in that mode.
- **When ON** (default): off-preference fills are permitted in Phase 2 as a fallback, weighted by the priority slider per §5.1; and Phase 1 treats zero-coverage outcomes as a soft (weighted) penalty rather than a hard rule.
- This toggle governs _whether the off-preference fallback exists at all_, in both phases; the slider only governs _how reluctant_ Phase 2 is to use that fallback when it does exist.

### 5.3 Logging and reporting

- Every off-preference fill must be logged with:
    - game, quarter, player, position assigned
    - which specialist(s) for that position were unavailable/benched that quarter (i.e. _why_ it was necessary)
- The app should report a **season-level count and rate** of off-preference fills (e.g. "12 of 308 on-court slots, ~4%") so the coach can judge whether the trade-off against fairness (§4) is acceptable.
- **This data must also surface per-player in the Player Summary (§7.2)** — a position a player was assigned off-preference is part of that player's position breakdown, not separate from it, and must not be dropped, hidden, or silently zeroed in that view.

### 5.4 Season-wide roster-off fairness ↔ position coverage

- **Coverage-awareness is the default behavior for every game, season-wide — not an optional toggle.** When choosing who to roster off, Phase 1 avoids simultaneously rostering off multiple players who cover the same position(s), weighted by preference rank and by the overlap between the specific players being considered together in the same roster-off decision.
- **A single slider (0–10)** controls the balance between "roster-off fairness" (even missed games) and "position coverage" (protecting scarce positions from being simultaneously stripped). This weight must apply consistently to _every_ decision point in Phase 1's search — both the initial allocation and any refinement pass — not just one part of it.
- When the off-preference toggle (§5.2) is off, position-coverage protection becomes a **hard constraint** within this phase rather than a weighted preference — see §5.2.
- **If perfectly even missed-games is not mathematically achievable** given the roster's actual position-preference distribution (e.g. a position preferred by only one or two players, such that removing them risks zero coverage more often than an even rotation would allow), the app must surface this plainly — naming the affected player(s) and position(s) — rather than silently producing an uneven result or leaving the coach unable to tell whether a setting is broken or the roster itself is the limiting factor.
- In practice, on a roster with reasonable depth at every position (roughly 3+ players covering each), this trade-off rarely bites at all — the two objectives are usually simultaneously achievable, and the slider's main value is as a safety valve for thinner squads or thinner individual positions.

### 5.5 Per-game strict specialist pairing

- A separate, **per-game** toggle (§2.3 `strict_specialist_pairing`) — distinct from the season-wide default coverage-awareness in §5.4, which always applies.
- **When on for a specific game**: roster-off selection for that game is allowed a small, bounded deviation from strict missed-games-fairness ordering, if doing so meaningfully protects position coverage that would otherwise be put at real risk for that game specifically.
- **When off (default)**: no such deviation is made for that game — the season-wide weight from §5.4 governs as normal.
- This exists for the coach to handle a specific problem game (e.g. a night where several specialists for the same position happen to be otherwise tied for fairness) without changing the season-wide balance for every other game.

## 6. Short-Staffed Games / Fill-In Players

- A game may have several regular players unavailable simultaneously (observed case: 6 of 11 players away for one game), leaving too few regulars to field a team.
- Shortfall is defined as `available_regular_players < 7`, **not** merely `roster_off_count < 0`. A negative `roster_off_count` (fielding a team by drawing down the bench below `desired_bench_size`) is normal operation, not a shortfall (see §2.3).
- The app should detect a true shortfall automatically and calculate a **recommended number of fill-in players**:
    - Minimum: enough to fill all 7 on-court positions with no bench at all.
    - Recommended: minimum + a small buffer (e.g. 1) so there's at least some bench rotation for that game, rather than 7 people playing all 4 quarters with no rest.
- A squad of exactly 7 (bench = 0) is a valid minimum configuration and does **not** itself require a fill-in. The app should still flag this state to the coach (e.g. "no bench available this game") and offer recruiting a fill-in as an optional action, not a forced one.
- The app should suggest what positions the fill-ins ideally need to cover, based on gaps in the remaining regulars' preferences for that specific game (e.g. "regulars have no one else who lists WD — recommend a fill-in comfortable there").
- Fill-in players are entered via a dialog, scoped to a single game by default, with their own (possibly short/flexible) position preference list, without being added to the permanent season roster by default.
    - **The dialog's Cancel action must fully discard any entered data and leave roster/schedule state exactly as it was before the dialog was opened.** Cancelling must not leave the dialog in a broken or pre-filled state on next open.
    - Fill-ins **can be saved and reused** across multiple games without re-entering their details each time (a coach will often use the same guest player repeatedly) — this should be an explicit, opt-in choice at the point of adding the fill-in (default to saving, but allow a genuine one-off), not an automatic side effect of creating one.
- This special-case game should **not** be forced through the normal "roster N off" rule (§2.3) — it already has reduced numbers for a different reason (unavailability, not a rotation choice), and should be handled as its own case with its own squad size.
- **Fill-ins do not count toward season player fairness calculations and totals**, even when reused across many games — they are guests, not squad members, and are permanently excluded from the fairness math in §4 by design.

### 6.1 Validation

- If a position has zero eligible players in the available squad even after any fill-ins are added — or if the "allow off-preference positions" toggle (§5.2) is off and no in-preference player is available — the app must surface this as an explicit error requiring coach action (e.g. add/adjust a fill-in, reassign a fill-in's preferences, or manually assign the position). It must not silently fail or produce an incomplete quarter.

## 7. Output / Reporting

The app should be able to produce, at minimum:

1. **Quarter-by-quarter rotation grid**: one row per game+quarter, columns for each of the 7 positions (showing the assigned player) plus a bench column. Should visually distinguish: rostered-off/unavailable players for that game, bench assignments, off-preference fills, fill-in-player slots, and played/locked games (§8.1).
2. **Player summary**: per player across the season — total on-court quarters, total bench quarters, total games missed, and a breakdown of quarters played by position, **including any quarters played off-preference** (§5.3).
3. **Per-game notes for short-staffed games**: who's unavailable, how many fill-ins are recommended and why, and what positions the existing regulars are expected to play that game.
4. **A roster-off achievability note** (§5.4): when perfectly even missed-games is not mathematically reachable given the roster's position-preference depth, name the affected player(s)/position(s) explicitly, distinct from the general missed-games-spread warning below.
5. **A missed-games spread warning**: independent of the achievability note above, flag when the _actual generated result_ has an uneven missed-games spread beyond a reasonable threshold — this can fire even on a roster where perfect evenness was achievable, if the current settings happened to produce an uneven outcome anyway.
6. Exportable to a spreadsheet (e.g. `.xlsx`) with the above as separate sheets/tabs.

## 8. Editing & Recalculation

- Coach can manually reassign any player/position/bench slot after generation.
- After a manual edit, the app should be able to **re-balance the remainder of the season** to restore fairness (§4) given the edits already locked in, rather than requiring a full manual redo.
- Manual edits should be lockable ("don't change this") so re-balancing works around them.
- "Generate" and "Rebalance" are, under this design, the same underlying operation: a full re-run of Phase 1 and Phase 2 across all non-played games, honoring every existing lock and manual edit. There is no separate incremental rebalancing algorithm — this is a deliberate simplification, not a missing feature, and should be documented as such so it isn't mistaken for an oversight.

### 8.1 Played-game locking

- A coach can mark an entire game as **played** once it has actually happened.
- A played game's full lineup (all quarters, all positions, bench) becomes read-only and is clearly indicated as locked in the UI.
- **Phase 1 and Phase 2 (including the Phase 2b refinement pass) must never modify a played game** — its data is left byte-for-byte unchanged, regardless of what triggers the regeneration (new season generation, availability change, manual edit elsewhere, etc.).
- A played game's actual lineup **still counts** toward season fairness totals (§4) — marking a game played removes it from _editing_, not from the fairness calculation. This is the mechanism by which real-world results (who actually played, once known) feed forward into fairer decisions for remaining games.
- A played game can be unlocked by the coach for manual editing, but it should be immediately re-locked to avoid being updated by re-balancing.

## 9. Non-Functional Notes

- **Speed is explicitly not a priority.** A generation pass may take up to several seconds — this is an accepted trade-off in exchange for exact (not merely heuristic) position optimization and a genuinely season-wide roster-off search. This is a deliberate change from the original spec, which called for instant/interactive regeneration; that requirement no longer holds. Each search phase (Phase 1's season-wide search, Phase 2b's within-game refinement) must still respect a bounded time budget so a pathological input cannot hang the browser indefinitely — if the budget is hit, the best solution found so far is used rather than failing.
- Squad sizes in practice are still small (roughly 8–15 players, 10–15 games), so even with exact/exhaustive-leaning algorithms this remains a small combinatorial problem well within the "several seconds" budget above.
- Primary user is a team coach/manager, likely on mobile, planning outside of any "match day" software — this is season-planning, not live game-day scoring.
- Should support **multiple teams/seasons** over time if reused (not just a single one-off roster), so player and preference data is worth persisting rather than re-entered each time.
- Support CSV import for the player list (name + ordered position preferences), so a season's roster doesn't need to be re-entered by hand each time — consistent with the persistence goal above.
- **This app will be built using HTML, CSS, and JavaScript only — no server-side code or database, and no build step.** It is **no longer required to be a single HTML file** — it may be split across multiple static files (e.g. separate HTML/CSS/JS, and a separate file for the solving algorithm itself, kept apart from UI code so it can be unit-tested in isolation) as long as it remains a zero-build, dependency-free static site, loaded via plain `<link>`/`<script>` tags and deployable as-is to GitHub Pages. Development-time tooling (e.g. a `package.json` for running unit tests or headless UI checks) is fine and does not count against this constraint, as long as it is clearly dev-only and not required to run the shipped app itself.
    - Export must cover the **full** roster state: players, preferences, availability exceptions, `desired_bench_size` and per-game `roster_off_count` values, fill-ins, manual locks (§8), played-game status (§8.1), the per-game strict-specialist-pairing toggle (§5.5), all season-wide settings (§11), and the generated schedule — not just the display grid in §7.1.
    - **All exported fields must round-trip through import without loss or reset.** In particular, per-game `roster_off_count` values must be preserved exactly on import, not reset to zero — this was a specific defect observed during development and is a hard requirement, not a nice-to-have.
    - Persistence between sessions on the same device should use `localStorage` or `IndexedDB`; CSV import/export is the mechanism for _sharing_ between users or devices, not a substitute for local persistence.

## 10. Design Decisions

- **NO** — "quarters per game" and "positions on court" are not configurable for other sports/formats; hard-coded to netball's 4 quarters / 7 positions.
- **YES** — fill-in players for a short-staffed game can be saved for reuse in future games (§6), opt-in at creation time, defaulting to saved.
- **Regeneration cadence**: "Generate" and "Rebalance" are the same underlying full re-run (§8) — there is no separate incremental algorithm. This was a deliberate simplification decided during algorithm design, not an oversight.
- **Off-preference/position-assignment algorithm**: an exact minimum-cost bipartite matching (Hungarian algorithm) per quarter, plus a within-game local-search refinement pass — not a heuristic weighted-cost pass as originally specified. This was a deliberate upgrade during algorithm redesign, chosen specifically because speed is not a priority (§9) and preference-optimality is the dominant goal (§4).
- **Roster-off algorithm**: a season-wide search (not sequential per-game selection), weighted between missed-games fairness and position coverage via a single tunable slider (§5.4) that must reach every decision point in the search — a partial implementation (affecting only some of the decision points) is treated as a defect, per real bugs found during development.
- **Priority reframing**: preference-honouring and optimal position placement were elevated above missed-games evenness as the dominant objective (§4), a direct reversal of the original priority order. Missed-games evenness remains real and weighted, but is now pursued on a best-effort basis with explicit reporting rather than strict enforcement.
- **File structure**: no longer required to be a single HTML file (§9) — may be split for maintainability, provided it remains a static, zero-build, dependency-free site.

## 11. Settings Reference

Every slider in the app must show explicit end-labels describing what moving in that direction actually changes, verified against the real underlying cost/weighting logic rather than generic copy — a mislabeled slider is worse than an unlabeled one. This table is the source of truth for what each one should say and do.

|Setting|Range|Low end means|High end means|Applies to|
|---|---|---|---|---|
|Preference priority slider|0–10|Playing-time fairness & variety can outweigh preference rank|Strict preference honouring — off-preference only when truly unavoidable|Phase 2a/2b cost model (§5.1)|
|Roster-off fairness ↔ coverage slider|0–10|Roster-off fairness (even missed games)|Position coverage (protect scarce positions)|Phase 1, both allocation and refinement (§5.4)|
|Allow off-preference positions|on/off|—|—|Hard toggle, both phases (§5.2)|
|Prefer top-2 positions only|on/off|—|—|Position-variety scope (§4 rule 5)|
|Bench weight|1–10|Less priority on even bench rotation|More priority on even bench rotation|Phase 2a/2b bench-slot cost|
|Position-purity weight|1–10|Repeat a player's favourite position more often|Spread play across their whole preference list|Phase 2a/2b variety term|
|Strict specialist pairing|on/off, **per-game**|—|—|Phase 1 for one specific game only (§5.5)|

Note: there is deliberately no standalone "missed-games weight" slider — that trade-off is controlled entirely by the roster-off fairness ↔ coverage slider above, not a separate dial. An earlier design had a redundant/inert missed-games slider; it was removed rather than fixed, on the basis that fewer, clearer controls beat more numerous overlapping ones.