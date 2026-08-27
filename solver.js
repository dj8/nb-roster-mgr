/* ============================================================
   Roster solver — season-wide roster-off search (Phase 1),
   exact per-quarter Hungarian position assignment (Phase 2a),
   and within-game local-search refinement (Phase 2b).
   Pure: no DOM, no localStorage, no reference to app-level STATE.
   Every function takes explicit plain-data input and returns
   plain data. Depends on hungarian.js (must load first).
   ============================================================ */
(function(root){
"use strict";

const POSITIONS = ["GS","GA","WA","C","WD","GD","GK"];

/* ---------------- Tunable constants (retune here) ---------------- */
const PHASE1_FAIRNESS_WEIGHT = 1;       // secondary objective weight
const PHASE1_COVERAGE_WEIGHT = 4;       // dominant — preference-enablement matters more
const PHASE1_TIME_BUDGET_MS = 3000;
const PHASE1_MAX_PASSES = 50;
const COVERAGE_GAP_ZERO_PENALTY = 100;  // a position with 0 remaining covering players
const COVERAGE_GAP_ONE_PENALTY = 30;    // a position with exactly 1 remaining covering player
const COVERAGE_OVERLAP_WEIGHT = 10;     // two players rostered off together who share a preferred position
const MISSED_GAMES_WARNING_SPREAD = 2;  // reports-tab warning threshold (max-min missed games)
const PHASE2B_TIME_BUDGET_MS = 500;     // per-game refinement budget
const BIG_M = 1e9;                      // disqualified-cell sentinel (finite, keeps Hungarian arithmetic sane)
const THIN_POSITION_PREFERRER_THRESHOLD = 1; // positions with this many (or fewer) preferrers can't be rested without risking zero coverage
const BENCH_SCALE_BOOST = 10;           // compensates bench cost for the (1-sliderNorm) attenuation below, so it keeps its old (pre-normalization) magnitude at the default slider (9)
const PHASE1_RESTART_SEED = 0xC0FFEE;   // fixed seed -> deterministic, reproducible restarts (no Math.random)
const STRICT_SPECIALIST_COVERAGE_BOOST = 3; // §5.5 per-game toggle: how much more heavily THIS game's coverage penalty counts, on top of the season-wide weight, when its own strict_specialist_pairing flag is on
const STRICT_SPECIALIST_MIN_COVERAGE_WEIGHT = PHASE1_COVERAGE_WEIGHT; // floor, not just a multiplier — a multiplicative boost alone does nothing when the season-wide slider is at 0 (fully coverage-blind), and the per-game toggle must still work at that extreme
const PHASE1_STAGNANT_ATTEMPTS_LIMIT = 25; // stop restarting after this many non-improving attempts in a row

/* Deterministic PRNG (mulberry32) — used only to reorder games between restart
   attempts, never to decide who's rostered off. Fixed seed keeps every run
   (and every test) reproducible. */
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

/* Coerce an untrusted setting (localStorage, CSV import, hand-edited state) to a
   number inside [lo,hi]. `Math.max(0,Math.min(10,NaN))` is NaN, which used to
   flow straight into the cost model and poison every comparison downstream —
   NaN < x is false, so the search silently selected nothing. Anything
   non-finite falls back to `fallback` instead. */
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

/* Rank-weighted per-position coverage-gap penalty for one game's final
   roster-off outcome: for each position, look at who's actually left
   covering it once every rostered-off player for this game has been
   removed, and penalize heavily at 0 remaining, moderately at 1 remaining.
   This alone already captures "did rostering these specific people off
   together strip a position's depth" correctly, however many of them
   share that position — no separate pairwise term is needed on top (an
   earlier version added one, but it fired on *any* shared preference
   regardless of remaining depth elsewhere, which over-penalized rosters
   with broadly overlapping preference lists — see COVERAGE_OVERLAP_WEIGHT,
   now unused but left as a named constant in case a rank-weighted
   tie-break signal is wanted again later). */
function gameCoveragePenalty(squadAfterOff, offPlayers){
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

/* True if, after removing `offPlayers` from `pool`, some position would be left
   with zero in-preference covering players. Used to enforce a *hard* rule when
   "allow off-preference" is off — a zero-coverage position isn't just
   undesirable then, it's disallowed (Phase 2 will hard-error on it), so Phase 1
   must never hand it a configuration like that. */
function hasZeroCoverage(squadAfter){
  return POSITIONS.some(pos=>!squadAfter.some(p=>p.prefs.includes(pos)));
}

/* Map the single 0-10 "roster-off fairness <-> position coverage" slider onto
   Phase 1's {fairness, coverage} weights. Fairness weight is held constant;
   coverage weight scales from 0 (slider=0, coverage-blind — pure fairness) up
   to PHASE1_COVERAGE_WEIGHT (slider=10, reproducing the original hardcoded
   default ratio, which is what shipped previously and stays the default). */
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
  /* §5.5: a game with its own strict_specialist_pairing flag on counts its
     OWN coverage penalty more heavily than the season-wide coverageWeight
     alone would — a small, bounded, per-game deviation from strict fairness
     ordering, used to protect that one game's position coverage without
     changing the season-wide balance for every other game (which keeps
     using the plain coverageWeight, untouched). */
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
      const offPlayers = pool.filter(p=>offSet.has(p.id));
      coverageTerm += effectiveCoverageWeight(g)*gameCoveragePenalty(squadAfter, offPlayers);
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
          const off = picked.concat([cand]);
          const score = missed*1000 + effectiveCoverageWeight(g)*gameCoveragePenalty(squadAfter, off);
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

  /* ---- local-search refinement: single-game swaps + paired cross-game
     exchanges, until no move improves or the shared deadline is hit ---- */
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

      // Move 2: paired cross-game exchange — swap *which* of two games player A
      // is rested in with player B's, when A is off in g1/on in g2 and B is off
      // in g2/on in g1. This leaves both A's and B's total missed-game count
      // unchanged (each is still off in exactly one of the two games), so it's
      // a pure coverage-penalty move — and it's what lets the search escape a
      // local optimum where fairness is already perfectly even but the two
      // single-game swaps that would get there each individually look like a
      // fairness regression on their own (and get rejected), even though doing
      // both together is fairness-neutral.
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

      // Move 3: two-hop chained exchange, targeting the current most- and
      // least-missed players (H, L). H hands off their off-slot in gameA to
      // an intermediary X (who's on-court there); X's *own* off-slot in some
      // other gameB then gets handed to L. X's total is unchanged (they lose
      // one off-game and gain another), so the fairness gain is isolated to
      // H (-1) and L (+1) only. This is what closes gaps neither a single-
      // game swap nor a same-pair cross-game exchange can reach alone, since
      // each half looks like a regression in isolation but chaining through
      // X cancels X's own count exactly.
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

  /* ---- attempt 0: original deterministic game order (exact prior behavior —
     in particular, a non-positive timeBudgetMs still yields a pure, deterministic
     seed with zero refinement passes, same as before this restart mechanism
     existed). Further attempts reorder games via a fixed-seed PRNG (never
     Math.random, so results stay reproducible) purely to give the greedy seed
     a different construction order — single-swap and paired-exchange local
     search alone can get stuck in a coverage-penalty local optimum that a
     differently-ordered seed sidesteps entirely (this is what the reported
     11-player/11-game/2-off-per-game case needed). Stops early once a
     near-perfect objective is reached or restarts stop improving. ---- */
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
   Roster-off achievability: positions so thin (few preferrers) that
   perfectly even missed-games counts can be structurally out of reach.
   Season/settings-independent — purely about roster composition, since
   this is a real constraint whenever "allow off-preference" is off (and,
   even when it's on, a strong practical pull in the same direction).
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

/* NOTE on cost design: `weights.bench` is a single unified "playing-time
   evenness" dial. It drives both (a) the bench cell's cost — lower cost
   (more likely picked) for players with less season/this-game bench time
   so far, which is how bench rotation emerges from the same optimization
   instead of a separate pass — and (b) a lightweight tie-break among
   position cells for players tied on preference rank, biased toward
   whoever has had less on-court time this season. `weights.positionPurity`
   nudges a player away from a position they've already played a lot this
   season. Both purity and balance terms are bounded well below 1 (an
   integer) so they can never flip an in-preference rank into losing
   against an off-preference candidate (whose cost is exactly "one worse
   than list length") — that preserves the slider's monotonicity
   guarantee: raising it can only make in-preference candidates cheaper
   relative to off-preference ones, never the reverse. */
function buildQuarterCostFns(cumulative, settings){
  const slider = clampSetting(settings.preferenceSlider, 0, 10, 9);
  const sliderNorm = slider/10;
  // The balance/bench side's weight, symmetric with sliderNorm's weight on
  // the preference side. (A steeper, e.g. squared, falloff was tried here to
  // try to further quiet residual wobble in the 7-10 "mostly preference"
  // region — it measurably made the fuzzed monotonicity sweep below *worse*,
  // not better, which is itself informative: the remaining non-monotonicity
  // isn't "balance noise occasionally outvotes a marginal preference
  // decision" so much as path-dependence across a sequential, cumulative-
  // state multi-quarter/multi-game solve, which a per-cell weighting curve
  // can't reach. Kept linear, the simpler and empirically-no-worse option.)
  const balanceDamping = (1-sliderNorm);
  const allowOff = !!settings.allowOffPreference;
  const topTwo = !!settings.topTwoOnly;
  const weights = settings.fairnessWeights||{};
  const benchWeight = clampSetting(weights.bench, 1, 10, 2);
  const purityWeight = clampSetting(weights.positionPurity, 1, 10, 1);

  /* Always rank against the player's *full* stated list — §5.2 defines
     off-preference as "outside the stated preference list", not "outside the
     top 2". Slicing to the top 2 here (as this used to do) made a player's
     3rd+ preference indistinguishable from a position they never listed at
     all: both hit the `idx<0` branch below, so with allowOffPreference off,
     a position only ever preferred as someone's 3rd choice could be reported
     as having *no* eligible in-preference player, even though it manifestly
     does. §4 rule 5 makes "prefer top 2" a position-*variety* scope — a soft
     nudge toward a player's top 2 — not a hard eligibility cutoff. */
  function prefRank(p,pos){
    return p.prefs.indexOf(pos);
  }
  function preferenceCost(p,pos){
    const idx = prefRank(p,pos);
    if(idx>=0) return idx;
    // Off-preference cost is "one worse than their whole list". For a player
    // with zero stated preferences, `p.prefs.length` is 0 — the same as a
    // rank-0 specialist's cost — which made an empty preference list the
    // single cheapest possible candidate at every position, beating every
    // real specialist. Floor at 1 so it's never better than a genuine rank-0
    // in-preference pick, while staying "one worse than the whole list" for
    // any player who actually listed at least one position.
    return allowOff ? Math.max(1, p.prefs.length) : null;
  }
  /* Bonus/penalty layered onto an in-preference rank: purity (nudge away from
     a position already played a lot) and, when "prefer top 2 only" is on, a
     small extra nudge away from a 3rd+-ranked position. Capped relative to
     THIS candidate's own gap to their off-preference cost
     (prefs.length - idx), not a flat constant — a flat cap under 1 (as this
     used to be) saturates almost immediately (posCount=1 already maxes it
     out at typical purity weights), so raising the weight further had no
     visible effect: it could never even overcome a single preference-rank
     step, meaning a player's #1 choice could never lose to their #2 no
     matter how many times they'd already played it. Scaling the cap to the
     player's own list keeps the one property that actually matters — an
     in-preference candidate never costs more than their own off-preference
     fallback — while giving a low-ranked (especially rank-0) position much
     more room to lose ground as it gets played out, so "spread across the
     whole list" (§11) is something the weight can actually do. */
  function purityAndVarietyTerm(p,pos){
    const idx = prefRank(p,pos);
    if(idx<0) return 0; // no purity/variety signal for an off-preference cell
    const posCount = (cumulative.posCount && cumulative.posCount[p.id+"::"+pos]) || 0;
    const purity = 0.15*purityWeight*Math.log2(1+posCount);
    const scopeBump = (topTwo && idx>=2) ? 0.3 : 0;
    const safeCap = Math.max(0, (p.prefs.length-idx) - 0.05);
    return Math.min(purity+scopeBump, safeCap);
  }
  /* How many of this player's squad-quarters (on-court + bench) have already
     been decided this season, per the cumulative snapshot this quarter's
     solve is working from. Turns onCourt/bench totals into RATES rather than
     raw, ever-growing counts: a player who's played half of an 11-game season
     should look about as "overplayed" (or not) as one three games into a
     20-game season, not have their raw count keep climbing all season in a
     way that quietly outweighs preference cost later on regardless of the
     preference slider — which is what an unbounded count multiplied by an
     unbounded weight did before, and was the main reason bench/balance
     weight changes could shift off-preference fill counts in ways their own
     slider labels didn't predict. */
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
  /* Bench-slot cost, scaled by the SAME balanceDamping factor as balanceCost
     above, and boosted back up by BENCH_SCALE_BOOST so it keeps a comparable
     magnitude to before at the default slider (9). Previously this wasn't
     scaled by the slider at all, so raising the preference slider toward
     "strict preference" could still leave bench-rotation pressure competing
     with — and occasionally beating — preference cost when deciding who gets
     a court slot vs a bench slot, which is how bench weight could increase
     off-preference fills even at the slider's literal maximum (10), directly
     contradicting §5.1 ("at the high end ... off-preference fills only occur
     when no in-preference candidate is eligible at all"). Scaling it the same
     way as balanceCost makes it exactly 0 at slider=10, and negligible well
     before that — bench rotation still meaningfully differentiates
     candidates across the lower/middle range, including the default, while
     guaranteeing it can't be the reason an in-preference candidate loses out
     once the coach has asked for mostly-strict preference.
     back-to-back-bench avoidance (§4 rule 6, within-game polish) is left
     unscaled: it's a small, preference-neutral tie-break, not part of the
     preference-vs-fairness trade-off the slider governs. */
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
    if(matrix[rowIdx][colIdx] >= BIG_M){ errors.push({position:col, reason:"NO_ELIGIBLE_PLAYER"}); }
    onCourt[col]=p.id;
    if(!p.prefs.includes(col)) offPreference[col]=true;
  });

  return { onCourt, bench, offPreference, errors };
}

/* ============================================================
   PHASE 2b — within-game local-search refinement
   ============================================================
   Confined to one game's own quarters. Each quarter's cost is evaluated
   against a *fixed* cumulative snapshot captured at the start of that
   quarter during the Phase 2a forward pass — swaps re-score using those
   same snapshots rather than re-propagating cascading cumulative effects
   through downstream quarters, which keeps the refinement simple, fast,
   and easy to reason about while still closing most of the gap between
   "each quarter optimal in isolation" and "this game, as a whole, is good."
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
