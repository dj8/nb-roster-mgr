/* Node-based regression suite for the engine embedded across app.js / solver.js / hungarian.js.
   Run with: node tests/run.js
   Loads a fresh, isolated instance of the app per test via harness.loadEngine()
   (document/localStorage/URL/Blob are stubbed — see harness.js). */
"use strict";
const assert = require("assert");
const { loadEngine } = require("./harness.js");

const results = [];
function test(name, fn){
  try{
    fn();
    results.push({name, ok:true});
  }catch(e){
    results.push({name, ok:false, error:e});
  }
}

function freshEngine(){
  const engine = loadEngine();
  engine._resetState();
  return engine;
}

function addPlayer(engine, name, prefs, unavailable){
  const st = engine._getState();
  const p = {id: engine.uid("p"), name, prefs: prefs.slice(), unavailable: (unavailable||[]).slice()};
  st.players.push(p);
  return p;
}

/* Brute-force optimal assignment cost for a square cost matrix, via full
   permutation search — only used on small matrices (n<=8) in tests, to
   independently verify the Hungarian implementation and the solver's
   cost-matrix construction. */
function bruteForceOptimalCost(matrix){
  const n = matrix.length;
  const idx = Array.from({length:n},(_,i)=>i);
  let best = Infinity;
  (function permute(arr, l){
    if(l===arr.length){
      let cost=0;
      arr.forEach((col,row)=>cost+=matrix[row][col]);
      if(cost<best) best=cost;
      return;
    }
    for(let i=l;i<arr.length;i++){
      [arr[l],arr[i]]=[arr[i],arr[l]];
      permute(arr,l+1);
      [arr[l],arr[i]]=[arr[i],arr[l]];
    }
  })(idx,0);
  return best;
}

/* ============================================================
   1. Hungarian algorithm correctness (brute-force comparison)
   ============================================================ */
test("HUNGARIAN-1: matches brute-force optimal on random small matrices (n=3..5)", ()=>{
  const engine = freshEngine();
  for(let n=3;n<=5;n++){
    for(let trial=0;trial<6;trial++){
      const matrix = Array.from({length:n},()=>Array.from({length:n},()=>Math.floor(Math.random()*20)));
      const assignment = engine.Hungarian.solve(matrix);
      assert.strictEqual(assignment.length, n);
      let cost=0; assignment.forEach((col,row)=>{ assert.ok(col>=0 && col<n); cost+=matrix[row][col]; });
      const bruteCost = bruteForceOptimalCost(matrix);
      assert.ok(Math.abs(cost-bruteCost)<1e-9,
        `n=${n} trial=${trial}: hungarian=${cost} brute=${bruteCost} matrix=${JSON.stringify(matrix)}`);
    }
  }
});

test("HUNGARIAN-2: avoids disqualified BIG_M-sentinel cells when a feasible alternative exists", ()=>{
  const engine = freshEngine();
  const BIG_M = engine.RosterSolver.CONSTANTS.BIG_M;
  const matrix = [
    [1, BIG_M, 5],
    [BIG_M, 2, 3],
    [4, 4, BIG_M]
  ];
  const assignment = engine.Hungarian.solve(matrix);
  let cost=0; assignment.forEach((col,row)=>cost+=matrix[row][col]);
  const bruteCost = bruteForceOptimalCost(matrix);
  assert.ok(cost<BIG_M, "should find an assignment avoiding every BIG_M cell: cost="+cost);
  assert.ok(Math.abs(cost-bruteCost)<1e-9, `expected brute-force optimum ${bruteCost}, got ${cost}`);
});

test("HUNGARIAN-3: ties are broken consistently (no error, valid permutation) on an all-equal matrix", ()=>{
  const engine = freshEngine();
  const matrix = [[3,3,3],[3,3,3],[3,3,3]];
  const assignment = engine.Hungarian.solve(matrix);
  assert.deepStrictEqual([...assignment].sort(), [0,1,2]);
});

/* ============================================================
   2. Phase 2a — exact per-quarter Hungarian position assignment
   ============================================================ */
test("QUARTER-OPTIMAL-1: solveQuarterPositions achieves the brute-force-optimal total cost", ()=>{
  const engine = freshEngine();
  const players = [
    {id:"a",name:"A",prefs:["GS","GA"],isFillIn:false},
    {id:"b",name:"B",prefs:["GA","GS"],isFillIn:false},
    {id:"c",name:"C",prefs:["WA","C"],isFillIn:false},
    {id:"d",name:"D",prefs:["C","WA"],isFillIn:false},
    {id:"e",name:"E",prefs:["WD","GD"],isFillIn:false},
    {id:"f",name:"F",prefs:["GD","WD"],isFillIn:false},
    {id:"g",name:"G",prefs:["GK"],isFillIn:false},
    {id:"h",name:"H",prefs:["GS","WA","C"],isFillIn:false}
  ];
  const cumulative = {posCount:{}, onCourt:{}, bench:{}, gameBenchSoFar:{}, benchedLastQuarter:new Set()};
  const settings = {preferenceSlider:10, allowOffPreference:true, topTwoOnly:false, fairnessWeights:{bench:2,positionPurity:1}};

  const result = engine.RosterSolver.solveQuarterPositions({players, benchSlotCount:1, lockedSlots:{}, cumulative, settings});
  assert.strictEqual(result.errors.length, 0);

  const { positionCellCost, benchCellCost } = engine.RosterSolver.buildQuarterCostFns(cumulative, settings);
  const columns = engine.POSITIONS.concat(["BENCH"]);
  const matrix = players.map(p => columns.map(col => col==="BENCH" ? benchCellCost(p) : positionCellCost(p,col)));
  const bruteCost = bruteForceOptimalCost(matrix);

  let resultCost = 0;
  engine.POSITIONS.forEach(pos=>{
    const pid = result.onCourt[pos];
    if(pid){ resultCost += positionCellCost(players.find(x=>x.id===pid), pos); }
  });
  result.bench.forEach(pid=>{ resultCost += benchCellCost(players.find(x=>x.id===pid)); });

  assert.ok(Math.abs(resultCost-bruteCost)<1e-6, `expected optimal cost ${bruteCost}, got ${resultCost}`);
});

test("QUARTER-LOCK-1: locked slots are pulled out before solving and never reassigned", ()=>{
  const engine = freshEngine();
  const players = [
    {id:"a",name:"A",prefs:["GS"],isFillIn:false},
    {id:"b",name:"B",prefs:["GA"],isFillIn:false},
    {id:"c",name:"C",prefs:["WA"],isFillIn:false},
    {id:"d",name:"D",prefs:["C"],isFillIn:false},
    {id:"e",name:"E",prefs:["WD"],isFillIn:false},
    {id:"f",name:"F",prefs:["GD"],isFillIn:false},
    {id:"g",name:"G",prefs:["GK"],isFillIn:false}
  ];
  const cumulative = {posCount:{}, onCourt:{}, bench:{}, gameBenchSoFar:{}, benchedLastQuarter:new Set()};
  const settings = {preferenceSlider:10, allowOffPreference:true, topTwoOnly:false, fairnessWeights:{bench:2,positionPurity:1}};
  // Lock A (a GS specialist) into GK, an obviously off-preference forced slot.
  const result = engine.RosterSolver.solveQuarterPositions({players, benchSlotCount:0, lockedSlots:{GK:"a"}, cumulative, settings});
  assert.strictEqual(result.onCourt.GK, "a");
  assert.strictEqual(result.offPreference.GK, true);
  assert.notStrictEqual(result.onCourt.GS, "a", "the locked player must not also appear at their preferred open position");
});

/* ============================================================
   3. Phase 2b — within-game refinement invariants
   ============================================================ */
