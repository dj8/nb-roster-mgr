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

function variance(nums){
  if(!nums.length) return 0;
  const mean = nums.reduce((a,b)=>a+b,0)/nums.length;
  return nums.reduce((a,b)=>a+(b-mean)*(b-mean),0)/nums.length;
}

/* Rank-weighted per-position coverage-gap penalty for one game's final
   roster-off outcome, plus a pairwise overlap penalty between players
   rostered off together who share preferred positions (rank-weighted on
   both sides) — the mechanism that stops the search from stripping a
   position's depth in one move. */
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
  for(let i=0;i<offPlayers.length;i++){
    for(let j=i+1;j<offPlayers.length;j++){
      const a=offPlayers[i], b=offPlayers[j];
      a.prefs.forEach((pos,rankA)=>{
        const rankB = b.prefs.indexOf(pos);
        if(rankB>=0) penalty += COVERAGE_OVERLAP_WEIGHT*(1/(rankA+1)+1/(rankB+1));
      });
    }
  }
  return penalty;
}

/* ============================================================
   PHASE 1 — season-wide roster-off allocation
   ============================================================
   input.players: [{id, prefs, unavailableCount}]  (season-total known unavailability)
   input.games:   [{num, availableIds:[id...], rosterOffCount, fixedOffIds:[id...]|null}]
                  fixedOffIds !== null means this game's roster-off is not decided here
                  (played / shortfall / manually locked) — it still counts toward fairness.
   input.weights: {fairness, coverage} (optional overrides)
   input.timeBudgetMs
   -> { rosterOffByGame: {num:[ids]}, stats:{passes, elapsedMs, finalCost} }
*/
function solveSeasonRosterOff(input){
  const players = input.players||[];
  const games = input.games||[];
  const fairnessWeight = (input.weights && input.weights.fairness!=null) ? input.weights.fairness : PHASE1_FAIRNESS_WEIGHT;
  const coverageWeight = (input.weights && input.weights.coverage!=null) ? input.weights.coverage : PHASE1_COVERAGE_WEIGHT;
  const timeBudgetMs = input.timeBudgetMs!=null ? input.timeBudgetMs : PHASE1_TIME_BUDGET_MS;
  const start = Date.now();

  const playerById = {};
  players.forEach(p=>{ playerById[p.id]=p; });

  const decidableGames = games.filter(g=>g.fixedOffIds==null && g.rosterOffCount>0);
  const fixedGames = games.filter(g=>g.fixedOffIds!=null);

  const current = {}; // gameNum -> [ids] (decidable games only)

  /* ---- greedy seed: fairness-first, coverage-aware tie-break ---- */
  const runningMissed = {};
  players.forEach(p=>{ runningMissed[p.id] = p.unavailableCount||0; });
  fixedGames.forEach(g=>{ (g.fixedOffIds||[]).forEach(id=>{ if(runningMissed[id]!=null) runningMissed[id]++; }); });

  decidableGames.forEach(g=>{
    const pool = g.availableIds.map(id=>playerById[id]).filter(Boolean);
    const picked = [];
    const remaining = pool.slice();
    for(let k=0;k<g.rosterOffCount && remaining.length;k++){
      let best=null, bestScore=Infinity;
      remaining.forEach(cand=>{
        const missed = runningMissed[cand.id]||0;
        const squadAfter = pool.filter(pp=>pp.id!==cand.id && !picked.some(x=>x.id===pp.id));
        const off = picked.concat([cand]);
        const score = missed*1000 + gameCoveragePenalty(squadAfter, off);
        if(score<bestScore){ bestScore=score; best=cand; }
      });
      picked.push(best);
      remaining.splice(remaining.indexOf(best),1);
    }
    current[g.num] = picked.map(p=>p.id);
    picked.forEach(p=>{ runningMissed[p.id]=(runningMissed[p.id]||0)+1; });
  });

  /* ---- shared objective ---- */
  function totalMissedMap(){
    const missed = {};
    players.forEach(p=>{ missed[p.id]=p.unavailableCount||0; });
    fixedGames.forEach(g=>{ (g.fixedOffIds||[]).forEach(id=>{ if(missed[id]!=null) missed[id]++; }); });
    decidableGames.forEach(g=>{ (current[g.num]||[]).forEach(id=>{ if(missed[id]!=null) missed[id]++; }); });
    return missed;
  }
  function totalObjective(){
    const missed = totalMissedMap();
    const fairnessTerm = fairnessWeight*variance(Object.values(missed));
    let coverageTerm = 0;
    games.forEach(g=>{
      const offIds = g.fixedOffIds!=null ? g.fixedOffIds : (current[g.num]||[]);
      const offSet = new Set(offIds);
      const pool = g.availableIds.map(id=>playerById[id]).filter(Boolean);
      const squadAfter = pool.filter(p=>!offSet.has(p.id));
      const offPlayers = pool.filter(p=>offSet.has(p.id));
      coverageTerm += gameCoveragePenalty(squadAfter, offPlayers);
    });
    return fairnessTerm + coverageWeight*coverageTerm;
  }

  let bestObjective = totalObjective();
  let passes = 0;
  let timedOut = false;

  outer:
  while(passes<PHASE1_MAX_PASSES){
    if(Date.now()-start>timeBudgetMs){ timedOut=true; break; }
    let improvedAny = false;
    for(const g of decidableGames){
      if(Date.now()-start>timeBudgetMs){ timedOut=true; break outer; }
      const pool = g.availableIds.map(id=>playerById[id]).filter(Boolean);
      const offSet = new Set(current[g.num]);
      for(let oi=0; oi<pool.length; oi++){
        const offP = pool[oi];
        if(!offSet.has(offP.id)) continue;
        for(let ni=0; ni<pool.length; ni++){
          const onP = pool[ni];
          if(offSet.has(onP.id)) continue;
          // try swapping offP (currently off) <-> onP (currently on)
          current[g.num] = current[g.num].map(id=>id===offP.id?onP.id:id);
          const newObjective = totalObjective();
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
    passes++;
    if(!improvedAny) break;
  }

  const rosterOffByGame = {};
  fixedGames.forEach(g=>{ rosterOffByGame[g.num] = (g.fixedOffIds||[]).slice(); });
  decidableGames.forEach(g=>{ rosterOffByGame[g.num] = (current[g.num]||[]).slice(); });
  games.forEach(g=>{ if(!rosterOffByGame[g.num]) rosterOffByGame[g.num]=[]; });

  return {
    rosterOffByGame,
    stats: { passes, elapsedMs: Date.now()-start, finalCost: bestObjective, timedOut }
  };
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
  const slider = Math.max(0,Math.min(10,Number(settings.preferenceSlider)));
  const sliderNorm = slider/10;
  const allowOff = !!settings.allowOffPreference;
  const topTwo = !!settings.topTwoOnly;
  const weights = settings.fairnessWeights||{};
  const benchWeight = Number(weights.bench)||0;
  const purityWeight = Number(weights.positionPurity)||0;

  function prefRank(p,pos){
    const list = topTwo ? p.prefs.slice(0,2) : p.prefs;
    return list.indexOf(pos);
  }
  function preferenceCost(p,pos){
    const idx = prefRank(p,pos);
    if(idx>=0) return idx;
    return allowOff ? p.prefs.length : null;
  }
  function purityTerm(p,pos){
    const posCount = (cumulative.posCount && cumulative.posCount[p.id+"::"+pos]) || 0;
    return Math.min(0.95, 0.15*purityWeight*Math.log2(1+posCount));
  }
  function balanceCost(p){
    return ((cumulative.onCourt && cumulative.onCourt[p.id])||0) * benchWeight;
  }
  function positionCellCost(p,pos){
    const pc = preferenceCost(p,pos);
    if(pc===null) return BIG_M;
    const prefSide = pc + purityTerm(p,pos);
    const balanceSide = balanceCost(p);
    return sliderNorm*prefSide + (1-sliderNorm)*balanceSide;
  }
  function benchCellCost(p){
    const season = (cumulative.bench && cumulative.bench[p.id])||0;
    const thisGame = (cumulative.gameBenchSoFar && cumulative.gameBenchSoFar[p.id])||0;
    const backToBack = (cumulative.benchedLastQuarter && cumulative.benchedLastQuarter.has && cumulative.benchedLastQuarter.has(p.id)) ? 5 : 0;
    return season*10*benchWeight + thisGame*3 + backToBack;
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
    MISSED_GAMES_WARNING_SPREAD, PHASE2B_TIME_BUDGET_MS, BIG_M
  },
  variance,
  gameCoveragePenalty,
  solveSeasonRosterOff,
  buildQuarterCostFns,
  solveQuarterPositions,
  refineGameQuarters,
  computeMissedGamesWarning
};

if(typeof module!=="undefined" && module.exports){ module.exports = RosterSolver; }
if(root) root.RosterSolver = RosterSolver;

})(typeof window!=="undefined" ? window : (typeof global!=="undefined" ? global : this));
