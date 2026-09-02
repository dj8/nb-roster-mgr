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
const COVERAGE_OVERLAP_WEIGHT = 10;     // unused — superseded by the rank-weighted penalty in gameCoveragePenalty()
const MISSED_GAMES_WARNING_SPREAD = 2;  // Reports-tab warning threshold (max-min missed games)
const PHASE2B_TIME_BUDGET_MS = 500;
const BIG_M = 1e9;                      // disqualified-cell sentinel; finite so Hungarian's potential arithmetic stays sane
const THIN_POSITION_PREFERRER_THRESHOLD = 1; // at or below this many preferrers, resting anyone risks zero coverage
const BENCH_SCALE_BOOST = 10;           // offsets the (1-sliderNorm) attenuation on bench cost, below
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

/* True if removing `offPlayers` from `pool` leaves any position with zero
   in-preference coverage. The hard version of the penalty above — when
   "allow off-preference" is off, Phase 1 must never produce this, since
   Phase 2 will hard-error on it. */
function hasZeroCoverage(squadAfter){
  return POSITIONS.some(pos=>!squadAfter.some(p=>p.prefs.includes(pos)));
}

/* Maps the 0-10 "roster-off fairness <-> position coverage" slider onto
   Phase 1's {fairness, coverage} weights. Fairness is held constant; coverage
   scales from 0 (slider=0, pure fairness) to PHASE1_COVERAGE_WEIGHT (slider=10,
   the default). */
function deriveRosterOffWeights(rosterOffWeight){
  const clamped = clampSetting(rosterOffWeight, 0, 10, 10);
  return {
    fairness: PHASE1_FAIRNESS_WEIGHT,
    coverage: (clamped/10) * PHASE1_COVERAGE_WEIGHT
  };
}