test("PHASE2B-1: refinement never increases total game cost and never touches a locked slot", ()=>{
  const engine = freshEngine();
  const players = [
    {id:"a",prefs:["GS","GA"]},{id:"b",prefs:["GA","GS"]},{id:"c",prefs:["WA","C"]},
    {id:"d",prefs:["C","WA"]},{id:"e",prefs:["WD","GD"]},{id:"f",prefs:["GD","WD"]},
    {id:"g",prefs:["GK"]}
  ];
  const settings = {preferenceSlider:10, allowOffPreference:true, topTwoOnly:false, fairnessWeights:{bench:2,positionPurity:1}};
  const emptyCum = ()=>({posCount:{},onCourt:{},bench:{},gameBenchSoFar:{},benchedLastQuarter:new Set()});
  const perms = [
    ["GA","GS","C","WA","GD","WD","GK"],
    ["GS","GA","WA","C","WD","GD","GK"],
    ["WA","C","GS","GA","GK","GD","WD"]
  ];
  const quarters = perms.map(posOrder=>{
    const onCourt={}; players.forEach((p,i)=>onCourt[posOrder[i]]=p.id);
    return {onCourt, bench:[], offPreference:{}};
  });
  const cumulativeSnapshots = [emptyCum(),emptyCum(),emptyCum()];
  const lockedPlayerAtQ2GK = quarters[2].onCourt.GK;
  const lockedSlotsPerQuarter = [{}, {}, {GK: lockedPlayerAtQ2GK}];

  function totalCost(qs){
    let total=0;
    qs.forEach((q,qi)=>{
      const {positionCellCost} = engine.RosterSolver.buildQuarterCostFns(cumulativeSnapshots[qi], settings);
      engine.POSITIONS.forEach(pos=>{ const pid=q.onCourt[pos]; if(pid){ total+=positionCellCost(players.find(x=>x.id===pid), pos); } });
    });
    return total;
  }

  const before = totalCost(quarters);
  const result = engine.RosterSolver.refineGameQuarters({ quarters, squadPool: players, cumulativeSnapshots, lockedSlotsPerQuarter, settings });
  const after = totalCost(result.quarters);

  assert.ok(after <= before + 1e-9, `refinement should never increase total cost: before=${before} after=${after}`);
  assert.strictEqual(result.quarters[2].onCourt.GK, lockedPlayerAtQ2GK, "locked slot must never change");

  // No quarter should ever contain the same player twice (a real risk for a naive cross-quarter swap).
  result.quarters.forEach(q=>{
    const ids = engine.POSITIONS.map(pos=>q.onCourt[pos]).filter(Boolean);
    assert.strictEqual(new Set(ids).size, ids.length, "a quarter must not contain the same player twice after refinement");
  });
});

/* ============================================================
   4. Season-wide roster-off search (Phase 1) — via runGeneration
   ============================================================ */
test("SEASON-ROSTEROFF-1: fairness term reflects total missed games (unavailable + rostered-off) across the season", ()=>{
  const engine = freshEngine();
  const st = engine._getState();
  st.season.numGames = 8;
  st.season.desiredBenchSize = 2;
  const defs = [
    ["Amy",["GS","GA"]], ["Bea",["GA","GS","WA"]], ["Cat",["WA","C","GA"]],
    ["Dee",["C","WA","WD"]], ["Eve",["WD","C","GD"]], ["Fay",["GD","WD","GK"]],
    ["Gia",["GK","GD"]], ["Hal",["GS","GA","WA"]], ["Ivy",["WA","C"]]
  ];
  defs.forEach(([name,prefs])=>addPlayer(engine, name, prefs));
  engine.ensureGamesExist();
  const r = engine.runGeneration();
  assert.strictEqual(r.invalid, null);
  engine.gameNums().forEach(n=>{
    const g = engine.getGame(n);
    assert.strictEqual(g.error, null, "game "+n+" should generate cleanly: "+g.error);
  });
});

/* ============================================================
   4b. Roster-off weight slider, the seed's coverage-weight fix, and the
       hard "allow off-preference off" constraint in solveSeasonRosterOff
   ============================================================ */
test("PHASE1-SEED-WEIGHTED: the greedy seed itself (not just refinement) responds to coverageWeight", ()=>{
  // Hand-traced: pool [X,Y,Z,W], rosterOffCount=2, all missed=0 (tied).
  // X,Y both prefer GS (rank0); Z,W both prefer WD (rank0). timeBudgetMs:-1 disables
  // refinement entirely (the outer loop's first budget check trips immediately), so
  // whatever comes out is purely the seed's choice — this is what would have stayed
  // frozen at coverageWeight=4's answer regardless of weight, before the seed fix.
  const engine = freshEngine();
  const players = [
    {id:"X", prefs:["GS"], unavailableCount:0},
    {id:"Y", prefs:["GS"], unavailableCount:0},
    {id:"Z", prefs:["WD"], unavailableCount:0},
    {id:"W", prefs:["WD"], unavailableCount:0}
  ];
  const games = [{ num:1, availableIds:["X","Y","Z","W"], rosterOffCount:2, fixedOffIds:null }];

  const coverageBlind = engine.RosterSolver.solveSeasonRosterOff({ players, games, weights:{fairness:1,coverage:0}, timeBudgetMs:-1 });
  const coverageAware = engine.RosterSolver.solveSeasonRosterOff({ players, games, weights:{fairness:1,coverage:4}, timeBudgetMs:-1 });

  assert.deepStrictEqual([...coverageBlind.rosterOffByGame[1]].sort(), ["X","Y"],
    "coverage-blind (weight 0) seed ties break by stable order, picking the first two candidates: "+JSON.stringify(coverageBlind.rosterOffByGame));
  assert.deepStrictEqual([...coverageAware.rosterOffByGame[1]].sort(), ["X","Z"],
    "coverage-aware (weight 4, today's default) seed avoids pairing the two GS specialists together: "+JSON.stringify(coverageAware.rosterOffByGame));
});

test("STRICT-PAIRING-1 (M3): a game's own strict_specialist_pairing flag overrides a coverage-blind season-wide weight, for that game alone", ()=>{
  // §5.5: distinct from the season-wide coverage weight (§5.4) — a coach can
  // flag one specific "problem game" (e.g. a night where two same-position
  // specialists are otherwise tied for fairness) without changing the
  // season-wide balance for every other game. Game 1 (X/Y/Z/W) has the flag
  // on; game 2 uses an entirely disjoint set of players (A/B/C/D) so its own
  // tie-break is unaffected by whatever running-missed-count cascade game 1's
  // choice creates (both games still share one sequential season-wide seed,
  // same as always — only the coverage *weight* used for each game's own
  // scoring is per-game). Season-wide weight is coverage=0 (fully
  // coverage-blind), so any coverage-aware behavior seen here can only come
  // from the per-game flag.
  const engine = freshEngine();
  const players = [
    {id:"X", prefs:["GS"], unavailableCount:0},
    {id:"Y", prefs:["GS"], unavailableCount:0},
    {id:"Z", prefs:["WD"], unavailableCount:0},
    {id:"W", prefs:["WD"], unavailableCount:0},
    {id:"A", prefs:["GS"], unavailableCount:0},
    {id:"B", prefs:["GS"], unavailableCount:0},
    {id:"C", prefs:["WD"], unavailableCount:0},
    {id:"D", prefs:["WD"], unavailableCount:0}
  ];
  const games = [
    { num:1, availableIds:["X","Y","Z","W"], rosterOffCount:2, fixedOffIds:null, strictSpecialistPairing:true },
    { num:2, availableIds:["A","B","C","D"], rosterOffCount:2, fixedOffIds:null, strictSpecialistPairing:false }
  ];
  const r = engine.RosterSolver.solveSeasonRosterOff({ players, games, weights:{fairness:1,coverage:0}, timeBudgetMs:-1 });

  assert.deepStrictEqual([...r.rosterOffByGame[1]].sort(), ["X","Z"],
    "the strict-pairing game must avoid rostering off both GS specialists together, even with the season-wide coverage weight at 0: "+JSON.stringify(r.rosterOffByGame));
  assert.deepStrictEqual([...r.rosterOffByGame[2]].sort(), ["A","B"],
    "the non-strict game must keep the plain coverage-blind (tied, stable-order) pick, unaffected by game 1's flag: "+JSON.stringify(r.rosterOffByGame));
});

