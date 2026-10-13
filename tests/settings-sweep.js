/* Settings sweep: does each Settings-tab control do what its label says, and
   does every increment of every slider change the result in a way a coach
   would notice? (Test plan §22, SET-*.)

   For each setting x roster fixture x context, regenerates the season at every
   value with all other settings held fixed, measures the outcome, and classes
   each step against that setting's intent (§11's settings table):
     +  a headline number moved the way the label says
     ~  the schedule changed but no headline number moved past its threshold
     .  the schedule is identical to the previous value's (a dead step)
     !  a headline number moved against the label
     *  some moved with the label, some against
   Hard checks (spec guarantees) fail the run; per-step observations are
   reported as findings and only fail it under --strict.

   Run with: npm run test:settings [-- --detail] [--strict] [--setting=<key>] */
"use strict";
const { loadEngine } = require("./harness.js");

const ARGS = process.argv.slice(2);
const DETAIL = ARGS.includes("--detail");
const STRICT = ARGS.includes("--strict");
const ONLY = (ARGS.find(a=>a.startsWith("--setting="))||"").split("=")[1] || null;

/* ---------------- Fixtures ---------------- */
// [name, prefs, unavailable game numbers]
const FIXTURES = {
  deep11: {note:"11 players, 11 games, bench 2 - good depth everywhere", numGames:11, bench:2, players:[
    ["Liv",["GA","GS"]], ["Poppy",["GS","GA","WA","C","WD"]], ["Mabel",["WA","GA","C","GS","WD"]],
    ["Izzy",["WA","WD"]], ["Layla",["WA","WD"]], ["Ella",["C","GA","WA"]], ["Zara",["C","WA","WD"]],
    ["Maddie",["WD","WA"]], ["Abby",["GD","WD","GK"]], ["Avalon",["GD","GK"]], ["Savanah",["GK","GD"]]]},
  unavail12: {note:"12 players, 8 games, bench 2 - uneven availability, thin GK", numGames:8, bench:2, players:[
    ["Amy",["GS","GA"],[3,7]], ["Bea",["GA","GS","WA"]], ["Cat",["WA","C","GA"]],
    ["Dee",["C","WA","WD"]], ["Eve",["WD","C","GD"],[2]], ["Fay",["GD","WD"]],
    ["Gia",["GK","GD"]], ["Hal",["GS","GA","WA"]], ["Ivy",["WA","C"]],
    ["Jaz",["C","WD","GD"],[5,6]], ["Kim",["GD","GK"]], ["Lou",["GD","WD"]]]},
  thin10: {note:"10 players, 10 games, bench 1 - a sole GK, short preference lists", numGames:10, bench:1, players:[
    ["Ava",["GS","GA"]], ["Bri",["GA","GS"]], ["Cleo",["WA","C"]], ["Dani",["C","WA"]], ["Emme",["WD","C"]],
    ["Flo",["GD","WD"]], ["Gwen",["GK"]], ["Hope",["GS","WA"]], ["Isla",["C","WD","WA"]], ["Joss",["GD","GA"]]]},
  small9: {note:"9 players, 10 games, bench 2 - nobody is ever rostered off", numGames:10, bench:2, players:[
    ["Ana",["GS","GA","WA"]], ["Bex",["GA","GS"]], ["Cora",["WA","C","WD"]], ["Dot",["C","WA"]], ["Edie",["WD","GD","C"]],
    ["Fern",["GD","GK","WD"]], ["Gigi",["GK","GD"]], ["Hana",["GS","GK"]], ["Indi",["C","WD","GA"]]]}
};

/* ---------------- Metrics ----------------
   Shares and spreads are in percentage points. `min` is the smallest change
   between two neighbouring slider values that counts as noticeable - roughly
   "a coach comparing the two Reports tabs would see it". */
const METRICS = {
  offPref:   {label:"off-preference fills (% of slots)", min:0.5},
  top1:      {label:"quarters at a player's #1 choice (%)", min:1},
  top2:      {label:"quarters in a player's top 2 (%)", min:1},
  playSd:    {label:"spread of on-court time (SD of on-court rate, pts)", min:0.5},
  distinct:  {label:"distinct positions played per player", min:0.15},
  missedVar: {label:"missed-games variance", min:0.05},
  thinCover: {label:"positions left with <=1 preferrer (season total)", min:1},
  errors:    {label:"games that failed to generate", min:1}
};

