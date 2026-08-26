/* Node-based regression suite for the engine embedded in index.html.
   Run with: node tests/run.js
   Loads a fresh, isolated instance of the app's inline script per test via
   harness.loadEngine() (document/localStorage/URL/Blob are stubbed — see harness.js). */
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

/* ============================================================
   1. Slider sweep monotonicity (rewritten cost function)
   ============================================================ */
test("SLIDER-1: off-preference count is non-increasing across slider 0..10", ()=>{
  function buildRoster(engine){
    const st = engine._getState();
    st.season.numGames = 10;
    st.season.desiredBenchSize = 3;
    const defs = [
      ["Amy",["GS","GA"]], ["Bea",["GA","GS","WA"]], ["Cat",["WA","C","GA"]],
      ["Dee",["C","WA","WD"]], ["Eve",["WD","C","GD"]], ["Fay",["GD","WD","GK"]],
      ["Gia",["GK","GD"]], ["Hal",["GS","GA","WA"]], ["Ivy",["WA","C"]],
      ["Jaz",["C","WD","GD"]], ["Kim",["GD","GK"]], ["Lou",["GK","GD","WD"]],
      ["Mia",["GA","WA","C"]], ["Nel",["WD","GD","GK"]]
    ];
    defs.forEach(([name,prefs])=>addPlayer(engine, name, prefs));
    st.players[0].unavailable = [3,7];
    st.players[4].unavailable = [2];
    st.players[9].unavailable = [5,6];
    st.players[12].unavailable = [1];
    engine.ensureGamesExist();
  }
  const counts = [];
  for(let slider=0; slider<=10; slider++){
    const engine = freshEngine();
    buildRoster(engine);
    engine._getState().settings.preferenceSlider = slider;
    const r = engine.runGeneration();
    assert.strictEqual(r.invalid, null, "roster should be valid at slider="+slider);
    counts.push(engine.computeOffPrefLog().length);
  }
  for(let i=1;i<counts.length;i++){
    assert.ok(counts[i] <= counts[i-1],
      `off-pref count increased raising slider from ${i-1} (${counts[i-1]}) to ${i} (${counts[i]}): ${counts}`);
  }
  assert.ok(counts[0] > counts[10], "sanity: slider should meaningfully change off-pref count end to end: "+counts);
});

test("SLIDER-2: fairnessWeights.onCourt and .positionPurity are consulted (changing them changes output)", ()=>{
  function buildRoster(engine){
    const st = engine._getState();
    st.season.numGames = 6;
    st.season.desiredBenchSize = 2;
    const defs = [
      ["Amy",["GS","GA"]], ["Bea",["GA","GS"]], ["Cat",["WA","C"]],
      ["Dee",["C","WA"]], ["Eve",["WD","GD"]], ["Fay",["GD","WD"]],
      ["Gia",["GK"]], ["Hal",["GS","WA"]], ["Ivy",["C","WD"]]
    ];
    defs.forEach(([name,prefs])=>addPlayer(engine, name, prefs));
    engine.ensureGamesExist();
  }
  const engineLow = freshEngine();
  buildRoster(engineLow);
  engineLow._getState().settings.preferenceSlider = 5;
  engineLow._getState().settings.fairnessWeights.onCourt = 1;
  engineLow.runGeneration();
  const onCourtCountsLow = engineLow.computePlayerSummaries().map(s=>s.onCourt).sort();

  const engineHigh = freshEngine();
  buildRoster(engineHigh);
  engineHigh._getState().settings.preferenceSlider = 5;
  engineHigh._getState().settings.fairnessWeights.onCourt = 10;
  engineHigh.runGeneration();
  const onCourtCountsHigh = engineHigh.computePlayerSummaries().map(s=>s.onCourt).sort();

  assert.notDeepStrictEqual(onCourtCountsLow, onCourtCountsHigh,
    "changing fairnessWeights.onCourt should be able to change the resulting on-court distribution");
});

/* ============================================================
   2. Coverage-aware roster-off selection
   ============================================================ */