test("PHASE1-TOGGLE-1: allowOffPreference visibly changes Phase 1's roster-off choice", ()=>{
  const engine = freshEngine();
  // Every position but GK has 2 coverers (so removing any one of A1/A2/B1/B2/
  // C1/C2 never zeroes a position) and Q is the *sole* GK preferrer, so
  // removing Q is the only candidate that ever creates a zero-coverage state.
  const players = [
    {id:"Q", prefs:["GK"], unavailableCount:0},
    {id:"A1", prefs:["GS","GA"], unavailableCount:0},
    {id:"A2", prefs:["GS","GA"], unavailableCount:0},
    {id:"B1", prefs:["WD","WA"], unavailableCount:0},
    {id:"B2", prefs:["WD","WA"], unavailableCount:0},
    {id:"C1", prefs:["C","GD"], unavailableCount:0},
    {id:"C2", prefs:["C","GD"], unavailableCount:0}
  ];
  const games = [{ num:1, availableIds:["Q","A1","A2","B1","B2","C1","C2"], rosterOffCount:1, fixedOffIds:null }];

  // Note: solver values live in a separate vm realm (see harness.js), so array
  // literals here compare via .slice()/spread (same-realm) rather than
  // assert.deepStrictEqual directly against a cross-realm array.
  const allowed = engine.RosterSolver.solveSeasonRosterOff({ players, games, weights:{fairness:1,coverage:0}, allowOffPreference:true, timeBudgetMs:-1 });
  assert.deepStrictEqual([...allowed.rosterOffByGame[1]], ["Q"],
    "with the toggle on and coverage weight zeroed, Q (the sole GK) can still be picked: "+JSON.stringify(allowed.rosterOffByGame));

  const disallowed = engine.RosterSolver.solveSeasonRosterOff({ players, games, weights:{fairness:1,coverage:0}, allowOffPreference:false, timeBudgetMs:-1 });
  assert.notDeepStrictEqual([...disallowed.rosterOffByGame[1]], ["Q"],
    "with the toggle off, Q must never be rostered off since it would leave GK uncovered: "+JSON.stringify(disallowed.rosterOffByGame));
});

test("ROSTEROFF-SLIDER-SWEEP: missed-games variance is monotonically non-decreasing as rosterOffWeight rises from 0 (fairness) to 10 (coverage)", ()=>{
  function buildRoster(engine){
    const st = engine._getState();
    st.season.numGames = 8;
    st.season.desiredBenchSize = 2;
    const defs = [
      ["Amy",["GS","GA"]], ["Bea",["GA","GS","WA"]], ["Cat",["WA","C","GA"]],
      ["Dee",["C","WA","WD"]], ["Eve",["WD","C","GD"]], ["Fay",["GD","WD"]],
      ["Gia",["GK","GD"]], ["Hal",["GS","GA","WA"]], ["Ivy",["WA","C"]],
      ["Jaz",["C","WD","GD"]], ["Kim",["GD","GK"]], ["Lou",["GD","WD"]]
    ];
    defs.forEach(([name,prefs])=>addPlayer(engine, name, prefs));
    const st2 = engine._getState();
    st2.players[0].unavailable = [3,7];
    st2.players[4].unavailable = [2];
    st2.players[9].unavailable = [5,6];
    engine.ensureGamesExist();
  }
  const variances = [];
  for(let w=0; w<=10; w++){
    const engine = freshEngine();
    buildRoster(engine);
    engine._getState().settings.rosterOffWeight = w;
    const r = engine.runGeneration();
    assert.strictEqual(r.invalid, null);
    const missed = engine.computePlayerSummaries().map(s=>s.missed);
    variances.push(engine.RosterSolver.variance(missed));
  }
  for(let i=1;i<variances.length;i++){
    assert.ok(variances[i] >= variances[i-1] - 1e-9,
      `variance should be non-decreasing as rosterOffWeight rises from ${i-1} (${variances[i-1]}) to ${i} (${variances[i]}): ${JSON.stringify(variances)}`);
  }
});

test("REPORTED-BUG: 11 players / 11 games / 2 off per game reaches exactly 2 missed each", ()=>{
  function buildReportedBugRoster(engine){
    const st = engine._getState();
    st.season.numGames = 11;
    st.season.desiredBenchSize = 2;
    const defs = [
      ["Liv",["GA","GS"]],
      ["Poppy",["GS","GA","WA","C","WD"]],
      ["Mabel",["WA","GA","C","GS","WD"]],
      ["Izzy",["WA","WD"]],
      ["Layla",["WA","WD"]],
      ["Ella",["C","GA","WA"]],
      ["Zara",["C","WA","WD"]],
      ["Maddie",["WD","WA"]],
      ["Abby",["GD","WD","GK"]],
      ["Avalon",["GD","GK"]],
      ["Savanah",["GK","GD"]]
    ];
    defs.forEach(([name,prefs])=>addPlayer(engine, name, prefs));
    engine.ensureGamesExist();
  }
  [
    {rosterOffWeight:0, allowOffPreference:true},
    {rosterOffWeight:0, allowOffPreference:false},
    {rosterOffWeight:10, allowOffPreference:true},
    {rosterOffWeight:10, allowOffPreference:false}
  ].forEach(({rosterOffWeight, allowOffPreference})=>{
    const engine = freshEngine();
    buildReportedBugRoster(engine);
    engine._getState().settings.rosterOffWeight = rosterOffWeight;
    engine._getState().settings.allowOffPreference = allowOffPreference;
    const r = engine.runGeneration();
    assert.strictEqual(r.invalid, null);
    const summaries = engine.computePlayerSummaries();
    summaries.forEach(s=>{
      assert.strictEqual(s.missed, 2,
        `rosterOffWeight=${rosterOffWeight}, allowOffPreference=${allowOffPreference}: ${s.name} should have exactly 2 missed games, got ${s.missed}`);
    });
  });
});

test("PHASE1-DETERMINISTIC-1 (M6): identical input reproduces identical roster-off output under the default time budget", ()=>{
  // Phase 1's restart loop is wall-clock bounded (Date.now()<deadline), so in
  // principle a slower machine could complete fewer restart attempts than a
  // faster one under the same nominal budget and settle on a different
  // candidate. In practice, on a realistic-scale roster (this fixture — the
  // same one REG-1 uses), the very first seed already reaches a near-zero
  // objective and the restart loop never even executes an iteration, so the
  // result is fully deterministic regardless of machine speed. This is
  // verified directly (not assumed) across independent runs, comparing by
  // player *name* rather than id — `uid()` embeds Math.random()/Date.now(),
  // so raw ids legitimately differ run to run even when the actual roster-off
  // *choice* is identical.
  const defs = [
    ["Liv",["GA","GS"]], ["Poppy",["GS","GA","WA","C","WD"]], ["Mabel",["WA","GA","C","GS","WD"]],
    ["Izzy",["WA","WD"]], ["Layla",["WA","WD"]], ["Ella",["C","GA","WA"]], ["Zara",["C","WA","WD"]],
    ["Maddie",["WD","WA"]], ["Abby",["GD","WD","GK"]], ["Avalon",["GD","GK"]], ["Savanah",["GK","GD"]]
  ];
  const results = [];
  for(let run=0; run<5; run++){
    const engine = freshEngine();
    const st = engine._getState();
    st.season.numGames = 11;
    st.season.desiredBenchSize = 2;
    defs.forEach(([name,prefs])=>addPlayer(engine, name, prefs));
    engine.ensureGamesExist();
    engine.runGeneration();
    const nameOf = id => st.players.find(p=>p.id===id).name;
    results.push(JSON.stringify(engine.gameNums().map(n=>(engine.getGame(n).rosteredOffIds||[]).map(nameOf).sort())));
  }
  assert.ok(results.every(r=>r===results[0]),
    "5 independent runs on identical input should produce identical roster-off choices under the default time budget: "+JSON.stringify(results));
});

test("THIN-POSITION-1: sole preferrer is never rostered off uncovered when allowOffPreference is off, and the Reports note names them", ()=>{
  const engine = freshEngine();
  const st = engine._getState();
  st.season.numGames = 6;
  st.season.desiredBenchSize = 2;
  st.settings.allowOffPreference = false;
  const defs = [
    ["Quinn",["GK"]],
    ["A1",["GS"]], ["A2",["GS"]],
    ["B1",["WD"]], ["B2",["WD"]],
    ["C1",["WA"]], ["C2",["WA"]],
    ["D1",["C"]], ["D2",["C"]],
    ["E1",["GA"]], ["E2",["GA"]],
    ["F1",["GD"]], ["F2",["GD"]]
  ];
  defs.forEach(([name,prefs])=>addPlayer(engine, name, prefs));
  engine.ensureGamesExist();
  const quinnId = engine._getState().players[0].id;

  const r = engine.runGeneration();
  assert.strictEqual(r.invalid, null);
  engine.gameNums().forEach(n=>{
    const g = engine.getGame(n);
    assert.ok(!(g.rosteredOffIds||[]).includes(quinnId),
      `game ${n} must never roster off the sole GK preferrer when off-preference is disallowed: ${JSON.stringify(g.rosteredOffIds)}`);
  });

  const notes = engine.computeRosterOffAchievabilityNotesForReports();
  const gkNote = notes.find(n=>n.position==="GK");
  assert.ok(gkNote, "expected a roster-off achievability note for the thin GK position: "+JSON.stringify(notes));
  assert.ok(gkNote.players.includes("Quinn"), "note should name the sole GK preferrer: "+JSON.stringify(gkNote));
});

