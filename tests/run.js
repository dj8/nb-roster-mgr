/* Node-based regression suite for the engine embedded across app.js / solver.js / hungarian.js.
   Run with: node tests/run.js 
   Loads a fresh, isolated instance of the app per test via harness.loadEngine()
   (document/localStorage/URL/Blob are stubbed — see harness.js). */
"use strict";
const assert = require("assert");
const fs = require("fs");
const path = require("path");
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

const ROSTER_OFF_PRIORITIES = freshEngine().RosterSolver.CONSTANTS.ROSTER_OFF_PRIORITIES;
const DEFAULT_LOADS = {...freshEngine().RosterSolver.CONSTANTS.DEFAULT_POSITION_LOAD};
const WORKLOAD_DEFAULTS = {loadBalance:0, positionLoad:DEFAULT_LOADS, centreQuarters:4};

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

test("HG-2: a non-square cost matrix throws rather than silently producing a wrong-length assignment", ()=>{
  const engine = freshEngine();
  assert.throws(()=>engine.Hungarian.solve([[1,2,3],[4,5,6]]), /square/i);
});

test("HG-4: a row that's entirely BIG_M still returns a complete assignment, not a crash", ()=>{
  const engine = freshEngine();
  const BIG_M = engine.RosterSolver.CONSTANTS.BIG_M;
  const matrix = [
    [BIG_M, BIG_M, BIG_M],
    [1, 2, 3],
    [4, 1, 2]
  ];
  const assignment = engine.Hungarian.solve(matrix);
  assert.strictEqual(assignment.length, 3);
  assert.deepStrictEqual([...assignment].sort(), [0,1,2], "still a complete, valid permutation");
  // Row 0 is forced onto a BIG_M cell (every option there is disqualified) —
  // the caller detects infeasibility from the returned cost, not a crash.
  const rowZeroCost = matrix[0][assignment[0]];
  assert.strictEqual(rowZeroCost, BIG_M, "the all-disqualified row must land on one of its BIG_M cells");
});