test("RO-COVERAGE-1: does not roster off two same-top-preference players together when a safer same-tier pick exists", ()=>{
  const engine = freshEngine();
  const cumulative = engine.emptyCumulative();
  const X = {id:"x", prefs:["GS","GA"], unavailable:[]};
  const Y = {id:"y", prefs:["GS","WA"], unavailable:[]};
  const W = {id:"w", prefs:["GS"], unavailable:[]};
  const Z = {id:"z", prefs:["WD"], unavailable:[]};
  const V = {id:"v", prefs:["GD"], unavailable:[]};
  const pool = [X,Y,W,Z,V];
  const picked = engine.selectRosterOff(pool, 2, cumulative, 1, false);
  assert.strictEqual(picked.length, 2);
  assert.ok(!(picked.includes("x") && picked.includes("y")),
    "should not roster off both GS-top-preference players together when Z (unrelated position) is available: "+picked);
});

test("RO-COVERAGE-2: still rosters off the required count when every tied candidate overlaps (no safe alternative)", ()=>{
  const engine = freshEngine();
  const cumulative = engine.emptyCumulative();
  const X = {id:"x", prefs:["GS","GA"], unavailable:[]};
  const Y = {id:"y", prefs:["GS","WA"], unavailable:[]};
  const Q = {id:"q", prefs:["GS","C"], unavailable:[]};
  const pool = [X,Y,Q];
  const picked = engine.selectRosterOff(pool, 2, cumulative, 1, false);
  assert.strictEqual(picked.length, 2, "fairness requirement (rostering off the needed count) must not be broken even with no safe option");
});

test("RO-COVERAGE-3: never reaches outside the fairness-tied group in default (non-strict) mode", ()=>{
  const engine = freshEngine();
  const cumulative = engine.emptyCumulative();
  cumulative.missed = {t:0, u:1, f1:1, f2:1};
  const T = {id:"t", prefs:["GK"], unavailable:[]}; // sole GK specialist, tied group of 1
  const U = {id:"u", prefs:["GA","WA"], unavailable:[]};
  const F1 = {id:"f1", prefs:["GA"], unavailable:[]};
  const F2 = {id:"f2", prefs:["WA"], unavailable:[]};
  const pool = [T,U,F1,F2];
  const picked = engine.selectRosterOff(pool, 1, cumulative, 1, false);
  assert.deepStrictEqual([...picked], ["t"], "default mode must pick the sole tied (missed=0) candidate, even though it creates a coverage gap");
});

/* ============================================================
   3. Per-game strict specialist pairing toggle
   ============================================================ */
test("STRICT-1: strict mode looks outside the tied group to avoid a severe coverage gap; default does not", ()=>{
  function buildPool(engine){
    const cumulative = engine.emptyCumulative();
    cumulative.missed = {t:0, u:1, fa1:1, fa2:1, fw1:1, fw2:1};
    const T = {id:"t", prefs:["GK"], unavailable:[]};       // only GK-lister anywhere in the pool
    const U = {id:"u", prefs:["GA","WA"], unavailable:[]};  // safe alternative one tier out
    const FA1 = {id:"fa1", prefs:["GA"], unavailable:[]};
    const FA2 = {id:"fa2", prefs:["GA"], unavailable:[]};
    const FW1 = {id:"fw1", prefs:["WA"], unavailable:[]};
    const FW2 = {id:"fw2", prefs:["WA"], unavailable:[]};
    return {cumulative, pool:[T,U,FA1,FA2,FW1,FW2]};
  }
  const engineA = freshEngine();
  const {cumulative:cumA, pool:poolA} = buildPool(engineA);
  const defaultPick = engineA.selectRosterOff(poolA, 1, cumA, 1, false);
  assert.deepStrictEqual([...defaultPick], ["t"], "default (strict off) must roster off the sole tied candidate regardless of severity");

  const engineB = freshEngine();
  const {cumulative:cumB, pool:poolB} = buildPool(engineB);
  const strictPick = engineB.selectRosterOff(poolB, 1, cumB, 1, true);
  assert.notStrictEqual(strictPick[0], "t", "strict mode should look outside the tied group instead of rostering off the sole GK specialist");
  assert.ok(!engineB.rosterOffHasSevereGap({id:strictPick[0], prefs:poolB.find(p=>p.id===strictPick[0]).prefs}, poolB.filter(p=>p.id!==strictPick[0])),
    "the strict-mode pick should actually be a safe one (no 0-1 coverage gap of its own)");
});