/* ============================================================
   5. Missed-games spread warning
   ============================================================ */
test("WARNING-1: triggers on a deliberately lopsided dataset", ()=>{
  const engine = freshEngine();
  const st = engine._getState();
  st.season.numGames = 6;
  st.season.desiredBenchSize = 2;
  const defs = [
    ["Amy",["GS","GA"]], ["Bea",["GA","GS","WA"]], ["Cat",["WA","C","GA"]],
    ["Dee",["C","WA","WD"]], ["Eve",["WD","C","GD"]], ["Fay",["GD","WD","GK"]],
    ["Gia",["GK","GD"]], ["Hal",["GS","GA","WA"]], ["Ivy",["WA","C"]]
  ];
  defs.forEach(([name,prefs])=>addPlayer(engine, name, prefs));
  // Amy misses almost the whole season; everyone else is fully available.
  engine._getState().players[0].unavailable = [1,2,3,4,5];
  engine.ensureGamesExist();
  engine.runGeneration();
  const warning = engine.computeMissedGamesWarningForReports();
  assert.ok(warning, "expected a missed-games warning to trigger");
  assert.ok(warning.spread > engine.RosterSolver.CONSTANTS.MISSED_GAMES_WARNING_SPREAD);
  assert.ok(warning.mostMissed.includes("Amy"));
});

test("WARNING-2: stays silent on a balanced dataset", ()=>{
  const engine = freshEngine();
  const st = engine._getState();
  st.season.numGames = 4;
  st.season.desiredBenchSize = 0;
  ["GS","GA","WA","C","WD","GD","GK"].forEach((pos,i)=>addPlayer(engine, "P"+i, [pos]));
  engine.ensureGamesExist();
  engine.runGeneration();
  const warning = engine.computeMissedGamesWarningForReports();
  assert.strictEqual(warning, null, "no warning expected when every player has identical missed-game counts: "+JSON.stringify(warning));
});

/* ============================================================
   6. Settings default
   ============================================================ */
test("SETTINGS-DEFAULT-1: preferenceSlider defaults to 9 (strongly favours preference)", ()=>{
  const engine = freshEngine();
  assert.strictEqual(engine._getState().settings.preferenceSlider, 9);
});

/* ============================================================
   6b. Regressions from external code review: manual slot-edit swap
       integrity, cumulative/refinement reconciliation, off-preference
       log freshness, and defensive CSV import sanitization.
   ============================================================ */
test("SLOT-SWAP-1: swapping in an on-court player relocates the displaced player rather than losing them", ()=>{
  const engine = freshEngine();
  const st = engine._getState();
  st.season.numGames = 1;
  st.season.desiredBenchSize = 0;
  ["GS","GA","WA","C","WD","GD","GK"].forEach((pos,i)=>addPlayer(engine, "P"+i, [pos]));
  engine.ensureGamesExist();
  engine.runGeneration();
  const g = engine.getGame(1);
  const q = g.schedule.quarters[0];
  const gsId = q.onCourt.GS, gaId = q.onCourt.GA;

  // Simulate the UI's slot-edit save handler directly: move GA's occupant
  // into GS. GS's previous occupant must end up somewhere findable (their
  // own now-vacant GA slot, via the fill-vacancy step), never discarded.
  const otherPos = "GA";
  q.onCourt.GS = gaId;
  q.onCourt[otherPos] = null;
  // Emulates picking the displaced player (gsId) to fill the vacancy, which
  // is openFillVacancyDialog's default selection.
  q.onCourt[otherPos] = gsId;

  const onCourtIds = engine.POSITIONS.map(p=>q.onCourt[p]);
  assert.strictEqual(new Set(onCourtIds).size, 7, "all 7 on-court slots must still be distinct, real players");
  assert.ok(onCourtIds.every(Boolean), "no on-court slot should end up empty after a swap");
  assert.strictEqual(q.onCourt.GS, gaId);
  assert.strictEqual(q.onCourt.GA, gsId);
});

test("CUMULATIVE-RECONCILE-1: cumulative onCourt/bench totals match the final (refined) schedule exactly", ()=>{
  const engine = freshEngine();
  const st = engine._getState();
  st.season.numGames = 6;
  st.season.desiredBenchSize = 2;
  const defs = [
    ["Amy",["GS","GA"]], ["Bea",["GA","GS","WA"]], ["Cat",["WA","C","GA"]],
    ["Dee",["C","WA","WD"]], ["Eve",["WD","C","GD"]], ["Fay",["GD","WD","GK"]],
    ["Gia",["GK","GD"]], ["Hal",["GS","GA","WA"]], ["Ivy",["WA","C"]]
  ];
  defs.forEach(([name,prefs])=>addPlayer(engine, name, prefs));
  engine.ensureGamesExist();
  const r = engine.runGeneration();
  assert.strictEqual(r.invalid, null);
  const summaries = engine.computePlayerSummaries();
  summaries.forEach(s=>{
    assert.strictEqual(r.cumulative.onCourt[s.id]||0, s.onCourt,
      `${s.name}: cumulative onCourt total (used for later games' fairness math) must match the actual, refined schedule`);
    assert.strictEqual(r.cumulative.bench[s.id]||0, s.bench,
      `${s.name}: cumulative bench total must match the actual, refined schedule`);
  });
});

test("OFFPREF-LOG-FRESH-1: computeOffPrefLog reflects manual schedule edits without regenerating", ()=>{
  const engine = freshEngine();
  const st = engine._getState();
  st.season.numGames = 1;
  st.season.desiredBenchSize = 0;
  ["GS","GA","WA","C","WD","GD","GK"].forEach((pos,i)=>addPlayer(engine, "P"+i, [pos]));
  engine.ensureGamesExist();
  engine.runGeneration();
  assert.strictEqual(engine.computeOffPrefLog().length, 0, "sanity: a perfectly-covered roster should generate with no off-preference fills");

  // Manually force an off-preference assignment, exactly as a slot edit would,
  // without calling runGeneration again.
  const g = engine.getGame(1);
  const q = g.schedule.quarters[0];
  const gsId = q.onCourt.GS, gaId = q.onCourt.GA;
  q.onCourt.GS = gaId; q.onCourt.GA = gsId;
  q.offPreference.GS = true; q.offPreference.GA = true;

  const log = engine.computeOffPrefLog();
  assert.strictEqual(log.length, 2, "off-preference log should immediately reflect the manual edit: "+JSON.stringify(log));
});

test("CSV-IMPORT-SANITIZE-1: a corrupted CSV is sanitized rather than corrupting app state", ()=>{
  const engine = freshEngine();
  const csv = [
    "#META", "version,1",
    "#SEASON", "numGames,500", "desiredBenchSize,2",
    "#SETTINGS", "preferenceSlider,9",
    "#PLAYERS",
    "p1,Amy,GS|GA,",
    "p1,AmyDupe,WA|C,",   // duplicate id — should be dropped
    "p2,Bea,WD|GD,",
    "#FILLINS",
    "#GAMES",
    "1,0,,,,,0-GS=ghost123,",  // locked slot references an unknown player
    "#SCHEDULE",
    "1,0,GS,p2,0",
    "1,0,GA,ghost456,0"        // unknown player id in the schedule
  ].join("\n");

  engine.importFullCsv(csv);
  const st = engine._getState();

  assert.strictEqual(st.season.numGames, 60, "numGames should be clamped to the app's supported range, not left at 500");
  assert.strictEqual(st.players.length, 2, "the duplicate player id should be dropped: "+JSON.stringify(st.players));
  assert.strictEqual(st.players.find(p=>p.id==="p1").name, "Amy", "the first occurrence of a duplicate id should be kept");

  const g = engine.getGame(1);
  assert.strictEqual(Object.keys(g.lockedSlots).length, 0, "a locked slot referencing an unknown player id should be dropped: "+JSON.stringify(g.lockedSlots));
  assert.strictEqual(g.schedule.quarters[0].onCourt.GS, "p2", "a valid schedule entry should still import correctly");
  assert.ok(!g.schedule.quarters[0].onCourt.GA, "an unknown player id in the schedule should be dropped, not left dangling: "+JSON.stringify(g.schedule.quarters[0].onCourt));
});