/* ============================================================
   PHASE 1 — season-wide roster-off allocation
   ============================================================
   input.players: [{id, prefs, unavailableCount}]  (season-total known unavailability)
   input.games:   [{num, availableIds:[id...], rosterOffCount, fixedOffIds:[id...]|null}]
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
  function totalObjectiveOf(current){
    const missed = totalMissedMapOf(current);
    const fairnessTerm = fairnessWeight*variance(Object.values(missed));
    let coverageTerm = 0;
    games.forEach(g=>{
      const offIds = g.fixedOffIds!=null ? g.fixedOffIds : (current[g.num]||[]);
      const offSet = new Set(offIds);
      const pool = g.availableIds.map(id=>playerById[id]).filter(Boolean);
      const squadAfter = pool.filter(p=>!offSet.has(p.id));
      coverageTerm += effectiveCoverageWeight(g)*gameCoveragePenalty(squadAfter);
    });
    return fairnessTerm + coverageTerm;
  }

  /* ---- greedy seed: fairness-first, coverage-aware tie-break ---- */
  function buildSeed(gameOrder){
    const current = {};
    const runningMissed = {};
    players.forEach(p=>{ runningMissed[p.id] = fixedMissedBase[p.id]||0; });
    gameOrder.forEach(g=>{
      const pool = g.availableIds.map(id=>playerById[id]).filter(Boolean);
      const picked = [];
      const remaining = pool.slice();
      for(let k=0;k<g.rosterOffCount && remaining.length;k++){
        let best=null, bestScore=Infinity;
        let bestSafe=null, bestSafeScore=Infinity; // fallback if every candidate is disqualified (structurally forced)
        remaining.forEach(cand=>{
          const missed = runningMissed[cand.id]||0;
          const squadAfter = pool.filter(pp=>pp.id!==cand.id && !picked.some(x=>x.id===pp.id));
          const score = missed*1000 + effectiveCoverageWeight(g)*gameCoveragePenalty(squadAfter);
          if(score<bestSafeScore){ bestSafeScore=score; bestSafe=cand; }
          const disqualified = !allowOffPreference && hasZeroCoverage(squadAfter);
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
        const pool = g.availableIds.map(id=>playerById[id]).filter(Boolean);
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
            if(!allowOffPreference && hasZeroCoverage(squadAfterSwap)) continue; // hard rule: never swap into a zero-coverage state
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
          const pool1 = g1.availableIds.map(id=>playerById[id]).filter(Boolean);
          const pool2 = g2.availableIds.map(id=>playerById[id]).filter(Boolean);
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
              const blocked = !allowOffPreference && (
                hasZeroCoverage(pool1.filter(p=>!newOff1.has(p.id))) ||
                hasZeroCoverage(pool2.filter(p=>!newOff2.has(p.id)))
              );
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
            const poolA = gA.availableIds.map(id=>playerById[id]).filter(Boolean);
            const offA = new Set(current[gA.num]);
            if(!offA.has(H)) continue; // H must be off in gA
            for(const X of poolA){
              if(offA.has(X.id) || X.id===H || X.id===L) continue; // X must be on in gA
              for(const gB of gameOrder){
                if(gB===gA) continue;
                const poolB = gB.availableIds.map(id=>playerById[id]).filter(Boolean);
                const offB = new Set(current[gB.num]);
                if(!offB.has(X.id)) continue; // X must be off in gB
                if(offB.has(L) || !poolB.some(p=>p.id===L)) continue; // L must be on in gB
                const newOffA = new Set(offA); newOffA.delete(H); newOffA.add(X.id);
                const newOffB = new Set(offB); newOffB.delete(X.id); newOffB.add(L);
                const blocked = !allowOffPreference && (
                  hasZeroCoverage(poolA.filter(p=>!newOffA.has(p.id))) ||
                  hasZeroCoverage(poolB.filter(p=>!newOffB.has(p.id)))
                );
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
        message: `${names.join(" and ")} ${single?"is the only player":"are the only players"} who prefer${single?"s":""} ${pos}. Resting ${single?"them":"both"} would leave ${pos} uncovered, so the roster-off split may never come out perfectly even — expect ${single?"them":"them"} to end up with fewer missed games than the rest of the roster.`
      });
    }
  });
  return notes;
}

/* ============================================================
   PHASE 2a — exact per-quarter Hungarian position assignment
   ============================================================ */

/* `weights.bench` is a single "playing-time evenness" dial: it sets bench
   cell cost (so bench rotation emerges from the same optimization, not a
   separate pass) and tie-breaks position cells tied on preference rank
   toward whoever's had less on-court time. `weights.positionPurity` nudges
   a player away from an over-played position. Both terms are bounded well
   below 1 so they can never flip an in-preference rank into losing against
   an off-preference candidate (cost = "one worse than list length") —
   raising either weight can only make in-preference candidates cheaper
   relative to off-preference ones, never the reverse. */
function buildQuarterCostFns(cumulative, settings){
  const slider = clampSetting(settings.preferenceSlider, 0, 10, 9);
  const sliderNorm = slider/10;
  // The balance/bench side's weight, symmetric with sliderNorm. Linear, not a
  // steeper falloff (e.g. squared) — a squared curve was tried and measured
  // strictly worse on the monotonicity sweep below, since the residual
  // non-monotonicity is path-dependence across the cumulative multi-quarter
  // solve, which no per-cell curve can fix.
  const balanceDamping = (1-sliderNorm);
  const allowOff = !!settings.allowOffPreference;
  const topTwo = !!settings.topTwoOnly;
  const weights = settings.fairnessWeights||{};
  const benchWeight = clampSetting(weights.bench, 1, 10, 2);
  const purityWeight = clampSetting(weights.positionPurity, 1, 10, 1);

  /* Ranks against the player's *full* stated list, never just the top 2 —
     §5.2 defines off-preference as "outside the stated list", and slicing to
     top 2 would make a 3rd+ choice indistinguishable from an unlisted
     position (both hit `idx<0` below). §4 rule 5's "prefer top 2" is a soft
     variety nudge (see topTwo below), not an eligibility cutoff. */
  function prefRank(p,pos){
    return p.prefs.indexOf(pos);
  }
  function preferenceCost(p,pos){
    const idx = prefRank(p,pos);
    if(idx>=0) return idx;
    // "One worse than their whole list" — floored at 1 so a player with zero
    // stated preferences (prefs.length === 0) doesn't cost the same as a
    // genuine rank-0 specialist and out-compete them at every position.
    return allowOff ? Math.max(1, p.prefs.length) : null;
  }
  /* Purity penalty (a position already played a lot) plus, with "top 2 only"
     on, a small extra nudge off a 3rd+-ranked position. Capped relative to
     this candidate's own gap to its off-preference cost (prefs.length - idx),
     not a flat constant — a flat cap saturates almost immediately and could
     never outweigh a single preference-rank step, so a #1 choice could never
     lose to a #2 no matter how overplayed. Scaling the cap to the player's
     own list preserves "never costs more than the off-preference fallback"
     while letting a low-ranked position actually lose ground as it's played
     out (§11's "spread across the whole list"). */
  function purityAndVarietyTerm(p,pos){
    const idx = prefRank(p,pos);
    if(idx<0) return 0; // no purity/variety signal for an off-preference cell
    const posCount = (cumulative.posCount && cumulative.posCount[p.id+"::"+pos]) || 0;
    const purity = 0.15*purityWeight*Math.log2(1+posCount);
    const scopeBump = (topTwo && idx>=2) ? 0.3 : 0;
    const safeCap = Math.max(0, (p.prefs.length-idx) - 0.05);
    return Math.min(purity+scopeBump, safeCap);
  }
  /* Squad-quarters (on-court + bench) decided so far this season, per this
     quarter's cumulative snapshot. Used to turn onCourt/bench totals into
     RATES rather than raw counts, so a player half-way through an 11-game
     season and one three games into a 20-game season look equally
     "overplayed" — an unbounded raw count would otherwise keep climbing all
     season and quietly outweigh preference cost regardless of the slider. */
  function quartersSoFar(p){
    return ((cumulative.onCourt&&cumulative.onCourt[p.id])||0) + ((cumulative.bench&&cumulative.bench[p.id])||0);
  }
  function balanceCost(p){
    const played = quartersSoFar(p);
    const onCourtRate = played>0 ? ((cumulative.onCourt&&cumulative.onCourt[p.id])||0)/played : 0;
    return onCourtRate*benchWeight;
  }
  function positionCellCost(p,pos){
    const pc = preferenceCost(p,pos);
    if(pc===null) return BIG_M;
    const prefSide = pc + purityAndVarietyTerm(p,pos);
    const balanceSide = balanceCost(p);
    return sliderNorm*prefSide + balanceDamping*balanceSide;
  }
  /* Bench-slot cost, scaled by the same balanceDamping factor as balanceCost
     (and boosted by BENCH_SCALE_BOOST to keep a comparable magnitude at the
     default slider). This makes it exactly 0 at slider=10, guaranteeing
     bench-rotation pressure can never be the reason an in-preference
     candidate loses to an off-preference one at max preference (§5.1).
     Back-to-back-bench avoidance (§4 rule 6) is left unscaled — a small,
     preference-neutral tie-break, not part of the slider's trade-off. */
  function benchCellCost(p){
    const played = quartersSoFar(p);
    const benchRate = played>0 ? ((cumulative.bench&&cumulative.bench[p.id])||0)/played : 0;
    const thisGame = (cumulative.gameBenchSoFar && cumulative.gameBenchSoFar[p.id])||0;
    const backToBack = (cumulative.benchedLastQuarter && cumulative.benchedLastQuarter.has && cumulative.benchedLastQuarter.has(p.id)) ? 2 : 0;
    const scaledSeasonSide = balanceDamping*BENCH_SCALE_BOOST*(benchRate*benchWeight + thisGame*0.3);
    return scaledSeasonSide + backToBack;
  }
  return { positionCellCost, benchCellCost, isDisqualified:(p,pos)=>preferenceCost(p,pos)===null };
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
      if(!p.prefs.includes(pos)) offPreference[pos]=true;
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
    if(!p.prefs.includes(col)) offPreference[col]=true;
  });

  return { onCourt, bench, offPreference, errors };
}