/* ---------------- Settings under test ----------------
   intent: [metric, direction along `values` (+1 up, -1 down)].
   side: metrics the label doesn't mention but a change is worth reporting. */
const R0 = [0,1,2,3,4,5,6,7,8,9,10];
const SETTINGS = [
  { key:"preferenceSlider", title:"Preference slider (0 even court time .. 10 strict preference)", values:R0,
    apply:(s,v)=>{ s.preferenceSlider = v; },
    intent:[["offPref",-1],["top1",+1],["playSd",+1]], side:["distinct"],
    contexts:[{}] },
  { key:"positionVariety", title:"Position variety slider (0 repeat favourite .. 10 spread across list)", values:R0,
    apply:(s,v)=>{ s.positionVariety = v; },
    intent:[["top1",-1],["distinct",+1]], side:["offPref","playSd"],
    contexts:[{}, {preferenceSlider:5}] },
  { key:"rosterOffPriority", title:"Roster-off priority (even missed games -> balanced -> protect thin positions)", values:["fairness","balanced","coverage"],
    apply:(s,v)=>{ s.rosterOffPriority = v; },
    intent:[["thinCover",-1],["missedVar",+1]], side:["offPref"],
    contexts:[{}] },
  { key:"allowOffPreference", title:"Allow off-preference positions (on -> off)", values:[true,false],
    apply:(s,v)=>{ s.allowOffPreference = v; },
    intent:[["offPref",-1]], side:["errors","playSd"],
    contexts:[{}, {preferenceSlider:0}] }
];

/* ---------------- Running one configuration ---------------- */
function buildEngine(fixtureName){
  const f = FIXTURES[fixtureName];
  const engine = loadEngine();
  engine._resetState();
  const st = engine._getState();
  st.season.numGames = f.numGames;
  st.season.desiredBenchSize = f.bench;
  f.players.forEach(([name,prefs,unavailable])=>{
    st.players.push({id:engine.uid("p"), name, prefs:prefs.slice(), unavailable:(unavailable||[]).slice()});
  });
  engine.ensureGamesExist();
  return engine;
}
// runGeneration logs its own timing line on every call.
function quietly(fn){
  const log = console.log;
  console.log = ()=>{};
  try{ return fn(); } finally { console.log = log; }
}
const pct = (n,d)=> d ? 100*n/d : 0;
const mean = a=> a.length ? a.reduce((x,y)=>x+y,0)/a.length : 0;

function run(fixtureName, configure){
  const engine = buildEngine(fixtureName);
  const st = engine._getState();
  configure(st.settings);
  const gen = quietly(()=>engine.runGeneration());
  const P = engine.POSITIONS;
  const prefs = {}, nameOf = {};
  st.players.forEach(p=>{ prefs[p.id] = p.prefs; nameOf[p.id] = p.name; });

  // Ids are random per engine instance, so schedules are compared by name.
  const slots = [], rosterOff = [];
  let total=0, off=0, top1=0, top2=0, thin=0, errors=0;
  engine.gameNums().forEach(num=>{
    const g = engine.getGame(num);
    rosterOff.push((g.rosteredOffIds||[]).map(id=>nameOf[id]).sort().join(","));
    thin += (g.coverageWarnings||[]).length;
    if(!g.schedule){ errors++; P.forEach(()=>slots.push("-","-","-","-")); return; }
    g.schedule.quarters.forEach(q=>P.forEach(pos=>{
      const id = q.onCourt[pos];
      slots.push(nameOf[id]);
      total++;
      const rank = (prefs[id]||[]).indexOf(pos);
      if(rank<0) off++;
      if(rank===0) top1++;
      if(rank===0 || rank===1) top2++;
    }));
  });
  const summaries = engine.computePlayerSummaries();
  const rates = summaries.filter(s=>s.onCourt+s.bench>0).map(s=>100*s.onCourt/(s.onCourt+s.bench));
  return {
    slots, rosterOff, timedOut: !!gen.phase1Stats.timedOut,
    m: {
      offPref: pct(off,total), top1: pct(top1,total), top2: pct(top2,total),
      playSd: Math.sqrt(engine.RosterSolver.variance(rates)),
      distinct: mean(summaries.map(s=>P.filter(pos=>s.positions[pos]>0).length)),
      missedVar: engine.RosterSolver.variance(summaries.map(s=>s.missed)),
      thinCover: thin, errors
    },
    offPrefCount: off
  };
}
function countDiff(a,b){
  let d = 0;
  for(let i=0;i<Math.max(a.length,b.length);i++) if(a[i]!==b[i]) d++;
  return d;
}

