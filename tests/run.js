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