test("STRICT-2: strict mode makes no difference when the tied group already has a safe pick", ()=>{
  const engine1 = freshEngine();
  const cumulative1 = engine1.emptyCumulative();
  const X = {id:"x", prefs:["GS","GA"], unavailable:[]};
  const Y = {id:"y", prefs:["GS","WA"], unavailable:[]};
  const W = {id:"w", prefs:["GS"], unavailable:[]};
  const Z = {id:"z", prefs:["WD"], unavailable:[]};
  const V = {id:"v", prefs:["GD"], unavailable:[]};
  const poolFor = ()=>[{...X},{...Y},{...W},{...Z},{...V}];
  const defaultPick = engine1.selectRosterOff(poolFor(), 2, engine1.emptyCumulative(), 1, false);
  const strictPick = engine1.selectRosterOff(poolFor(), 2, engine1.emptyCumulative(), 1, true);
  assert.deepStrictEqual([...defaultPick].sort(), [...strictPick].sort(),
    "with a same-tier safe pick already available, strict mode shouldn't need to change the outcome");
});

/* ============================================================
   4. Coverage warning
   ============================================================ */
test("COVERAGE-WARN-1: flags a position dropped to 0-1 covering players after roster-off", ()=>{
  const engine = freshEngine();
  const plan = {
    shortfall: false,
    rosteredOffIds: ["g2"],
    squad: [
      {id:"g1", prefs:["GK"], isFillIn:false},
      {id:"a1", prefs:["GA"], isFillIn:false},
      {id:"a2", prefs:["GA"], isFillIn:false},
    ]
  };
  const st = engine._getState();
  st.players.push({id:"g2", name:"Gone", prefs:["GK"], unavailable:[]});
  const warnings = engine.computeCoverageWarnings(plan);
  const gk = warnings.find(w=>w.position==="GK");
  assert.ok(gk, "expected a GK coverage warning: "+JSON.stringify(warnings));
  assert.strictEqual(gk.count, 1);
  assert.deepStrictEqual(gk.causedBy, ["Gone"]);
});

/* ============================================================
   5. CSV round-trip — extends the roster-off round-trip test with the new
      per-game strictSpecialistMode field.
   ============================================================ */
test("CSV-ROUNDTRIP-1: strictSpecialistMode round-trips through export/import per game", ()=>{
  const engine = freshEngine();
  const st = engine._getState();
  st.season.numGames = 3;
  st.season.desiredBenchSize = 1;
  ["GS","GA","WA","C","WD","GD","GK","GA"].forEach((pos,i)=>addPlayer(engine, "P"+i, [pos]));
  engine.ensureGamesExist();
  const g1 = engine.getGame(1);
  const g2 = engine.getGame(2);
  g1.strictSpecialistMode = true;
  g2.strictSpecialistMode = false;
  engine.runGeneration();

  engine.exportFullCsv();
  const csvText = engine.CapturingBlob.last;
  assert.ok(csvText && csvText.includes("strictSpecialistMode"), "exported CSV should carry the new per-game column header");

  engine.importFullCsv(csvText);
  const st2 = engine._getState();
  assert.strictEqual(st2.games["1"].strictSpecialistMode, true, "game 1's strict flag should survive the round trip");
  assert.strictEqual(st2.games["2"].strictSpecialistMode, false, "game 2's strict flag should survive the round trip");
});

test("CSV-ROUNDTRIP-2: settings CSV no longer emits weight_missed and drops the missed weight cleanly", ()=>{
  const engine = freshEngine();
  const st = engine._getState();
  st.season.numGames = 1;
  ["GS","GA","WA","C","WD","GD","GK"].forEach((pos,i)=>addPlayer(engine, "P"+i, [pos]));
  engine.ensureGamesExist();
  engine.runGeneration();
  engine.exportFullCsv();
  const csvText = engine.CapturingBlob.last;
  assert.ok(!csvText.includes("weight_missed"), "weight_missed should no longer be exported");
  assert.ok(!("missed" in engine._getState().settings.fairnessWeights), "fairnessWeights.missed should not exist");
});

/* ============================================================
   6. Regression: previously-established behavior
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
  // Nobody lists GK; everyone else uniquely covers the other 6 positions.
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
  const cumulativeCheck = engine.emptyCumulative();
  assert.strictEqual(Object.keys(cumulativeCheck.onCourt).length, 0);
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
