/* ============================================================
   Roster solver: season-wide roster-off search (Phase 1),
   per-quarter Hungarian position assignment (Phase 2a), and
   within-game local-search refinement (Phase 2b). Pure —
   plain data in, plain data out, no DOM/localStorage/STATE.
   Depends on hungarian.js (must load first).
   ============================================================ */
(function(root){
"use strict";

const POSITIONS = ["GS","GA","WA","C","WD","GD","GK"];

/* ---------------- Tunable constants (retune here) ---------------- */
const PHASE1_FAIRNESS_WEIGHT = 1;
const PHASE1_COVERAGE_WEIGHT = 4;       // dominant over fairness — preference-enablement matters more
const PHASE1_TIME_BUDGET_MS = 3000;
const PHASE1_MAX_PASSES = 50;
const COVERAGE_GAP_ZERO_PENALTY = 100;  // zero players left covering the position
const COVERAGE_GAP_ONE_PENALTY = 30;    // exactly one player left covering it
const FORCED_ON_COURT_PENALTY = 0.02;   // per squad member who can't be benched without leaving a position uncovered in-preference. A tie-break below per-position coverage too: a whole season's worth (12 players x 60 games) stays under the smallest coverage step (30)
const ROSTER_OFF_TIEBREAK_WEIGHT = 1e-6; // small enough that a whole season of penalties can't outweigh the smallest gain in missed-games evenness
const MISSED_GAMES_WARNING_SPREAD = 2;  // Reports-tab warning threshold (max-min missed games)
const PHASE2B_TIME_BUDGET_MS = 500;
const BIG_M = 1e9;                      // disqualified-cell sentinel; finite so Hungarian's potential arithmetic stays sane
const THIN_POSITION_PREFERRER_THRESHOLD = 1; // at or below this many preferrers, resting anyone risks zero coverage
const COURT_TIME_WEIGHT = 24;           // bench-cell cost per bench quarter a player is ahead of their share this game (before the balance weight): at the default slider, about two preference-rank steps
const BENCH_CAP_PENALTY = 6;            // §4 rule 3: a bench stint beyond a player's per-game cap costs this many quarters of imbalance — a strong goal (outweighs any preference-rank gap), not a hard cap
const BACK_TO_BACK_BENCH_PENALTY = 0.5; // §4 rule 5, in the same units
/* §4 rule 3a, in "centre units" (buildQuarterCostFns: one preference-rank step plus one quarter of court-time
   imbalance), so the Centre target outranks both at every preference-slider value but stays under the per-game
   bench limit; finite, so never a disqualified cell. Scaling them by the preference weight alone (the first
   version) left them worth almost nothing at a low preference slider: a coach at slider 1 saw a Centre play all four. */
const CENTRE_OVER_TARGET_COST = 1;      // per Centre quarter beyond the coach's target
const CENTRE_BACK_TO_BACK_COST = 1;     // Centre straight after Centre, at a target of 1-2
const CENTRE_THIRD_IN_ROW_COST = 2;     // a third Centre in a row, at a target of 1-3 (on top of the two above)
const CENTRE_PLAN_CANDIDATES = 4;      // squad members tried as each quarter's Centre when planning a game's Centre sequence: at most 4^4 = 256 sequences
const CENTRE_FATIGUE_COST = 0.25;      // every on-court cell, per Centre quarter already played this game (target < 4): same on every position, so it moves court vs bench, never which position
const OFF_PREFERENCE_COST = POSITIONS.length; // same for every player, and above any in-preference cell (worst rank is 6)
const OFF_PREFERENCE_LAST_RESORT = 1e5;  // added to every off-preference cell: above anything court-time evenness can add up to, far below BIG_M — so evenness never buys an off-preference fill
const NO_PREFERENCE_COST = 1;           // a player who stated no preferences (a fill-in, §6) is happy anywhere: level with a #2 choice, never ahead of a #1
const PREFERENCE_RATIO_AT_0 = 0.5;     // preference:balance weight ratio at slider 0 — low, but never 0 (0 would make off-preference free)
const PREFERENCE_RATIO_AT_9 = 16;       // ...and at slider 9; geometric in between, so each step multiplies the ratio by the same factor
/* The season-wide settings' defaults — app.js's defaultState() and the
   fallbacks below both read this, so a retune can't leave them disagreeing. */
const DEFAULT_POSITION_LOAD = Object.freeze({ GS:0.55, GA:0.85, WA:0.7, C:1, WD:0.7, GD:0.85, GK:0.55 }); // how hard a quarter there is, relative to centre
const POSITION_LOAD_MIN = 0.1, POSITION_LOAD_MAX = 2;
const DEFAULT_SETTINGS = Object.freeze({ preferenceSlider:8, allowOffPreference:false, positionVariety:1, rosterOffPriority:"fairness",
  loadBalance:0, positionLoad:DEFAULT_POSITION_LOAD, centreQuarters:4 }); // positionLoad is shared and frozen: copy it before handing it to anything that edits (app.js's defaultState does)
/* Phase 1 coverage weight per roster-off priority. "fairness" is a pure
   tie-break: small enough that a whole season's coverage penalties can't
   outweigh the smallest possible gain in missed-games evenness, but not 0,
   so equally even splits still prefer the better-covered one. "balanced" sits
   inside the narrow band (~0.002-0.02) where fairness and coverage actually
   trade off — above it coverage wins every conflict, which is why this is a
   three-way choice and not a 0-10 slider. */
const ROSTER_OFF_COVERAGE_WEIGHT = Object.freeze({ fairness:ROSTER_OFF_TIEBREAK_WEIGHT, balanced:0.006, coverage:PHASE1_COVERAGE_WEIGHT });
const ROSTER_OFF_PRIORITIES = Object.keys(ROSTER_OFF_COVERAGE_WEIGHT);
const PHASE1_RESTART_SEED = 0xC0FFEE;   // fixed -> deterministic, reproducible restarts (no Math.random)
const STRICT_SPECIALIST_COVERAGE_BOOST = 3; // §5.5: multiplies a game's own coverage weight when its strictSpecialistPairing flag is on
const STRICT_SPECIALIST_MIN_COVERAGE_WEIGHT = PHASE1_COVERAGE_WEIGHT; // floor for the boost above — a pure multiplier does nothing when the season-wide weight is 0
const PHASE1_STAGNANT_ATTEMPTS_LIMIT = 25; // stop restarting after this many non-improving attempts

/* Deterministic PRNG — reorders games between restart attempts only, never
   decides who's rostered off. Fixed seed keeps runs (and tests) reproducible. */
function mulberry32(seed){
  let a = seed;
  return function(){
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function shuffled(arr, rng){
  const a = arr.slice();
  for(let i=a.length-1;i>0;i--){
    const j = Math.floor(rng()*(i+1));
    const tmp=a[i]; a[i]=a[j]; a[j]=tmp;
  }
  return a;
}

/* Coerces an untrusted setting (localStorage, CSV import) to a number inside
   [lo,hi]. Non-finite input falls back to `fallback` rather than propagating
   NaN — every comparison against NaN is false, so an uncaught NaN silently
   disables whatever downstream logic depends on it. */
function clampSetting(v, lo, hi, fallback){
  const n = Number(v);
  if(!Number.isFinite(n)) return fallback;
  return Math.max(lo, Math.min(hi, n));
}

/* §6: a player who states no preferences (only a fill-in can) is happy to
   play any position — every position is in-preference for them. */
function isInPreference(p, pos){
  const prefs = p.prefs||[];
  return !prefs.length || prefs.includes(pos);
}

function variance(nums){
  if(!nums.length) return 0;
  const mean = nums.reduce((a,b)=>a+b,0)/nums.length;
  return nums.reduce((a,b)=>a+(b-mean)*(b-mean),0)/nums.length;
}

/* Per-position coverage-gap penalty for one roster-off outcome: penalizes
   heavily at 0 remaining covering players, moderately at 1. Rank-weighted
   and based only on the post-removal squad, which is what makes it correct
   regardless of how many rostered-off players share a position — no
   separate pairwise-overlap term needed. */
function gameCoveragePenalty(squadAfterOff){
  let penalty = 0;
  POSITIONS.forEach(pos=>{
    const coverers = squadAfterOff.filter(p=>p.prefs.includes(pos));
    if(coverers.length===0) penalty += COVERAGE_GAP_ZERO_PENALTY;
    else if(coverers.length===1){
      const rank = coverers[0].prefs.indexOf(pos);
      penalty += COVERAGE_GAP_ONE_PENALTY * (1+rank);
    }
  });
  return penalty;
}

/* True if `players` can fill all seven positions in-preference, one player
   each (Kuhn's augmenting-path matching — seven positions, a dozen players). */
function canFieldInPreference(players){
  const holder = {}; // position -> index of the player matched to it
  function place(i, seen){
    return POSITIONS.some(pos=>{
      if(seen[pos] || !isInPreference(players[i],pos)) return false; // a squad here may include fill-ins
      seen[pos] = true;
      if(holder[pos]===undefined || place(holder[pos], seen)){ holder[pos]=i; return true; }
      return false;
    });
  }
  let filled = 0;
  for(let i=0; i<players.length && filled<POSITIONS.length; i++) if(place(i, {})) filled++;
  return filled===POSITIONS.length;
}

/* How many of a squad can't sit out a quarter without leaving a position
   uncovered in-preference. The per-position penalty above can't see this:
   two defenders left for GK and GD is "two coverers each", yet both must
   play every quarter, so the bench stints fall on everyone else. A squad
   that can't field in-preference at all counts as everyone forced (the worst
   score — three positions shared by the same two players passes every
   per-position check); one of seven or fewer has no bench to rotate, so 0. */
function forcedOnCourtCount(squad){
  if(!canFieldInPreference(squad)) return squad.length;
  if(squad.length<=POSITIONS.length) return 0;
  return squad.filter(p=>!canFieldInPreference(squad.filter(x=>x!==p))).length;
}

/* True if removing `offPlayers` from `pool` leaves any position with zero
   in-preference coverage. The hard version of the penalty above — when
   "allow off-preference" is off, Phase 1 must never produce this, since
   Phase 2 will hard-error on it. */
function hasZeroCoverage(squadAfter){
  return POSITIONS.some(pos=>!squadAfter.some(p=>p.prefs.includes(pos)));
}

/* Maps the roster-off priority ("fairness" | "balanced" | "coverage") onto
   Phase 1's {fairness, coverage} weights. Fairness is held constant; anything
   unrecognised falls back to the default. */
function deriveRosterOffWeights(rosterOffPriority){
  const priority = ROSTER_OFF_PRIORITIES.includes(rosterOffPriority) ? rosterOffPriority : DEFAULT_SETTINGS.rosterOffPriority;
  return { fairness: PHASE1_FAIRNESS_WEIGHT, coverage: ROSTER_OFF_COVERAGE_WEIGHT[priority] };
}

/* Maps the 0-10 preference slider onto the {preference, balance} weights of
   the Phase 2 cost model (they sum to 1). The preference:balance ratio grows
   geometrically from slider 0 to 9 — a linear split (s : 10-s) bunched nearly
   all of the visible change into the last three steps. Slider 10 is the hard
   end of the scale: balance weight exactly 0 (§5.1). */
function derivePreferenceWeights(preferenceSlider){
  const slider = clampSetting(preferenceSlider, 0, 10, DEFAULT_SETTINGS.preferenceSlider);
  const ratio = PREFERENCE_RATIO_AT_0 * Math.pow(PREFERENCE_RATIO_AT_9/PREFERENCE_RATIO_AT_0, Math.min(slider,9)/9);
  const balance = (1/(1+ratio)) * Math.min(1, 10-slider); // fades linearly to 0 across 9..10
  return { preference: 1-balance, balance };
}

/* ============================================================
   PHASE 1 — season-wide roster-off allocation
   ============================================================
   input.players: [{id, prefs, unavailableCount}]  (season-total known unavailability)
   input.games:   [{num, availableIds:[id...], rosterOffCount, fixedOffIds:[id...]|null, allowOffPreference?:boolean,
                    fillIns?:[{prefs}] (assigned guests — only the bench-flexibility tie-break looks at them)}]
                  fixedOffIds !== null means this game's roster-off is not decided here
                  (played / shortfall / manually locked) — it still counts toward fairness.
   input.weights: {fairness, coverage} (optional overrides)
   input.allowOffPreference: boolean (default true) — when false, a candidate
                  combination that would leave any position at zero in-preference
                  coverage is disqualified outright, not merely penalized.
   input.timeBudgetMs
   -> { rosterOffByGame: {num:[ids]}, stats:{passes, elapsedMs, finalCost, timedOut, attempts} }
*/
function solveSeasonRosterOff(input){
  const players = input.players||[];
  const games = input.games||[];
  const fairnessWeight = (input.weights && input.weights.fairness!=null) ? input.weights.fairness : PHASE1_FAIRNESS_WEIGHT;
  const coverageWeight = (input.weights && input.weights.coverage!=null) ? input.weights.coverage : PHASE1_COVERAGE_WEIGHT;
  const allowOffPreference = input.allowOffPreference !== false;
  /* A game may override the season-wide toggle with its own boolean
     (g.allowOffPreference); null/undefined follows the season-wide value. */
  const allowOffFor = g=> (typeof g.allowOffPreference==="boolean") ? g.allowOffPreference : allowOffPreference;
  const timeBudgetMs = input.timeBudgetMs!=null ? input.timeBudgetMs : PHASE1_TIME_BUDGET_MS;
  const start = Date.now();
  const deadline = start + timeBudgetMs;

  const playerById = {};
  players.forEach(p=>{ playerById[p.id]=p; });

  const decidableGames = games.filter(g=>g.fixedOffIds==null && g.rosterOffCount>0);
  const fixedGames = games.filter(g=>g.fixedOffIds!=null);

  const fixedMissedBase = {};
  players.forEach(p=>{ fixedMissedBase[p.id] = p.unavailableCount||0; });
  fixedGames.forEach(g=>{ (g.fixedOffIds||[]).forEach(id=>{ if(fixedMissedBase[id]!=null) fixedMissedBase[id]++; }); });

  function totalMissedMapOf(current){
    const missed = {};
    players.forEach(p=>{ missed[p.id]=fixedMissedBase[p.id]||0; });
    decidableGames.forEach(g=>{ (current[g.num]||[]).forEach(id=>{ if(missed[id]!=null) missed[id]++; }); });
    return missed;
  }
  /* §5.5: a game with strictSpecialistPairing on weighs its own coverage
     penalty more heavily than coverageWeight alone would — a bounded,
     per-game deviation that doesn't touch the weight used for every other
     game. */
  function effectiveCoverageWeight(g){
    if(!g.strictSpecialistPairing) return coverageWeight;
    return Math.max(coverageWeight*STRICT_SPECIALIST_COVERAGE_BOOST, STRICT_SPECIALIST_MIN_COVERAGE_WEIGHT);
  }
  /* One roster-off outcome's coverage cost. Bench flexibility is a tie-break
     at every priority: it never costs missed-games evenness or per-position
     coverage, it only picks between splits that are level on both. */
  const COVERAGE_CACHE_MAX_PER_GAME = 5000; // bounds memory on a long solve; a cleared entry is just recomputed
  const coverageTermCache = {};
  function coverageTermOf(g, offIds){
    // Restarts and moves re-score the same choices constantly; the squad is only built on a miss.
    const cache = coverageTermCache[g.num] || (coverageTermCache[g.num] = new Map());
    const key = offIds.slice().sort().join(",");
    let term = cache.get(key);
    if(term===undefined){
      const offSet = new Set(offIds);
      const squadAfter = poolByNum[g.num].filter(p=>!offSet.has(p.id));
      term = effectiveCoverageWeight(g)*gameCoveragePenalty(squadAfter);
      // Only where there's a choice to break a tie in; the game's fill-ins (§6) rotate through the bench too.
      if(g.fixedOffIds==null) term += ROSTER_OFF_TIEBREAK_WEIGHT*FORCED_ON_COURT_PENALTY*forcedOnCourtCount(squadAfter.concat(g.fillIns||[]));
      if(cache.size>=COVERAGE_CACHE_MAX_PER_GAME) cache.clear();
      cache.set(key, term);
    }
    return term;
  }
  // Each game's available players (invariant for the whole solve).
  const poolByNum = {};
  games.forEach(g=>{ poolByNum[g.num] = g.availableIds.map(id=>playerById[id]).filter(Boolean); });
  function totalObjectiveOf(current){
    const missed = totalMissedMapOf(current);
    const fairnessTerm = fairnessWeight*variance(Object.values(missed));
    let coverageTerm = 0;
    games.forEach(g=>{
      const offIds = g.fixedOffIds!=null ? g.fixedOffIds : (current[g.num]||[]);
      coverageTerm += coverageTermOf(g, offIds); // a move touches one or two games; the rest hit the cache
    });
    return fairnessTerm + coverageTerm;
  }

  /* ---- greedy seed: fairness-first, coverage-aware tie-break ---- */
  function buildSeed(gameOrder){
    const current = {};
    const runningMissed = {};
    players.forEach(p=>{ runningMissed[p.id] = fixedMissedBase[p.id]||0; });
    gameOrder.forEach(g=>{
      const pool = poolByNum[g.num];
      const picked = [];
      const remaining = pool.slice();
      for(let k=0;k<g.rosterOffCount && remaining.length;k++){
        let best=null, bestScore=Infinity;
        let bestSafe=null, bestSafeScore=Infinity; // fallback if every candidate is disqualified (structurally forced)
        remaining.forEach(cand=>{
          const missed = runningMissed[cand.id]||0;
          const squadAfter = pool.filter(pp=>pp.id!==cand.id && !picked.some(x=>x.id===pp.id));
          const score = missed*1000 + coverageTermOf(g, picked.map(x=>x.id).concat(cand.id));
          if(score<bestSafeScore){ bestSafeScore=score; bestSafe=cand; }
          const disqualified = !allowOffFor(g) && hasZeroCoverage(squadAfter);
          if(!disqualified && score<bestScore){ bestScore=score; best=cand; }
        });
        const chosen = best!==null ? best : bestSafe;
        if(!chosen){
          // Unreachable with finite weights: `remaining` is non-empty, so some
          // candidate always scores below Infinity. Only a non-finite weight
          // could get here, and silently pushing null would corrupt the seed
          // (indexOf(null) === -1 removes the *last* candidate instead).
          throw new Error("Phase 1 seed could not pick a roster-off candidate (non-finite weights?)");
        }
        picked.push(chosen);
        remaining.splice(remaining.indexOf(chosen),1);
      }
      current[g.num] = picked.map(p=>p.id);
      picked.forEach(p=>{ runningMissed[p.id]=(runningMissed[p.id]||0)+1; });
    });
    return current;
  }

  /* ---- local search: three move types (below), until nothing improves or the deadline hits ---- */
  function refine(current, gameOrder){
    let bestObjective = totalObjectiveOf(current);
    let passes = 0;
    let timedOut = false;

    outer:
    while(passes<PHASE1_MAX_PASSES){
      if(Date.now()>deadline){ timedOut=true; break; }
      let improvedAny = false;

      // Move 1: single-game swap (offP <-> onP within the same game).
      for(const g of gameOrder){
        if(Date.now()>deadline){ timedOut=true; break outer; }
        const pool = poolByNum[g.num];
        const offSet = new Set(current[g.num]);
        for(let oi=0; oi<pool.length; oi++){
          const offP = pool[oi];
          if(!offSet.has(offP.id)) continue;
          for(let ni=0; ni<pool.length; ni++){
            const onP = pool[ni];
            if(offSet.has(onP.id)) continue;
            const candidateOffIds = current[g.num].map(id=>id===offP.id?onP.id:id);
            const candidateOffSet = new Set(candidateOffIds);
            const squadAfterSwap = pool.filter(p=>!candidateOffSet.has(p.id));
            if(!allowOffFor(g) && hasZeroCoverage(squadAfterSwap)) continue; // hard rule: never swap into a zero-coverage state
            current[g.num] = candidateOffIds;
            const newObjective = totalObjectiveOf(current);
            if(newObjective < bestObjective-1e-9){
              bestObjective = newObjective;
              offSet.delete(offP.id); offSet.add(onP.id);
              improvedAny = true;
              break; // offP is no longer off; move to next oi candidate
            } else {
              current[g.num] = current[g.num].map(id=>id===onP.id?offP.id:id); // revert
            }
          }
        }
      }

      // Move 2: paired cross-game exchange — A (off in g1, on in g2) trades
      // rest-games with B (off in g2, on in g1). Both totals stay unchanged,
      // so this is a pure coverage-penalty move: it escapes local optima
      // where the two single-game swaps that would get there each look like
      // a fairness regression alone, even though together they're neutral.
      for(let gi=0; gi<gameOrder.length; gi++){
        for(let gj=gi+1; gj<gameOrder.length; gj++){
          if(Date.now()>deadline){ timedOut=true; break outer; }
          const g1 = gameOrder[gi], g2 = gameOrder[gj];
          const pool1 = poolByNum[g1.num];
          const pool2 = poolByNum[g2.num];
          const off1 = new Set(current[g1.num]);
          const off2 = new Set(current[g2.num]);
          for(const A of pool1){
            if(!off1.has(A.id)) continue; // A off in g1
            if(off2.has(A.id) || !pool2.some(p=>p.id===A.id)) continue; // must be on-court (available, not off) in g2
            for(const B of pool2){
              if(!off2.has(B.id) || B.id===A.id) continue; // B off in g2
              if(off1.has(B.id) || !pool1.some(p=>p.id===B.id)) continue; // must be on-court (available, not off) in g1
              const newOff1 = new Set(off1); newOff1.delete(A.id); newOff1.add(B.id);
              const newOff2 = new Set(off2); newOff2.delete(B.id); newOff2.add(A.id);
              const blocked = (!allowOffFor(g1) && hasZeroCoverage(pool1.filter(p=>!newOff1.has(p.id)))) ||
                (!allowOffFor(g2) && hasZeroCoverage(pool2.filter(p=>!newOff2.has(p.id))));
              current[g1.num] = current[g1.num].map(id=>id===A.id?B.id:id);
              current[g2.num] = current[g2.num].map(id=>id===B.id?A.id:id);
              const newObjective = blocked ? Infinity : totalObjectiveOf(current);
              if(newObjective < bestObjective-1e-9){
                bestObjective = newObjective;
                off1.delete(A.id); off1.add(B.id);
                off2.delete(B.id); off2.add(A.id);
                improvedAny = true;
                break; // A is no longer off in g1; move to next A candidate
              } else {
                current[g1.num] = current[g1.num].map(id=>id===B.id?A.id:id); // revert
                current[g2.num] = current[g2.num].map(id=>id===A.id?B.id:id);
              }
            }
          }
        }
      }

      // Move 3: chained exchange through an intermediary X, targeting the
      // current most/least-missed players (H, L). H's off-slot in gameA goes
      // to X; X's own off-slot in gameB goes to L. X's total is unchanged, so
      // the fairness gain is isolated to H (-1) / L (+1) — closes gaps
      // Moves 1-2 can't reach alone.
      if(Date.now()>deadline){ timedOut=true; break outer; }
      {
        const missedNow = totalMissedMapOf(current);
        const eligibleIds = new Set();
        gameOrder.forEach(g=>g.availableIds.forEach(id=>eligibleIds.add(id)));
        let H=null, L=null;
        eligibleIds.forEach(id=>{
          const m = missedNow[id]; if(m==null) return;
          if(H===null || m>missedNow[H]) H=id;
          if(L===null || m<missedNow[L]) L=id;
        });
        if(H!=null && L!=null && H!==L && missedNow[H]>missedNow[L]){
          chainSearch:
          for(const gA of gameOrder){
            const poolA = poolByNum[gA.num];
            const offA = new Set(current[gA.num]);
            if(!offA.has(H)) continue; // H must be off in gA
            for(const X of poolA){
              if(offA.has(X.id) || X.id===H || X.id===L) continue; // X must be on in gA
              for(const gB of gameOrder){
                if(gB===gA) continue;
                const poolB = poolByNum[gB.num];
                const offB = new Set(current[gB.num]);
                if(!offB.has(X.id)) continue; // X must be off in gB
                if(offB.has(L) || !poolB.some(p=>p.id===L)) continue; // L must be on in gB
                const newOffA = new Set(offA); newOffA.delete(H); newOffA.add(X.id);
                const newOffB = new Set(offB); newOffB.delete(X.id); newOffB.add(L);
                const blocked = (!allowOffFor(gA) && hasZeroCoverage(poolA.filter(p=>!newOffA.has(p.id)))) ||
                  (!allowOffFor(gB) && hasZeroCoverage(poolB.filter(p=>!newOffB.has(p.id))));
                if(blocked) continue;
                current[gA.num] = current[gA.num].map(id=>id===H?X.id:id);
                current[gB.num] = current[gB.num].map(id=>id===X.id?L:id);
                const newObjective = totalObjectiveOf(current);
                if(newObjective < bestObjective-1e-9){
                  bestObjective = newObjective;
                  improvedAny = true;
                  break chainSearch;
                } else {
                  current[gA.num] = current[gA.num].map(id=>id===X.id?H:id); // revert
                  current[gB.num] = current[gB.num].map(id=>id===L?X.id:id);
                }
              }
            }
          }
        }
      }

      passes++;
      if(!improvedAny) break;
    }
    return { current, bestObjective, passes, timedOut };
  }

  /* Attempt 0 uses the deterministic game order (so a non-positive
     timeBudgetMs still yields a pure seed with zero refinement passes).
     Further attempts reorder games via the fixed-seed PRNG to give the
     greedy seed a different construction order — the local search alone can
     get stuck in a coverage-penalty local optimum a differently-ordered seed
     sidesteps. Stops early once near-optimal or restarts stop improving. */
  let best = refine(buildSeed(decidableGames), decidableGames);
  let attempts = 1;
  const rng = mulberry32(PHASE1_RESTART_SEED);
  let stagnant = 0;
  while(Date.now()<deadline && decidableGames.length>1 && best.bestObjective>1e-9 && stagnant<PHASE1_STAGNANT_ATTEMPTS_LIMIT){
    const order = shuffled(decidableGames, rng);
    const attempt = refine(buildSeed(order), order);
    attempts++;
    if(attempt.bestObjective < best.bestObjective-1e-9){ best = attempt; stagnant = 0; }
    else { stagnant++; }
  }

  const rosterOffByGame = {};
  fixedGames.forEach(g=>{ rosterOffByGame[g.num] = (g.fixedOffIds||[]).slice(); });
  decidableGames.forEach(g=>{ rosterOffByGame[g.num] = (best.current[g.num]||[]).slice(); });
  games.forEach(g=>{ if(!rosterOffByGame[g.num]) rosterOffByGame[g.num]=[]; });

  return {
    rosterOffByGame,
    stats: { passes: best.passes, elapsedMs: Date.now()-start, finalCost: best.bestObjective, timedOut: best.timedOut, attempts }
  };
}

/* ============================================================
   Roster-off achievability: positions so thin (few preferrers) that even
   missed-games counts can be structurally out of reach. Settings-independent
   — purely a function of roster composition.
   ============================================================ */
function computeRosterOffAchievabilityNotes(players){
  const notes = [];
  POSITIONS.forEach(pos=>{
    const preferrers = (players||[]).filter(p=>p.prefs && p.prefs.includes(pos));
    if(preferrers.length>0 && preferrers.length<=THIN_POSITION_PREFERRER_THRESHOLD){
      const names = preferrers.map(p=>p.name);
      const single = names.length===1;
      notes.push({
        position: pos,
        players: names,
        message: `${names.join(" and ")} ${single?"is the only player":"are the only players"} who prefer${single?"s":""} ${pos}. Resting ${single?"them":"both"} would leave ${pos} uncovered, so the roster-off split may never come out perfectly even — expect them to end up with fewer missed games than the rest of the roster.`
      });
    }
  });
  return notes;
}

/* ============================================================
   PHASE 2a — exact per-quarter Hungarian position assignment
   ============================================================ */

/* One position's workload weight from an untrusted value. Only a real number
   is clamped; anything else (including "" and null, which Number() would
   read as 0 and clampSetting would raise to the minimum) is that position's
   default. */
function cleanPositionLoad(value, pos){
  return (typeof value==="number" && Number.isFinite(value))
    ? Math.max(POSITION_LOAD_MIN, Math.min(POSITION_LOAD_MAX, value)) : DEFAULT_POSITION_LOAD[pos];
}
/* The workload slider as a 0..1 blend. Besides weighting the quarters
   (derivePositionLoads) it eases the per-game bench limit — see docs/gotchas.md. */
function loadBlendOf(settings){
  return clampSetting((settings||{}).loadBalance, 0, 10, DEFAULT_SETTINGS.loadBalance)/10;
}
/* The coach's own weights, cleaned, before the slider blends them. -> {pos: weight} */
function rawPositionLoads(settings){
  const raw = {};
  POSITIONS.forEach(pos=>{ raw[pos] = cleanPositionLoad(((settings||{}).positionLoad||{})[pos], pos); });
  return raw;
}
/* The Centre-quarters target (§11): an integer 1..4, 4 (no limit) when absent or junk. */
function centreQuartersOf(settings){
  const v = (settings||{}).centreQuarters;
  return (typeof v==="number" && Number.isFinite(v)) ? Math.max(1, Math.min(4, Math.round(v))) : DEFAULT_SETTINGS.centreQuarters;
}
/* What one quarter at each position counts for in the court-time evenness
   sums (§4 rule 2). The workload slider blends between every quarter
   counting the same (0: equal quarters) and each counting its position's
   load (10: equal load). Loads are scaled so the seven average 1, which keeps
   a full line-up worth seven "quarters" at any slider value — so targets,
   quotas and the tuned weights don't shift with it.
   -> {pos: weight} */
function derivePositionLoads(settings){
  const s = settings||{};
  const blend = loadBlendOf(s);
  const raw = rawPositionLoads(s);
  const mean = POSITIONS.reduce((sum,pos)=>sum+raw[pos],0)/POSITIONS.length;
  const loads = {};
  POSITIONS.forEach(pos=>{ loads[pos] = 1 + blend*(raw[pos]/mean - 1); });
  return loads;
}

/* Each player's court time so far in load units, straight from the season's
   position counts, and the rate they earn it at: what they've actually
   averaged per quarter once they've played (someone who lists three positions
   may only ever get the heaviest), else an estimate from their list that
   leans on the higher choices (each rank counts half the one above), as
   assignment does. `heaviestQuarter` bounds what one more in-preference
   quarter could add.
   input: { players:[{id,prefs}], posCount:{"id::pos":n}, positionLoads:{pos:w} }
   -> { loadSoFar:{id:n}, quarterLoad:{id:n}, heaviestQuarter:{id:n} } */
function playerLoadStats(input){
  const loads = input.positionLoads, posCount = input.posCount||{};
  const loadSoFar = {}, quarterLoad = {}, heaviestQuarter = {};
  (input.players||[]).forEach(p=>{
    let quarters = 0, load = 0;
    POSITIONS.forEach(pos=>{ const n = posCount[p.id+"::"+pos]||0; quarters += n; load += n*loads[pos]; });
    const listed = ((p.prefs||[]).length ? p.prefs : POSITIONS).map(pos=>loads[pos]);
    loadSoFar[p.id] = load;
    const ranked = (p.prefs||[]).length>0; // no list (a fill-in): any position, so a plain average
    let weightSum = 0, estimate = 0;
    listed.forEach((l,rank)=>{ const w = ranked ? Math.pow(0.5,rank) : 1; weightSum += w; estimate += w*l; });
    quarterLoad[p.id] = quarters>0 ? load/quarters : estimate/weightSum;
    heaviestQuarter[p.id] = Math.max(...listed);
  });
  return { loadSoFar, quarterLoad, heaviestQuarter };
}

/* §4 rule 2: each regular's season on-court target. Everyone gets the same
   number of quarters ("level") unless they can't reach it (`cap`: too many
   missed games) or are already past it (`floor`: quarters already played in
   frozen games) — the rest then share what's left evenly. This is what makes
   a player who misses more games play more of the games they do attend.
   players: [{id, floor, cap}], total: on-court quarters to share -> {id: target} */
function computeCourtTargets(players, total){
  const clampTo = (p, level)=>Math.max(p.floor, Math.min(p.cap, level));
  let lo = 0, hi = Math.max(0, ...players.map(p=>p.cap));
  for(let i=0;i<50;i++){
    const mid = (lo+hi)/2;
    if(players.reduce((sum,p)=>sum+clampTo(p,mid),0) < total) lo = mid; else hi = mid;
  }
  const targets = {};
  players.forEach(p=>{ targets[p.id] = clampTo(p,hi); });
  return targets;
}

/* §4 rule 3: the fewest bench quarters per game that "nobody is benched more
   than this" can be held to — 1 while there's at most one bench stint each to
   go round (a bench of 1 or 2 with a full squad), more only when the bench is
   too big for that. */
function baseBenchCap(squadSize, benchSlotCount){
  return Math.max(1, Math.ceil(4*benchSlotCount/Math.max(1,squadSize)));
}

/* §4 rules 2-3 for one game about to be solved: the bench quarters each squad
   member is due in it, and the most they may sit before the cap penalty.
   A regular is due whatever leaves them on pace for their season target over
   the games they have left — the target and the tally are in load units
   (derivePositionLoads), turned back into quarters at the rate the player
   earns it (`quarterLoad`, from playerLoadStats: a centre reaches their share
   in fewer quarters and sits out more); a fill-in (outside season fairness) an even share
   of this game's bench. Only a player who misses fewer games than someone
   else in this squad may be benched one more time, to hand that squad-mate
   court time — an absentee who isn't playing doesn't relax anyone's cap.
   input: { squad:[{id,isFillIn}], benchSlotCount, courtTargets:{id:n}, loadSoFar:{id:n},
            gamesLeft:{id:n} (this game included), missed:{id:n}, quarterLoad?:{id:n} (default 1 each) }
   -> { benchQuota:{id:n}, benchCap:{id:n} } */
function planGameBench(input){
  const squad = input.squad||[];
  const baseCap = baseBenchCap(squad.length, input.benchSlotCount);
  const missed = input.missed||{};
  const mostMissed = Math.max(0, ...squad.filter(p=>!p.isFillIn).map(p=>missed[p.id]||0));
  const benchQuota = {}, benchCap = {};
  squad.forEach(p=>{
    if(p.isFillIn){ benchQuota[p.id] = 4*input.benchSlotCount/squad.length; benchCap[p.id] = baseCap; return; }
    const courtDue = (input.courtTargets[p.id]||0) - (input.loadSoFar[p.id]||0);
    const quartersDue = courtDue/Math.max(1, input.gamesLeft[p.id]||1)/((input.quarterLoad||{})[p.id]||1);
    benchQuota[p.id] = Math.max(0, Math.min(4, 4 - quartersDue));
    benchCap[p.id] = baseCap + ((missed[p.id]||0)<mostMissed ? 1 : 0);
  });
  return { benchQuota, benchCap };
}

/* The preference slider sets how the two sides of a cell's cost are weighed
   (derivePreferenceWeights): preference rank plus the variety term on one
   side, playing-time evenness on the other. Evenness lives entirely in the
   bench cell (so bench rotation emerges from the same optimization, not a
   separate pass): every player takes exactly one cell per quarter, so a
   per-player on-court cost would only be the same number with the sign
   flipped. `settings.positionVariety` nudges a player away from an
   over-played position; it is capped below OFF_PREFERENCE_COST, which is the
   same for every player, so raising it can never make an off-preference
   cell cheaper than any in-preference one.
   cumulative: {posCount, gameBenchSoFar:{id:n}, benchedLastQuarter:Set,
                centres:[id] (who played Centre in each earlier quarter of this game, fill-ins included — §4 rule 3a),
                benchQuota:{id:n} (bench quarters this player should sit out this game),
                benchCap:{id:n}   (most bench quarters this game before BENCH_CAP_PENALTY applies — a penalty that the workload slider scales down, to 0 at 10) — both from planGameBench} */
function buildQuarterCostFns(cumulative, settings){
  const { preference: prefWeight, balance: balanceWeight } = derivePreferenceWeights(settings.preferenceSlider);
  const allowOff = !!settings.allowOffPreference;
  const varietyWeight = clampSetting(settings.positionVariety, 0, 10, DEFAULT_SETTINGS.positionVariety);
  const capPenalty = BENCH_CAP_PENALTY*(1-loadBlendOf(settings)); // the coach trades the per-game limit for equal workload as the slider rises; gone at 10

  /* §4 rule 3a. 0 throughout at the default (4); finite, so it never disqualifies a cell. */
  const centreTarget = centreQuartersOf(settings);
  // One preference-rank step plus one quarter of court-time imbalance: so a Centre cost of 1 outweighs either
  // alone, at any preference-slider value, while staying well under the per-game bench limit (capPenalty quarters).
  const centreUnit = prefWeight + balanceWeight*COURT_TIME_WEIGHT;
  const centreOn = centreTarget<4;
  const restLoad = centreOn ? rawPositionLoads(settings) : null; // the coach's weights, not the slider's blend
  // Read per call, not hoisted: refineGameQuarters re-points cumulative.centres after these functions are built.
  function centreSoFarOf(p){
    let n = 0;
    for(const id of cumulative.centres||[]) if(id===p.id) n++;
    return n;
  }
  function centreRunOf(p){
    const centres = cumulative.centres||[];
    let run = 0;
    for(let i=centres.length-1; i>=0 && centres[i]===p.id; i--) run++;
    return run;
  }
  /* The rest quarter after a Centre one: among the player's listed non-Centre positions, the lightest first
     (ties keep their own ranking; Array sort is stable). Same 0..6 scale as a rank, so variety and the
     off-preference costs are untouched — and it replaces the rank rather than adding to it, which is what
     lets workload order win over the player's own (§4 rule 3a). */
  const restRank = (p,pos)=>p.prefs.filter(x=>x!=="C").sort((a,b)=>restLoad[a]-restLoad[b]).indexOf(pos);
  function centreCost(p,pos){
    if(!centreOn) return 0;
    const soFar = centreSoFarOf(p), run = centreRunOf(p);
    let cost = CENTRE_FATIGUE_COST*soFar;
    if(pos!=="C") return cost;
    if(soFar>=centreTarget) cost += CENTRE_OVER_TARGET_COST*(soFar-centreTarget+1);
    if(run>=1 && centreTarget<=2) cost += CENTRE_BACK_TO_BACK_COST;
    if(run>=2 && centreTarget<=3) cost += CENTRE_THIRD_IN_ROW_COST;
    return cost;
  }
  function prefRank(p,pos){
    return p.prefs.indexOf(pos);
  }
  function preferenceCost(p,pos){
    const idx = prefRank(p,pos);
    if(idx>=0) return (centreOn && pos!=="C" && centreRunOf(p)>=1) ? restRank(p,pos) : idx;
    if(!p.prefs.length) return NO_PREFERENCE_COST; // no list at all: in-preference everywhere (isInPreference)
    // §5.2: "outside the stated list". One flat cost for everyone — a cost
    // tied to the list's length made short-list players the cheapest
    // off-preference fill, and let them undercut a long-list player's
    // lower-ranked in-preference cell.
    return allowOff ? OFF_PREFERENCE_COST : null;
  }
  /* Variety penalty: a position this player has already played a lot costs
     more. Capped relative to the candidate's own list (prefs.length - idx),
     not a flat constant — a flat cap saturates almost immediately and could
     never outweigh a single preference-rank step, so a #1 choice could never
     lose to a #2 no matter how overplayed. Scaling the cap to the player's
     own list lets a favourite lose ground as it's played out (§11's "spread
     across the whole list") while never costing more than "one worse than
     their last choice" — itself always below OFF_PREFERENCE_COST. */
  function varietyTerm(p,pos,rank){ // rank: the one preferenceCost used (a rest quarter's workload order replaces the player's own)
    if(prefRank(p,pos)<0) return 0; // no variety signal off the list (or for a player with no list)
    const posCount = (cumulative.posCount && cumulative.posCount[p.id+"::"+pos]) || 0;
    const safeCap = Math.max(0, (p.prefs.length-rank) - 0.05);
    return Math.min(0.15*varietyWeight*Math.log2(1+posCount), safeCap);
  }
  function positionCellCost(p,pos){
    const pc = preferenceCost(p,pos);
    if(pc===null) return BIG_M;
    // Off-preference (prefs listed, this position not among them) is a last
    // resort at every slider value: used only when the quarter can't be filled
    // in-preference, never to even out court time.
    const lastResort = isInPreference(p,pos) ? 0 : OFF_PREFERENCE_LAST_RESORT;
    return lastResort + prefWeight*(pc + varietyTerm(p,pos,pc)) + centreUnit*centreCost(p,pos);
  }
  /* Bench-slot cost: how far benching this player now would put them past
     the bench quarters they're due this game (benchQuota — higher for a
     player who is ahead on season court time), plus the strong per-game cap
     and the back-to-back tie-break. All of it scales with the balance
     weight, so it is exactly 0 at slider=10: bench-rotation pressure can
     never be the reason an in-preference candidate loses to an
     off-preference one at max preference (§5.1). Never negative (planGameBench
     keeps a quota within 0..4), which keeps it clear of Hungarian's BIG_M arithmetic. */
  function benchCellCost(p){
    const thisGame = (cumulative.gameBenchSoFar && cumulative.gameBenchSoFar[p.id])||0;
    const quota = (cumulative.benchQuota && cumulative.benchQuota[p.id])||0;
    const cap = (cumulative.benchCap && cumulative.benchCap[p.id]) || 1;
    const overCap = Math.max(0, thisGame+1-cap);
    const backToBack = (cumulative.benchedLastQuarter && cumulative.benchedLastQuarter.has(p.id)) ? BACK_TO_BACK_BENCH_PENALTY : 0;
    return balanceWeight*COURT_TIME_WEIGHT*(thisGame + 4 - quota + overCap*capPenalty + backToBack);
  }
  return { positionCellCost, benchCellCost, centreCost };
}

/* input: { players:[{id,name,prefs,isFillIn}], benchSlotCount, lockedSlots:{pos:playerId},
           cumulative:{posCount,onCourt,bench,gameBenchSoFar,benchedLastQuarter}, settings }
   -> { onCourt:{pos:id}, bench:[ids], offPreference:{pos:true}, errors:[{position,reason}] } */
function solveQuarterPositions(input){
  const settings = input.settings||{};
  const cumulative = input.cumulative||{};
  const lockedSlots = input.lockedSlots||{};
  const onCourt = {}; const offPreference = {};
  let remaining = (input.players||[]).slice();

  POSITIONS.forEach(pos=>{
    const pid = lockedSlots[pos];
    if(!pid) return;
    const idx = remaining.findIndex(p=>p.id===pid);
    if(idx>=0){
      const p = remaining.splice(idx,1)[0];
      onCourt[pos]=p.id;
      if(!isInPreference(p,pos)) offPreference[pos]=true;
    }
  });

  const openPositions = POSITIONS.filter(pos=>!onCourt[pos]);
  const benchSlotCount = Math.max(0, input.benchSlotCount||0);
  const errors = [];

  if(remaining.length===0){
    return { onCourt, bench:[], offPreference, errors };
  }

  const { positionCellCost, benchCellCost } = buildQuarterCostFns(cumulative, settings);
  const columns = openPositions.concat(new Array(benchSlotCount).fill("BENCH"));

  if(columns.length!==remaining.length){
    // Defensive: caller contract violated (shouldn't happen in practice).
    errors.push({position:null, reason:"SLOT_MISMATCH"});
    return { onCourt, bench: remaining.map(p=>p.id), offPreference, errors };
  }

  const matrix = remaining.map(p => columns.map(col => col==="BENCH" ? benchCellCost(p) : positionCellCost(p,col)));
  const assignment = root.Hungarian.solve(matrix);
  const bench = [];

  assignment.forEach((colIdx,rowIdx)=>{
    const p = remaining[rowIdx];
    const col = columns[colIdx];
    if(col==="BENCH"){ bench.push(p.id); return; }
    if(matrix[rowIdx][colIdx] >= BIG_M){
      // Hungarian still returns a complete assignment even when every option
      // for a row is disqualified (see HG-4) — but §5.2 forbids ever
      // committing an off-preference fill when allowOffPreference is off, so
      // bench the player instead. runGeneration discards the whole game's
      // schedule whenever `errors` is non-empty, so this is never shown live.
      errors.push({position:col, reason:"NO_ELIGIBLE_PLAYER"});
      bench.push(p.id);
      return;
    }
    onCourt[col]=p.id;
    if(!isInPreference(p,col)) offPreference[col]=true;
  });

  return { onCourt, bench, offPreference, errors };
}

/* ============================================================
   PHASE 2b — within-game local-search refinement
   ============================================================
   Confined to one game's own quarters: players trade slots within a quarter
   (one quarter at a time, or the same pair in two quarters at once). Each
   quarter's season-level signals (position counts, bench quota/cap) come from
   the *fixed* cumulative snapshot taken at the start of that quarter in the
   Phase 2a forward pass — except what this game itself adds (bench stints so
   far, benched last quarter, positions played in its earlier quarters), which
   is re-derived from the candidate lineup, so a trade that would bench
   someone past their cap, or repeat a position, is priced as exactly that. A
   trade is scored on the whole game's cost, since moving a bench stint
   changes later quarters' too. Below "no limit" on Centre quarters it also
   tries the quarters in other orders (Move 0, §4 rule 3a). */
/* Every ordering of `items`, the given order first. */
function permutationsOf(items){
  if(items.length<=1) return [items.slice()];
  return items.flatMap((x,i)=>permutationsOf(items.filter((_,j)=>j!==i)).map(rest=>[x].concat(rest)));
}
/* A quarter as one slot map: position -> id, plus "B0".."Bn" -> id for the bench. */
function quarterToAssign(q){
  const assign = {};
  POSITIONS.forEach(pos=>{ if(q.onCourt && q.onCourt[pos]) assign[pos]=q.onCourt[pos]; });
  (q.bench||[]).forEach((pid,i)=>{ assign["B"+i]=pid; });
  return assign;
}
const isBenchKey = k=>k.charAt(0)==="B";

/* The whole-game objective Phase 2b minimises: every quarter's cells summed,
   with what the game itself adds (bench stints so far, benched last quarter,
   positions played in its earlier quarters, who played Centre) re-derived from
   the lineup being scored. Only the season-level fields of the snapshots are
   read (posCount before the game from the first; benchQuota/benchCap), so one
   scorer prices any lineup for the same game.
   -> (qs:[slot map per quarter]) => number */
function makeGameScorer(squadPool, cumulativeSnapshots, settings){
  const playerById = {};
  squadPool.forEach(p=>{ playerById[p.id]=p; });
  // One cost-function pair per quarter, built once: the within-game fields
  // of each quarter's cumulative are re-pointed as the scorer walks the game.
  const liveCums = cumulativeSnapshots.map(cum=>Object.assign({}, cum));
  const costFns = liveCums.map(cum=>buildQuarterCostFns(cum, settings));
  const posCountBeforeGame = (cumulativeSnapshots[0]||{}).posCount||{};
  return function gameCost(qs){
    const nQ = qs.length;
    const gameBenchSoFar = {}, centres = [];
    const posCount = Object.assign({}, posCountBeforeGame);
    let benchedLastQuarter = new Set();
    let total = 0;
    for(let qi=0; qi<nQ; qi++){
      liveCums[qi].gameBenchSoFar = gameBenchSoFar;
      liveCums[qi].benchedLastQuarter = benchedLastQuarter;
      liveCums[qi].posCount = posCount;
      liveCums[qi].centres = centres;
      const { positionCellCost, benchCellCost } = costFns[qi];
      const bench = [], played = [];
      Object.keys(qs[qi]).forEach(key=>{
        const pid = qs[qi][key]; if(!pid) return;
        const isBench = isBenchKey(key);
        if(isBench) bench.push(pid);
        const p = playerById[pid]; if(!p) return;
        total += isBench ? benchCellCost(p) : positionCellCost(p,key);
        if(!isBench && !p.isFillIn) played.push(pid+"::"+key); // fill-ins stay out of season counts
      });
      centres.push(qs[qi].C); // fill-ins included: it's player welfare, not season fairness (§4 rule 3a)
      played.forEach(k=>{ posCount[k] = (posCount[k]||0)+1; }); // after the quarter is priced, as Phase 2a saw it
      bench.forEach(pid=>{ gameBenchSoFar[pid] = (gameBenchSoFar[pid]||0)+1; });
      benchedLastQuarter = new Set(bench);
    }
    return total;
  };
}
/* §4 rule 3a: Phase 2a solves a quarter at a time, so Q1 can't see that a Centre
   will have to sit out later, and undoing that afterwards takes a chain of trades
   longer than Phase 2b's pairs. So below "no limit" the caller tries whole-game
   Centre sequences up front: every way of giving each quarter's Centre to one of
   the squad members who list it highest (at most CENTRE_PLAN_CANDIDATES), keeping
   coach locks. A quarter with nobody to try is left to the solver (null).
   -> [[id|null x4]] */
function centreSequences(squad, lockedSlotsPerQuarter){
  const candidates = squad.map((p,i)=>({p,i})).filter(({p})=>isInPreference(p,"C"))
    .sort((a,b)=>(a.p.prefs.indexOf("C")-b.p.prefs.indexOf("C")) || (a.i-b.i)) // no list (-1) sorts first: happy anywhere
    .slice(0, CENTRE_PLAN_CANDIDATES).map(({p})=>p.id);
  const options = [0,1,2,3].map(q=>{
    const locks = lockedSlotsPerQuarter[q]||{};
    if(locks.C) return [locks.C];
    const lockedElsewhere = new Set(Object.values(locks));
    const free = candidates.filter(id=>!lockedElsewhere.has(id));
    return free.length ? free : [null];
  });
  return options.reduce((seqs,opts)=>seqs.flatMap(seq=>opts.map(id=>seq.concat([id]))), [[]]);
}

/* input: { quarters:[{onCourt,bench}], squadPool, cumulativeSnapshots, settings } -> number */
function scoreGameQuarters(input){
  return makeGameScorer(input.squadPool||[], input.cumulativeSnapshots||[], input.settings||{})(input.quarters.map(quarterToAssign));
}

/* input: { quarters:[{onCourt,bench,offPreference}], squadPool:[{id,prefs}],
            cumulativeSnapshots:[cum0,cum1,cum2,cum3], lockedSlotsPerQuarter:[{pos:id}],
            settings, timeBudgetMs }
   -> { quarters, stats:{swaps, elapsedMs} } */
function refineGameQuarters(input){
  const squadPool = input.squadPool||[];
  const settings = input.settings||{};
  const cumulativeSnapshots = input.cumulativeSnapshots||[];
  const lockedSlotsPerQuarter = input.lockedSlotsPerQuarter||[];
  const timeBudgetMs = input.timeBudgetMs!=null ? input.timeBudgetMs : PHASE2B_TIME_BUDGET_MS;
  const start = Date.now();
  const playerById = {};
  squadPool.forEach(p=>{ playerById[p.id]=p; });
  const qs = input.quarters.map(quarterToAssign);
  const nQ = qs.length;

  function isLocked(qi,key){
    if(isBenchKey(key)) return false;
    const locks = lockedSlotsPerQuarter[qi]||{};
    return !!locks[key];
  }
  const scoreGame = makeGameScorer(squadPool, qs.map((_,qi)=>cumulativeSnapshots[qi]||{}), settings);
  const gameCost = ()=>scoreGame(qs);
  // Two players trade slots within one quarter — the only move that keeps
  // everyone in exactly one slot per quarter. (Trading slots *between*
  // quarters would put a player in two slots of the same quarter whenever the
  // whole squad appears in each, i.e. always.)
  function trade(qi,keyA,keyB){
    const tmp = qs[qi][keyA]; qs[qi][keyA] = qs[qi][keyB]; qs[qi][keyB] = tmp;
  }
  const bothBench = (a,b)=>isBenchKey(a) && isBenchKey(b); // trading two bench seats changes nothing
  const freeKeys = qi=>Object.keys(qs[qi]).filter(k=>!isLocked(qi,k));
  const keyOf = (qi,pid)=>Object.keys(qs[qi]).find(k=>qs[qi][k]===pid);

  let swaps = 0;
  let improved = true;
  let best = gameCost();
  const keep = ()=>{
    const after = gameCost();
    if(after < best-1e-9){ best = after; improved = true; swaps++; return true; }
    return false;
  };
  // Quarters with no coach lock can be played in any order between themselves (Move 0).
  const movable = qs.map((_,qi)=>qi).filter(qi=>!Object.keys(lockedSlotsPerQuarter[qi]||{}).length);
  const reorders = centreQuartersOf(settings)<4 ? permutationsOf(movable).slice(1) : []; // [0] is the current order
  outer:
  while(improved){
    improved = false;
    // Move 0 (§4 rule 3a, below "no limit" only): play the quarters in a different
    // order. Everyone keeps every slot, so only what depends on order changes —
    // back-to-back Centre (and bench) quarters, and where a Centre rests. Pair
    // trades can't reach this: it moves every player at once.
    if(reorders.length){
      const current = qs.slice();
      let bestOrder = null;
      reorders.forEach(perm=>{
        movable.forEach((qi,k)=>{ qs[qi] = current[perm[k]]; });
        const after = gameCost();
        if(after < best-1e-9){ best = after; bestOrder = perm; }
      });
      movable.forEach((qi,k)=>{ qs[qi] = current[bestOrder ? bestOrder[k] : qi]; });
      if(bestOrder){ improved = true; swaps++; }
    }
    // Move 1: one trade in one quarter. Each quarter was solved exactly given
    // the quarters before it, but not the ones after — hindsight can still
    // move a bench stint to a better quarter or player.
    for(let qi=0; qi<nQ; qi++){
      if(Date.now()-start>timeBudgetMs) break outer;
      const keys = freeKeys(qi);
      for(let a=0; a<keys.length; a++){
        if(Date.now()-start>timeBudgetMs) break outer;
        for(let b=a+1; b<keys.length; b++){
          if(bothBench(keys[a],keys[b])) continue;
          trade(qi,keys[a],keys[b]);
          if(!keep()) trade(qi,keys[a],keys[b]);
        }
      }
    }
    // Move 2: the same two players trade slots in two quarters at once, so
    // each keeps their bench count — reaches lineups where either trade alone
    // would look like a bench-fairness loss.
    for(let qi=0; qi<nQ; qi++){
      for(let qj=qi+1; qj<nQ; qj++){
        if(Date.now()-start>timeBudgetMs) break outer;
        const keysI = freeKeys(qi);
        for(let a=0; a<keysI.length; a++){
          if(Date.now()-start>timeBudgetMs) break outer;
          for(let b=a+1; b<keysI.length; b++){
            const keyAj = keyOf(qj, qs[qi][keysI[a]]), keyBj = keyOf(qj, qs[qi][keysI[b]]);
            if(!keyAj || !keyBj || isLocked(qj,keyAj) || isLocked(qj,keyBj)) continue;
            if(bothBench(keysI[a],keysI[b]) || bothBench(keyAj,keyBj)) continue; // one half is a no-op: that's just Move 1
            trade(qi,keysI[a],keysI[b]); trade(qj,keyAj,keyBj);
            if(!keep()){ trade(qi,keysI[a],keysI[b]); trade(qj,keyAj,keyBj); }
          }
        }
      }
    }
  }

  const quarters = qs.map(assign=>{
    const onCourt = {}; const bench = []; const offPreference = {};
    Object.keys(assign).forEach(key=>{
      const pid = assign[key];
      if(isBenchKey(key)) bench.push(pid);
      else {
        onCourt[key]=pid;
        const p = playerById[pid];
        if(p && !isInPreference(p,key)) offPreference[key]=true;
      }
    });
    return { onCourt, bench, offPreference };
  });

  return { quarters, stats:{ swaps, elapsedMs: Date.now()-start } };
}

/* ============================================================
   Reports-tab warning: missed-games spread across the roster
   ============================================================ */
function computeMissedGamesWarning(missedByPlayer, threshold){
  if(!missedByPlayer || !missedByPlayer.length) return null;
  const spreadThreshold = threshold==null ? MISSED_GAMES_WARNING_SPREAD : threshold;
  const vals = missedByPlayer.map(p=>p.missed);
  const max = Math.max(...vals), min = Math.min(...vals);
  const spread = max-min;
  if(spread<=spreadThreshold) return null;
  return {
    spread, max, min,
    mostMissed: missedByPlayer.filter(p=>p.missed===max).map(p=>p.name),
    leastMissed: missedByPlayer.filter(p=>p.missed===min).map(p=>p.name),
    suggestion: "Consider lowering the desired bench size, reducing reliance on off-preference restrictions, or manually overriding roster-off for a specific game."
  };
}

const RosterSolver = {
  POSITIONS,
  CONSTANTS: {
    PHASE1_FAIRNESS_WEIGHT, PHASE1_COVERAGE_WEIGHT, PHASE1_TIME_BUDGET_MS, PHASE1_MAX_PASSES,
    PHASE1_RESTART_SEED, PHASE1_STAGNANT_ATTEMPTS_LIMIT,
    COVERAGE_GAP_ZERO_PENALTY, COVERAGE_GAP_ONE_PENALTY, FORCED_ON_COURT_PENALTY, ROSTER_OFF_TIEBREAK_WEIGHT,
    MISSED_GAMES_WARNING_SPREAD, PHASE2B_TIME_BUDGET_MS, BIG_M, THIN_POSITION_PREFERRER_THRESHOLD,
    COURT_TIME_WEIGHT, BENCH_CAP_PENALTY, CENTRE_OVER_TARGET_COST, CENTRE_BACK_TO_BACK_COST, CENTRE_THIRD_IN_ROW_COST, CENTRE_FATIGUE_COST, CENTRE_PLAN_CANDIDATES, BACK_TO_BACK_BENCH_PENALTY, STRICT_SPECIALIST_COVERAGE_BOOST, STRICT_SPECIALIST_MIN_COVERAGE_WEIGHT,
    OFF_PREFERENCE_COST, OFF_PREFERENCE_LAST_RESORT, PREFERENCE_RATIO_AT_0, PREFERENCE_RATIO_AT_9,
    ROSTER_OFF_PRIORITIES, ROSTER_OFF_COVERAGE_WEIGHT, NO_PREFERENCE_COST, DEFAULT_SETTINGS,
    DEFAULT_POSITION_LOAD, POSITION_LOAD_MIN, POSITION_LOAD_MAX
  },
  variance,
  clampSetting,
  isInPreference,
  gameCoveragePenalty,
  forcedOnCourtCount,
  hasZeroCoverage,
  deriveRosterOffWeights,
  derivePreferenceWeights,
  solveSeasonRosterOff,
  cleanPositionLoad,
  rawPositionLoads,
  centreQuartersOf,
  derivePositionLoads,
  playerLoadStats,
  computeCourtTargets,
  baseBenchCap,
  planGameBench,
  buildQuarterCostFns,
  solveQuarterPositions,
  refineGameQuarters,
  scoreGameQuarters,
  centreSequences,
  computeMissedGamesWarning,
  computeRosterOffAchievabilityNotes
};

if(typeof module!=="undefined" && module.exports){ module.exports = RosterSolver; }
if(root) root.RosterSolver = RosterSolver;

})(typeof window!=="undefined" ? window : (typeof global!=="undefined" ? global : this));