/* ---------------- Classifying a step / a whole sweep ---------------- */
// +1 moved with the intent, -1 against, 0 below the noticeable threshold.
function moved(metric, dir, from, to){
  const delta = to.m[metric]-from.m[metric];
  if(Math.abs(delta) < METRICS[metric].min-1e-9) return 0;
  return Math.sign(delta)===dir ? 1 : -1;
}
function classify(setting, from, to){
  if(countDiff(from.slots,to.slots)===0 && countDiff(from.rosterOff,to.rosterOff)===0) return ".";
  const moves = setting.intent.map(([metric,dir])=>moved(metric,dir,from,to));
  const withIntent = moves.includes(1), against = moves.includes(-1);
  return withIntent && against ? "*" : withIntent ? "+" : against ? "!" : "~";
}

const hardFailures = [], findings = [];
function hard(ok, id, msg){ if(!ok) hardFailures.push(`${id}: ${msg}`); }
const fmt = v=> typeof v==="number" ? (Number.isInteger(v) ? String(v) : v.toFixed(v<10?2:1)) : String(v);
const ctxLabel = ctx=> Object.keys(ctx).map(k=>`${k}=${ctx[k]}`).join(", ") || "defaults";

function sweep(setting, fixtureName, ctx){
  const results = setting.values.map(v=>run(fixtureName, s=>{ Object.assign(s,ctx); setting.apply(s,v); }));
  const steps = results.slice(1).map((r,i)=>classify(setting, results[i], r));
  const first = results[0], last = results[results.length-1];
  const where = `${setting.key} / ${fixtureName} / ${ctxLabel(ctx)}`;
  const overall = setting.intent.map(([metric,dir])=>moved(metric,dir,first,last));
  const allDead = steps.every(s=>s===".");

  hard(results.every(r=>!r.timedOut), "SET-1", `${where}: Phase 1 hit its time budget, so results are not reproducible`);
  // LBL-2: end to end, nothing may move against what the label promises.
  setting.intent.forEach(([metric,dir],i)=>{
    hard(overall[i]>=0, "SET-3", `${where}: ${METRICS[metric].label} moved against the label end to end (${fmt(first.m[metric])} -> ${fmt(last.m[metric])}, expected ${dir>0?"up":"down"})`);
  });
  if(setting.key==="preferenceSlider"){
    // §5.1: raising the slider must never increase off-preference fills.
    results.slice(1).forEach((r,i)=>hard(r.offPrefCount<=results[i].offPrefCount, "SET-4",
      `${where}: off-preference fills rose from ${results[i].offPrefCount} to ${r.offPrefCount} between ${setting.values[i]} and ${setting.values[i+1]}`));
  }
  if(setting.key==="rosterOffPriority"){
    results.slice(1).forEach((r,i)=>hard(r.m.missedVar>=results[i].m.missedVar-1e-9 && r.m.thinCover<=results[i].m.thinCover, "SET-5",
      `${where}: fairness/coverage trade-off not monotonic between ${setting.values[i]} and ${setting.values[i+1]}`));
  }
  if(setting.key==="allowOffPreference"){
    // §5.2: with the toggle off, an off-preference fill is never committed.
    hard(last.offPrefCount===0, "SET-6", `${where}: ${last.offPrefCount} off-preference fill(s) with the toggle off`);
  }

  let verdict;
  if(allDead) verdict = "NO EFFECT";
  else if(overall.includes(-1)) verdict = "AGAINST LABEL";
  else if(overall.includes(1)) verdict = "as labelled";
  else verdict = "reshuffles only";

  const stepName = i=>`${setting.values[i]}->${setting.values[i+1]}`;
  const list = sym=>steps.map((s,i)=>s===sym?stepName(i):null).filter(Boolean);
  const notes = [];
  if(allDead) notes.push("no effect at all - every value gives the same season");
  else {
    if(list(".").length) notes.push(`dead step(s) ${list(".").join(" ")}`);
    if(list("~").length) notes.push(`reshuffle-only step(s) ${list("~").join(" ")}`);
    if(list("!").length) notes.push(`step(s) against the label ${list("!").join(" ")}`);
  }
  setting.side.forEach(metric=>{
    const delta = last.m[metric]-first.m[metric];
    if(Math.abs(delta)>=METRICS[metric].min*2) notes.push(`side effect: ${metric} ${fmt(first.m[metric])} -> ${fmt(last.m[metric])}`);
  });
  if(notes.length) findings.push(`${where}: ${notes.join("; ")}`);
  return {results, steps, verdict};
}