test("CSV-IMPORT-SANITIZE-2 (C1 regression): non-numeric settings are clamped, not left as NaN", ()=>{
  // Previously: Number("abc") -> NaN flowed straight into deriveRosterOffWeights/
  // buildQuarterCostFns, every candidate scored NaN in Phase 1's greedy seed, and
  // solveSeasonRosterOff crashed with "Cannot read properties of null (reading 'id')"
  // because a null candidate got pushed onto the picked list. Import must sanitize
  // instead of propagating garbage into the solver.
  const engine = freshEngine();
  const defs = [
    ["Amy",["GS","GA"]], ["Bea",["GA","GS"]], ["Cat",["WA","C"]], ["Dee",["C","WA"]],
    ["Eve",["WD","GD"]], ["Fay",["GD","WD"]], ["Gia",["GK","GD"]], ["Hal",["GS","WA"]],
    ["Ivy",["WA","C"]], ["Jaz",["C","WD"]]
  ];
  const rows = [
    "#META","version,1",
    "#SEASON","numGames,3","desiredBenchSize,2",
    "#SETTINGS","preferenceSlider,abc","rosterOffWeight,abc","weight_bench,nope","weight_positionPurity,",
    "#PLAYERS",
    ...defs.map(([name,prefs],i)=>`p${i},${name},${prefs.join("|")},`),
    "#FILLINS","#GAMES","#SCHEDULE"
  ].join("\n");

  engine.importFullCsv(rows);
  const st = engine._getState();
  assert.ok(Number.isFinite(st.settings.preferenceSlider), "preferenceSlider must be a finite number after import: "+st.settings.preferenceSlider);
  assert.ok(Number.isFinite(st.settings.rosterOffWeight), "rosterOffWeight must be a finite number after import: "+st.settings.rosterOffWeight);
  assert.ok(Number.isFinite(st.settings.fairnessWeights.bench), "bench weight must be a finite number after import: "+st.settings.fairnessWeights.bench);
  assert.ok(Number.isFinite(st.settings.fairnessWeights.positionPurity), "positionPurity weight must be a finite number after import: "+st.settings.fairnessWeights.positionPurity);

  // The real regression check: generation must not throw.
  const r = engine.runGeneration();
  assert.strictEqual(r.invalid, null);
  engine.gameNums().forEach(n=>{
    const g = engine.getGame(n);
    assert.strictEqual(g.error, null, "game "+n+" should generate cleanly after a garbage-settings import: "+g.error);
  });
});

test("SETTINGS-SANITIZE-1 (C1 regression): a corrupted localStorage blob is clamped on load, not left as NaN", ()=>{
  const engine = freshEngine();
  const st = engine._getState();
  Object.assign(st, {
    season: {numGames:"NaN", desiredBenchSize:-5},
    settings: {preferenceSlider:"oops", rosterOffWeight:999, allowOffPreference:true, topTwoOnly:false,
               fairnessWeights:{bench:"x", positionPurity:0}}
  });
  engine.saveState();
  const reloaded = engine.loadState();
  assert.ok(Number.isFinite(reloaded.season.numGames) && reloaded.season.numGames>=1 && reloaded.season.numGames<=60,
    "numGames should be clamped to a valid range: "+reloaded.season.numGames);
  assert.strictEqual(reloaded.season.desiredBenchSize, 0, "a negative bench size should be clamped to 0");
  assert.ok(Number.isFinite(reloaded.settings.preferenceSlider), "a non-numeric preferenceSlider should fall back to a finite default");
  assert.strictEqual(reloaded.settings.rosterOffWeight, 10, "an out-of-range rosterOffWeight (999) should be clamped to the max (10)");
  assert.ok(Number.isFinite(reloaded.settings.fairnessWeights.bench), "a non-numeric bench weight should fall back to a finite default");
});