/* ============================================================
   PHASE 2b — within-game local-search refinement
   ============================================================
   Confined to one game's own quarters. Each quarter's cost is scored against
   a *fixed* cumulative snapshot taken at the start of that quarter in the
   Phase 2a forward pass, rather than re-propagating cascading effects
   through downstream quarters — keeps refinement simple and fast while still
   closing most of the gap between "each quarter optimal alone" and "this
   game, as a whole, is good."
   input: { quarters:[{onCourt,bench,offPreference}], squadPool:[{id,prefs}],
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

  function toAssign(q){
    const assign = {};
    POSITIONS.forEach(pos=>{ if(q.onCourt && q.onCourt[pos]) assign[pos]=q.onCourt[pos]; });
    (q.bench||[]).forEach((pid,i)=>{ assign["B"+i]=pid; });
    return assign;
  }
  const qs = input.quarters.map(toAssign);
  const nQ = qs.length;

  function isLocked(qi,key){
    if(key.charAt(0)==="B") return false;
    const locks = lockedSlotsPerQuarter[qi]||{};
    return !!locks[key];
  }
  function costOfQuarter(qi){
    const { positionCellCost, benchCellCost } = buildQuarterCostFns(cumulativeSnapshots[qi]||{}, settings);
    let total = 0;
    Object.keys(qs[qi]).forEach(key=>{
      const pid = qs[qi][key]; if(!pid) return;
      const p = playerById[pid]; if(!p) return;
      total += key.charAt(0)==="B" ? benchCellCost(p) : positionCellCost(p,key);
    });
    return total;
  }
  function swap(qi,keyA,qj,keyB){
    const tmp = qs[qi][keyA];
    qs[qi][keyA] = qs[qj][keyB];
    qs[qj][keyB] = tmp;
  }
  // A cross-quarter swap is only valid if it doesn't leave the same player
  // occupying two slots within one quarter (e.g. swapping a player into qi
  // who already appears elsewhere in qi under a different key).
  function wouldDuplicate(qi,excludeKey,incomingPlayerId){
    if(!incomingPlayerId) return false;
    return Object.keys(qs[qi]).some(k=>k!==excludeKey && qs[qi][k]===incomingPlayerId);
  }

  let swaps = 0;
  let improved = true;
  outer:
  while(improved){
    improved = false;
    for(let qi=0; qi<nQ; qi++){
      for(let qj=qi+1; qj<nQ; qj++){
        if(Date.now()-start>timeBudgetMs) break outer;
        const keysA = Object.keys(qs[qi]).filter(k=>!isLocked(qi,k));
        const keysB = Object.keys(qs[qj]).filter(k=>!isLocked(qj,k));
        for(const keyA of keysA){
          for(const keyB of keysB){
            const playerA = qs[qi][keyA], playerB = qs[qj][keyB];
            if(playerA===playerB) continue;
            if(wouldDuplicate(qi,keyA,playerB)) continue;
            if(wouldDuplicate(qj,keyB,playerA)) continue;
            const before = costOfQuarter(qi)+costOfQuarter(qj);
            swap(qi,keyA,qj,keyB);
            const after = costOfQuarter(qi)+costOfQuarter(qj);
            if(after < before-1e-9){ improved = true; swaps++; }
            else { swap(qi,keyA,qj,keyB); } // revert (map-swap is its own inverse)
          }
        }
      }
    }
  }

  const quarters = qs.map(assign=>{
    const onCourt = {}; const bench = []; const offPreference = {};
    Object.keys(assign).forEach(key=>{
      const pid = assign[key];
      if(key.charAt(0)==="B") bench.push(pid);
      else {
        onCourt[key]=pid;
        const p = playerById[pid];
        if(p && !p.prefs.includes(key)) offPreference[key]=true;
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
    COVERAGE_GAP_ZERO_PENALTY, COVERAGE_GAP_ONE_PENALTY, COVERAGE_OVERLAP_WEIGHT,
    MISSED_GAMES_WARNING_SPREAD, PHASE2B_TIME_BUDGET_MS, BIG_M, THIN_POSITION_PREFERRER_THRESHOLD,
    BENCH_SCALE_BOOST, STRICT_SPECIALIST_COVERAGE_BOOST, STRICT_SPECIALIST_MIN_COVERAGE_WEIGHT
  },
  variance,
  clampSetting,
  gameCoveragePenalty,
  hasZeroCoverage,
  deriveRosterOffWeights,
  solveSeasonRosterOff,
  buildQuarterCostFns,
  solveQuarterPositions,
  refineGameQuarters,
  computeMissedGamesWarning,
  computeRosterOffAchievabilityNotes
};

if(typeof module!=="undefined" && module.exports){ module.exports = RosterSolver; }
if(root) root.RosterSolver = RosterSolver;

})(typeof window!=="undefined" ? window : (typeof global!=="undefined" ? global : this));