/* ---------------- Report ---------------- */
function printDetail(setting, out){
  const metrics = setting.intent.map(i=>i[0]).concat(setting.side);
  const row = (label, cells)=>console.log("      "+label.padEnd(10)+cells.map(c=>String(c).padStart(6)).join(""));
  row("value", setting.values);
  metrics.forEach(metric=>row(metric, out.results.map(r=>fmt(r.m[metric]))));
  row("changed%", out.results.map((r,i)=> i ? Math.round(pct(countDiff(out.results[i-1].slots,r.slots), r.slots.length)) : "-"));
}

/* SET-1: the same inputs must give the same season, or step-to-step
   comparisons would be measuring noise. */
Object.keys(FIXTURES).forEach(name=>{
  const a = run(name, ()=>{}), b = run(name, ()=>{});
  hard(countDiff(a.slots,b.slots)===0 && countDiff(a.rosterOff,b.rosterOff)===0, "SET-1", `${name}: two identical runs produced different seasons`);
});

console.log("Settings sweep - legend: + moved as labelled   ~ reshuffle only   . identical   ! against label   * mixed");
console.log("Fixtures:");
Object.keys(FIXTURES).forEach(name=>console.log(`  ${name.padEnd(10)} ${FIXTURES[name].note}`));

SETTINGS.filter(s=>!ONLY || s.key===ONLY).forEach(setting=>{
  console.log(`\n${setting.title}`);
  console.log(`  intent: ${setting.intent.map(([m,d])=>`${METRICS[m].label} ${d>0?"up":"down"}`).join("; ")}`);
  console.log(`  ${"fixture".padEnd(10)} ${"context".padEnd(40)} ${("steps "+setting.values[0]+".."+setting.values[setting.values.length-1]).padEnd(21)} verdict`);
  setting.contexts.forEach(ctx=>{
    Object.keys(FIXTURES).forEach(fixtureName=>{
      const out = sweep(setting, fixtureName, ctx);
      console.log(`  ${fixtureName.padEnd(10)} ${ctxLabel(ctx).padEnd(40)} ${out.steps.join(" ").padEnd(21)} ${out.verdict}`);
      if(DETAIL) printDetail(setting, out);
    });
  });
});

console.log(`\nFindings (${findings.length}) - observations, not failures${STRICT?" (--strict: treated as failures)":""}. Metrics:`);
Object.keys(METRICS).forEach(k=>console.log(`  ${k.padEnd(10)} ${METRICS[k].label}; noticeable from ${METRICS[k].min}`));
findings.forEach(f=>console.log("  - "+f));
console.log(`\nHard checks: ${hardFailures.length ? hardFailures.length+" FAILED" : "all passed"}`);
hardFailures.forEach(f=>console.log("  FAIL "+f));
process.exit(hardFailures.length || (STRICT && findings.length) ? 1 : 0);