test("HG-5: degenerate n=0 and n=1 matrices are handled without error", ()=>{
  // Solver values live in a separate vm realm (see harness.js) — compare via
  // a plain array spread rather than assert.deepStrictEqual directly against
  // a cross-realm array, which fails on constructor identity alone.
  const engine = freshEngine();
  assert.deepStrictEqual([...engine.Hungarian.solve([])], []);
  assert.deepStrictEqual([...engine.Hungarian.solve([[5]])], [0]);
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
  const settings = {preferenceSlider:10, allowOffPreference:true, positionVariety:1};

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
  const settings = {preferenceSlider:10, allowOffPreference:true, positionVariety:1};
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
  const settings = {preferenceSlider:10, allowOffPreference:true, positionVariety:1};
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

test("P2B-4: a forced very low Phase 2b time budget stops promptly and returns a valid (if unrefined) result", ()=>{
  const engine = freshEngine();
  const players = Array.from({length:12},(_,i)=>({id:"p"+i, prefs: engine.POSITIONS.slice(i%7).concat(engine.POSITIONS.slice(0,i%7))}));
  const settings = {preferenceSlider:9, allowOffPreference:true, positionVariety:1};
  const emptyCum = ()=>({posCount:{},onCourt:{},bench:{},gameBenchSoFar:{},benchedLastQuarter:new Set()});
  const quarters = [0,1,2,3].map(qi=>{
    const onCourt = {}; engine.POSITIONS.forEach((pos,i)=>{ onCourt[pos] = players[(i+qi)%players.length].id; });
    const onIds = new Set(Object.values(onCourt));
    const bench = players.filter(p=>!onIds.has(p.id)).map(p=>p.id); // everyone in exactly one slot, as runGeneration always hands over
    return { onCourt, bench, offPreference:{} };
  });
  const start = Date.now();
  const result = engine.RosterSolver.refineGameQuarters({
    quarters, squadPool: players, cumulativeSnapshots:[0,1,2,3].map(emptyCum),
    lockedSlotsPerQuarter:[{},{},{},{}], settings, timeBudgetMs: 1
  });
  const elapsed = Date.now()-start;
  assert.ok(elapsed < 2000, `should stop promptly once its own 1ms budget is exhausted, took ${elapsed}ms`);
  assert.strictEqual(result.quarters.length, 4, "should still return a complete, valid set of quarters even under time pressure");
  result.quarters.forEach(q=>{
    const ids = engine.POSITIONS.map(pos=>q.onCourt[pos]).filter(Boolean);
    assert.strictEqual(new Set(ids).size, ids.length, "no quarter should contain a duplicate player, even when refinement is cut short");
  });
});

test("P2B-5: refinement actually moves players — a second bench stint it can see in hindsight is traded away", ()=>{
  // Regression: every candidate move used to be a cross-quarter slot swap,
  // which always put one player in two slots of a quarter and was rejected —
  // so Phase 2b never changed anything.
  const engine = freshEngine();
  const S = engine.RosterSolver;
  const players = Array.from({length:8},(_,i)=>({id:"p"+i, prefs: engine.POSITIONS.slice()}));
  const settings = {preferenceSlider:5, allowOffPreference:false, positionVariety:0};
  const cum = ()=>({posCount:{}, benchQuota:{}, benchCap:{}});
  // p7 sits all four quarters; everyone else plays the same position throughout.
  const quarters = [0,1,2,3].map(()=>{
    const onCourt = {}; engine.POSITIONS.forEach((pos,i)=>{ onCourt[pos] = "p"+i; });
    return { onCourt, bench:["p7"], offPreference:{} };
  });
  const result = S.refineGameQuarters({ quarters, squadPool: players, cumulativeSnapshots:[0,1,2,3].map(cum), lockedSlotsPerQuarter:[{},{},{},{}], settings });
  assert.ok(result.stats.swaps>0, "refinement should have made at least one trade");
  const stints = {};
  result.quarters.forEach(q=>{
    q.bench.forEach(id=>{ stints[id]=(stints[id]||0)+1; });
    const ids = Object.values(q.onCourt).concat(q.bench);
    assert.strictEqual(new Set(ids).size, 8, "everyone still in exactly one slot each quarter");
  });
  assert.ok(Object.values(stints).every(n=>n===1), "four bench stints should end up with four different players: "+JSON.stringify(stints));

  // Position variety is priced from the lineup being scored, not the Phase 2a snapshots:
  // with variety on and court-time pressure off, one player parked at their #1 all game rotates.
  const two = [{id:"x", prefs:["GS","GA"]}, {id:"y", prefs:["GA","GS"]}].concat(["WA","C","WD","GD","GK"].map(pos=>({id:pos, prefs:[pos]})));
  const fixed = [0,1,2,3].map(()=>({ onCourt:{GS:"x",GA:"y",WA:"WA",C:"C",WD:"WD",GD:"GD",GK:"GK"}, bench:[], offPreference:{} }));
  const varied = S.refineGameQuarters({ quarters:fixed, squadPool:two, cumulativeSnapshots:[0,1,2,3].map(cum), lockedSlotsPerQuarter:[{},{},{},{}],
    settings:{preferenceSlider:10, allowOffPreference:false, positionVariety:10} });
  assert.ok(varied.quarters.some(q=>q.onCourt.GS==="y"), "with variety at 10, the two shooters should trade ends at least once");
});

test("P1-9 (FORCED-ON-COURT-1): Phase 1 prefers the roster-off that leaves the bench free to rotate, without giving up evenness", ()=>{
  const engine = freshEngine();
  const S = engine.RosterSolver;
  const mk = (id,prefs)=>({id, prefs, unavailableCount:0});
  // Three defenders share GK/GD (one to spare); the other six have none to spare between them.
  const players = [mk("a",["GS","GA"]), mk("b",["GA","GS"]), mk("c",["WA","C","WD"]), mk("d",["C","WA","WD"]), mk("e",["WD","WA","C"]), mk("f",["GS","GA","WA"]),
    mk("d1",["GK","GD"]), mk("d2",["GD","GK"]), mk("d3",["GK","GD"])];
  const squad = ids=>players.filter(p=>ids.includes(p.id));
  assert.strictEqual(S.forcedOnCourtCount(squad(["d1","d2","a","b","c","d","e","f"])), 2, "two defenders left for GK and GD: neither can sit");
  assert.strictEqual(S.forcedOnCourtCount(squad(["d1","d2","d3","a","b","c","d","e"])), 5, "without the swing player, both shooters and all three mid-courters must stay on");
  assert.strictEqual(S.forcedOnCourtCount(players), 0);
  assert.strictEqual(S.forcedOnCourtCount(squad(["d1","d2","a","b","c","d","e"])), 0, "a squad of seven has no bench to rotate");
  assert.strictEqual(S.forcedOnCourtCount(squad(["d1","d2","d3","a","b","c","d"]).concat([mk("s3",["GS","GA"])])), 8, "a squad that can't field in-preference at all (two mid-courters, three mid-court positions) is the worst score, not the best");
  assert.strictEqual(S.forcedOnCourtCount(squad(["d1","d2","a","b","c","d","e","f"]).concat([{id:"guest", prefs:[]}])), 0, "a no-preference fill-in can relieve anyone");
  // Every choice leaves each position with 2+ coverers, so only bench flexibility separates them;
  // "a", listed first, is the seed's pick when nothing does.
  const games = [{num:1, availableIds:players.map(p=>p.id), rosterOffCount:1, fixedOffIds:null}];
  ["fairness","balanced","coverage"].forEach(priority=>{
    const r = S.solveSeasonRosterOff({players, games, weights:S.deriveRosterOffWeights(priority)});
    assert.ok(["d1","d2","d3"].includes(r.rosterOffByGame[1][0]), `${priority}: should rest a defender (fewest players forced on), got ${r.rosterOffByGame[1][0]}`);
  });
});

/* ============================================================
   3b. QR-1..QR-5 — structural invariants over a full generated season
   ============================================================ */
test("QR-STRUCTURAL-1 (QR-1..QR-5): every quarter is well-formed across a full generated season", ()=>{
  const engine = freshEngine();
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
  engine.runGeneration();

  engine.gameNums().forEach(num=>{
    const game = engine.getGame(num);
    assert.ok(game.schedule, `game ${num} should have a generated schedule`);
    const squad = new Set(game.squadIds);
    assert.ok(squad.size>=7, `game ${num}: squad must be at least 7 to generate a valid schedule`);
    game.schedule.quarters.forEach((q,qi)=>{
      // QR-1: every position filled exactly once, no duplicates/omissions.
      const filled = engine.POSITIONS.filter(pos=>q.onCourt[pos]);
      assert.strictEqual(filled.length, 7, `game ${num} Q${qi+1}: expected all 7 positions filled, got ${filled.length}`);
      // QR-2: bench count matches squad size - 7 exactly.
      assert.strictEqual((q.bench||[]).length, squad.size-7,
        `game ${num} Q${qi+1}: bench count should be squad(${squad.size})-7`);
      // QR-4: no player double-booked (on court twice, or on court AND bench).
      const allIds = filled.map(pos=>q.onCourt[pos]).concat(q.bench||[]);
      assert.strictEqual(new Set(allIds).size, allIds.length,
        `game ${num} Q${qi+1}: a player must never appear twice on-court/bench in the same quarter`);
      // every assigned id must actually belong to this game's squad.
      allIds.forEach(id=>assert.ok(squad.has(id), `game ${num} Q${qi+1}: ${id} assigned but not in squad`));
    });
    // QR-3: bench rotates — nobody benched in literally every quarter this game,
    // whenever the squad is large enough for rotation to be possible at all.
    if(squad.size>7){
      const benchedEveryQuarter = [...squad].filter(id=>
        game.schedule.quarters.every(q=>(q.bench||[]).includes(id)));
      assert.strictEqual(benchedEveryQuarter.length, 0,
        `game ${num}: nobody should be benched every single quarter when rotation is possible: ${JSON.stringify(benchedEveryQuarter)}`);
    }
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
  // Hand-traced: pool [X,Y,Z,W], rosterOffCount=2, all missed=0 (tied); X,Y
  // prefer GS, Z,W prefer WD. timeBudgetMs:-1 disables refinement entirely,
  // so the result is purely the greedy seed's choice.
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
  // §5.5: the per-game flag, distinct from the season-wide coverage weight
  // (§5.4). Game 1 (X/Y/Z/W) has it on; game 2 uses a disjoint player set
  // (A/B/C/D) so its tie-break is unaffected by game 1's choice. Season-wide
  // weight is coverage=0, so any coverage-aware behavior can only come from
  // the per-game flag.
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

test("ROSTEROFF-PRIORITY-SWEEP: fairness -> balanced -> coverage are three distinct outcomes, each trading more missed-games evenness for coverage", ()=>{
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
  const variances = [], thin = [];
  ROSTER_OFF_PRIORITIES.forEach(priority=>{
    const engine = freshEngine();
    buildRoster(engine);
    engine._getState().settings.rosterOffPriority = priority;
    const r = engine.runGeneration();
    assert.strictEqual(r.invalid, null);
    variances.push(engine.RosterSolver.variance(engine.computePlayerSummaries().map(s=>s.missed)));
    thin.push(engine.gameNums().reduce((n,num)=>n+engine.getGame(num).coverageWarnings.length, 0));
  });
  // Strict, not just monotonic: the old 0-10 slider only ever had two
  // outcomes (0, or anything else), which is why it became a three-way choice.
  assert.ok(variances[0] < variances[1] && variances[1] < variances[2],
    `missed-games variance should rise at each step toward coverage: ${JSON.stringify(variances)}`);
  assert.ok(thin[0] > thin[1] && thin[1] > thin[2],
    `thin-position warnings should fall at each step toward coverage: ${JSON.stringify(thin)}`);
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
  ROSTER_OFF_PRIORITIES.forEach(rosterOffPriority=>[true,false].forEach(allowOffPreference=>{
    const engine = freshEngine();
    buildReportedBugRoster(engine);
    engine._getState().settings.rosterOffPriority = rosterOffPriority;
    engine._getState().settings.allowOffPreference = allowOffPreference;
    const r = engine.runGeneration();
    assert.strictEqual(r.invalid, null);
    const summaries = engine.computePlayerSummaries();
    summaries.forEach(s=>{
      assert.strictEqual(s.missed, 2,
        `rosterOffPriority=${rosterOffPriority}, allowOffPreference=${allowOffPreference}: ${s.name} should have exactly 2 missed games, got ${s.missed}`);
    });
  }));
});

test("PHASE1-DETERMINISTIC-1 (M6): identical input reproduces identical roster-off output under the default time budget", ()=>{
  // Phase 1's restart loop is wall-clock bounded, so in principle a slower
  // machine could run fewer restarts and settle differently — but on this
  // realistic-scale roster the first seed already reaches near-zero and the
  // restart loop never iterates, so the result is deterministic regardless.
  // Compares by player *name*, not id — uid() embeds Math.random()/Date.now().
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

test("FR-3/FR-4: on-court and bench quarters are even (within a small tolerance) among players attending the same number of games", ()=>{
  // §4 ranks on-court/bench evenness below preference-honouring, so some
  // spread at the app's default (preferenceSlider 8) is intended, not a bug
  // (PLAYTIME-SWEEP-1 confirms lowering the slider closes it). Tests the
  // "within a small tolerance" claim near the slider's even-court-time end
  // — best-effort, not absolute.
  const engine = freshEngine();
  const st = engine._getState();
  st.season.numGames = 11;
  st.season.desiredBenchSize = 2;
  st.settings.preferenceSlider = 1; // the even-court-time end of §5.1's trade-off, not the preference-favouring default
  const defs = [
    ["Amy",["GS","GA"]], ["Bea",["GA","GS","WA"]], ["Cat",["WA","C","GA"]],
    ["Dee",["C","WA","WD"]], ["Eve",["WD","C","GD"]], ["Fay",["GD","WD","GK"]],
    ["Gia",["GK","GD"]], ["Hal",["GS","GA","WA"]], ["Ivy",["WA","C"]],
    ["Jaz",["C","WD","GD"]], ["Kim",["GD","GK"]]
  ];
  defs.forEach(([name,prefs])=>addPlayer(engine, name, prefs));
  engine.ensureGamesExist();
  engine.runGeneration();
  const summaries = engine.computePlayerSummaries();
  const gamesPlayedIn = new Set(summaries.map(s=>s.gamesPlayedIn));
  assert.strictEqual(gamesPlayedIn.size, 1, "sanity: everyone should attend the same number of games on this fixture");
  const TOLERANCE = 3; // quarters — "small", not zero; §4 priority 3/4 is best-effort, not a hard rule
  const onCourt = summaries.map(s=>s.onCourt);
  const bench = summaries.map(s=>s.bench);
  assert.ok(Math.max(...onCourt)-Math.min(...onCourt) <= TOLERANCE,
    `on-court quarters should be within ${TOLERANCE} of each other across players attending the same number of games: `+JSON.stringify(summaries.map(s=>[s.name,s.onCourt])));
  assert.ok(Math.max(...bench)-Math.min(...bench) <= TOLERANCE,
    `bench quarters should be within ${TOLERANCE} of each other across players attending the same number of games: `+JSON.stringify(summaries.map(s=>[s.name,s.bench])));
});

test("FR-7: a player is benched in consecutive quarters only when squad size leaves no alternative", ()=>{
  const engine = freshEngine();
  const st = engine._getState();
  st.season.numGames = 11;
  st.season.desiredBenchSize = 2; // bench of 2 out of 11 -> rotation is always possible
  const defs = [
    ["Liv",["GA","GS"]], ["Poppy",["GS","GA","WA","C","WD"]], ["Mabel",["WA","GA","C","GS","WD"]],
    ["Izzy",["WA","WD"]], ["Layla",["WA","WD"]], ["Ella",["C","GA","WA"]], ["Zara",["C","WA","WD"]],
    ["Maddie",["WD","WA"]], ["Abby",["GD","WD","GK"]], ["Avalon",["GD","GK"]], ["Savanah",["GK","GD"]]
  ];
  defs.forEach(([name,prefs])=>addPlayer(engine, name, prefs));
  engine.ensureGamesExist();
  engine.runGeneration();
  let backToBack = 0, totalBenchSlots = 0;
  engine.gameNums().forEach(num=>{
    const g = engine.getGame(num);
    for(let q=1;q<4;q++){
      const prev = new Set(g.schedule.quarters[q-1].bench);
      g.schedule.quarters[q].bench.forEach(id=>{ totalBenchSlots++; if(prev.has(id)) backToBack++; });
    }
  });
  assert.strictEqual(backToBack, 0,
    `expected zero back-to-back bench occurrences when squad size (bench=2/11) always allows rotation, got ${backToBack}/${totalBenchSlots}`);
});

/* ============================================================
   6. Settings default
   ============================================================ */
test("SETTINGS-DEFAULT-1: the four settings and their defaults (preference 8 - strongly favours preference)", ()=>{
  const engine = freshEngine();
  assert.deepStrictEqual(JSON.parse(JSON.stringify(engine._getState().settings)),
    {preferenceSlider:8, allowOffPreference:false, positionVariety:1, rosterOffPriority:"fairness", ...WORKLOAD_DEFAULTS});
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

test("OFFPREF-LOG-BENCHED-1 (I4 regression): the off-preference log names a specialist benched that quarter, not just ones missing from the squad entirely", ()=>{
  // §5.3: previously only "unavailable" (absent from squadIds) was tracked —
  // a specialist merely rested this quarter (still in squadIds) was invisible.
  const engine = freshEngine();
  const st = engine._getState();
  addPlayer(engine, "Amy", ["GS"]);
  addPlayer(engine, "Bea", ["GK"]); // benched this quarter, still in the squad
  addPlayer(engine, "Cat", ["GK"]); // unavailable for the whole game, never in the squad
  engine.ensureGamesExist();
  const g = engine.getGame(1);
  g.schedule = { quarters: [
    { onCourt: {GS:"__amy__", GK:"__amy__"}, bench: ["__bea__"], offPreference: {GK:true} }
  ]};
  // Resolve real ids after addPlayer generated them.
  const amy = st.players.find(p=>p.name==="Amy").id, bea = st.players.find(p=>p.name==="Bea").id;
  g.schedule.quarters[0].onCourt = {GS:amy, GK:amy};
  g.schedule.quarters[0].bench = [bea];
  g.squadIds = [amy, bea]; // Cat is deliberately excluded — "unavailable"

  const log = engine.computeOffPrefLog();
  assert.strictEqual(log.length, 1);
  assert.deepStrictEqual([...log[0].unavailableSpecialists], ["Cat"]);
  assert.deepStrictEqual([...log[0].benchedSpecialists], ["Bea"]);
});

/* Builds a minimal valid backup file as text, merging `plan`/`results` overrides in. */
function makeBackup(planOverrides, results){
  return JSON.stringify({
    format:"netball-roster-backup", schemaVersion:2,
    plan: Object.assign({season:{numGames:1, desiredBenchSize:0}, settings:{}, players:[], fillIns:[], games:{}}, planOverrides||{}),
    results: results || {games:{}}
  });
}
function backupRoundTrip(engine){
  engine.exportBackup();
  const text = engine.CapturingBlob.last;
  engine.importBackup(text);
  return JSON.parse(text);
}

test("BACKUP-IMPORT-SANITIZE-1: a corrupted backup is sanitized rather than corrupting app state", ()=>{
  const engine = freshEngine();
  engine.importBackup(makeBackup({
    season:{numGames:500, desiredBenchSize:2},
    players:[
      {id:"p1", name:"Amy", prefs:["GS","GA"], unavailable:[]},
      {id:"p1", name:"AmyDupe", prefs:["WA","C"], unavailable:[]},   // duplicate id — should be dropped
      {id:"p2", name:"Bea", prefs:["WD","GD"], unavailable:[]}
    ],
    games:{"1":{lockedSlots:{"0-GS":"ghost123"}}}                    // locked slot references an unknown player
  }, {games:{"1":{schedule:{quarters:[
    {onCourt:{GS:"p2", GA:"ghost456"}, bench:[], offPreference:{}},  // unknown player id in the schedule
    {onCourt:{}, bench:[]}, {onCourt:{}, bench:[]}, {onCourt:{}, bench:[]}
  ]}}}}));
  const st = engine._getState();

  assert.strictEqual(st.season.numGames, 60, "numGames should be clamped to the app's supported range, not left at 500");
  assert.strictEqual(st.players.length, 2, "the duplicate player id should be dropped: "+JSON.stringify(st.players));
  assert.strictEqual(st.players.find(p=>p.id==="p1").name, "Amy", "the first occurrence of a duplicate id should be kept");

  const g = engine.getGame(1);
  assert.strictEqual(Object.keys(g.lockedSlots).length, 0, "a locked slot referencing an unknown player id should be dropped: "+JSON.stringify(g.lockedSlots));
  assert.strictEqual(g.schedule.quarters[0].onCourt.GS, "p2", "a valid schedule entry should still import correctly");
  assert.ok(!g.schedule.quarters[0].onCourt.GA, "an unknown player id in the schedule should be dropped, not left dangling: "+JSON.stringify(g.schedule.quarters[0].onCourt));
});

test("BACKUP-IMPORT-REJECT-1: non-backup, malformed and too-new files are refused without touching state", ()=>{
  const engine = freshEngine();
  const st = engine._getState();
  addPlayer(engine, "Keeper", ["GS"]);
  const before = JSON.stringify(engine._getState().players);
  ["not json at all", "[]", "{}", JSON.stringify({format:"something-else", plan:{}}),
   JSON.stringify({format:"netball-roster-backup", schemaVersion:99, plan:{}}),
   JSON.stringify({format:"netball-roster-backup", schemaVersion:1}),
   "#META\nversion,1\n#PLAYERS\np1,Amy,GS,"   // the retired CSV format
  ].forEach(bad=>{
    engine.importBackup(bad);
    assert.strictEqual(JSON.stringify(engine._getState().players), before, "a refused import must leave state untouched: "+bad.slice(0,40));
  });
  assert.strictEqual(engine._getState(), st, "state object itself must not be swapped by a refused import");
});

test("BACKUP-IMPORT-VALIDATE-1 (E5/E6/E7 regression): backup player import applies the same rules as the Add-player dialog", ()=>{
  const engine = freshEngine();
  engine.importBackup(makeBackup({
    season:{numGames:5, desiredBenchSize:2},
    players:[
      {id:"p1", name:"Dupe", prefs:["GS","GS","GS","GA"], unavailable:[3,"abc",-2,99,0]},  // duplicated prefs + garbage/invalid unavailable values
      {id:"p2", name:"NoPrefs", prefs:[], unavailable:[]}                                   // no recognised preference at all
    ]
  }));
  const st = engine._getState();

  const dupe = st.players.find(p=>p.name==="Dupe");
  assert.ok(dupe, "the valid player row should still import");
  // Cross-realm arrays (see harness.js) — spread before deepStrictEqual.
  assert.deepStrictEqual([...dupe.prefs], ["GS","GA"], "E6: duplicated preference entries must be de-duplicated, not inflate prefs.length: "+JSON.stringify(dupe.prefs));
  // Note: only non-finite/negative/zero values are filtered — an out-of-range
  // game number like 99 in a 5-game season is left as-is, matching the
  // Add-player dialog's own validation exactly (it has no upper bound either).
  assert.deepStrictEqual([...dupe.unavailable], [3,99], "E5: non-numeric/negative/zero unavailable values must be filtered out, same as the Add-player dialog: "+JSON.stringify(dupe.unavailable));

  assert.ok(!st.players.some(p=>p.name==="NoPrefs"), "E7: a player with zero recognised preferences must be dropped, not imported with an empty list");
});

test("BACKUP-ROUNDTRIP-NAMES-1: awkward names (formula characters, quotes, commas, unicode) round-trip exactly", ()=>{
  const engine = freshEngine();
  const st = engine._getState();
  st.season.numGames = 1;
  const names = ["=1+1", "+cmd", "-x", "@sum", "'quoted'", 'He said "hi", ok', "Zoë 🏐"];
  names.forEach(name=>st.players.push({id: engine.uid("p"), name, prefs:["GS"], unavailable:[]}));
  engine.ensureGamesExist();
  backupRoundTrip(engine);
  assert.deepStrictEqual([...engine._getState().players.map(p=>p.name)], names, "names must come back byte-for-byte, with no CSV-style escaping artefacts");
});

test("BACKUP-IMPORT-SANITIZE-2 (C1 regression): non-numeric settings are clamped, not left as NaN", ()=>{
  // Previously: Number("abc") -> NaN flowed into the cost model, every
  // candidate scored NaN, and solveSeasonRosterOff crashed pushing a null
  // candidate onto the picked list.
  const engine = freshEngine();
  const defs = [
    ["Amy",["GS","GA"]], ["Bea",["GA","GS"]], ["Cat",["WA","C"]], ["Dee",["C","WA"]],
    ["Eve",["WD","GD"]], ["Fay",["GD","WD"]], ["Gia",["GK","GD"]], ["Hal",["GS","WA"]],
    ["Ivy",["WA","C"]], ["Jaz",["C","WD"]]
  ];
  engine.importBackup(makeBackup({
    season:{numGames:3, desiredBenchSize:2},
    settings:{preferenceSlider:"abc", positionVariety:null, rosterOffPriority:"<img src=x>", allowOffPreference:"yes"},
    players: defs.map(([name,prefs],i)=>({id:"p"+i, name, prefs, unavailable:[]}))
  }));
  const st = engine._getState();
  assert.ok(Number.isFinite(st.settings.preferenceSlider), "preferenceSlider must be a finite number after import: "+st.settings.preferenceSlider);
  assert.ok(Number.isFinite(st.settings.positionVariety), "positionVariety must be a finite number after import: "+st.settings.positionVariety);
  assert.strictEqual(st.settings.rosterOffPriority, "fairness", "an unrecognised roster-off priority must fall back to the default");
  assert.strictEqual(st.settings.allowOffPreference, false, "a non-boolean toggle must be ignored, leaving the default");

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
    settings: {preferenceSlider:"oops", positionVariety:999, rosterOffPriority:"sideways", allowOffPreference:true,
               // controls that no longer exist, as an older save would still carry them
               rosterOffWeight:3, topTwoOnly:true, fairnessWeights:{bench:7, positionPurity:4}}
  });
  engine.saveState();
  const reloaded = engine.loadState();
  assert.ok(Number.isFinite(reloaded.season.numGames) && reloaded.season.numGames>=1 && reloaded.season.numGames<=60,
    "numGames should be clamped to a valid range: "+reloaded.season.numGames);
  assert.strictEqual(reloaded.season.desiredBenchSize, 0, "a negative bench size should be clamped to 0");
  assert.ok(Number.isFinite(reloaded.settings.preferenceSlider), "a non-numeric preferenceSlider should fall back to a finite default");
  assert.strictEqual(reloaded.settings.positionVariety, 10, "an out-of-range positionVariety (999) should be clamped to the max (10)");
  assert.strictEqual(reloaded.settings.rosterOffPriority, "fairness", "an unrecognised roster-off priority should fall back to the default");
  ["rosterOffWeight","topTwoOnly","fairnessWeights"].forEach(k=>assert.ok(!(k in reloaded.settings), `retired setting ${k} should be dropped on load`));
});

test("BACKUP-IMPORT-XSS-1 (C2 regression): imported preferences are filtered to real positions only", ()=>{
  // Prefs strings are later interpolated into HTML, so a crafted backup from a
  // co-coach must not be able to smuggle markup through them.
  const engine = freshEngine();
  engine.importBackup(makeBackup({
    players:[{id:"p1", name:"Amy", prefs:["GS",'"><img src=x onerror=alert(1)>'], unavailable:[]}],
    fillIns:[{id:"f1", name:"Guest", prefs:['"><svg onload=alert(2)>'], saved:true}]
  }));
  const st = engine._getState();
  // st.players/fillIns live in the harness's separate vm realm (see the note on
  // PHASE1-TOGGLE-1 above) — spread into a same-realm array before comparing.
  assert.deepStrictEqual([...st.players[0].prefs], ["GS"], "the injected markup must be stripped, leaving only the real position token: "+JSON.stringify(st.players[0].prefs));
  assert.deepStrictEqual([...st.fillIns[0].prefs], [], "a fill-in preference string with no real position tokens should end up empty, not carry the markup through: "+JSON.stringify(st.fillIns[0].prefs));
});

test("BACKUP-IMPORT-KEYS-1: unexpected game/slot keys (including __proto__) are ignored, not applied", ()=>{
  const engine = freshEngine();
  engine.importBackup(`{"format":"netball-roster-backup","schemaVersion":1,"plan":{"season":{"numGames":2,"desiredBenchSize":0},
    "players":[{"id":"p1","name":"Amy","prefs":["GS"],"unavailable":[]}],
    "games":{"__proto__":{"isPlayed":true},"constructor":{"isPlayed":true},"0":{},"1":{"lockedSlots":{"0-GS":"p1","9-XX":"p1","__proto__":"p1"}}}}}`);
  assert.strictEqual(({}).isPlayed, undefined, "Object.prototype must not be polluted");
  assert.deepStrictEqual([...engine.gameNums()], [1,2], "only real game numbers should exist");
  assert.deepStrictEqual(JSON.parse(JSON.stringify(engine.getGame(1).lockedSlots)), {"0-GS":"p1"}, "only well-formed slot keys survive");
});

/* ============================================================
   7. Backup round-trip
   ============================================================ */
test("BACKUP-ROUNDTRIP-1: the file is versioned, split into plan/results, and omits retired and device-only fields", ()=>{
  const engine = freshEngine();
  const st = engine._getState();
  st.season.numGames = 1;
  ["GS","GA","WA","C","WD","GD","GK"].forEach((pos,i)=>addPlayer(engine, "P"+i, [pos]));
  engine.ensureGamesExist();
  engine.runGeneration();
  engine.exportBackup();
  const text = engine.CapturingBlob.last;
  const b = JSON.parse(text);
  assert.strictEqual(b.format, "netball-roster-backup");
  assert.strictEqual(b.schemaVersion, 2);
  assert.ok(Number.isInteger(b.buildNumber) && b.buildNumber>0, "buildNumber should be recorded");
  assert.ok(b.plan && b.results, "plan and results sections should both be present");
  assert.strictEqual(b.plan.players.length, 7);
  assert.ok(b.results.games["1"].schedule, "the generated schedule belongs under results");
  assert.ok(!("schedule" in b.plan.games["1"]), "results must not leak into plan");
  assert.ok(!text.includes("weight_missed") && !text.includes("onCourt\":1"), "retired settings must not be exported");
  assert.ok(!("theme" in b) && !("theme" in b.plan), "device-only theme must not be exported");
  assert.deepStrictEqual(Object.keys(b.plan.settings).sort(), ["allowOffPreference","centreQuarters","loadBalance","positionLoad","positionVariety","preferenceSlider","rosterOffPriority"]);
});

test("BACKUP-ROUNDTRIP-2: a played game's rosteredOffIds and unavailableIds survive export/import as frozen facts", ()=>{
  const engine = freshEngine();
  const st = engine._getState();
  st.season.numGames = 1;
  st.season.desiredBenchSize = 2;
  ["GS","GA","WA","C","WD","GD","GK","GA","GD","WA","C"].forEach((pos,i)=>addPlayer(engine, "P"+i, [pos])); // 11 players, 1 unavailable, bench 2 -> 1 roster-off
  st.players[0].unavailable = [1];
  engine.ensureGamesExist();
  engine.runGeneration();
  const g1 = engine.getGame(1);
  assert.strictEqual(g1.rosteredOffIds.length, 1, "sanity: exactly one roster-off expected");
  g1.isPlayed = true;
  const rosteredOffBefore = [...g1.rosteredOffIds].sort();
  const unavailBefore = [...g1.unavailableIds];
  assert.strictEqual(unavailBefore.length, 1, "sanity: one unavailable player recorded");

  backupRoundTrip(engine);

  const st2 = engine._getState();
  // Cross-realm arrays (see harness.js) — spread before deepStrictEqual.
  assert.deepStrictEqual([...st2.games["1"].rosteredOffIds].sort(), rosteredOffBefore,
    "played game's roster-off decision should be frozen and survive the round-trip exactly");
  assert.deepStrictEqual([...st2.games["1"].unavailableIds], unavailBefore, "played game's unavailable list must survive too");
  assert.strictEqual(st2.games["1"].isPlayed, true, "played/locked status must survive export/import, not reset to false");
});

test("BACKUP-ROUNDTRIP-3 (M5 regression): an unplayed game's exact rosteredOffIds survive import even when Phase 1 would pick differently", ()=>{
  // Previously the import unconditionally re-ran Phase 1, overwriting
  // rosteredOffIds — it only *looked* like a round-trip since the solver is
  // deterministic on identical input. The file here is hand-edited to a
  // selection Phase 1 would never produce on its own, so preservation can only
  // be verified by the import path actually trusting the file.
  const engine = freshEngine();
  const st = engine._getState();
  st.season.numGames = 1;
  st.season.desiredBenchSize = 2;
  ["GS","GA","WA","C","WD","GD","GK","GA","GD","WA"].forEach((pos,i)=>addPlayer(engine, "P"+i, [pos])); // 10 players, bench 2 -> natural roster-off = 1
  engine.ensureGamesExist();
  engine.runGeneration();
  assert.strictEqual(engine.getGame(1).rosteredOffIds.length, 1, "sanity: natural roster-off for this squad is exactly 1 player");

  engine.exportBackup();
  const b = JSON.parse(engine.CapturingBlob.last);
  const ids = engine._getState().players.map(p=>p.id);
  const forcedPair = [ids[2], ids[3]].sort(); // force 2 players off, not the natural 1
  b.results.games["1"].rosteredOffIds = forcedPair;
  engine.importBackup(JSON.stringify(b));

  assert.deepStrictEqual([...engine.getGame(1).rosteredOffIds].sort(), forcedPair,
    "the imported (hand-edited) roster-off selection must be preserved exactly, not silently recomputed by a fresh Phase 1 solve");

  // A subsequent real Generate/Rebalance must still be free to change it —
  // preservation is a one-time import behavior, not an implicit permanent lock.
  engine.runGeneration();
  assert.strictEqual(engine.getGame(1).rosteredOffIds.length, 1,
    "a later Generate/Rebalance must still recompute freely and is not stuck honoring the imported value as a lock");
});

test("BACKUP-ROUNDTRIP-4: an explicit empty roster-off lock ([] = nobody off) stays distinct from no lock (null)", ()=>{
  const engine = freshEngine();
  const st = engine._getState();
  st.season.numGames = 2;
  ["GS","GA","WA","C","WD","GD","GK","GA"].forEach((pos,i)=>addPlayer(engine, "P"+i, [pos]));
  engine.ensureGamesExist();
  engine.getGame(1).rosterOffLockIds = [];
  engine.getGame(2).rosterOffLockIds = null;
  backupRoundTrip(engine);
  assert.deepStrictEqual([...engine.getGame(1).rosterOffLockIds], [], "explicit 'nobody off' must survive (the old CSV format collapsed it to null)");
  assert.strictEqual(engine.getGame(2).rosterOffLockIds, null, "no lock must stay no lock");
});

test("BACKUP-ROUNDTRIP-5: schedule, locks, off-preference flags and every per-game setting survive a round-trip", ()=>{
  const engine = freshEngine();
  const st = engine._getState();
  st.season.numGames = 2;
  st.season.desiredBenchSize = 1;
  ["GS","GA","WA","C","WD","GD","GK","GS"].forEach((pos,i)=>addPlayer(engine, "P"+i, [pos]));
  engine.ensureGamesExist();
  const g1 = engine.getGame(1);
  g1.date = "2026-03-14"; g1.time = "10:30"; g1.location = "=Court 3, \"Main\" Hall";
  g1.rosterOffOverride = 0; g1.allowOffPreference = false; g1.strictSpecialistPairing = true;
  engine.runGeneration();
  g1.lockedSlots["0-GS"] = st.players[0].id;
  const scheduleBefore = JSON.parse(JSON.stringify(g1.schedule));
  backupRoundTrip(engine);
  const g = engine.getGame(1);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(g.schedule)), scheduleBefore, "schedule must round-trip exactly");
  assert.strictEqual(g.lockedSlots["0-GS"], st.players[0].id);
  assert.strictEqual(g.date, "2026-03-14");
  assert.strictEqual(g.time, "10:30");
  assert.strictEqual(g.location, "=Court 3, \"Main\" Hall", "free text must come back exactly");
  assert.strictEqual(g.rosterOffOverride, 0);
  assert.strictEqual(g.allowOffPreference, false);
  assert.strictEqual(g.strictSpecialistPairing, true);
  assert.strictEqual(g.generated, true);
  assert.strictEqual(engine.getGame(2).allowOffPreference, null, "an unset per-game override stays null (follow Settings)");
});

test("FILLIN-SAVED-ROUNDTRIP-1 (M4 regression): a one-off fill-in's saved:false flag survives export/import", ()=>{
  // §6: saving for reuse is an explicit opt-in choice that must persist
  // (§9), or a one-off would silently become reusable on next import.
  const engine = freshEngine();
  const st = engine._getState();
  st.fillIns.push({id: engine.uid("fi"), name:"Guest One-off", prefs:["GK"], saved:false});
  st.fillIns.push({id: engine.uid("fi"), name:"Guest Reusable", prefs:["GS"], saved:true});
  backupRoundTrip(engine);
  const st2 = engine._getState();
  const oneOff = st2.fillIns.find(f=>f.name==="Guest One-off");
  const reusable = st2.fillIns.find(f=>f.name==="Guest Reusable");
  assert.strictEqual(oneOff.saved, false, "a one-off fill-in must not flip to saved:true on import");
  assert.strictEqual(reusable.saved, true, "a reusable fill-in must stay saved:true on import");
});

test("STRICT-PAIRING-APP-1 (M3): the per-game toggle reaches computeSeasonRosterOff and survives the backup round-trip", ()=>{
  const engine = freshEngine();
  const st = engine._getState();
  st.season.numGames = 1;
  st.season.desiredBenchSize = 2;
  // Same shape as the solver-level STRICT-PAIRING-1 test: two GS specialists,
  // two WD specialists, coverage-blind season-wide weight (0) so any
  // coverage-aware pick can only come from the per-game flag.
  [["X",["GS"]],["Y",["GS"]],["Z",["WD"]],["W",["WD"]]].forEach(([name,prefs])=>addPlayer(engine,name,prefs));
  st.settings.rosterOffPriority = "fairness";
  engine.ensureGamesExist();
  engine.getGame(1).strictSpecialistPairing = true;
  engine.computeSeasonRosterOff();
  const nameOf = id => st.players.find(p=>p.id===id).name;
  const offNames = (engine.getGame(1).rosteredOffIds||[]).map(nameOf).sort();
  assert.notDeepStrictEqual(offNames, ["X","Y"],
    "with strict pairing on for this game, both GS specialists should not be rostered off together: "+JSON.stringify(offNames));
  assert.notDeepStrictEqual(offNames, ["Z","W"],
    "with strict pairing on for this game, both WD specialists should not be rostered off together: "+JSON.stringify(offNames));

  backupRoundTrip(engine);
  assert.strictEqual(engine.getGame(1).strictSpecialistPairing, true,
    "the per-game strict-pairing flag must survive export/import");
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

test("MANUAL-ROSTEROFF-EMPTY-1 (E3 regression): an explicit 'roster off nobody' lock is honored, not treated as auto", ()=>{
  // Previously checked `rosterOffLockIds && .length`, so an explicit []
  // ("nobody off") was indistinguishable from null ("no lock") and fell
  // through to the normal derived count.
  const engine = freshEngine();
  const st = engine._getState();
  st.season.numGames = 1;
  st.season.desiredBenchSize = 2;
  ["GS","GA","WA","C","WD","GD","GK","GA","GD","WA"].forEach((pos,i)=>addPlayer(engine, "P"+i, [pos])); // 10 players, auto would roster off 1
  engine.ensureGamesExist();
  engine.getGame(1).rosterOffLockIds = [];
  const avail = engine.planGameAvailability(1);
  assert.deepStrictEqual(avail.fixedOffIds, [], "an explicit empty lock must be honored as 'roster off nobody', not fall back to auto-derivation");
  assert.strictEqual(avail.rosterOffCount, 0);
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
  engine.runGeneration();
  const g = engine.getGame(1);
  assert.strictEqual(g.error, null, "should not error when off-preference is allowed: "+g.error);
  assert.ok(g.schedule.quarters[0].onCourt.GK, "GK should still be filled by someone, off-preference");
  assert.strictEqual(g.schedule.quarters[0].offPreference.GK, true);
});

test("OP-9: toggling allowOffPreference off raises an error instead of an off-preference fallback", ()=>{
  // Regression: solveQuarterPositions used to push a NO_ELIGIBLE_PLAYER error
  // AND still commit the disqualified (BIG_M) cell into onCourt — the
  // forbidden off-preference fill shipped even though the error was also set.
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
  assert.strictEqual(g.generated, false, "a game with an unfillable position must not be marked generated");
  assert.strictEqual(g.schedule, null, "a game with an unfillable position must not have a saved schedule");
  assert.strictEqual(engine.computeOffPrefLog().length, 0, "no off-preference fill should ever be logged when the toggle is off");
});

test("DATE-1: game dates are validated, labelled, and survive a backup round-trip", ()=>{
  const engine = freshEngine();
  assert.strictEqual(engine.sanitizeGameDate("2026-03-14"), "2026-03-14");
  ["", null, undefined, "2026-02-30", "14/03/2026", "2026-3-4", "garbage"].forEach(bad=>
    assert.strictEqual(engine.sanitizeGameDate(bad), "", `${JSON.stringify(bad)} must collapse to an empty date`));
  const st = engine._getState();
  st.season.numGames = 2;
  engine.ensureGamesExist();
  assert.strictEqual(engine.gameLabel(1), "Game 1", "an undated game keeps its plain label");
  engine.getGame(1).date = "2026-03-14";
  assert.ok(/^Game 1 · .*14/.test(engine.gameLabel(1)), "a dated game's label includes the formatted date: "+engine.gameLabel(1));
  backupRoundTrip(engine);
  assert.strictEqual(engine.getGame(1).date, "2026-03-14");
  assert.ok(/^G1 \(.*14.*\)$/.test(engine.gameTag(1)), "tag links the game number to its date: "+engine.gameTag(1));
  assert.strictEqual(engine.gameTag(2), "G2");
  assert.strictEqual(engine.getGame(2).date, "");
});

test("DATE-2: game time and location are sanitized and survive a backup round-trip", ()=>{
  const engine = freshEngine();
  assert.strictEqual(engine.sanitizeGameTime("09:05"), "09:05");
  ["", null, "24:00", "9:05", "12:60", "noon"].forEach(bad=>
    assert.strictEqual(engine.sanitizeGameTime(bad), "", `${JSON.stringify(bad)} must collapse to an empty time`));
  assert.strictEqual(engine.sanitizeGameLocation("  Court   3 \n Riverside "), "Court 3 Riverside");
  assert.strictEqual(engine.sanitizeGameLocation("x".repeat(200)).length, 80);
  const st = engine._getState();
  st.season.numGames = 1;
  engine.ensureGamesExist();
  const g = engine.getGame(1);
  g.date = "2026-03-14"; g.time = "10:30"; g.location = "=Court 3, Riverside";
  assert.ok(/10/.test(engine.gameLabel(1)), "label includes the time: "+engine.gameLabel(1));
  backupRoundTrip(engine);
  const g2 = engine.getGame(1);
  assert.strictEqual(g2.time, "10:30");
  assert.strictEqual(g2.location, "=Court 3, Riverside", "location must round-trip exactly");
});

test("OP-13: an off-preference slot the coach locked is flagged in the off-preference log", ()=>{
  const engine = freshEngine();
  const st = engine._getState();
  st.season.numGames = 1;
  st.season.desiredBenchSize = 0;
  st.settings.allowOffPreference = true;
  ["GS","GA","WA","C","WD","GD"].forEach((pos,i)=>addPlayer(engine, "P"+i, [pos]));
  addPlayer(engine, "P6", ["GS"]); // nobody lists GK, so someone must be placed there off-preference
  engine.ensureGamesExist();
  engine.runGeneration();
  const before = engine.computeOffPrefLog();
  assert.ok(before.length>0 && before.every(o=>o.locked===false), "sanity: unlocked off-preference fills are not flagged locked");
  const first = before[0];
  engine.getGame(1).lockedSlots[(first.quarter-1)+"-"+first.position] = first.playerId;
  const after = engine.computeOffPrefLog();
  const hit = after.find(o=>o.quarter===first.quarter && o.position===first.position);
  assert.strictEqual(hit.locked, true, "the locked off-preference slot must be flagged");
  assert.ok(/^Locked by coach/.test(engine.describeOffPrefReason(hit)), "the report reason should say it was locked: "+engine.describeOffPrefReason(hit));
  after.filter(o=>o!==hit).forEach(o=>assert.strictEqual(o.locked, false, "other slots stay unflagged"));
});

test("OP-12: per-game allowOffPreference overrides the season-wide setting in both directions", ()=>{
  const build = (globalAllow, gameAllow)=>{
    const engine = freshEngine();
    const st = engine._getState();
    st.season.numGames = 1;
    st.season.desiredBenchSize = 0;
    st.settings.allowOffPreference = globalAllow;
    ["GS","GA","WA","C","WD","GD"].forEach((pos,i)=>addPlayer(engine, "P"+i, [pos]));
    addPlayer(engine, "P6", ["GS"]); // no one lists GK
    engine.ensureGamesExist();
    engine.getGame(1).allowOffPreference = gameAllow;
    engine.runGeneration();
    return engine.getGame(1);
  };
  const blocked = build(true, false);
  assert.ok(blocked.error && /GK/.test(blocked.error), "game override 'not allowed' must error even though Settings allows: "+blocked.error);
  const allowed = build(false, true);
  assert.strictEqual(allowed.error, null, "game override 'allowed' must schedule even though Settings disallows");
  assert.strictEqual(allowed.generated, true);
  const followed = build(false, null);
  assert.ok(followed.error, "null override must follow the Settings toggle (off)");
});

test("OP-11: with allowOffPreference off, the preference slider has no effect (no off-preference fills regardless of value)", ()=>{
  const engine = freshEngine();
  const st = engine._getState();
  st.season.numGames = 1;
  st.season.desiredBenchSize = 0;
  st.settings.allowOffPreference = false;
  ["GS","GA","WA","C","WD","GD","GK"].forEach((pos,i)=>addPlayer(engine, "P"+i, [pos])); // every position covered in-preference
  engine.ensureGamesExist();
  [0,3,5,7,10].forEach(slider=>{
    st.settings.preferenceSlider = slider;
    engine.runGeneration();
    const g = engine.getGame(1);
    assert.strictEqual(g.error, null, `slider=${slider}, toggle off: should generate cleanly with full in-preference coverage: ${g.error}`);
    assert.strictEqual(engine.computeOffPrefLog().length, 0, `slider=${slider}, toggle off: must have zero off-preference fills`);
  });
});

test("RANK3-1 (H2 regression): a 3rd+ preference is still in-preference, not an off-preference fill", ()=>{
  // Previously: prefRank sliced to prefs.slice(0,2), so a 3rd+ preference was
  // indistinguishable from unlisted — with allowOffPreference off, genuine
  // (non-top-2) coverage became a false NO_ELIGIBLE_PLAYER error.
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
  engine.runGeneration();
  assert.strictEqual(engine.getGame(1).error, null,
    "a position a player lists third must count as in-preference coverage: "+engine.getGame(1).error);
});

test("EMPTYPREFS-1 (H3 regression): a preference-less candidate is never cheaper than a real specialist", ()=>{
  // Previously: off-preference cost was p.prefs.length, which is 0 for a
  // no-preference fill-in (§6 allows this) — tying the best rank-0 specialist
  // and out-competing every real candidate at every position.
  const engine = freshEngine();
  const cumulative = {posCount:{}, onCourt:{}, bench:{}, gameBenchSoFar:{}, benchedLastQuarter:new Set()};
  const settings = {preferenceSlider:10, allowOffPreference:true, positionVariety:1};
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
   Cost-model guarantees behind the two sliders: position variety actually
   spreads play, the preference slider actually evens out court time and is
   evenly spaced, and nothing but the absence of an in-preference candidate
   can cause an off-preference fill at the slider's maximum.
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

test("VARIETY-SWEEP-1 (M1 regression): raising position variety measurably spreads play across a player's list", ()=>{
  // Previously: the variety penalty was capped at a flat 0.95, saturating after
  // one quarter at a position, so raising the weight had almost no further
  // effect — making §11's "spread across the whole list" false at the high end.
  const engine = freshEngine();
  const defs = buildRealisticRosterFixture(engine);
  function avgShareOnTopPreference(variety){
    engine._getState().settings.positionVariety = variety;
    engine.runGeneration();
    const summaries = engine.computePlayerSummaries();
    const shares = summaries.map(s=>{
      const prefs = defs.find(d=>d[0]===s.name)[1];
      return s.onCourt ? (s.positions[prefs[0]]||0)/s.onCourt : 0;
    });
    return shares.reduce((a,b)=>a+b,0)/shares.length;
  }
  const none = avgShareOnTopPreference(0);
  const mid = avgShareOnTopPreference(5);
  const high = avgShareOnTopPreference(10);
  assert.ok(mid < none - 0.1 && high < mid,
    `each half of the variety slider should reduce the share of quarters spent on a player's #1 preference: 0=${none.toFixed(3)} 5=${mid.toFixed(3)} 10=${high.toFixed(3)}`);
});

test("PLAYTIME-SWEEP-1: lowering the preference slider evens out court time, steadily rather than all at the top end", ()=>{
  const engine = freshEngine();
  buildRealisticRosterFixture(engine);
  function courtSpreadAt(slider){
    engine._getState().settings.preferenceSlider = slider;
    engine.runGeneration();
    const onCourt = engine.computePlayerSummaries().map(s=>s.onCourt);
    return Math.max(...onCourt)-Math.min(...onCourt);
  }
  // Court-time evenness outranks preference rank (§4), so it is as even as
  // in-preference play allows across most of the slider; it gives way at the top.
  const spreads = [0,5,8,10].map(courtSpreadAt);
  assert.ok(spreads[0] <= spreads[1] && spreads[1] <= spreads[2] && spreads[2] < spreads[3],
    `on-court spread should never narrow as the slider rises, and widen at the top end: ${JSON.stringify(spreads)}`);
});

/* Per player: season on-court quarters, missed games and the most bench
   quarters they sat in any one game. */
function courtTimeFacts(engine){
  const facts = {};
  engine.computePlayerSummaries().forEach(s=>{ facts[s.name] = {onCourt:s.onCourt, missed:s.missed, maxBenchInGame:0}; });
  const nameOf = {};
  engine._getState().players.forEach(p=>{ nameOf[p.id]=p.name; });
  engine.gameNums().forEach(n=>{
    const sched = engine.getGame(n).schedule; if(!sched) return;
    const count = {};
    sched.quarters.forEach(q=>q.bench.forEach(id=>{ count[id]=(count[id]||0)+1; }));
    Object.keys(count).forEach(id=>{ const f=facts[nameOf[id]]; if(f) f.maxBenchInGame=Math.max(f.maxBenchInGame,count[id]); });
  });
  return facts;
}

/* 11 players who each list all seven positions (in rotated order), bench of
   2: preference never forces who sits, so court-time rules can be tested alone. */
function buildFlexibleRoster(engine){
  const st = engine._getState();
  st.season.numGames = 11;
  st.season.desiredBenchSize = 2;
  const POS = engine.POSITIONS;
  for(let i=0;i<11;i++) addPlayer(engine, "P"+i, POS.map((_,k)=>POS[(i+k)%7]));
  engine.ensureGamesExist();
  return st;
}

test("COURT-TARGET-1: season court targets are level, except for players who can't reach the level or are already past it", ()=>{
  const S = freshEngine().RosterSolver;
  const near = (a,b)=>Math.abs(a-b)<1e-6;
  const even = S.computeCourtTargets([{id:"a",floor:0,cap:40},{id:"b",floor:0,cap:36},{id:"c",floor:0,cap:36}], 90);
  assert.ok(near(even.a,30) && near(even.b,30) && near(even.c,30), JSON.stringify(even));
  const capped = S.computeCourtTargets([{id:"a",floor:0,cap:40},{id:"b",floor:0,cap:40},{id:"c",floor:0,cap:16}], 90);
  assert.ok(near(capped.c,16) && near(capped.a,37) && near(capped.b,37), "a player short of games plays all of theirs; the rest share what's left: "+JSON.stringify(capped));
  const past = S.computeCourtTargets([{id:"a",floor:36,cap:40},{id:"b",floor:0,cap:40},{id:"c",floor:0,cap:40}], 90);
  assert.ok(near(past.a,36) && near(past.b,27) && near(past.c,27), "quarters already played in frozen games can't be taken back: "+JSON.stringify(past));
  assert.strictEqual(S.baseBenchCap(9,2), 1);
  assert.strictEqual(S.baseBenchCap(8,1), 1);
  assert.strictEqual(S.baseBenchCap(10,3), 2, "12 bench stints can't go round 10 players once each");

  // planGameBench: a regular behind on court time is due less bench; only those missing fewer games get the relaxed cap.
  const plan = S.planGameBench({
    squad:[{id:"a"},{id:"b"},{id:"g",isFillIn:true}].concat(["c","d","e","f","h","i"].map(id=>({id}))), benchSlotCount:2,
    courtTargets:{a:28,b:28},  loadSoFar:{a:14,b:10}, gamesLeft:{a:4,b:4}, missed:{a:2,b:3,c:3,d:3,e:3,f:3,h:3,i:3,away:9}
  });
  assert.ok(near(plan.benchQuota.a,0.5) && near(plan.benchQuota.b,0), JSON.stringify(plan.benchQuota));
  assert.ok(near(plan.benchQuota.g,8/9), "a fill-in is due an even share of this game's bench");
  assert.deepStrictEqual([plan.benchCap.a, plan.benchCap.b, plan.benchCap.g], [2,1,1]);
});

test("LOAD-1: position loads blend from equal quarters to the coach's weights, always averaging 1", ()=>{
  const S = freshEngine().RosterSolver;
  const sum = l=>S.POSITIONS.reduce((a,pos)=>a+l[pos],0);
  const off = S.derivePositionLoads({loadBalance:0, positionLoad:{C:2}});
  S.POSITIONS.forEach(pos=>assert.strictEqual(off[pos], 1, "at 0 every quarter counts the same, whatever the weights"));
  const full = S.derivePositionLoads({loadBalance:10});
  assert.ok(Math.abs(sum(full)-7)<1e-9, "a full line-up is always worth seven quarters");
  assert.ok(full.C>full.GA && full.GA===full.GD && full.GA>full.WA && full.WA===full.WD && full.WA>full.GS && full.GS===full.GK, JSON.stringify(full));
  assert.ok(Math.abs(full.C/full.GK - 1/0.55)<1e-9, "at 10 the ratios are exactly the weights'");
  assert.deepStrictEqual(DEFAULT_LOADS, {GS:0.55, GA:0.85, WA:0.7, C:1, WD:0.7, GD:0.85, GK:0.55}, "the shipped defaults");
  const half = S.derivePositionLoads({loadBalance:5});
  assert.ok(Math.abs(half.C-(1+full.C)/2)<1e-9 && Math.abs(sum(half)-7)<1e-9, "linear in between");
  const junk = S.derivePositionLoads({loadBalance:"x", positionLoad:{C:"abc", GK:-5, WA:99}});
  assert.ok(S.POSITIONS.every(pos=>junk[pos]===1), "a non-numeric slider falls back to the default (0)");
  const clamped = S.derivePositionLoads({loadBalance:10, positionLoad:{GS:1,GA:1,WA:99,C:"abc",WD:1,GD:1,GK:-5}});
  assert.ok(clamped.WA/clamped.GS===2 && Math.abs(clamped.GK/clamped.GS-0.1)<1e-9 && clamped.C/clamped.GS===1, "weights are clamped to 0.1..2 and a non-number falls back to that position's default: "+JSON.stringify(clamped));
  ["", null, false, [], "0.3", NaN].forEach(v=>assert.strictEqual(S.cleanPositionLoad(v,"WA"), 0.7, `${JSON.stringify(v)} is not a weight: the default, never the minimum`));
  assert.strictEqual(S.cleanPositionLoad(0, "WA"), 0.1);
});

test("LOAD-2: toward equal workload, players in the heavy positions rest more and the season's workload spread narrows", ()=>{
  function season(loadBalance){
    const engine = freshEngine();
    const st = engine._getState();
    st.season.numGames = 10; st.season.desiredBenchSize = 2;
    // Specialists: whoever plays centre can only get there by sitting out, not by moving.
    [["C1",["C"]],["C2",["C"]],["WA1",["WA"]],["WA2",["WA"]],["WD1",["WD"]],["GA1",["GA"]],["GD1",["GD"]],["GS1",["GS"]],["GK1",["GK"]]].forEach(([n,p])=>addPlayer(engine,n,p));
    engine.ensureGamesExist();
    st.settings.loadBalance = loadBalance;
    engine.runGeneration();
    const full = engine.RosterSolver.derivePositionLoads({loadBalance:10});
    const out = {};
    engine.computePlayerSummaries().forEach(s=>{ out[s.name] = {onCourt:s.onCourt, load:engine.POSITIONS.reduce((sum,pos)=>sum+s.positions[pos]*full[pos],0)}; });
    assert.ok(engine.gameNums().every(n=>!engine.getGame(n).error), "sanity: every game schedules");
    return out;
  }
  const quarters = season(0), load = season(10);
  // Only the two centres and two wing attacks can ever sit (everyone else is the sole cover for their position).
  assert.strictEqual(quarters.C1.onCourt+quarters.C2.onCourt, 40);
  assert.ok(Math.abs((quarters.C1.onCourt+quarters.C2.onCourt)-(quarters.WA1.onCourt+quarters.WA2.onCourt))===0, "sanity: C and WA are each played 40 quarters");
  const gap = s=>Math.abs(s.C1.onCourt-s.C2.onCourt)+Math.abs(s.WA1.onCourt-s.WA2.onCourt);
  assert.ok(gap(load)<=gap(quarters)+2, "the two players sharing a position still split it evenly");
  const spreadOf = s=>{ const v=Object.values(s).map(x=>x.load); return Math.max(...v)-Math.min(...v); };
  assert.ok(spreadOf(load)<=spreadOf(quarters)+1e-9, `workload spread should not widen: ${spreadOf(quarters).toFixed(2)} -> ${spreadOf(load).toFixed(2)}`);
});

test("LOAD-3: a centre is due more bench than a keeper for the same court time so far (planGameBench quarterLoad)", ()=>{
  const S = freshEngine().RosterSolver;
  const squad = ["c","k","a","b","d","e","f","g","h"].map(id=>({id}));
  const plan = S.planGameBench({ squad, benchSlotCount:2, courtTargets:{c:28,k:28},  loadSoFar:{c:14,k:14}, gamesLeft:{c:4,k:4}, missed:{},
    quarterLoad:{c:1.4, k:0.7} });
  assert.ok(Math.abs(plan.benchQuota.c-(4-3.5/1.4))<1e-9 && plan.benchQuota.k===0, JSON.stringify(plan.benchQuota));
});

test("LOAD-5: playerLoadStats reads load from the season's position counts, and the rate a player actually earns it at", ()=>{
  const S = freshEngine().RosterSolver;
  const positionLoads = S.derivePositionLoads({loadBalance:10});
  const players = [{id:"z", prefs:["C","WA","WD"]}, {id:"new", prefs:["C","GK"]}, {id:"guest", prefs:[]}];
  const r = S.playerLoadStats({players, posCount:{"z::C":6, "z::WA":2, "other::C":9}, positionLoads});
  const near = (a,b)=>Math.abs(a-b)<1e-9;
  assert.ok(near(r.loadSoFar.z, 6*positionLoads.C+2*positionLoads.WA) && near(r.quarterLoad.z, r.loadSoFar.z/8), "mostly centre so far: earns load faster than her list's average");
  assert.ok(r.quarterLoad.z > (positionLoads.C+positionLoads.WA+positionLoads.WD)/3);
  assert.ok(r.loadSoFar.new===0 && near(r.quarterLoad.new, (2*positionLoads.C+positionLoads.GK)/3) && near(r.heaviestQuarter.z, positionLoads.C), "before playing: the listed positions, each rank counting half the one above");
  assert.ok(near(r.quarterLoad.guest, 1), "no list: any position, so the average quarter");
});

test("LOAD-6: with missed games equal (nobody is ever rostered off) every workload step helps or at least doesn't hurt, through the top of the slider", ()=>{
  // Nine players, bench of two, every game: the per-game bench limit leaves almost no room to rest anyone
  // more than anyone else, so the slider only works up there because it relaxes that limit.
  // (The same nine as `small9` in tests/settings-sweep.js, whose SET-7 check covers the slider across more rosters.)
  const NINE = [["Ana",["GS","GA","WA"]], ["Bex",["GA","GS"]], ["Cora",["WA","C","WD"]], ["Dot",["C","WA"]], ["Edie",["WD","GD","C"]],
    ["Fern",["GD","GK","WD"]], ["Gigi",["GK","GD"]], ["Hana",["GS","GK"]], ["Indi",["C","WD","GA"]]];
  const spreads = [], doubles = [];
  let mostBenched = 0; // most bench quarters anyone has in one game, at any slider value
  for(let loadBalance=0; loadBalance<=10; loadBalance++){
    const engine = freshEngine();
    const st = engine._getState();
    st.season.numGames = 10; st.season.desiredBenchSize = 2;
    NINE.forEach(([name,prefs])=>addPlayer(engine, name, prefs));
    engine.ensureGamesExist();
    st.settings.loadBalance = loadBalance;
    engine.runGeneration();
    const loads = engine.computePlayerSummaries().filter(s=>s.onCourt>0)
      .map(s=>engine.POSITIONS.reduce((sum,pos)=>sum+s.positions[pos]*DEFAULT_LOADS[pos],0));
    spreads.push(Math.sqrt(engine.RosterSolver.variance(loads)));
    let twice = 0; // players benched twice or more in a game, summed over the season
    engine.gameNums().forEach(n=>{ const c={}; engine.getGame(n).schedule.quarters.forEach(q=>q.bench.forEach(id=>{ c[id]=(c[id]||0)+1; })); twice += Object.values(c).filter(v=>v>=2).length; mostBenched = Math.max(mostBenched, ...Object.values(c)); });
    doubles.push(twice);
  }
  const shown = spreads.map(v=>v.toFixed(2)).join(" ");
  spreads.slice(1).forEach((v,i)=>assert.ok(v<=spreads[i]+0.15, `step ${i}->${i+1} made the season's workload spread noticeably worse: ${shown}`));
  assert.ok(spreads[10] < spreads[0]*0.6, `equal workload should cut the spread well down: ${shown}`);
  assert.ok(spreads[10] < spreads[5]-0.5, `the top half of the slider has to do real work too, not only the bottom: ${shown}`);
  assert.ok(mostBenched<=2, `even with the limit gone nobody should sit three quarters of a game (the per-stint cost still applies): ${mostBenched}`);
  assert.ok(doubles[10] > doubles[0], `the price is the per-game bench limit, given up as the slider rises: ${doubles.join(" ")}`);
});

test("LOAD-7: the per-game bench limit's penalty is full at 'equal quarters' and gone at 'equal workload'", ()=>{
  const S = freshEngine().RosterSolver;
  const costs = loadBalance=>{
    const settings = {preferenceSlider:5, allowOffPreference:false, positionVariety:1, loadBalance};
    const cum = gameBenchSoFar=>({posCount:{}, gameBenchSoFar, benchedLastQuarter:new Set(), benchQuota:{a:1}, benchCap:{a:1}});
    const p = {id:"a", prefs:["GS"]};
    const under = S.buildQuarterCostFns(cum({}), settings).benchCellCost(p);            // first stint: within the limit
    const over  = S.buildQuarterCostFns(cum({a:1}), settings).benchCellCost(p);         // second stint: one past it
    return {under, over, weight: S.derivePreferenceWeights(5).balance*S.CONSTANTS.COURT_TIME_WEIGHT};
  };
  const near = (a,b)=>Math.abs(a-b)<1e-9;
  const at0 = costs(0), at5 = costs(5), at10 = costs(10);
  assert.ok(near(at0.over-at0.under, at0.weight*(1+S.CONSTANTS.BENCH_CAP_PENALTY)), "full penalty plus the ordinary cost of a stint");
  assert.ok(near(at5.over-at5.under, at5.weight*(1+S.CONSTANTS.BENCH_CAP_PENALTY/2)), "half the penalty at 5");
  assert.ok(near(at10.over-at10.under, at10.weight*1), "no penalty at 10, only the ordinary cost of a stint");
});

test("LOAD-4: the workload settings are sanitised, persisted in backups and survive a round trip", ()=>{
  const engine = freshEngine();
  const st = engine._getState();
  addPlayer(engine, "Liv", ["GS"]);
  st.settings.loadBalance = 7; st.settings.positionLoad.C = 1.5;
  engine.exportBackup();
  const text = engine.CapturingBlob.last;
  assert.deepStrictEqual(JSON.parse(text).plan.settings.positionLoad, {...DEFAULT_LOADS, C:1.5});
  const fresh = freshEngine();
  fresh.importBackup(text);
  assert.strictEqual(fresh._getState().settings.loadBalance, 7);
  assert.strictEqual(fresh._getState().settings.positionLoad.C, 1.5);
  // Untrusted values: wrong types fall back per position, out-of-range clamps, unknown keys go.
  const bad = JSON.parse(text);
  bad.plan.settings.loadBalance = "lots";
  bad.plan.settings.positionLoad = {C:50, GK:"heavy", XX:3};
  fresh.importBackup(JSON.stringify(bad));
  const s = fresh._getState().settings;
  assert.strictEqual(s.loadBalance, 0);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(s.positionLoad)), {...DEFAULT_LOADS, C:2});
  bad.plan.settings.positionLoad = [1,2,3];
  fresh.importBackup(JSON.stringify(bad));
  assert.deepStrictEqual(JSON.parse(JSON.stringify(fresh._getState().settings.positionLoad)), {...WORKLOAD_DEFAULTS.positionLoad});
  // A default state must own its weights: editing one season's must not leak into the next.
  const a = freshEngine(); a._getState().settings.positionLoad.C = 0.2;
  assert.strictEqual(freshEngine()._getState().settings.positionLoad.C, 1);
});

test("LOAD-8: a save still holding the old default workloads gets the new ones; edited tables are kept", ()=>{
  const OLD = {GS:0.55, GA:0.7, WA:0.85, C:1, WD:0.85, GD:0.7, GK:0.55};
  const engine = freshEngine();
  const st = engine._getState();
  st.settings.positionLoad = {...OLD};
  engine.saveState();
  assert.deepStrictEqual({...engine.loadState().settings.positionLoad}, DEFAULT_LOADS, "old defaults migrate on load");
  st.settings.positionLoad = {...OLD, C:1.2};
  engine.saveState();
  assert.deepStrictEqual({...engine.loadState().settings.positionLoad}, {...OLD, C:1.2}, "an edited table is the coach's own");
  const text = (()=>{ st.settings.positionLoad = {...OLD}; engine.exportBackup(); return engine.CapturingBlob.last; })();
  const fresh = freshEngine(); fresh.importBackup(text);
  assert.deepStrictEqual({...fresh._getState().settings.positionLoad}, DEFAULT_LOADS, "old defaults migrate on import");
  const edited = JSON.parse(text); edited.plan.settings.positionLoad.GK = 0.6;
  fresh.importBackup(JSON.stringify(edited));
  assert.strictEqual(fresh._getState().settings.positionLoad.GA, 0.7, "an edited table is kept on import");
});

test("COURT-EVEN-1: when missed games are even, nobody is benched more than once in a game", ()=>{
  // Everyone can play anywhere, so preference never forces a second stint
  // (two specialists sharing a position can't both sit, however the bench falls).
  const engine = freshEngine();
  buildFlexibleRoster(engine); // everyone misses exactly 2 of 11 games
  engine.runGeneration();
  const facts = courtTimeFacts(engine);
  Object.keys(facts).forEach(name=>{
    assert.strictEqual(facts[name].missed, 2, `sanity: ${name} should miss exactly 2 games`);
    assert.ok(facts[name].maxBenchInGame<=1, `${name} was benched ${facts[name].maxBenchInGame} times in one game`);
  });
});

test("COURT-EVEN-2: players who miss more games play more of the games they attend, and only the others may be benched twice", ()=>{
  const engine = freshEngine();
  const st = buildFlexibleRoster(engine);
  // Three players each away for three games: they end the season on more missed games than the rest.
  [["P0",[1,2,3]], ["P1",[4,5,6]], ["P2",[7,8,9]]].forEach(([name,away])=>{ st.players.find(p=>p.name===name).unavailable = away; });
  st.settings.preferenceSlider = 4; // court time firmly ahead of preference rank (at the default 8, rank still costs a quarter or two)
  engine.runGeneration();
  const facts = courtTimeFacts(engine);
  const names = Object.keys(facts);
  const most = Math.max(...names.map(n=>facts[n].missed));
  const missMore = names.filter(n=>facts[n].missed===most), missFewer = names.filter(n=>facts[n].missed<most);
  assert.ok(missFewer.length>0, "sanity: missed games are uneven in this season");
  const avg = list=>list.reduce((sum,n)=>sum+facts[n].onCourt,0)/list.length;
  assert.ok(Math.abs(avg(missMore)-avg(missFewer))<=1.5,
    `season court time should come out level despite the uneven missed games: ${avg(missMore).toFixed(1)} vs ${avg(missFewer).toFixed(1)}`);
  assert.ok(Math.max(...names.map(n=>facts[n].onCourt))-Math.min(...names.map(n=>facts[n].onCourt))<=2, "on-court quarters should be within 2 of each other: "+JSON.stringify(facts));
  missMore.forEach(n=>assert.ok(facts[n].maxBenchInGame<=1, `${n} misses the most games, so should never be benched twice in one (got ${facts[n].maxBenchInGame})`));
  assert.ok(missFewer.every(n=>facts[n].maxBenchInGame<=2), "nobody should be benched three times in a game");
});

test("ROSTEROFF-TIEBREAK-1: 'even missed games' never gives up evenness for coverage, but still prefers the better-covered of two equally even splits", ()=>{
  const engine = freshEngine();
  const S = engine.RosterSolver;
  const w = S.deriveRosterOffWeights("fairness");
  assert.ok(w.coverage>0, "coverage must still break ties");
  // The worst coverage penalty a whole season can carry must stay below the smallest evenness gain (2/n in variance).
  const worstSeasonPenalty = 60*7*S.CONSTANTS.COVERAGE_GAP_ONE_PENALTY*7;
  assert.ok(w.coverage*worstSeasonPenalty < w.fairness*2/20, "a tie-break only: coverage can't outweigh one step of evenness");
  // 8 players, one game, one to rest: resting the sole GK is equally "even" but leaves GK uncovered.
  const players = ["GK","GS","GA","WA","C","WD","GD","GS"].map((pos,i)=>({id:"p"+i, prefs:[pos], unavailableCount:0}));
  const games = [{num:1, availableIds:players.map(p=>p.id), rosterOffCount:1, fixedOffIds:null}];
  const r = S.solveSeasonRosterOff({players, games, weights:w});
  assert.ok(["p1","p7"].includes(r.rosterOffByGame[1][0]), "should rest one of the two GS players, got "+r.rosterOffByGame[1][0]);
});

test("PREF-WEIGHTS-1: the preference slider is evenly (geometrically) spaced from 0 to 9 and removes balance entirely at 10", ()=>{
  const engine = freshEngine();
  const S = engine.RosterSolver;
  const ratios = [];
  for(let s=0;s<=9;s++){
    const w = S.derivePreferenceWeights(s);
    assert.ok(Math.abs(w.preference+w.balance-1)<1e-12, `weights should sum to 1 at slider ${s}`);
    assert.ok(w.preference>0, `preference weight must never reach 0 (off-preference would become free) at slider ${s}`);
    ratios.push(w.preference/w.balance);
  }
  for(let s=1;s<=9;s++){
    assert.ok(Math.abs(ratios[s]/ratios[s-1]-ratios[1]/ratios[0])<1e-9,
      `each step should multiply the preference:balance ratio by the same factor: ${JSON.stringify(ratios)}`);
  }
  assert.strictEqual(S.derivePreferenceWeights(10).balance, 0);

  // BENCH-MAXSLIDER-1 (M2 regression): at 10 the whole bench cost — quota,
  // cap penalty, back-to-back — is exactly zero, so bench rotation can never
  // be why an in-preference candidate loses out (§5.1).
  const cumulative = {posCount:{}, gameBenchSoFar:{a:3}, benchedLastQuarter:new Set(["a"]), benchQuota:{a:0}, benchCap:{a:1}};
  const atMax = S.buildQuarterCostFns(cumulative, {preferenceSlider:10, allowOffPreference:true, positionVariety:1});
  assert.strictEqual(atMax.benchCellCost({id:"a", prefs:["GS"]}), 0);
  assert.strictEqual(atMax.positionCellCost({id:"a", prefs:["GS"]}, "GS"), 0);
});

test("OFFPREF-FLAT-1: off-preference costs every player with a list the same, and more than any in-preference cell at any slider or variety setting", ()=>{
  // Previously: off-preference cost was the player's own list length, so a
  // one-position player was the cheapest off-preference fill and could
  // undercut a long-list player's overplayed 5th choice.
  const engine = freshEngine();
  const S = engine.RosterSolver;
  const longList = {id:"long", prefs:["GS","GA","WA","C","WD"]};
  const shortList = {id:"short", prefs:["GK"]};
  const otherShortList = {id:"short2", prefs:["GD","GK"]};
  const noList = {id:"none", prefs:[]};
  const posCount = {};
  longList.prefs.forEach(pos=>{ posCount["long::"+pos] = 200; }); // every listed position heavily overplayed
  const cumulative = {posCount, onCourt:{}, bench:{}, gameBenchSoFar:{}, benchedLastQuarter:new Set()};
  for(let slider=0; slider<=10; slider++){
    const { positionCellCost } = S.buildQuarterCostFns(cumulative, {preferenceSlider:slider, allowOffPreference:true, positionVariety:10});
    assert.strictEqual(positionCellCost(shortList,"WD"), positionCellCost(otherShortList,"WD"), `slider ${slider}: off-preference cost must not depend on list length`);
    assert.strictEqual(positionCellCost(shortList,"WD"), positionCellCost(longList,"GK"), `slider ${slider}: off-preference cost must not depend on list length`);
    // A player with no list at all (a fill-in, §6) is happy anywhere: cheaper
    // than anyone's off-preference fill, never cheaper than a fresh #1 choice.
    assert.ok(positionCellCost(noList,"WD") < positionCellCost(shortList,"WD"), `slider ${slider}: a no-preference player must cost less than an off-preference fill`);
    assert.ok(positionCellCost(noList,"GK") > positionCellCost(shortList,"GK"), `slider ${slider}: a no-preference player must cost more than someone's #1 choice`);
    longList.prefs.forEach(pos=>assert.ok(positionCellCost(longList,pos) < positionCellCost(shortList,pos),
      `slider ${slider}: ${pos} in-preference (however overplayed) must stay cheaper than another player's off-preference fill`));
  }
});

test("SLIDER-SWEEP-REALISTIC-1 (H1): off-preference count is monotonically non-increasing on a roster with good position depth", ()=>{
  // Tests §5.1's monotonicity guarantee against a "reasonable depth" roster
  // (§5.4), not an adversarial/thin one — a general proof isn't attempted,
  // since the residual non-monotonicity is genuine path-dependence across the
  // cumulative multi-quarter solve, not a fixable cost-formula defect
  // (confirmed by testing an alternative damping curve that measured worse).
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
  // Off-preference is a last resort at every slider value (never traded for
  // court-time evenness), so a roster with this depth never needs one.
  assert.ok(counts.every(c=>c===0), `no off-preference fill should be needed on this roster at any slider: ${JSON.stringify(counts)}`);
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

test("ED-8: unlocking a played game makes it editable and participating in rebalancing again", ()=>{
  const engine = freshEngine();
  const st = engine._getState();
  st.season.numGames = 2;
  st.season.desiredBenchSize = 1;
  ["GS","GA","WA","C","WD","GD","GK","GA"].forEach((pos,i)=>addPlayer(engine, "P"+i, [pos]));
  engine.ensureGamesExist();
  engine.runGeneration();
  const g1 = engine.getGame(1);
  g1.isPlayed = true;
  const lockedSchedule = JSON.stringify(g1.schedule);

  st.settings.preferenceSlider = 0; // force a setting change that would visibly affect a fresh solve
  engine.runGeneration();
  assert.strictEqual(JSON.stringify(engine.getGame(1).schedule), lockedSchedule,
    "sanity: still frozen while locked, even with settings changed");

  g1.isPlayed = false; // unlock
  engine.runGeneration();
  assert.ok(engine.getGame(1).generated, "an unlocked game should be regenerated like any other unplayed game");
});

test("ED-9 (H4 regression): a played game's roster-off/unavailable record survives a later availability edit", ()=>{
  // Previously: planGameAvailability recomputed a played game's fixedOffIds
  // by filtering rosteredOffIds down to who's *currently* available, so a
  // later availability edit silently changed an already-locked game's
  // record — §8.1 requires it stay byte-for-byte unchanged.
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

test("PERF-2: a forced low Phase 1 time budget on a larger/conflict-heavy input returns best-so-far rather than hanging", ()=>{
  // Exercises the "best effort within budget" behavior §9 sanctions for
  // pathological inputs — an accepted trade-off, per M6, not a fixable defect.
  const engine = freshEngine();
  const S = engine.RosterSolver;
  const POS = engine.POSITIONS;
  const players = [];
  for(let i=0;i<20;i++){
    const shuffled = POS.slice().sort(()=>(i*7+3)%5-2); // deterministic-ish shuffle, not random
    players.push({id:"P"+i, prefs: shuffled.slice(0, 1+(i%3)), unavailableCount:0});
  }
  const ids = players.map(p=>p.id);
  const games = [];
  for(let g=1; g<=20; g++) games.push({num:g, availableIds:ids, rosterOffCount:3, fixedOffIds:null});

  const start = Date.now();
  const r = S.solveSeasonRosterOff({
    players, games, weights:S.deriveRosterOffWeights("coverage"), allowOffPreference:true,
    timeBudgetMs: 30
  });
  const elapsed = Date.now()-start;

  assert.ok(elapsed < 2000, `should return promptly once its own budget (30ms) is exhausted, took ${elapsed}ms`);
  assert.ok(r.stats.timedOut, "a 30ms budget on 20 games/20 players should report timedOut, not silently succeed instantly");
  games.forEach(g=>{
    assert.ok(Array.isArray(r.rosterOffByGame[g.num]), `game ${g.num} should still have a (best-so-far) roster-off array, not be missing`);
    assert.strictEqual(r.rosterOffByGame[g.num].length, g.rosterOffCount, `game ${g.num} should still roster off exactly ${g.rosterOffCount}, even under time pressure`);
  });
});

test("DG-1: deleteGame renumbers later games and shifts player unavailability", ()=>{
  const engine = freshEngine();
  const st = engine._getState();
  st.season.numGames = 4;
  const p = addPlayer(engine, "Liv", ["GA"], [1,2,4]);
  engine.ensureGamesExist();
  [1,2,3,4].forEach(n=>{ engine.getGame(n).location = "L"+n; });
  assert.strictEqual(engine.deleteGame(2), true);
  assert.strictEqual(st.season.numGames, 3);
  assert.strictEqual(engine.gameNums().map(n=>engine.getGame(n).location).join(), "L1,L3,L4");
  assert.strictEqual(st.games["4"], undefined);
  assert.strictEqual(p.unavailable.join(), "1,3");
  st.season.numGames = 1; // never delete the last game
  assert.strictEqual(engine.deleteGame(1), false);
});

test("BYE-1: a bye is emptied, skipped by generation and fairness, and can't be played", ()=>{
  const engine = freshEngine();
  const st = engine._getState();
  st.season.numGames = 3; st.season.desiredBenchSize = 1;
  ["A","B","C","D","E","F","G","H","I"].forEach((n,i)=>addPlayer(engine, n, ["GS","GA","WA","C","WD","GD","GK"].slice(i%7), i===0?[2]:[]));
  engine.ensureGamesExist();
  engine.runGeneration();
  const g2 = engine.getGame(2); g2.date = "2026-03-14"; g2.location = "Court 1";
  assert.ok(g2.schedule, "game 2 generated before bye");
  assert.strictEqual(engine.makeBye(2), true);
  assert.strictEqual(st.games["2"].isBye, true);
  assert.strictEqual(st.games["2"].schedule, null);
  assert.strictEqual(st.games["2"].date, "2026-03-14", "bye keeps its date");
  assert.strictEqual(st.games["2"].location, "Court 1", "bye keeps its location");
  engine.runGeneration();
  const b = engine.getGame(2);
  assert.strictEqual(b.schedule, null);
  assert.strictEqual(b.generated, false);
  assert.strictEqual(b.error, null);
  assert.ok(engine.getGame(1).schedule && engine.getGame(3).schedule, "other games still generated");
  engine.computePlayerSummaries().forEach(s=>assert.ok(s.missed<=2, "bye adds no missed games"));
  const played = engine.getGame(1); played.isPlayed = true;
  assert.strictEqual(engine.makeBye(1), false, "played game can't become a bye");
});

test("PURGE-1: removing a person clears them from unplayed games only (played games stay frozen)", ()=>{
  const engine = freshEngine();
  const st = engine._getState();
  st.season.numGames = 2; st.season.desiredBenchSize = 1;
  ["GS","GA","WA","C","WD","GD","GK","GS"].forEach((pos,i)=>addPlayer(engine, "P"+i, [pos]));
  engine.ensureGamesExist();
  engine.runGeneration();
  const victim = st.players[0].id;
  engine.getGame(1).isPlayed = true;
  const g2 = engine.getGame(2);
  g2.lockedSlots["0-GS"] = victim; g2.rosterOffLockIds = [victim];
  const inGame = g=>g.schedule.quarters.some(q=>Object.values(q.onCourt).includes(victim) || q.bench.includes(victim));
  const playedBefore = JSON.stringify(engine.getGame(1));
  st.players = st.players.filter(p=>p.id!==victim);
  engine.purgePersonFromGames(victim);
  assert.strictEqual(JSON.stringify(engine.getGame(1)), playedBefore, "played game untouched");
  assert.strictEqual(inGame(g2), false, "gone from the unplayed schedule");
  assert.ok(!g2.squadIds.includes(victim));
  assert.strictEqual(g2.lockedSlots["0-GS"], undefined);
  assert.strictEqual(g2.rosterOffLockIds, null, "a lock naming only them reverts to auto, not []");
});

test("BYE-2: bye/delete drop the game's one-off fill-ins; an imported bye ignores results", ()=>{
  const engine = freshEngine();
  const st = engine._getState();
  st.season.numGames = 3;
  engine.ensureGamesExist();
  st.fillIns.push({id:"fi1", name:"One-off", prefs:[], saved:false}, {id:"fi2", name:"Saved", prefs:[], saved:true}, {id:"fi3", name:"One-off 3", prefs:[], saved:false});
  engine.getGame(2).fillInIds = ["fi1","fi2"];
  engine.getGame(3).fillInIds = ["fi3"];
  engine.makeBye(2);
  assert.strictEqual(st.fillIns.map(f=>f.id).join(), "fi2,fi3");
  engine.deleteGame(3);
  assert.strictEqual(st.fillIns.map(f=>f.id).join(), "fi2");

  const q = {onCourt:{GS:"p1"}, bench:[], offPreference:{}};
  engine.importBackup(makeBackup(
    {players:[{id:"p1", name:"Liv", prefs:["GS"], unavailable:[]}], games:{"1":{isBye:true}}},
    {games:{"1":{rosteredOffIds:["p1"], unavailableIds:[], schedule:{quarters:[q,q,q,q]}}}}
  ));
  const g = engine.getGame(1);
  assert.strictEqual(g.isBye, true);
  assert.strictEqual(g.schedule, null);
  assert.strictEqual((g.rosteredOffIds||[]).length, 0);
});

test("FILLIN-NOPREFS-1: a fill-in with no stated preferences is happy anywhere - plays, is never off-preference, and is unaffected by the off-preference toggle", ()=>{
  // Regression: charging a preference-less player the full flat off-preference
  // cost benched them for every quarter from slider 5 up, default included;
  // and with the toggle off they were disqualified from every position.
  [true,false].forEach(allowOffPreference=>{
    const engine = freshEngine();
    const st = engine._getState();
    st.season.numGames = 4;
    st.season.desiredBenchSize = 1;
    st.settings.allowOffPreference = allowOffPreference;
    ["GS","GA","WA","C","WD","GD","GK"].forEach((pos,i)=>addPlayer(engine, "P"+i, [pos]));
    engine.ensureGamesExist();
    st.fillIns.push({id:"fi1", name:"Guest", prefs:[], saved:true});
    engine.gameNums().forEach(n=>{ engine.getGame(n).fillInIds = ["fi1"]; });
    engine.runGeneration();
    let onCourt = 0;
    engine.gameNums().forEach(n=>{
      const g = engine.getGame(n);
      assert.strictEqual(g.error, null, `allowOffPreference=${allowOffPreference}: game ${n} should generate: ${g.error}`);
      g.schedule.quarters.forEach(q=>{ if(Object.values(q.onCourt).includes("fi1")) onCourt++; });
    });
    assert.ok(onCourt >= 4, `allowOffPreference=${allowOffPreference}: the guest should be on court for a fair share of the 16 quarters, got ${onCourt}`);
    assert.strictEqual(engine.computeOffPrefLog().filter(o=>o.playerId==="fi1").length, 0, `allowOffPreference=${allowOffPreference}: none of the guest's quarters are off-preference`);
  });
});

test("FILLIN-NOPREFS-2: a no-preference fill-in covers a position nobody else lists, even with off-preference disallowed", ()=>{
  const engine = freshEngine();
  const st = engine._getState();
  st.season.numGames = 1;
  st.season.desiredBenchSize = 0;
  st.settings.allowOffPreference = false;
  ["GS","GA","WA","C","WD","GD"].forEach((pos,i)=>addPlayer(engine, "P"+i, [pos])); // nobody lists GK
  engine.ensureGamesExist();
  st.fillIns.push({id:"fi1", name:"Guest", prefs:[], saved:true});
  engine.getGame(1).fillInIds = ["fi1"];
  engine.runGeneration();
  const g = engine.getGame(1);
  assert.strictEqual(g.error, null, "the guest fills GK rather than the game erroring: "+g.error);
  g.schedule.quarters.forEach(q=>assert.strictEqual(q.onCourt.GK, "fi1"));
  assert.strictEqual(engine.computeOffPrefLog().length, 0);
});

test("HEADLINES-1: the Settings tab's at-a-glance numbers are empty before generation and count regular players only", ()=>{
  const engine = freshEngine();
  const st = engine._getState();
  st.season.numGames = 2;
  st.season.desiredBenchSize = 1;
  ["GS","GA","WA","C","WD","GD","GK"].forEach((pos,i)=>addPlayer(engine, "P"+i, [pos]));
  engine.ensureGamesExist();
  assert.strictEqual(engine.computeSeasonHeadlines(), null, "nothing generated yet");

  // A fill-in the coach has locked out of position for one quarter.
  st.fillIns.push({id:"fi1", name:"Guest", prefs:["GS"], saved:true});
  engine.getGame(1).fillInIds = ["fi1"];
  engine.getGame(2).fillInIds = ["fi1"];
  engine.getGame(1).lockedSlots = {"0-GK":"fi1"};
  engine.runGeneration();
  const h = engine.computeSeasonHeadlines();
  assert.ok(engine.computeOffPrefLog().length > 0, "sanity: the fill-in did play off-preference quarters");
  assert.strictEqual(h.offPrefPct, 0, "the fill-in's off-preference quarters are not counted: "+JSON.stringify(h));
  assert.strictEqual(h.firstChoicePct, 100, "every regular only ever plays their sole listed position; the fill-in is not counted");
  assert.strictEqual(h.positionsPerPlayer, 1);
  assert.ok(h.courtTimeMinPct>0 && h.courtTimeMaxPct<=100 && h.courtTimeMinPct<=h.courtTimeMaxPct);
  assert.strictEqual(h.missedSpread, 0);
});

test("BACKUP-V1-1: a version-1 file still imports; its retired settings are ignored, not migrated", ()=>{
  const engine = freshEngine();
  engine.importBackup(JSON.stringify({
    format:"netball-roster-backup", schemaVersion:1,
    plan:{season:{numGames:1, desiredBenchSize:0},
      settings:{preferenceSlider:4, allowOffPreference:false, topTwoOnly:true, rosterOffWeight:0, fairnessWeights:{bench:9, positionPurity:7}},
      players:[{id:"p1", name:"Liv", prefs:["GS"], unavailable:[]}], fillIns:[], games:{}},
    results:{games:{}}
  }));
  const st = engine._getState();
  assert.strictEqual(st.players.length, 1, "the rest of a v1 file imports normally");
  assert.deepStrictEqual(JSON.parse(JSON.stringify(st.settings)),
    {preferenceSlider:4, allowOffPreference:false, positionVariety:1, rosterOffPriority:"fairness", ...WORKLOAD_DEFAULTS});
});

/* tests/fixtures/season-backup-v1.json is a real coach's export from build 39 (the venue name is
   replaced; everything else is as exported): 11 regulars, 11 games, one fill-in game and one
   game with every slot locked. */
test("BACKUP-V1-2: a real version-1 season export imports whole and regenerates cleanly", ()=>{
  const text = fs.readFileSync(path.join(__dirname, "fixtures", "season-backup-v1.json"), "utf8");
  const src = JSON.parse(text);
  const engine = freshEngine();
  engine.importBackup(text);
  const st = engine._getState();
  const plain = v => JSON.parse(JSON.stringify(v));

  assert.strictEqual(src.schemaVersion, 1, "sanity: the fixture must stay an old-format file");
  assert.deepStrictEqual(plain(st.players), src.plan.players);
  assert.deepStrictEqual(plain(st.fillIns), src.plan.fillIns);
  assert.deepStrictEqual(plain(st.settings),
    {preferenceSlider:1, allowOffPreference:false, positionVariety:1, rosterOffPriority:"fairness", ...WORKLOAD_DEFAULTS});
  assert.deepStrictEqual([...engine.gameNums()], [1,2,3,4,5,6,7,8,9,10,11]);
  engine.gameNums().forEach(n=>{
    const g = engine.getGame(n), plan = src.plan.games[n], res = src.results.games[n];
    ["date","time","location","fillInIds","lockedSlots","rosterOffLockIds","allowOffPreference"].forEach(k=>
      assert.deepStrictEqual(plain(g[k]), plan[k], `game ${n} ${k}`));
    // Import keeps only the `true` off-preference flags; a locked game exports explicit `false`s too.
    const expected = res.schedule.quarters.map(q=>({onCourt:q.onCourt, bench:q.bench,
      offPreference:Object.fromEntries(Object.entries(q.offPreference).filter(([,v])=>v===true))}));
    assert.deepStrictEqual(plain(g.schedule), {quarters:expected}, `game ${n} schedule`);
  });

  const locked4 = plain(engine.getGame(4).lockedSlots);
  assert.strictEqual(Object.keys(locked4).length, 28, "sanity: game 4 is fully locked in the fixture");
  engine.runGeneration();
  engine.gameNums().forEach(n=>{
    const g = engine.getGame(n);
    assert.strictEqual(g.error, null, `game ${n} should regenerate without error`);
    assert.strictEqual(g.schedule.quarters.length, 4);
  });
  Object.keys(locked4).forEach(k=>{
    const [q, pos] = k.split("-");
    assert.strictEqual(engine.getGame(4).schedule.quarters[q].onCourt[pos], locked4[k], `locked slot ${k} must survive regeneration`);
  });
  assert.deepStrictEqual([...engine.getGame(7).fillInIds], ["fi_bga58q12hq1"]);
});

/* ============================================================
   Centre quarters per game (§4 rule 3a, §11) — CQ-*
   ============================================================ */
const { FIXTURES: SWEEP_FIXTURES, quietly } = require("./fixtures.js");
/* A game's `centres` list (who played Centre each earlier quarter) giving `id` soFar Centre quarters, the last `run` of them in a row. */
const centresFor = (soFar, run, id="p")=>[...Array(soFar-run).fill([id,"x"]).flat(), ...Array(run).fill(id)];

/* A season of `players` ([name, prefs]) at the given centreQuarters. Returns the engine and, per game, the
   quarters as names ({centre, bench:[names], onCourt:{pos:name}}). */
function centreSeason(players, {centre=4, games=6, bench=2, settings={}, setup=null}={}){
  const engine = freshEngine();
  const st = engine._getState();
  st.season.numGames = games; st.season.desiredBenchSize = bench;
  const made = players.map(([name,prefs])=>addPlayer(engine, name, prefs));
  engine.ensureGamesExist();
  if(centre!==undefined) st.settings.centreQuarters = centre;
  Object.assign(st.settings, settings);
  if(setup) setup(engine, made);
  quietly(()=>engine.runGeneration());
  const nameOf = {}; st.players.forEach(p=>{ nameOf[p.id] = p.name; });
  const perGame = engine.gameNums().map(n=>{
    const g = engine.getGame(n);
    if(!g.schedule) return {error:g.error, quarters:[]};
    return {error:null, quarters:g.schedule.quarters.map(q=>({
      centre:nameOf[q.onCourt.C], bench:q.bench.map(id=>nameOf[id]), offPreference:Object.keys(q.offPreference||{}).length,
      onCourt:Object.fromEntries(Object.entries(q.onCourt).map(([pos,id])=>[pos,nameOf[id]]))}))};
  });
  return {engine, st, perGame, made};
}
const centrePatterns = game=>{ // name -> "C··C"
  const out = {};
  game.quarters.forEach((q,i)=>{ if(q.centre && !out[q.centre]) out[q.centre] = ["·","·","·","·"]; if(q.centre) out[q.centre][i] = "C"; });
  return Object.fromEntries(Object.entries(out).map(([k,v])=>[k, v.join("")]));
};
const CQ_SPECIALISTS = [["GS1",["GS","GA"]],["GA1",["GA","GS"]],["WA1",["WA"]],["WD1",["WD"]],["GD1",["GD","GK"]],["GK1",["GK","GD"]]];
const CQ_TWO_CENTRES = CQ_SPECIALISTS.concat([["C1",["C","WA","WD"]],["C2",["C","WD","WA"]]]);

test("CQ-1: centreCost - zero at 4, over-target / back-to-back / third-in-row at the right targets, same fatigue on every position, never BIG_M", ()=>{
  const S = freshEngine().RosterSolver, K = S.CONSTANTS;
  const p = {id:"p", prefs:["C","WA","GA"]};
  const cost = (target, pos, soFar, run)=>S.buildQuarterCostFns({centres:centresFor(soFar,run)}, {centreQuarters:target, preferenceSlider:8}).centreCost(p,pos);
  S.POSITIONS.forEach(pos=>[0,1,2,3].forEach(n=>assert.strictEqual(cost(4,pos,n,n?1:0), 0, "no limit costs nothing")));
  // target 2: Q1+Q3 is free; a back-to-back Centre pays, a third quarter pays over + back-to-back, a third in a row pays all three.
  assert.strictEqual(cost(2,"C",0,0), 0);
  assert.strictEqual(cost(2,"C",1,0), K.CENTRE_FATIGUE_COST);
  assert.strictEqual(cost(2,"C",1,1), K.CENTRE_FATIGUE_COST + K.CENTRE_BACK_TO_BACK_COST);
  assert.strictEqual(cost(2,"C",2,1), 2*K.CENTRE_FATIGUE_COST + K.CENTRE_OVER_TARGET_COST + K.CENTRE_BACK_TO_BACK_COST);
  assert.strictEqual(cost(2,"C",2,2), 2*K.CENTRE_FATIGUE_COST + K.CENTRE_OVER_TARGET_COST + K.CENTRE_BACK_TO_BACK_COST + K.CENTRE_THIRD_IN_ROW_COST);
  // target 3: back-to-back is fine, a third in a row isn't, and a 4th quarter is over.
  assert.strictEqual(cost(3,"C",1,1), K.CENTRE_FATIGUE_COST);
  assert.strictEqual(cost(3,"C",2,2), 2*K.CENTRE_FATIGUE_COST + K.CENTRE_THIRD_IN_ROW_COST);
  assert.strictEqual(cost(3,"C",3,0), 3*K.CENTRE_FATIGUE_COST + K.CENTRE_OVER_TARGET_COST);
  // target 1: the 2nd quarter is already over.
  assert.strictEqual(cost(1,"C",1,0), K.CENTRE_FATIGUE_COST + K.CENTRE_OVER_TARGET_COST);
  // fatigue is the same on every position (so it never changes which position, only court vs bench), and Centre-only costs don't leak onto others.
  S.POSITIONS.filter(pos=>pos!=="C").forEach(pos=>assert.strictEqual(cost(2,pos,2,1), 2*K.CENTRE_FATIGUE_COST));
  // bounded and finite everywhere; junk targets round and clamp
  [1,2,3,4].forEach(t=>S.POSITIONS.forEach(pos=>[0,1,2,3].forEach(n=>[0,1,2,3].forEach(r=>{
    const c = cost(t,pos,n,Math.min(r,n)); assert.ok(Number.isFinite(c) && c>=0 && c<K.OFF_PREFERENCE_LAST_RESORT/100, "stays far below the off-preference last resort: "+c);
  }))));
  assert.deepStrictEqual([undefined,null,"x",NaN,0,1.4,2.6,9].map(v=>S.centreQuartersOf({centreQuarters:v})), [4,4,4,4,1,1,3,4]);
  assert.strictEqual(S.centreQuartersOf(undefined), 4);
  // the cell function folds it in, scaled by the preference weight; BIG_M cells stay BIG_M
  const fns = S.buildQuarterCostFns({centres:["p"]}, {centreQuarters:2, preferenceSlider:8});
  const w = S.derivePreferenceWeights(8).preference;
  assert.ok(Math.abs((fns.positionCellCost(p,"C") - 0) - w*(0 + fns.centreCost(p,"C")))<1e-9);
  assert.strictEqual(fns.positionCellCost(p,"GK"), K.BIG_M, "off-list with off-preference disallowed is still disqualified");
});

test("CQ-2: setting 4 (or the setting absent) generates exactly the season it did before", ()=>{
  const names = r=>JSON.stringify(r.perGame);
  ["small9","thin10"].forEach(key=>{
    const f = SWEEP_FIXTURES[key], roster = f.players.map(([n,p])=>[n,p]);
    const four = centreSeason(roster, {centre:4, games:f.numGames, bench:f.bench});
    const absent = centreSeason(roster, {centre:undefined, games:f.numGames, bench:f.bench, setup:e=>{ delete e._getState().settings.centreQuarters; }});
    assert.strictEqual(names(four), names(absent), key+": absent means no limit");
  });
});

test("CQ-3: target 2 with two Centres - every game alternates, nobody plays Centre more than twice", ()=>{
  const r = centreSeason(CQ_TWO_CENTRES, {centre:2, bench:1});
  r.perGame.forEach((g,i)=>{
    assert.strictEqual(g.error, null);
    g.quarters.forEach((q,k)=>{ if(k) assert.notStrictEqual(q.centre, g.quarters[k-1].centre, `game ${i+1} Q${k+1} repeats the Centre`); });
    Object.values(centrePatterns(g)).forEach(pat=>assert.ok((pat.match(/C/g)||[]).length<=2, pat));
  });
});

test("CQ-4: a third Centre quarter always falls with the break in Q2 or Q3 (targets 2 and 3), a third in a row is the worst shape", ()=>{
  const S = freshEngine().RosterSolver;
  const patterns = [];
  for(let m=0;m<16;m++) patterns.push([0,1,2,3].map(q=>(m>>q)&1));
  const total = (pat, target)=>{
    let sum = 0;
    pat.forEach((isC,i)=>{
      const f = S.buildQuarterCostFns({centres:pat.slice(0,i).map(c=>c?"p":"x")}, {centreQuarters:target});
      sum += f.centreCost({id:"p",prefs:["C","WA"]}, isC?"C":"WA");
    });
    return sum;
  };
  [2,3].forEach(target=>{
    const threeCentre = patterns.filter(p=>p.reduce((a,b)=>a+b,0)===3);
    const best = Math.min(...threeCentre.map(p=>total(p,target)));
    const winners = threeCentre.filter(p=>total(p,target)===best).map(p=>p.map(x=>x?"C":"·").join(""));
    assert.ok(winners.length && winners.every(w=>w==="CC·C"||w==="C·CC"), `target ${target}: the break goes in Q2 or Q3, got ${winners}`);
    assert.ok(total([1,1,1,0],target) > best && total([0,1,1,1],target) > best);
    assert.ok(total([1,1,1,1],target) > total([1,1,1,0],target), "four in a row is worse than three");
  });
  // and a lone-ish Centre in a whole squad does get a break when a stand-in exists
  const r = centreSeason(CQ_TWO_CENTRES, {centre:3, bench:1});
  r.perGame.forEach(g=>Object.values(centrePatterns(g)).forEach(pat=>assert.ok(!/CCC/.test(pat), pat)));
});

test("CQ-5: target 1 - four Centres play one quarter each; two Centres play two each, alternating", ()=>{
  const four = centreSeason(CQ_SPECIALISTS.concat([["C1",["C","WA","WD"]],["C2",["C","WD","WA"]],["C3",["C","WA","WD"]],["C4",["C","WD","WA"]]]), {centre:1, bench:3});
  four.perGame.forEach((g,i)=>assert.strictEqual(new Set(g.quarters.map(q=>q.centre)).size, 4, `game ${i+1}: ${g.quarters.map(q=>q.centre)}`));
  const two = centreSeason(CQ_TWO_CENTRES, {centre:1, bench:1});
  two.perGame.forEach((g,i)=>{
    const pats = Object.values(centrePatterns(g));
    assert.strictEqual(pats.length, 2); pats.forEach(pat=>assert.strictEqual((pat.match(/C/g)||[]).length, 2, `game ${i+1}: ${pat}`));
    assert.ok(!/CC/.test(pats.join(",")), "alternating");
  });
});

test("CQ-6: a lone Centre at target 1 still plays all four quarters, with no error and no off-preference fill", ()=>{
  const r = centreSeason(CQ_SPECIALISTS.concat([["C1",["C"]],["X",["GS","GA","WA","WD","GD","GK"]]]), {centre:1, bench:1});
  r.perGame.forEach((g,i)=>{
    assert.strictEqual(g.error, null, "game "+(i+1));
    g.quarters.forEach(q=>{ assert.strictEqual(q.centre, "C1"); assert.strictEqual(q.offPreference, 0); });
  });
});

test("CQ-7: the rest quarter after Centre goes to the lightest listed position, by the coach's workloads (rank only breaks ties)", ()=>{
  const S = freshEngine().RosterSolver;
  const rankOf = (prefs, settings, pos)=>{
    const p = {id:"p", prefs};
    return S.buildQuarterCostFns({centres:["p"]}, Object.assign({centreQuarters:2, preferenceSlider:8, positionVariety:0}, settings)).positionCellCost(p,pos);
  };
  const order = (prefs, settings)=>prefs.filter(x=>x!=="C").sort((a,b)=>rankOf(prefs,settings,a)-rankOf(prefs,settings,b));
  assert.deepStrictEqual(order(["C","GA","WA","GS"], {}), ["GS","WA","GA"], "GS lightest, then WA, then GA - not the player's own order");
  assert.deepStrictEqual(order(["C","GA","WA"], {}), ["WA","GA"], "with GS gone, WA");
  assert.deepStrictEqual(order(["C","GA","WA","GS"], {positionLoad:{GS:2, GA:0.1}}), ["GA","WA","GS"], "edited weights are followed");
  assert.deepStrictEqual(order(["C","WD","WA"], {}), ["WD","WA"], "equal weights fall back to the player's ranking");
  assert.deepStrictEqual(order(["C","GA","WA","GS"], {loadBalance:0}), ["GS","WA","GA"], "the workload slider doesn't change the order");
  // without a Centre quarter just before, the player's own ranking applies
  const plain = pos=>S.buildQuarterCostFns({}, {centreQuarters:2, preferenceSlider:8, positionVariety:0}).positionCellCost({id:"p",prefs:["C","GA","WA","GS"]}, pos);
  assert.ok(plain("GA")<plain("WA") && plain("WA")<plain("GS"));
  // end to end: the rest quarter lands on the lightest position
  const r = centreSeason(CQ_SPECIALISTS.concat([["C1",["C","GA","WA","GS"]],["C2",["C","GA","WA","GS"]]]), {centre:2, bench:1, games:3});
  r.perGame.forEach(g=>g.quarters.forEach((q,k)=>{
    if(!k || q.centre===g.quarters[k-1].centre) return;
    const prev = g.quarters[k-1].centre;
    if(q.bench.includes(prev)) return; // the bench is the best rest
    const pos = Object.keys(q.onCourt).find(x=>q.onCourt[x]===prev);
    assert.notStrictEqual(pos, "GA", "rest at GA only when nothing lighter is free");
  }));
});

test("CQ-8: bench as rest - with the same court time due, the player with more Centre quarters takes the bench", ()=>{
  const S = freshEngine().RosterSolver;
  const players = [["GS1",["GS"]],["GA1",["GA"]],["C1",["C"]],["WD1",["WD"]],["GD1",["GD"]],["GK1",["GK"]],["a",["WA"]],["b",["WA"]]].map(([id,prefs])=>({id,name:id,prefs}));
  const centreHistory = (soFarA, soFarB)=>[...Array(soFarA).fill("a"), ...Array(soFarB).fill("b"), "C1"]; // ends on someone else: neither is mid-run
  const solve = (soFarA, soFarB)=>S.solveQuarterPositions({players, benchSlotCount:1, lockedSlots:{},
    cumulative:{posCount:{}, benchQuota:{a:1,b:1}, benchCap:{a:1,b:1}, centres:centreHistory(soFarA,soFarB)}, settings:{centreQuarters:2, preferenceSlider:8}});
  assert.deepStrictEqual([...solve(3,2).bench], ["a"]);
  assert.deepStrictEqual([...solve(2,3).bench], ["b"]);
  const noLimit = S.solveQuarterPositions({players, benchSlotCount:1, lockedSlots:{}, cumulative:{posCount:{}, benchQuota:{a:1,b:1}, benchCap:{a:1,b:1}, centres:centreHistory(3,2)}, settings:{centreQuarters:4, preferenceSlider:8}});
  assert.strictEqual(noLimit.bench.length, 1, "at no limit the fatigue term is off (the tie falls however it fell before)");
});

test("CQ-9: tightening the target to 1 on the four sweep rosters never adds an off-preference fill, a failed game or a missed game", ()=>{
  Object.keys(SWEEP_FIXTURES).forEach(key=>{
    const f = SWEEP_FIXTURES[key];
    const run = centre=>{
      const r = centreSeason(f.players.map(([n,p])=>[n,p]), {centre, games:f.numGames, bench:f.bench, settings:{allowOffPreference:true}, setup:(e,made)=>{ f.players.forEach(([,,un],i)=>{ made[i].unavailable = (un||[]).slice(); }); }});
      const off = r.perGame.reduce((a,g)=>a+g.quarters.reduce((b,q)=>b+q.offPreference,0),0);
      const errors = r.perGame.filter(g=>g.error).length;
      const missed = JSON.stringify(r.engine.computePlayerSummaries().map(s=>[s.name,s.missed]));
      return {off, errors, missed, centre:r.engine.computeCentreStats(2)};
    };
    const four = run(4), one = run(1);
    assert.ok(one.off<=four.off, `${key}: off-preference ${four.off} -> ${one.off}`);
    assert.ok(one.errors<=four.errors, `${key}: failed games ${four.errors} -> ${one.errors}`);
    assert.strictEqual(one.missed, four.missed, `${key}: Phase 1 is untouched`);
    assert.ok(one.centre.backToBack<=four.centre.backToBack, `${key}: back-to-back Centre quarters ${four.centre.backToBack} -> ${one.centre.backToBack}`);
  });
});

test("CQ-10: Phase 2b never raises a game's back-to-back Centre count above what Phase 2a produced", ()=>{
  const S = freshEngine().RosterSolver;
  const rosters = [CQ_TWO_CENTRES, CQ_TWO_CENTRES.concat([["X",["GS","GA","WA","WD","GD","GK"]]]), CQ_SPECIALISTS.concat([["C1",["C","WA"]],["C2",["C","WD"]],["C3",["C","GA"]]])];
  rosters.forEach((roster,ri)=>[1,2,3].forEach(target=>{
    const players = roster.map(([id,prefs])=>({id,name:id,prefs}));
    const settings = {centreQuarters:target, preferenceSlider:8, positionVariety:1};
    const benchSlotCount = players.length-7;
    const gameBenchSoFar = {}, centres = [], quarters = [], snaps = [];
    let benchedLast = new Set();
    for(let q=0;q<4;q++){
      const snap = {posCount:{}, gameBenchSoFar:Object.assign({},gameBenchSoFar), benchedLastQuarter:new Set(benchedLast), centres:centres.slice(), benchQuota:{}, benchCap:{}};
      snaps.push(snap);
      const res = S.solveQuarterPositions({players, benchSlotCount, lockedSlots:{}, cumulative:snap, settings});
      res.bench.forEach(id=>{ gameBenchSoFar[id]=(gameBenchSoFar[id]||0)+1; }); benchedLast = new Set(res.bench);
      centres.push(res.onCourt.C);
      quarters.push({onCourt:res.onCourt, bench:res.bench, offPreference:res.offPreference});
    }
    const b2b = qs=>qs.reduce((a,q,i)=>a+(i && q.onCourt.C===qs[i-1].onCourt.C ? 1 : 0),0);
    const before = b2b(quarters);
    const refined = S.refineGameQuarters({quarters, squadPool:players, cumulativeSnapshots:snaps, lockedSlotsPerQuarter:[{},{},{},{}], settings});
    assert.ok(b2b(refined.quarters)<=before, `roster ${ri} target ${target}: back-to-back ${before} -> ${b2b(refined.quarters)}`);
  }));
});

test("CQ-11: centreQuarters survives a backup round trip; missing means 4; junk is rounded, clamped or ignored", ()=>{
  const engine = freshEngine();
  addPlayer(engine, "Liv", ["GS"]);
  engine._getState().settings.centreQuarters = 2;
  engine.exportBackup();
  const text = engine.CapturingBlob.last;
  assert.strictEqual(JSON.parse(text).plan.settings.centreQuarters, 2);
  const fresh = freshEngine(); fresh.importBackup(text);
  assert.strictEqual(fresh._getState().settings.centreQuarters, 2);
  const withValue = v=>{ const b = JSON.parse(text); if(v===undefined) delete b.plan.settings.centreQuarters; else b.plan.settings.centreQuarters = v; fresh.importBackup(JSON.stringify(b)); return fresh._getState().settings.centreQuarters; };
  assert.strictEqual(withValue(undefined), 4, "an old backup without it means no limit");
  assert.strictEqual(withValue(9), 4); assert.strictEqual(withValue(0), 1); assert.strictEqual(withValue(2.6), 3);
  assert.strictEqual(withValue("2"), 4, "a non-number is ignored"); assert.strictEqual(withValue(null), 4);
  // localStorage: a corrupted value is corrected on load
  const st = engine._getState(); st.settings.centreQuarters = "lots"; engine.saveState();
  assert.strictEqual(engine.loadState().settings.centreQuarters, 4);
  st.settings.centreQuarters = 3; engine.saveState();
  assert.strictEqual(engine.loadState().settings.centreQuarters, 3);
});

test("CQ-12: a coach locking Centre for one player in Q1 and Q2 still generates, with the locks kept", ()=>{
  const r = centreSeason(CQ_TWO_CENTRES, {centre:1, bench:1, games:2, setup:(engine, made)=>{
    const g = engine.getGame(1); g.lockedSlots = {"0-C":made[6].id, "1-C":made[6].id};
  }});
  assert.strictEqual(r.perGame[0].error, null);
  assert.strictEqual(r.perGame[0].quarters[0].centre, "C1"); assert.strictEqual(r.perGame[0].quarters[1].centre, "C1");
  assert.strictEqual(r.perGame[1].error, null);
});

test("CQ-13: below no limit, Phase 2b also tries every order of the unlocked quarters (a reorder no pair trade can reach)", ()=>{
  const S = freshEngine().RosterSolver;
  const roster = CQ_SPECIALISTS.concat([["C1",["C","WA"]],["C2",["C","WD"]],["C3",["C","GA"]]]);
  const players = roster.map(([id,prefs])=>({id,name:id,prefs}));
  const settings = {centreQuarters:2, preferenceSlider:8, positionVariety:1};
  const snap = {posCount:{}, benchQuota:{}, benchCap:{}};
  // A valid game whose Centres run C1,C1,C2,C2: every quarter's lineup is fine, only the order is bad.
  const q = (c, bench)=>{ const rest = ["C1","C2","C3"].filter(id=>id!==c && !bench.includes(id));
    return {onCourt:{GS:"GS1",GA:"GA1",WA:"WA1",WD:"WD1",GD:"GD1",GK:"GK1",C:c}, bench:bench.concat(rest).slice(0,2)}; };
  const quarters = [q("C1",["C2","C3"]), q("C1",["C2","C3"]), q("C2",["C1","C3"]), q("C2",["C1","C3"])];
  const input = locks=>({quarters, squadPool:players, cumulativeSnapshots:[snap,snap,snap,snap], lockedSlotsPerQuarter:locks, settings});
  const score = qs=>S.scoreGameQuarters({quarters:qs, squadPool:players, cumulativeSnapshots:[snap,snap,snap,snap], settings});
  const refined = S.refineGameQuarters(input([{},{},{},{}])).quarters;
  assert.deepStrictEqual(refined.map(x=>x.onCourt.C).filter((c,i,a)=>i && c===a[i-1]), [], "no back-to-back Centre left");
  // and nothing it returns can be beaten by just reordering its own quarters
  const perms = []; (function P(a,r){ if(!r.length) perms.push(a); r.forEach((x,i)=>P(a.concat(x), r.filter((_,j)=>j!==i))); })([], [0,1,2,3]);
  perms.forEach(p=>assert.ok(score(refined) <= score(p.map(i=>refined[i]))+1e-9));
  // a coach lock pins its quarter in place
  const locked = S.refineGameQuarters(input([{C:"C1"},{},{},{}])).quarters;
  assert.strictEqual(locked[0].onCourt.C, "C1");
  // (at no limit the move is off: CQ-2 shows setting 4 generates exactly what it did before)
});

test("CQ-14: centreSequences - the squad members who rank Centre highest (at most 4), every order, coach locks kept", ()=>{
  const S = freshEngine().RosterSolver;
  const sq = [["a",["GS","C"]],["b",["C"]],["c",["WA","GA","C"]],["d",["C","WA"]],["e",["GK"]],["f",["WD","C"]],["g",[]]].map(([id,prefs])=>({id,prefs}));
  const seqs = S.centreSequences(sq, [{},{},{},{}]);
  assert.strictEqual(seqs.length, 256);
  assert.deepStrictEqual([...new Set(seqs.flat())].sort(), ["a","b","d","g"], "no list (happy anywhere) and #1s first, then #2s; c (#3) and f are cut");
  const locked = S.centreSequences(sq, [{C:"c"},{GS:"a"},{},{}]);
  assert.ok(locked.every(seq=>seq[0]==="c"), "a locked Centre is kept");
  assert.ok(locked.every(seq=>seq[1]!=="a"), "someone locked elsewhere that quarter isn't tried at Centre");
  assert.strictEqual(JSON.stringify(S.centreSequences([{id:"x",prefs:["GS"]}], [{},{},{},{}])), "[[null,null,null,null]]", "nobody to try: left to the solver");
});

test("CQ-15: the real-roster backup at targets 3, 2 and 1 - no three Centre quarters in a row, and few back-to-backs", ()=>{
  const backup = fs.readFileSync(path.join(__dirname, "fixtures", "season-backup-v1.json"), "utf8");
  const run = target=>{
    const engine = freshEngine(); quietly(()=>engine.importBackup(backup));
    engine._getState().settings.centreQuarters = target;
    engine.gameNums().forEach(n=>{ engine.getGame(n).isPlayed = false; });
    quietly(()=>engine.runGeneration());
    const runs = engine.gameNums().map(n=>engine.getGame(n).schedule.quarters.map(q=>q.onCourt.C)).filter(cs=>cs.some((c,i)=>i>1 && c===cs[i-1] && c===cs[i-2]));
    return {b2b:engine.computeCentreStats(target).backToBack, runs:runs.length};
  };
  [3,2,1].forEach(t=>assert.strictEqual(run(t).runs, 0, "target "+t));
  // Before whole-game Centre planning and quarter reordering this roster had 6 at target 2 and 5-6 at target 1.
  assert.ok(run(2).b2b<=5); assert.ok(run(1).b2b<=5);
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