test("CSV-IMPORT-XSS-1 (C2 regression): imported preferences are filtered to real positions only", ()=>{
  // Previously: importFullCsv took the CSV's "prefs" column verbatim with no
  // check against POSITIONS, and those strings were later interpolated into
  // HTML unescaped in several render spots (player list, fill-in dialogs,
  // fill-in list). A crafted CSV — the kind a coach might receive from a
  // co-coach, since CSV is this app's stated sharing mechanism — could land
  // arbitrary markup inside player/fill-in prefs.
  const engine = freshEngine();
  // Each field is quoted exactly once (toCsvField-style) — quoting twice would
  // corrupt the field content itself (stray literal quote characters) and mask
  // the thing under test, which is import-time filtering, not CSV escaping.
  const csvField = v => /[",\n]/.test(v) ? '"'+v.replace(/"/g,'""')+'"' : v;
  const rows = [
    ["#META"],["version","1"],
    ["#SEASON"],["numGames","1"],["desiredBenchSize","0"],
    ["#SETTINGS"],["preferenceSlider","9"],
    ["#PLAYERS"],
    ["p1","Amy",'GS|"><img src=x onerror=alert(1)>',""],
    ["#FILLINS"],
    ["f1","Guest",'"><svg onload=alert(2)>'],
    ["#GAMES"],["#SCHEDULE"]
  ];
  const csv = rows.map(r=>r.map(csvField).join(",")).join("\n");

  engine.importFullCsv(csv);
  const st = engine._getState();
  // st.players/fillIns live in the harness's separate vm realm (see the note on
  // PHASE1-TOGGLE-1 above) — spread into a same-realm array before comparing.
  assert.deepStrictEqual([...st.players[0].prefs], ["GS"], "the injected markup must be stripped, leaving only the real position token: "+JSON.stringify(st.players[0].prefs));
  assert.deepStrictEqual([...st.fillIns[0].prefs], [], "a fill-in preference string with no real position tokens should end up empty, not carry the markup through: "+JSON.stringify(st.fillIns[0].prefs));
});

/* ============================================================
   7. CSV round-trip
   ============================================================ */
test("CSV-ROUNDTRIP-1: settings CSV no longer emits weight_missed/weight_onCourt", ()=>{
  const engine = freshEngine();
  const st = engine._getState();
  st.season.numGames = 1;
  ["GS","GA","WA","C","WD","GD","GK"].forEach((pos,i)=>addPlayer(engine, "P"+i, [pos]));
  engine.ensureGamesExist();
  engine.runGeneration();
  engine.exportFullCsv();
  const csvText = engine.CapturingBlob.last;
  assert.ok(!csvText.includes("weight_missed"), "weight_missed should not be exported");
  assert.ok(!csvText.includes("weight_onCourt"), "weight_onCourt should not be exported (merged into weight_bench)");
  assert.ok(!("missed" in engine._getState().settings.fairnessWeights));
  assert.ok(!("onCourt" in engine._getState().settings.fairnessWeights));
});

test("CSV-ROUNDTRIP-2: a played game's rosteredOffIds survive export/import as a frozen fact", ()=>{
  const engine = freshEngine();
  const st = engine._getState();
  st.season.numGames = 1;
  st.season.desiredBenchSize = 2;
  ["GS","GA","WA","C","WD","GD","GK","GA","GD","WA"].forEach((pos,i)=>addPlayer(engine, "P"+i, [pos])); // 10 players, bench 2 -> 1 roster-off
  engine.ensureGamesExist();
  engine.runGeneration();
  const g1 = engine.getGame(1);
  assert.strictEqual(g1.rosteredOffIds.length, 1, "sanity: exactly one roster-off expected");
  g1.isPlayed = true;
  const rosteredOffBefore = g1.rosteredOffIds.slice().sort();

  engine.exportFullCsv();
  const csvText = engine.CapturingBlob.last;
  assert.ok(csvText.includes("rosteredOffIds"), "exported CSV should carry the rosteredOffIds column");
  engine.importFullCsv(csvText);

  const st2 = engine._getState();
  assert.deepStrictEqual(st2.games["1"].rosteredOffIds.slice().sort(), rosteredOffBefore,
    "played game's roster-off decision should be frozen and survive CSV round-trip exactly");
});

test("CSV-ROUNDTRIP-3 (M5 regression): an unplayed game's exact rosteredOffIds survive import even when Phase 1 would pick differently", ()=>{
  // Previously: importFullCsv unconditionally called computeSeasonRosterOff(),
  // which re-ran Phase 1 fresh and overwrote every unplayed game's
  // rosteredOffIds with a brand-new solve — it only ever *looked* like a
  // round-trip because the solver is deterministic on identical input. Here
  // the CSV is hand-edited to a roster-off selection Phase 1 would never
  // produce on its own (a different *count* than the natural derivation, not
  // just different players), so preservation can only be verified by the
  // import path actually trusting the file rather than recomputing.
  const engine = freshEngine();
  const st = engine._getState();
  st.season.numGames = 1;
  st.season.desiredBenchSize = 2;
  ["GS","GA","WA","C","WD","GD","GK","GA","GD","WA"].forEach((pos,i)=>addPlayer(engine, "P"+i, [pos])); // 10 players, bench 2 -> natural roster-off = 1
  engine.ensureGamesExist();
  engine.runGeneration();
  assert.strictEqual(engine.getGame(1).rosteredOffIds.length, 1, "sanity: natural roster-off for this squad is exactly 1 player");

  engine.exportFullCsv();
  const lines = engine.CapturingBlob.last.split("\r\n");
  const gamesIdx = lines.findIndex(l=>l.startsWith("#GAMES"));
  const ids = engine._getState().players.map(p=>p.id);
  const forcedPair = [ids[2], ids[3]].sort().join("|"); // force 2 players off, not the natural 1
  for(let i=gamesIdx+1;i<lines.length;i++){
    if(lines[i].startsWith("#")) break;
    const cols = lines[i].split(",");
    if(cols[0]==="1"){ cols[4] = forcedPair; lines[i]=cols.join(","); break; }
  }
  engine.importFullCsv(lines.join("\r\n"));

  assert.strictEqual(engine.getGame(1).rosteredOffIds.slice().sort().join("|"), forcedPair,
    "the imported (hand-edited) roster-off selection must be preserved exactly, not silently recomputed by a fresh Phase 1 solve");

  // A subsequent real Generate/Rebalance must still be free to change it —
  // preservation is a one-time import behavior, not an implicit permanent lock.
  engine.runGeneration();
  assert.strictEqual(engine.getGame(1).rosteredOffIds.length, 1,
    "a later Generate/Rebalance must still recompute freely and is not stuck honoring the imported value as a lock");
});

test("FILLIN-SAVED-ROUNDTRIP-1 (M4 regression): a one-off fill-in's saved:false flag survives CSV export/import", ()=>{
  // §6: saving a fill-in for reuse must be an explicit, opt-in choice, not an
  // automatic side effect of creating one — and that choice has to persist,
  // the same way rostered-off values do (§9's CSV round-trip requirement),
  // or a one-off would silently turn into a reusable fill-in on next import.
  const engine = freshEngine();
  const st = engine._getState();
  st.fillIns.push({id: engine.uid("fi"), name:"Guest One-off", prefs:["GK"], saved:false});
  st.fillIns.push({id: engine.uid("fi"), name:"Guest Reusable", prefs:["GS"], saved:true});
  engine.exportFullCsv();
  const csvText = engine.CapturingBlob.last;
  assert.ok(csvText.includes("saved"), "exported CSV should carry the fill-in saved column");
  engine.importFullCsv(csvText);
  const st2 = engine._getState();
  const oneOff = st2.fillIns.find(f=>f.name==="Guest One-off");
  const reusable = st2.fillIns.find(f=>f.name==="Guest Reusable");
  assert.strictEqual(oneOff.saved, false, "a one-off fill-in must not flip to saved:true on import");
  assert.strictEqual(reusable.saved, true, "a reusable fill-in must stay saved:true on import");
});

test("STRICT-PAIRING-APP-1 (M3): the per-game toggle reaches computeSeasonRosterOff and survives CSV round-trip", ()=>{
  const engine = freshEngine();
  const st = engine._getState();
  st.season.numGames = 1;
  st.season.desiredBenchSize = 2;
  // Same shape as the solver-level STRICT-PAIRING-1 test: two GS specialists,
  // two WD specialists, coverage-blind season-wide weight (0) so any
  // coverage-aware pick can only come from the per-game flag.
  [["X",["GS"]],["Y",["GS"]],["Z",["WD"]],["W",["WD"]]].forEach(([name,prefs])=>addPlayer(engine,name,prefs));
  st.settings.rosterOffWeight = 0;
  engine.ensureGamesExist();
  engine.getGame(1).strictSpecialistPairing = true;
  engine.computeSeasonRosterOff();
  const nameOf = id => st.players.find(p=>p.id===id).name;
  const offNames = (engine.getGame(1).rosteredOffIds||[]).map(nameOf).sort();
  assert.notDeepStrictEqual(offNames, ["X","Y"],
    "with strict pairing on for this game, both GS specialists should not be rostered off together: "+JSON.stringify(offNames));
  assert.notDeepStrictEqual(offNames, ["Z","W"],
    "with strict pairing on for this game, both WD specialists should not be rostered off together: "+JSON.stringify(offNames));

  engine.exportFullCsv();
  const csvText = engine.CapturingBlob.last;
  assert.ok(csvText.includes("strictSpecialistPairing"), "exported CSV should carry the strict-pairing column");
  engine.importFullCsv(csvText);
  assert.strictEqual(engine.getGame(1).strictSpecialistPairing, true,
    "the per-game strict-pairing flag must survive CSV export/import");
});

/* ============================================================
   8. Regression: previously-established behavior
   ============================================================ */
test("REGRESSION: full season generates cleanly with a valid roster", ()=>{
  const engine = freshEngine();
  const st = engine._getState();
  st.season.numGames = 11;
  st.season.desiredBenchSize = 2;
  const defs = [
    ["Amy",["GS","GA"]], ["Bea",["GA","GS","WA"]], ["Cat",["WA","C","GA"]],
    ["Dee",["C","WA","WD"]], ["Eve",["WD","C","GD"]], ["Fay",["GD","WD","GK"]],
    ["Gia",["GK","GD"]], ["Hal",["GS","GA","WA"]], ["Ivy",["WA","C"]]
  ];
  defs.forEach(([name,prefs])=>addPlayer(engine, name, prefs));
  engine.ensureGamesExist();
  const r = engine.runGeneration();
  assert.strictEqual(r.invalid, null);
  engine.gameNums().forEach(n=>{
    const g = engine.getGame(n);
    assert.strictEqual(g.error, null, "game "+n+" should generate without error: "+g.error);
    assert.ok(g.generated);
  });
});

test("RO-3: exactly enough available players for squad (no bench) means zero roster-off", ()=>{
  const engine = freshEngine();
  const st = engine._getState();
  st.season.numGames = 1;
  st.season.desiredBenchSize = 2;
  ["GS","GA","WA","C","WD","GD","GK","GA","GD"].forEach((pos,i)=>addPlayer(engine, "P"+i, [pos])); // 9 = 7+2
  engine.ensureGamesExist();
  engine.runGeneration();
  const g = engine.getGame(1);
  assert.strictEqual(g.rosteredOffIds.length, 0, "9 available players with bench size 2 needs exactly 9 -> no roster-off");
});

test("RO-4: one more available player than needed rosters off exactly one", ()=>{
  const engine = freshEngine();
  const st = engine._getState();
  st.season.numGames = 1;
  st.season.desiredBenchSize = 2;
  ["GS","GA","WA","C","WD","GD","GK","GA","GD","WA"].forEach((pos,i)=>addPlayer(engine, "P"+i, [pos])); // 10 = 7+2+1
  engine.ensureGamesExist();
  engine.runGeneration();
  const g = engine.getGame(1);
  assert.strictEqual(g.rosteredOffIds.length, 1, "10 available players with bench size 2 needs exactly 1 roster-off");
});

test("OP-5: off-preference fill is allowed and used when allowOffPreference is on and no in-preference candidate remains", ()=>{
  const engine = freshEngine();
  const st = engine._getState();
  st.season.numGames = 1;
  st.season.desiredBenchSize = 0;
  st.settings.allowOffPreference = true;
  ["GS","GA","WA","C","WD","GD"].forEach((pos,i)=>addPlayer(engine, "P"+i, [pos]));
  addPlayer(engine, "P6", ["GS"]); // 7th player — nobody in this roster lists GK at all
  engine.ensureGamesExist();
  const r = engine.runGeneration();
  const g = engine.getGame(1);
  assert.strictEqual(g.error, null, "should not error when off-preference is allowed: "+g.error);
  assert.ok(g.schedule.quarters[0].onCourt.GK, "GK should still be filled by someone, off-preference");
  assert.strictEqual(g.schedule.quarters[0].offPreference.GK, true);
});

test("OP-9: toggling allowOffPreference off raises an error instead of an off-preference fallback", ()=>{
  const engine = freshEngine();
  const st = engine._getState();
  st.season.numGames = 1;
  st.season.desiredBenchSize = 0;
  st.settings.allowOffPreference = false;
  ["GS","GA","WA","C","WD","GD"].forEach((pos,i)=>addPlayer(engine, "P"+i, [pos]));
  addPlayer(engine, "P6", ["GS"]); // no one left who lists GK
  engine.ensureGamesExist();
  engine.runGeneration();
  const g = engine.getGame(1);
  assert.ok(g.error && /GK/.test(g.error), "expected a no-eligible-player error mentioning GK: "+g.error);
});

test("TOPTWO-1 (H2 regression): topTwoOnly is a soft nudge, not a hard eligibility cutoff", ()=>{
  // Previously: prefRank sliced to prefs.slice(0,2) before looking up a
  // position, so a position listed only as a player's 3rd+ preference was
  // indistinguishable from one never listed at all. With allowOffPreference
  // off, that meant "prefer top 2" could turn a position that genuinely has
  // in-preference coverage (just not in anyone's top 2) into a false
  // NO_ELIGIBLE_PLAYER error. §4 rule 5 defines top-2 as a variety *scope*
  // over the player's stated list, never a stricter eligibility rule than
  // §5.2's off-preference toggle.
  const engine = freshEngine();
  const st = engine._getState();
  st.season.numGames = 1;
  st.season.desiredBenchSize = 0;
  st.settings.allowOffPreference = false;
  // GK is listed by two players, but only ever as their 3rd preference.
  const defs = [
    ["Amy",["GS","GA","GK"]], ["Bea",["GA","GS"]], ["Cat",["WA","C"]],
    ["Dee",["C","WA"]], ["Eve",["WD","GD"]], ["Fay",["GD","WD"]], ["Gia",["WA","GD","GK"]]
  ];
  defs.forEach(([name,prefs])=>addPlayer(engine, name, prefs));
  engine.ensureGamesExist();

  st.settings.topTwoOnly = false;
  engine.runGeneration();
  assert.strictEqual(engine.getGame(1).error, null, "sanity: without topTwoOnly, GK has in-preference coverage and should generate cleanly: "+engine.getGame(1).error);

  st.settings.topTwoOnly = true;
  engine.runGeneration();
  assert.strictEqual(engine.getGame(1).error, null,
    "topTwoOnly must not disqualify a position that a player genuinely lists (just not in their top 2): "+engine.getGame(1).error);
});

test("EMPTYPREFS-1 (H3 regression): a preference-less candidate is never cheaper than a real specialist", ()=>{
  // Previously: the off-preference cost was p.prefs.length, which is 0 for a
  // player/fill-in with no stated preferences at all — tying the very best
  // in-preference candidate (rank 0, cost 0) and beating every other real
  // rank. A fill-in with no preferences set (§6 explicitly allows this) could
  // therefore out-compete every specialist on the roster at every position.
  const engine = freshEngine();
  const cumulative = {posCount:{}, onCourt:{}, bench:{}, gameBenchSoFar:{}, benchedLastQuarter:new Set()};
  const settings = {preferenceSlider:10, allowOffPreference:true, topTwoOnly:false, fairnessWeights:{bench:2,positionPurity:1}};
  const { positionCellCost } = engine.RosterSolver.buildQuarterCostFns(cumulative, settings);
  const specialist = {id:"a", prefs:["GK","GD"]};
  const noPrefs = {id:"b", prefs:[]};
  const rank1 = {id:"c", prefs:["GD","GK"]};
  assert.ok(positionCellCost(noPrefs,"GK") > positionCellCost(specialist,"GK"),
    "a no-preference candidate must cost more than the top-ranked specialist at the same position");
  assert.ok(positionCellCost(noPrefs,"GK") >= positionCellCost(rank1,"GK"),
    "a no-preference candidate must not undercut a real rank-1 in-preference candidate");
});

/* ============================================================
   M1/M2/H1 regression: the cost-scale rework that made the position-purity
   and bench-weight settings actually responsive, and closed off a concrete
   monotonicity leak (bench weight could increase off-preference fills even
   at the preference slider's literal maximum).
   ============================================================ */
function buildRealisticRosterFixture(engine){
  const st = engine._getState();
  st.season.numGames = 11;
  st.season.desiredBenchSize = 2;
  const defs = [
    ["Liv",["GA","GS"]], ["Poppy",["GS","GA","WA","C","WD"]], ["Mabel",["WA","GA","C","GS","WD"]],
    ["Izzy",["WA","WD"]], ["Layla",["WA","WD"]], ["Ella",["C","GA","WA"]], ["Zara",["C","WA","WD"]],
    ["Maddie",["WD","WA"]], ["Abby",["GD","WD","GK"]], ["Avalon",["GD","GK"]], ["Savanah",["GK","GD"]]
  ];
  defs.forEach(([name,prefs])=>addPlayer(engine, name, prefs));
  engine.ensureGamesExist();
  return defs;
}

test("PURITY-SWEEP-1 (M1 regression): raising position-purity weight measurably spreads play across a player's list", ()=>{
  // Previously: the purity bonus was capped at a flat 0.95, saturating (via
  // its log2 growth) after as little as one quarter played at a position —
  // so raising the weight from 1 to 10 had almost no further effect, and it
  // could never overcome even a single preference-rank step regardless of
  // weight, making "spread play across their whole preference list" (§11)
  // false at the labelled high end.
  const engine = freshEngine();
  const defs = buildRealisticRosterFixture(engine);
  function avgShareOnTopPreference(purityWeight){
    engine._getState().settings.fairnessWeights.positionPurity = purityWeight;
    engine.runGeneration();
    const summaries = engine.computePlayerSummaries();
    const shares = summaries.map(s=>{
      const prefs = defs.find(d=>d[0]===s.name)[1];
      return s.onCourt ? (s.positions[prefs[0]]||0)/s.onCourt : 0;
    });
    return shares.reduce((a,b)=>a+b,0)/shares.length;
  }
  const low = avgShareOnTopPreference(1);
  const high = avgShareOnTopPreference(10);
  assert.ok(high < low - 0.1,
    `raising position-purity from 1 to 10 should meaningfully reduce the share of quarters spent on a player's #1 preference: low=${low.toFixed(3)} high=${high.toFixed(3)}`);
});

test("BENCH-SWEEP-1 (M2 regression): raising bench weight measurably evens out bench/on-court spread", ()=>{
  const engine = freshEngine();
  buildRealisticRosterFixture(engine);
  function spreadAt(benchWeight){
    engine._getState().settings.fairnessWeights.bench = benchWeight;
    engine.runGeneration();
    const bench = engine.computePlayerSummaries().map(s=>s.bench);
    return Math.max(...bench)-Math.min(...bench);
  }
  const low = spreadAt(1);
  const high = spreadAt(10);
  assert.ok(high <= low,
    `raising bench weight should never widen bench-quarter spread: weight=1 spread=${low}, weight=10 spread=${high}`);
});

test("BENCH-MAXSLIDER-1 (M2 regression): bench weight cannot affect off-preference fills at the preference slider's literal maximum", ()=>{
  // Previously: benchCellCost wasn't scaled by the preference slider at all,
  // so at slider=10 — where §5.1 promises "off-preference fills only occur
  // when no in-preference candidate is eligible at all" — raising bench
  // weight could still change who landed on bench vs on court and, via that,
  // increase the season's off-preference fill count. Confirmed directly: at
  // slider=10, benchCellCost's season-rate term must scale to exactly zero
  // regardless of benchWeight.
  const engine = freshEngine();
  buildRealisticRosterFixture(engine);
  engine._getState().settings.preferenceSlider = 10;
  const counts = [1,5,10].map(w=>{
    engine._getState().settings.fairnessWeights.bench = w;
    engine.runGeneration();
    return engine.computeOffPrefLog().length;
  });
  assert.ok(counts.every(c=>c===counts[0]),
    `off-preference count must be identical across bench weights at slider=10: ${JSON.stringify(counts)}`);
});

test("SLIDER-SWEEP-REALISTIC-1 (H1): off-preference count is monotonically non-increasing on a roster with good position depth", ()=>{
  // §5.1's monotonicity guarantee is tested here against a roster with
  // "reasonable depth at every position" (§5.4's own framing for when this
  // stuff is well-behaved) — the REG-1 fixture, not an adversarial/thin one.
  // A fully general proof across arbitrarily thin rosters isn't attempted:
  // that non-monotonicity turned out to be genuine path-dependence across a
  // sequential, cumulative-state multi-quarter/multi-game solve (confirmed
  // by testing two different balance-damping curves, one of which made a
  // fuzzed adversarial sweep measurably *worse* — ruling out "tune the curve
  // more" as a fix), not a locally-fixable cost-formula defect.
  const engine = freshEngine();
  buildRealisticRosterFixture(engine);
  const counts = [];
  for(let s=0;s<=10;s++){
    engine._getState().settings.preferenceSlider = s;
    engine.runGeneration();
    counts.push(engine.computeOffPrefLog().length);
  }
  for(let i=1;i<counts.length;i++){
    assert.ok(counts[i] <= counts[i-1],
      `off-preference count should not increase from slider=${i-1} (${counts[i-1]}) to slider=${i} (${counts[i]}): ${JSON.stringify(counts)}`);
  }
  // Guard against a reversion to the old, saturated cost model, which was so
  // inert across most of the range that "monotonic" was trivially true only
  // because the counts barely moved at all (e.g. flat at 24 for sliders
  // 1-9). A real fix should show the slider actually doing something.
  assert.ok(counts[1] - counts[10] > 5,
    `expected the slider to meaningfully reduce off-preference fills from slider=1 (${counts[1]}) to slider=10 (${counts[10]}), not stay essentially flat: ${JSON.stringify(counts)}`);
});

test("ED-6: a played game's schedule is frozen across regeneration even when settings/roster change", ()=>{
  const engine = freshEngine();
  const st = engine._getState();
  st.season.numGames = 2;
  st.season.desiredBenchSize = 1;
  ["GS","GA","WA","C","WD","GD","GK","GA"].forEach((pos,i)=>addPlayer(engine, "P"+i, [pos]));
  engine.ensureGamesExist();
  engine.runGeneration();
  const g1 = engine.getGame(1);
  g1.isPlayed = true;
  const before = JSON.stringify(g1.schedule);

  st.settings.preferenceSlider = 0;
  addPlayer(engine, "Extra", ["GS"]);
  engine.runGeneration();

  const after = JSON.stringify(engine.getGame(1).schedule);
  assert.strictEqual(after, before, "a played game's schedule must not change on regeneration");
});

test("ED-7: a played game's outcome still folds into season fairness totals", ()=>{
  const engine = freshEngine();
  const st = engine._getState();
  st.season.numGames = 2;
  st.season.desiredBenchSize = 1;
  ["GS","GA","WA","C","WD","GD","GK","GA"].forEach((pos,i)=>addPlayer(engine, "P"+i, [pos]));
  engine.ensureGamesExist();
  engine.runGeneration();
  engine.getGame(1).isPlayed = true;
  engine.runGeneration();
  const summaries = engine.computePlayerSummaries();
  const totalOnCourt = summaries.reduce((sum,s)=>sum+s.onCourt, 0);
  assert.strictEqual(totalOnCourt, 2*4*7, "both games' on-court quarters (including the played/locked one) should count toward summaries");
});

test("ED-9 (H4 regression): a played game's roster-off/unavailable record survives a later availability edit", ()=>{
  // Previously: planGameAvailability recomputed a played game's fixedOffIds by
  // filtering game.rosteredOffIds down to whoever is *currently* available —
  // so if a coach edited a player's availability for that game number after
  // the fact (e.g. correcting a record, or just editing a different game and
  // triggering a season-wide regeneration), the already-locked game's
  // roster-off record silently changed. §8.1 requires it stay byte-for-byte
  // unchanged "regardless of what triggers the regeneration".
  const engine = freshEngine();
  const st = engine._getState();
  st.season.numGames = 3;
  st.season.desiredBenchSize = 2;
  const defs = [
    ["Amy",["GS","GA"]], ["Bea",["GA","GS","WA"]], ["Cat",["WA","C","GA"]],
    ["Dee",["C","WA","WD"]], ["Eve",["WD","C","GD"]], ["Fay",["GD","WD","GK"]],
    ["Gia",["GK","GD"]], ["Hal",["GS","GA","WA"]], ["Ivy",["WA","C"]], ["Jaz",["C","WD","GD"]]
  ];
  defs.forEach(([name,prefs])=>addPlayer(engine, name, prefs));
  engine.ensureGamesExist();
  engine.runGeneration();

  const g1 = engine.getGame(1);
  g1.isPlayed = true;
  assert.ok(g1.rosteredOffIds.length>0, "sanity: game 1 should have at least one roster-off");
  // g1.rosteredOffIds lives in the harness's separate vm realm; .slice() on it
  // would stay in that realm (species-preserving), so spread into a same-realm
  // array first — same convention as PHASE1-TOGGLE-1 and CSV-IMPORT-XSS-1 above.
  const rosteredOffBefore = [...g1.rosteredOffIds].sort();
  const scheduleBefore = JSON.stringify(g1.schedule);
  const victimId = rosteredOffBefore[0];

  // Mark the already-rested player unavailable for game 1, after the fact,
  // and regenerate — simulating an availability correction or an edit to a
  // different game that triggers a full season regeneration.
  engine._getState().players.find(p=>p.id===victimId).unavailable = [1];
  engine.runGeneration();

  const g1After = engine.getGame(1);
  assert.deepStrictEqual([...g1After.rosteredOffIds].sort(), rosteredOffBefore,
    "a played game's rosteredOffIds must not change after an availability edit: "+JSON.stringify(g1After.rosteredOffIds));
  assert.strictEqual(JSON.stringify(g1After.schedule), scheduleBefore,
    "a played game's schedule must not change after an availability edit");

  const victimSummary = engine.computePlayerSummaries().find(s=>s.id===victimId);
  assert.strictEqual(victimSummary.missed, 1,
    "the player must be counted as missed exactly once for game 1, not double-counted as both rostered-off and unavailable: "+victimSummary.missed);
});

test("FILLIN-EXCLUDED: fill-ins assigned to a shortfall game are excluded from season fairness totals", ()=>{
  const engine = freshEngine();
  const st = engine._getState();
  st.season.numGames = 1;
  st.season.desiredBenchSize = 0;
  ["GS","GA","WA","C","WD","GD"].forEach((pos,i)=>addPlayer(engine, "P"+i, [pos])); // only 6, shortfall by 1
  const fillIn = {id: engine.uid("fi"), name:"Guest", prefs:["GK"]};
  st.fillIns.push(fillIn);
  engine.ensureGamesExist();
  engine.getGame(1).fillInIds = [fillIn.id];
  engine.runGeneration();
  const g = engine.getGame(1);
  assert.strictEqual(g.error, null, "shortfall game with a fill-in covering the gap should generate cleanly: "+g.error);
  const summaries = engine.computePlayerSummaries();
  assert.ok(!summaries.some(s=>s.name==="Guest"), "fill-ins must not appear in season player summaries");
});

/* ============================================================
   9. Realistic-size timing (informational — no hard bound asserted)
   ============================================================ */
test("TIMING-1: realistic season size (12 players, 15 games) generates and reports wall-clock time", ()=>{
  const engine = freshEngine();
  const st = engine._getState();
  st.season.numGames = 15;
  st.season.desiredBenchSize = 3;
  const defs = [
    ["Amy",["GS","GA"]], ["Bea",["GA","GS","WA"]], ["Cat",["WA","C","GA"]],
    ["Dee",["C","WA","WD"]], ["Eve",["WD","C","GD"]], ["Fay",["GD","WD","GK"]],
    ["Gia",["GK","GD"]], ["Hal",["GS","GA","WA"]], ["Ivy",["WA","C"]],
    ["Jaz",["C","WD","GD"]], ["Kim",["GD","GK"]], ["Lou",["GK","GD","WD"]]
  ];
  defs.forEach(([name,prefs])=>addPlayer(engine, name, prefs));
  engine.ensureGamesExist();
  const start = Date.now();
  const r = engine.runGeneration();
  const elapsed = Date.now()-start;
  assert.strictEqual(r.invalid, null);
  console.log(`      [TIMING-1] 12 players / 15 games generated in ${elapsed}ms (reported elapsedMs=${r.elapsedMs}, phase1=${r.phase1Stats.elapsedMs}ms/${r.phase1Stats.passes} passes)`);
});

/* ============================================================
   Report
   ============================================================ */
let passed = 0, failed = 0;
results.forEach(r=>{
  if(r.ok){ passed++; console.log("PASS  "+r.name); }
  else{ failed++; console.log("FAIL  "+r.name); console.log("      "+(r.error && r.error.stack || r.error)); }
});
console.log(`\n${passed} passed, ${failed} failed, ${results.length} total`);
process.exit(failed ? 1 : 0);
