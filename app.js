/* ============================================================
   Netball Season Roster App
   Single-file, client-only. Data model + engine + UI + I/O.
   ============================================================ */
(function(){
"use strict";

/* ---------------- Constants ---------------- */
const APP_VERSION = "0.4.0";
const POSITIONS = ["GS","GA","WA","C","WD","GD","GK"];
const POS_LABEL = {GS:"Goal Shooter",GA:"Goal Attack",WA:"Wing Attack",C:"Centre",WD:"Wing Defence",GD:"Goal Defence",GK:"Goal Keeper"};
const STORAGE_KEY = "netballRosterApp_v1";
const QUARTERS = [0,1,2,3];

/* ---------------- Utilities ---------------- */
function uid(prefix){ return prefix+"_"+Math.random().toString(36).slice(2,9)+Date.now().toString(36).slice(-4); }
function clamp(v,lo,hi){ return Math.max(lo,Math.min(hi,v)); }
function deepClone(o){ return JSON.parse(JSON.stringify(o)); }
function byId(arr,id){ return arr.find(x=>x.id===id); }
function esc(s){ return String(s==null?"":s).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c])); }
function todayIso(){ return new Date().toISOString(); }

/* ---------------- Default state ---------------- */
function defaultState(){
  return {
    version:1,
    theme:"dark",
    players:[],            // {id,name,prefs:[pos,...],unavailable:[gameNum,...]}
    fillIns:[],            // {id,name,prefs:[pos,...]}
    season:{numGames:11, desiredBenchSize:2},
    games:{},              // gameNum(string) -> gameState
    settings:{
      preferenceSlider:9,        // 0..10 — defaults to strongly favouring preference (see Settings tab)
      allowOffPreference:true,
      topTwoOnly:false,          // §4 rule 4 toggle
      rosterOffWeight:10,        // 0..10 — roster-off fairness <-> position coverage; 10 reproduces the original hardcoded default ratio
      fairnessWeights:{bench:2, positionPurity:1} // relative priority order, higher = more important
    },
    activeTab:"setup"
  };
}
function newGameState(){
  return {
    isPlayed:false,
    rosterOffOverride:null,     // number|null - overrides derived roster_off_count
    rosterOffLockIds:null,      // array of playerIds|null - manual explicit roster-off selection (locked)
    fillInIds:[],               // fill-ins assigned to this game
    lockedSlots:{},             // "q-pos" -> playerId (manual lock, survives rebalance)
    schedule:null,              // computed: {quarters:[{onCourt:{pos:playerId|fillinId},bench:[ids],offPreference:{pos:true}}]}
    squadIds:null,              // computed regular player ids in squad (post roster-off)
    rosteredOffIds:null,        // computed
    unavailableIds:null,        // computed (regulars unavailable this game)
    shortfall:false,
    generated:false,
    coverageWarnings:[]         // computed: [{position,count,causedBy:[names]}]
  };
}

/* ---------------- State ---------------- */
let STATE = loadState();

function loadState(){
  try{
    const raw = localStorage.getItem(STORAGE_KEY);
    if(!raw) return defaultState();
    const parsed = JSON.parse(raw);
    const d = defaultState();
    const merged = Object.assign(d, parsed, {
      players: parsed.players||[],
      fillIns: parsed.fillIns||[],
      season: Object.assign(d.season, parsed.season||{}),
      games: parsed.games||{},
      settings: Object.assign(d.settings, parsed.settings||{}, {fairnessWeights:Object.assign(d.settings.fairnessWeights,(parsed.settings&&parsed.settings.fairnessWeights)||{})})
    });
    delete merged.settings.strictSpecialistMode; // superseded by the season-wide roster-off search's coverage term
    delete merged.settings.fairnessWeights.missed; // missed-games evenness is a weighted objective now, not a tunable weight
    delete merged.settings.fairnessWeights.onCourt; // merged into the single "bench" playing-time-evenness weight
    Object.values(merged.games||{}).forEach(g=>{
      delete g.strictSpecialistMode;
      if(!Array.isArray(g.coverageWarnings)) g.coverageWarnings=[];
    });
    return merged;
  }catch(e){ console.warn("Failed to load state, starting fresh.",e); return defaultState(); }
}
function saveState(){
  try{ localStorage.setItem(STORAGE_KEY, JSON.stringify(STATE)); }
  catch(e){ toast("Could not save to local storage ("+e.message+")"); }
}
function gameNums(){
  const n = STATE.season.numGames;
  const arr=[]; for(let i=1;i<=n;i++) arr.push(i); return arr;
}
function getGame(num){
  const key=String(num);
  if(!STATE.games[key]) STATE.games[key]=newGameState();
  return STATE.games[key];
}
function ensureGamesExist(){
  gameNums().forEach(n=>getGame(n));
  // prune games beyond numGames
  Object.keys(STATE.games).forEach(k=>{ if(Number(k)>STATE.season.numGames) delete STATE.games[k]; });
}


/* ============================================================
   ENGINE
   Orchestrates RosterSolver (solver.js) + Hungarian (hungarian.js):
   Phase 1 season-wide roster-off search, then Phase 2a/2b per game
   in order. See solver.js for the actual algorithms/cost functions —
   this section only builds plain-data inputs from STATE and writes
   results back onto STATE.games[n].
   ============================================================ */

function regularRosterInvalid(){
  const n = STATE.players.length;
  const need = 7 + Number(STATE.season.desiredBenchSize||0);
  if(n===0) return null;
  if(need > n) return `Desired bench size (${STATE.season.desiredBenchSize}) needs a squad of ${need} (7 on court + bench), but the roster only has ${n} player(s). Lower the bench size or add players.`;
  return null;
}

function playerLabel(p){ return p ? p.name : "—"; }

/* Build the pool of "playable units": regular players + assigned fill-ins,
   each normalised to {id, name, prefs, isFillIn} */
function poolFor(game){
  const regulars = STATE.players.map(p=>({id:p.id,name:p.name,prefs:p.prefs.slice(),isFillIn:false}));
  const fillins = (game.fillInIds||[]).map(fid=>{
    const f = byId(STATE.fillIns, fid);
    return f ? {id:f.id,name:f.name,prefs:f.prefs.slice(),isFillIn:true} : null;
  }).filter(Boolean);
  return {regulars, fillins};
}

function isUnavailable(player, gameNum){
  return (player.unavailable||[]).includes(gameNum);
}

/* Availability facts for one game that don't depend on which specific players
   end up rostered off: who's available, whether it's a shortfall game, and
   how many (if any) need to be rostered off — or, if that's already fixed
   (played / shortfall / manually locked), exactly who. Feeds Phase 1's
   season-wide input; `fixedOffIds !== null` means Phase 1 doesn't decide it. */
function planGameAvailability(gameNum){
  const game = getGame(gameNum);
  const regulars = STATE.players;
  const availableRegulars = regulars.filter(p=>!isUnavailable(p,gameNum));
  const unavailableIds = regulars.filter(p=>isUnavailable(p,gameNum)).map(p=>p.id);
  const shortfall = availableRegulars.length < 7;
  const minFillIns = shortfall ? (7-availableRegulars.length) : 0;
  const recommendedFillIns = shortfall ? minFillIns+1 : 0;

  let rosterOffCount = 0;
  let fixedOffIds = null;

  if(shortfall){
    // §6: don't force the normal roster-off rule; use all available regulars + fill-ins
    fixedOffIds = [];
  } else if(game.isPlayed){
    fixedOffIds = (game.rosteredOffIds||[]).filter(id=>availableRegulars.some(p=>p.id===id));
  } else if(game.rosterOffLockIds && game.rosterOffLockIds.length){
    fixedOffIds = game.rosterOffLockIds.filter(id=>availableRegulars.some(p=>p.id===id));
  } else if(Number.isFinite(game.rosterOffOverride)){
    rosterOffCount = clamp(game.rosterOffOverride,0,Math.max(0,availableRegulars.length-7));
  } else {
    rosterOffCount = Math.max(0, availableRegulars.length-(7+Number(STATE.season.desiredBenchSize||0)));
  }

  return {
    shortfall, minFillIns, recommendedFillIns,
    availableRegularIds: availableRegulars.map(p=>p.id),
    unavailableIds, rosterOffCount, fixedOffIds
  };
}

/* This game's actual squad: available regulars minus whatever is currently
   stored on game.rosteredOffIds (the Phase 1 decision, or a fixed value for
   played/shortfall/locked games) plus assigned fill-ins. Used both for
   display (dialogs, gap suggestions) and, during generation, as Phase 2's
   input once Phase 1 has written rosteredOffIds for every game. */
function planGameSquad(gameNum){
  const game = getGame(gameNum);
  const avail = planGameAvailability(gameNum);
  const availIdSet = new Set(avail.availableRegularIds);
  const availableRegulars = STATE.players.filter(p=>availIdSet.has(p.id));
  const assignedFillIns = (game.fillInIds||[]).map(fid=>byId(STATE.fillIns,fid)).filter(Boolean);
  const rosteredOffIds = avail.shortfall ? [] : (game.rosteredOffIds || avail.fixedOffIds || []);
  const rosteredOffSet = new Set(rosteredOffIds);

  const squad = availableRegulars.filter(p=>avail.shortfall || !rosteredOffSet.has(p.id))
    .map(p=>({id:p.id,name:p.name,prefs:p.prefs.slice(),isFillIn:false}))
    .concat(assignedFillIns.map(f=>({id:f.id,name:f.name,prefs:f.prefs.slice(),isFillIn:true})));

  return {
    shortfall: avail.shortfall, minFillIns: avail.minFillIns, recommendedFillIns: avail.recommendedFillIns,
    availableRegularIds: avail.availableRegularIds, unavailableIds: avail.unavailableIds,
    rosteredOffIds, squad,
    noBenchOnly: !avail.shortfall && squad.length===7 && availableRegulars.length===7 && rosteredOffIds.length===0
  };
}

/* After roster-off, flag any position where 0 or 1 of the resulting squad's members list
   it in their preferences — the coverage warning is informational regardless of whether
   strict specialist pairing is on for this game. */
function computeCoverageWarnings(plan){
  if(plan.shortfall) return [];
  const warnings = [];
  POSITIONS.forEach(pos=>{
    const coverers = plan.squad.filter(p=>p.prefs.includes(pos));
    if(coverers.length<=1){
      const causedBy = plan.rosteredOffIds
        .map(id=>byId(STATE.players,id))
        .filter(p=>p && p.prefs.includes(pos))
        .map(p=>p.name);
      warnings.push({position:pos, count:coverers.length, causedBy});
    }
  });
  return warnings;
}

/* fill-in position gap suggestions for a shortfall game */
function fillInGapSuggestions(gameNum){
  const avail = planGameAvailability(gameNum);
  if(!avail.shortfall) return [];
  const availIds = new Set(avail.availableRegularIds);
  const availPlayers = STATE.players.filter(p=>availIds.has(p.id));
  return POSITIONS.filter(pos=>{
    const coverage = availPlayers.filter(p=>p.prefs.includes(pos)).length;
    return coverage<=1;
  });
}

function emptyCumulative(){
  return {missed:{}, onCourt:{}, bench:{}, posCount:{}};
}
function bumpCum(cumulative, key, id, amt){
  cumulative[key][id] = (cumulative[key][id]||0) + amt;
}
function posCountKey(id,pos){ return id+"::"+pos; }

/* Apply a game's *actual* outcome (played or freshly generated) into cumulative totals */
function foldGameIntoCumulative(cumulative, rosteredOffIds, unavailableIds, schedule){
  unavailableIds.forEach(id=>bumpCum(cumulative,"missed",id,1));
  rosteredOffIds.forEach(id=>bumpCum(cumulative,"missed",id,1));
  if(!schedule) return;
  schedule.quarters.forEach(q=>{
    POSITIONS.forEach(pos=>{
      const pid = q.onCourt[pos];
      if(!pid) return;
      const isFillIn = STATE.fillIns.some(f=>f.id===pid);
      if(isFillIn) return; // §6: fill-ins excluded from fairness totals
      bumpCum(cumulative,"onCourt",pid,1);
      const pck = posCountKey(pid,pos);
      cumulative.posCount[pck] = (cumulative.posCount[pck]||0)+1;
    });
    (q.bench||[]).forEach(pid=>{
      const isFillIn = STATE.fillIns.some(f=>f.id===pid);
      if(isFillIn) return;
      bumpCum(cumulative,"bench",pid,1);
    });
  });
}

function buildOffPrefLog(gameNum, quarterIdx, pos, playerId, squad){
  const player = byId(STATE.players,playerId) || byId(STATE.fillIns,playerId);
  const specialists = STATE.players.filter(p=>p.id!==playerId && p.prefs.includes(pos));
  const squadIds = new Set(squad.map(p=>p.id));
  const unavailableSpecialists = specialists.filter(p=>!squadIds.has(p.id)).map(p=>p.name);
  return {
    game:gameNum, quarter:quarterIdx+1, playerId, playerName: player?player.name:"?",
    position:pos, unavailableSpecialists
  };
}

/* Phase 1 only: run the season-wide roster-off search and write availability
   facts + the resulting rosteredOffIds/coverageWarnings onto every game.
   Does not touch schedules. Used by runGeneration (before Phase 2) and by
   importFullCsv (to re-derive these display fields after loading a CSV). */
function computeSeasonRosterOff(){
  const nums = gameNums();
  const availByNum = {};
  nums.forEach(num=>{ availByNum[num] = planGameAvailability(num); });

  const seasonPlayers = STATE.players.map(p=>({
    id: p.id, prefs: p.prefs.slice(),
    unavailableCount: (p.unavailable||[]).filter(g=>nums.includes(g)).length
  }));
  const seasonGames = nums.map(num=>{
    const a = availByNum[num];
    return {
      num,
      availableIds: a.availableRegularIds,
      rosterOffCount: a.fixedOffIds!=null ? a.fixedOffIds.length : a.rosterOffCount,
      fixedOffIds: a.fixedOffIds
    };
  });
  const phase1 = RosterSolver.solveSeasonRosterOff({
    players: seasonPlayers, games: seasonGames,
    weights: RosterSolver.deriveRosterOffWeights(STATE.settings.rosterOffWeight),
    allowOffPreference: !!STATE.settings.allowOffPreference
  });

  nums.forEach(num=>{
    const game = getGame(num);
    const a = availByNum[num];
    game.rosteredOffIds = a.shortfall ? [] : (phase1.rosterOffByGame[num]||[]);
    game.unavailableIds = a.unavailableIds;
    game.shortfall = a.shortfall;
    game.minFillIns = a.minFillIns;
    game.recommendedFillIns = a.recommendedFillIns;
    const plan = planGameSquad(num);
    game.noBenchOnly = plan.noBenchOnly;
    game.coverageWarnings = computeCoverageWarnings(plan);
    if(!game.squadIds || !game.squadIds.length) game.squadIds = plan.squad.map(p=>p.id);
  });

  return phase1.stats;
}

/* Generate (or re-generate) the full season: Phase 1 decides roster-off for
   every game at once (season-wide), then Phase 2 solves each unplayed game's
   positions (Hungarian, per quarter) and refines across that game's own
   quarters, in game order — skipping played games, respecting per-slot locks
   and roster-off locks. Used by both "Generate" and "Rebalance". */
function runGeneration(){
  ensureGamesExist();
  const invalid = regularRosterInvalid();
  const startTime = Date.now();
  const phase1Stats = computeSeasonRosterOff();

  const offPrefLog = [];
  const cumulative = emptyCumulative();
  const nums = gameNums();

  nums.forEach(num=>{
    const game = getGame(num);
    const plan = planGameSquad(num);
    game.squadIds = plan.squad.map(p=>p.id);
    game.noBenchOnly = plan.noBenchOnly;
    game.coverageWarnings = computeCoverageWarnings(plan);

    if(game.isPlayed){
      // locked: leave schedule untouched, but still fold into cumulative fairness
      foldGameIntoCumulative(cumulative, game.rosteredOffIds, game.unavailableIds, game.schedule);
      return;
    }

    if(plan.squad.length<7){
      game.error = `Not enough players for game ${num}: ${plan.squad.length} available (need 7). Add ${7-plan.squad.length} more fill-in(s).`;
      game.schedule = null; game.generated=false;
      foldGameIntoCumulative(cumulative, game.rosteredOffIds, game.unavailableIds, null);
      return;
    }
    game.error = null;

    const benchCount = plan.squad.length-7;
    const gameBenchSoFar = {};
    let benchedLastQuarter = new Set();
    const quarters = [];
    const cumulativeSnapshots = [];
    const lockedSlotsPerQuarter = [];
    let quarterError = null;

    for(let q=0;q<4;q++){
      const lockedSlots = {};
      POSITIONS.forEach(pos=>{
        const lockKey = q+"-"+pos;
        if(game.lockedSlots && game.lockedSlots[lockKey]) lockedSlots[pos]=game.lockedSlots[lockKey];
      });
      lockedSlotsPerQuarter.push(lockedSlots);
      const snapshot = {
        posCount: Object.assign({}, cumulative.posCount),
        onCourt: Object.assign({}, cumulative.onCourt),
        bench: Object.assign({}, cumulative.bench),
        gameBenchSoFar: Object.assign({}, gameBenchSoFar),
        benchedLastQuarter: new Set(benchedLastQuarter)
      };
      cumulativeSnapshots.push(snapshot);

      const result = RosterSolver.solveQuarterPositions({
        players: plan.squad, benchSlotCount: benchCount, lockedSlots,
        cumulative: snapshot, settings: STATE.settings
      });

      if(result.errors.length){
        quarterError = `Game ${num}, Quarter ${q+1}: no eligible in-preference player for ${result.errors.map(e=>e.position).join(", ")}. Add/adjust a fill-in, or allow off-preference positions.`;
      }

      // fold this quarter immediately so later quarters in same game see updated counts
      POSITIONS.forEach(pos=>{
        const pid = result.onCourt[pos]; if(!pid) return;
        const isFillIn = STATE.fillIns.some(f=>f.id===pid);
        if(isFillIn) return;
        const pck = posCountKey(pid,pos);
        cumulative.posCount[pck]=(cumulative.posCount[pck]||0)+1;
        cumulative.onCourt[pid]=(cumulative.onCourt[pid]||0)+1;
      });
      result.bench.forEach(pid=>{
        const isFillIn = STATE.fillIns.some(f=>f.id===pid);
        if(isFillIn) return;
        cumulative.bench[pid]=(cumulative.bench[pid]||0)+1;
        gameBenchSoFar[pid]=(gameBenchSoFar[pid]||0)+1;
      });
      benchedLastQuarter = new Set(result.bench);
      quarters.push({onCourt:result.onCourt, bench:result.bench, offPreference:result.offPreference});
    }

    // Phase 2b: bounded local-search refinement across this game's own 4 quarters only.
    const refined = RosterSolver.refineGameQuarters({
      quarters, squadPool: plan.squad, cumulativeSnapshots, lockedSlotsPerQuarter, settings: STATE.settings
    });

    refined.quarters.forEach((q,qi)=>{
      POSITIONS.forEach(pos=>{
        if(q.offPreference && q.offPreference[pos]) offPrefLog.push(buildOffPrefLog(num,qi,pos,q.onCourt[pos],plan.squad));
      });
    });

    plan.unavailableIds.forEach(id=>bumpCum(cumulative,"missed",id,1));
    plan.rosteredOffIds.forEach(id=>bumpCum(cumulative,"missed",id,1));

    game.schedule = {quarters:refined.quarters};
    game.generated = true;
    game.error = quarterError;
  });

  STATE._offPrefLog = offPrefLog;
  STATE._lastGeneratedAt = todayIso();
  STATE._lastGenerationMs = Date.now()-startTime;
  console.log(`Season generation took ${STATE._lastGenerationMs}ms (Phase 1: ${phase1Stats.elapsedMs}ms across ${phase1Stats.passes} pass(es)).`);
  saveState();
  return {invalid, offPrefLog, phase1Stats, elapsedMs: STATE._lastGenerationMs};
}

/* Season-wide player summary stats (for reports) */
function computePlayerSummaries(){
  const summary = {};
  STATE.players.forEach(p=>{ summary[p.id]={id:p.id,name:p.name,onCourt:0,bench:0,missed:0,gamesPlayedIn:0,positions:{},offPrefPositions:{},offPrefTotal:0}; POSITIONS.forEach(pos=>summary[p.id].positions[pos]=0); });
  gameNums().forEach(num=>{
    const game = getGame(num);
    (game.rosteredOffIds||[]).forEach(id=>{ if(summary[id]) summary[id].missed++; });
    (game.unavailableIds||[]).forEach(id=>{ if(summary[id]) summary[id].missed++; });
    if(!game.schedule) return;
    const playedThisGame = new Set();
    game.schedule.quarters.forEach(q=>{
      POSITIONS.forEach(pos=>{
        const pid=q.onCourt[pos]; if(!pid || !summary[pid]) return;
        summary[pid].onCourt++; summary[pid].positions[pos]++; playedThisGame.add(pid);
        if(q.offPreference && q.offPreference[pos]){
          summary[pid].offPrefTotal++;
          summary[pid].offPrefPositions[pos]=(summary[pid].offPrefPositions[pos]||0)+1;
        }
      });
      (q.bench||[]).forEach(pid=>{ if(summary[pid]){ summary[pid].bench++; playedThisGame.add(pid);} });
    });
    playedThisGame.forEach(pid=>{ if(summary[pid]) summary[pid].gamesPlayedIn++; });
  });
  return Object.values(summary);
}

function computeOffPrefLog(){ return STATE._offPrefLog||[]; }
function computeOffPrefRate(){
  const log = computeOffPrefLog();
  let totalSlots=0;
  gameNums().forEach(num=>{ const g=getGame(num); if(g.schedule) totalSlots += g.schedule.quarters.length*7; });
  return {count:log.length, totalSlots, rate: totalSlots? (log.length/totalSlots*100):0};
}

/* Informational-only: how uneven total missed games (unavailable + rostered off)
   is across the roster. Never fed back into generation — see RosterSolver.computeMissedGamesWarning. */
function computeMissedGamesWarningForReports(){
  const list = computePlayerSummaries().map(s=>({id:s.id, name:s.name, missed:s.missed}));
  return RosterSolver.computeMissedGamesWarning(list);
}

/* Roster-composition-based note: positions so thin that perfectly even
   missed-games counts are structurally out of reach, independent of settings. */
function computeRosterOffAchievabilityNotesForReports(){
  return RosterSolver.computeRosterOffAchievabilityNotes(STATE.players.map(p=>({name:p.name, prefs:p.prefs})));
}

/* ============================================================
   TOASTS / MODALS
   ============================================================ */
function toast(msg){
  let stack = document.querySelector(".toast-stack");
  if(!stack){ stack=document.createElement("div"); stack.className="toast-stack"; document.body.appendChild(stack); }
  const el = document.createElement("div"); el.className="toast"; el.textContent=msg;
  stack.appendChild(el);
  setTimeout(()=>{ el.style.opacity="0"; el.style.transition="opacity .25s"; setTimeout(()=>el.remove(),260); }, 2600);
}
function closeModal(){
  const bd = document.querySelector(".modal-backdrop");
  if(bd) bd.remove();
}
function openModal(html, onMount){
  closeModal();
  const bd = document.createElement("div");
  bd.className="modal-backdrop";
  bd.innerHTML = `<div class="modal" role="dialog" aria-modal="true">${html}</div>`;
  bd.addEventListener("mousedown", e=>{ if(e.target===bd) closeModal(); });
  document.body.appendChild(bd);
  if(onMount) onMount(bd.querySelector(".modal"));
  return bd.querySelector(".modal");
}
function confirmDialog(title, msg, onYes){
  openModal(`
    <h3>${esc(title)}</h3>
    <p class="modal-sub">${esc(msg)}</p>
    <div class="modal-actions">
      <button class="btn" data-act="cancel">Cancel</button>
      <button class="btn btn-primary" data-act="yes">Confirm</button>
    </div>`, m=>{
    m.querySelector('[data-act="cancel"]').onclick=closeModal;
    m.querySelector('[data-act="yes"]').onclick=()=>{ closeModal(); onYes(); };
  });
}

/* ============================================================
   RENDER: SHELL
   ============================================================ */
const TABS = [
  {id:"setup", label:"Setup"},
  {id:"schedule", label:"Schedule"},
  {id:"fillins", label:"Fill-ins"},
  {id:"reports", label:"Reports"},
  {id:"settings", label:"Settings"},
  {id:"data", label:"Data"}
];

function render(){
  document.documentElement.setAttribute("data-theme", STATE.theme);
  const app = document.getElementById("app");
  app.innerHTML = `
    <div class="topbar">
      <div class="topbar-inner">
        <div class="brand">
          <div class="brand-mark">GK</div>
          <div>
            <h1>Season Roster</h1>
            <div class="sub">Netball rotation &amp; fairness planner · v${APP_VERSION}</div>
          </div>
        </div>
        <div class="topbar-actions">
          <button class="icon-btn" id="themeToggle" title="Toggle dark / light mode">${STATE.theme==="dark"?"&#9728;":"&#9789;"}</button>
        </div>
      </div>
      <div class="tabs" id="tabs">
        ${TABS.map(t=>`<button class="tab-btn ${STATE.activeTab===t.id?'active':''}" data-tab="${t.id}">${t.label}</button>`).join("")}
      </div>
    </div>
    <main id="main"></main>
  `;
  document.getElementById("themeToggle").onclick=()=>{
    STATE.theme = STATE.theme==="dark"?"light":"dark"; saveState(); render();
  };
  document.querySelectorAll("[data-tab]").forEach(b=>b.onclick=()=>{ STATE.activeTab=b.dataset.tab; saveState(); renderMain(); syncTabButtons(); });
  renderMain();
}
function syncTabButtons(){
  document.querySelectorAll("[data-tab]").forEach(b=>b.classList.toggle("active", b.dataset.tab===STATE.activeTab));
}
function renderMain(){
  const main = document.getElementById("main");
  ensureGamesExist();
  const fns = {setup:renderSetup, schedule:renderSchedule, fillins:renderFillIns, reports:renderReports, settings:renderSettings, data:renderData};
  main.innerHTML = `<div class="panel active" id="panelRoot"></div>`;
  fns[STATE.activeTab](document.getElementById("panelRoot"));
}

/* ============================================================
   RENDER: SETUP TAB
   ============================================================ */
function renderSetup(root){
  const invalidMsg = regularRosterInvalid();
  root.innerHTML = `
    <div class="card">
      <div class="card-head">
        <div><h2>Season parameters</h2><p>Drives roster-off &amp; bench math for every game.</p></div>
      </div>
      <div class="row">
        <div class="field"><label>Number of games</label>
          <input type="number" id="numGames" min="1" max="60" value="${STATE.season.numGames}"></div>
        <div class="field"><label>Desired bench size</label>
          <input type="number" id="benchSize" min="0" max="20" value="${STATE.season.desiredBenchSize}"></div>
      </div>
      ${invalidMsg? `<div class="pill pill-danger" style="display:block;margin-top:4px;">${esc(invalidMsg)}</div>` : `<p class="hint">On-court is always 7. Roster-off count per game = available regulars − (7 + desired bench size), auto-derived unless you override a specific game in the Schedule tab.</p>`}
    </div>

    <div class="card">
      <div class="card-head">
        <div><h2>Players (${STATE.players.length})</h2><p>Ordered position preferences, best first.</p></div>
        <div class="btn-row">
          <button class="btn btn-sm" id="importCsvBtn">Import CSV</button>
          <input type="file" id="csvFileInput" accept=".csv" hidden>
          <button class="btn btn-primary btn-sm" id="addPlayerBtn">+ Add player</button>
        </div>
      </div>
      <div id="playerList"></div>
    </div>
  `;
  renderPlayerList(document.getElementById("playerList"));

  document.getElementById("numGames").onchange=e=>{
    const v = clamp(parseInt(e.target.value||"1",10),1,60);
    STATE.season.numGames=v; ensureGamesExist(); saveState(); renderSetup(root);
  };
  document.getElementById("benchSize").onchange=e=>{
    STATE.season.desiredBenchSize = clamp(parseInt(e.target.value||"0",10),0,20); saveState(); renderSetup(root);
  };
  document.getElementById("addPlayerBtn").onclick=()=>openPlayerDialog(null);
  document.getElementById("importCsvBtn").onclick=()=>document.getElementById("csvFileInput").click();
  document.getElementById("csvFileInput").onchange=e=>{
    const f = e.target.files[0]; if(!f) return;
    const reader = new FileReader();
    reader.onload = ev=>{ importPlayersCsv(ev.target.result); e.target.value=""; };
    reader.readAsText(f);
  };
}

function renderPlayerList(el){
  if(!STATE.players.length){
    el.innerHTML = `<div class="empty-state"><div class="glyph">&#127940;</div>
      <div>No players yet.</div>
      <div class="cta">Add your squad, or import a CSV of names + preferences.</div></div>`;
    return;
  }
  el.innerHTML = STATE.players.map(p=>`
    <div class="list-row">
      <div style="flex:1;min-width:0;">
        <div class="player-name">${esc(p.name)}</div>
        <div class="player-meta">
          ${p.prefs.map((pos,i)=>`<span class="pos-badge pos-${pos}" title="${POS_LABEL[pos]}">${pos}</span>`).join(" ")}
          ${p.unavailable&&p.unavailable.length? `<span class="pill pill-warn" style="margin-left:6px;">Out: ${p.unavailable.map(g=>"G"+g).join(", ")}</span>`:""}
        </div>
      </div>
      <div class="btn-row" style="margin:0;">
        <button class="btn btn-sm" data-edit="${p.id}">Edit</button>
        <button class="btn btn-sm btn-danger" data-del="${p.id}">Remove</button>
      </div>
    </div>
  `).join("");
  el.querySelectorAll("[data-edit]").forEach(b=>b.onclick=()=>openPlayerDialog(b.dataset.edit));
  el.querySelectorAll("[data-del]").forEach(b=>b.onclick=()=>{
    const p = byId(STATE.players,b.dataset.del);
    confirmDialog("Remove player", `Remove ${p.name} from the roster? This also clears them from any generated schedule.`, ()=>{
      STATE.players = STATE.players.filter(x=>x.id!==b.dataset.del);
      saveState(); renderMain();
    });
  });
}

function openPlayerDialog(playerId){
  const existing = playerId ? byId(STATE.players,playerId) : null;
  const draft = existing ? deepClone(existing) : {id:uid("p"), name:"", prefs:[], unavailable:[]};
  const isDup = name => STATE.players.some(p=>p.id!==draft.id && p.name.trim().toLowerCase()===name.trim().toLowerCase());

  const m = openModal(`
    <h3>${existing?"Edit player":"Add player"}</h3>
    <p class="modal-sub">Preferences are ordered best-to-worst. Positions not listed are treated as off-preference.</p>
    <div class="field"><label>Name</label><input type="text" id="pfName" value="${esc(draft.name)}" placeholder="e.g. Jess Nguyen"></div>
    <div class="field" id="dupWarn" style="display:none;"><span class="pill pill-danger">A player with this name already exists</span></div>
    <div class="field">
      <label>Position preferences (click to add, in order)</label>
      <div id="prefChips" style="min-height:30px;"></div>
      <div class="btn-row" id="prefButtons"></div>
    </div>
    <div class="field">
      <label>Unavailable for game numbers (comma-separated, e.g. "3, 7")</label>
      <input type="text" id="pfUnavail" value="${(draft.unavailable||[]).join(', ')}">
    </div>
    <div class="modal-actions">
      <button class="btn" data-act="cancel">Cancel</button>
      <button class="btn btn-primary" data-act="save">${existing?"Save changes":"Add player"}</button>
    </div>
  `, modal=>{
    function paintChips(){
      modal.querySelector("#prefChips").innerHTML = draft.prefs.length
        ? draft.prefs.map((pos,i)=>`<span class="pref-chip"><span class="pref-rank">${i+1}</span><span class="pos-badge pos-${pos}">${pos}</span>${POS_LABEL[pos]}<button data-rm="${pos}" title="Remove">&times;</button></span>`).join("")
        : `<span class="hint">No preferences set yet — click a position below.</span>`;
      modal.querySelectorAll("[data-rm]").forEach(b=>b.onclick=()=>{ draft.prefs = draft.prefs.filter(p=>p!==b.dataset.rm); paintChips(); paintButtons(); });
    }
    function paintButtons(){
      modal.querySelector("#prefButtons").innerHTML = POSITIONS.filter(p=>!draft.prefs.includes(p))
        .map(pos=>`<button class="btn btn-sm" data-add="${pos}"><span class="pos-badge pos-${pos}">${pos}</span> ${POS_LABEL[pos]}</button>`).join("");
      modal.querySelectorAll("[data-add]").forEach(b=>b.onclick=()=>{ draft.prefs.push(b.dataset.add); paintChips(); paintButtons(); });
    }
    paintChips(); paintButtons();
    modal.querySelector("#pfName").addEventListener("input", e=>{
      modal.querySelector("#dupWarn").style.display = isDup(e.target.value) && e.target.value.trim() ? "block":"none";
    });
    modal.querySelector('[data-act="cancel"]').onclick=closeModal;
    modal.querySelector('[data-act="save"]').onclick=()=>{
      const name = modal.querySelector("#pfName").value.trim();
      if(!name){ toast("Enter a name first."); return; }
      if(isDup(name)){ toast("That name is already on the roster."); return; }
      draft.name = name;
      draft.unavailable = modal.querySelector("#pfUnavail").value.split(",").map(s=>parseInt(s.trim(),10)).filter(n=>Number.isFinite(n)&&n>0);
      if(existing){ Object.assign(existing, draft); }
      else STATE.players.push(draft);
      saveState(); closeModal(); renderMain();
    };
  });
}

function importPlayersCsv(text){
  try{
    const rows = parseCsv(text);
    if(!rows.length){ toast("CSV appears empty."); return; }
    let header = rows[0].map(h=>h.trim().toLowerCase());
    let startIdx = 1;
    if(!header.includes("name")){ header=["name","preferences"]; startIdx=0; }
    const nameIdx = header.indexOf("name");
    const prefIdx = header.indexOf("preferences")>=0?header.indexOf("preferences"):1;
    let added=0, skipped=0;
    for(let i=startIdx;i<rows.length;i++){
      const r = rows[i]; if(!r || !r[nameIdx] || !r[nameIdx].trim()) continue;
      const name = r[nameIdx].trim();
      if(STATE.players.some(p=>p.name.toLowerCase()===name.toLowerCase())){ skipped++; continue; }
      const prefsRaw = (r[prefIdx]||"").trim();
      const prefs = prefsRaw.split(/[|,;\s]+/).map(s=>s.toUpperCase().trim()).filter(s=>POSITIONS.includes(s));
      STATE.players.push({id:uid("p"), name, prefs, unavailable:[]});
      added++;
    }
    saveState(); renderMain();
    toast(`Imported ${added} player(s)${skipped?`, skipped ${skipped} duplicate(s)`:""}.`);
  }catch(e){ toast("Could not read that CSV: "+e.message); }
}

/* Minimal RFC4180-ish CSV parser (handles quoted fields, commas, newlines) */
function parseCsv(text){
  const rows=[]; let row=[]; let field=""; let inQuotes=false;
  text = text.replace(/\r\n/g,"\n").replace(/\r/g,"\n");
  for(let i=0;i<text.length;i++){
    const c=text[i];
    if(inQuotes){
      if(c==='"'){ if(text[i+1]==='"'){field+='"';i++;} else inQuotes=false; }
      else field+=c;
    } else {
      if(c==='"') inQuotes=true;
      else if(c===','){ row.push(field); field=""; }
      else if(c==='\n'){ row.push(field); rows.push(row); row=[]; field=""; }
      else field+=c;
    }
  }
  if(field.length||row.length){ row.push(field); rows.push(row); }
  return rows.filter(r=>r.some(f=>f.trim()!==""));
}
function toCsvField(v){
  v = v==null?"":String(v);
  if(/[",\n]/.test(v)) return '"'+v.replace(/"/g,'""')+'"';
  return v;
}

/* ============================================================
   RENDER: SCHEDULE TAB
   ============================================================ */
let scheduleUiState = { openGame:null };

function renderSchedule(root){
  const invalidMsg = regularRosterInvalid();
  const hasAnyGenerated = gameNums().some(n=>getGame(n).generated || getGame(n).isPlayed);
  root.innerHTML = `
    <div class="card">
      <div class="card-head">
        <div><h2>Generate &amp; rebalance</h2><p>Runs the assignment engine across every unplayed game, in order.</p></div>
        <div class="btn-row">
          <button class="btn btn-primary" id="genBtn" ${invalidMsg||!STATE.players.length?"disabled":""}>Generate season</button>
          <button class="btn" id="rebalBtn" ${invalidMsg||!STATE.players.length?"disabled":""}>Rebalance remaining games</button>
        </div>
      </div>
      ${!STATE.players.length? `<p class="hint">Add players in the Setup tab first.</p>` :
        invalidMsg ? `<div class="pill pill-danger">${esc(invalidMsg)}</div>` :
        `<p class="hint">Rebalance re-runs the same engine honoring every lock and edit you've made — played games and manually locked slots are never touched, but the fairness math folds their results in.</p>`}
      ${Number.isFinite(STATE._lastGenerationMs)? `<p class="hint">Last generation took ${STATE._lastGenerationMs}ms.</p>` : ""}
      <div id="genSummary"></div>
    </div>
    <div id="gamesList"></div>
  `;
  document.getElementById("genBtn").onclick=()=>{ const r=runGeneration(); toast(`Season generated in ${r.elapsedMs}ms.`); renderSchedule(root); };
  document.getElementById("rebalBtn").onclick=()=>{ const r=runGeneration(); toast(`Remaining games rebalanced in ${r.elapsedMs}ms.`); renderSchedule(root); };
  renderGamesList(document.getElementById("gamesList"));
}

function renderGamesList(el){
  el.innerHTML = gameNums().map(num=>renderGameCard(num)).join("");
  gameNums().forEach(num=>wireGameCard(el, num));
}

function statusPillsForGame(game, num){
  const pills=[];
  if(game.isPlayed) pills.push(`<span class="game-locked-banner">&#128274; Played &amp; locked</span>`);
  if(game.error) pills.push(`<span class="pill pill-danger">${esc(game.error)}</span>`);
  else if(game.shortfall) pills.push(`<span class="pill pill-danger">Shortfall — recommend ${game.recommendedFillIns} fill-in(s)</span>`);
  else if(game.noBenchOnly) pills.push(`<span class="pill pill-warn">No bench this game</span>`);
  if(!game.error && game.generated) pills.push(`<span class="pill pill-ok">Generated</span>`);
  if(!game.generated && !game.isPlayed && !game.error) pills.push(`<span class="pill pill-muted">Not yet generated</span>`);
  (game.coverageWarnings||[]).forEach(w=>{
    const causedText = w.causedBy && w.causedBy.length ? ` — rostered off: ${w.causedBy.join(", ")}` : "";
    const suggestion = `Consider enabling strict specialist pairing for this game, lowering the desired bench size, or adding a fill-in comfortable at ${w.position}.`;
    pills.push(`<span class="pill pill-warn" title="${esc(suggestion)}">Low ${w.position} coverage: ${w.count} player(s)${esc(causedText)}</span>`);
  });
  return pills.join(" ");
}

function renderGameCard(num){
  const game = getGame(num);
  const open = scheduleUiState.openGame===num;
  return `
  <div class="game-card" data-game="${num}">
    <div class="game-card-head">
      <h4>Game ${num}</h4>
      <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap;">
        ${statusPillsForGame(game,num)}
        <button class="btn btn-sm" data-toggle="${num}">${open?"Hide":"Details"}</button>
      </div>
    </div>
    <div id="gameBody-${num}">${open?renderGameBody(num):""}</div>
  </div>`;
}

function renderGameBody(num){
  const game = getGame(num);
  const avail = planGameAvailability(num);
  const rosteredOffNames = (game.rosteredOffIds||[]).map(id=>playerLabel(byId(STATE.players,id))).join(", ")||"—";
  const unavailNames = (game.unavailableIds||[]).map(id=>playerLabel(byId(STATE.players,id))).join(", ")||"—";
  const fillinChips = (game.fillInIds||[]).map(fid=>{ const f=byId(STATE.fillIns,fid); return f?`<span class="pill pill-warn">${esc(f.name)} <button data-rmfillin="${fid}" style="background:none;border:none;color:inherit;cursor:pointer;">&times;</button></span>`:""; }).join(" ");

  let gapHtml="";
  if(avail.shortfall){
    const gaps = fillInGapSuggestions(num);
    gapHtml = `<div class="pill pill-danger" style="display:block;">Minimum ${avail.minFillIns} fill-in(s) needed, ${avail.recommendedFillIns} recommended for bench rotation.
      ${gaps.length?` Coverage gaps: ${gaps.join(", ")}.`:""}</div>`;
  }

  return `
    <div style="margin-top:12px;">
      <div class="row">
        <div>
          <div class="section-label">Rostered off</div>
          <div class="hint">${esc(rosteredOffNames)}</div>
          <button class="btn btn-sm" style="margin-top:6px;" data-manageoff="${num}" ${game.isPlayed?"disabled":""}>Set roster-off manually</button>
        </div>
        <div>
          <div class="section-label">Unavailable</div>
          <div class="hint">${esc(unavailNames)}</div>
        </div>
        <div>
          <div class="section-label">Bench-size override</div>
          <input type="number" class="mono" id="rosterOffOverride-${num}" placeholder="auto" min="0"
            value="${Number.isFinite(game.rosterOffOverride)?game.rosterOffOverride:''}" ${game.isPlayed?"disabled":""} style="max-width:100px;">
        </div>
      </div>
      ${gapHtml}
      <div class="section-label" style="margin-top:10px;">Fill-ins assigned to this game</div>
      <div>${fillinChips||'<span class="hint">None yet.</span>'}</div>
      <button class="btn btn-sm" data-assignfillin="${num}" style="margin-top:6px;" ${game.isPlayed?"disabled":""}>Assign a fill-in</button>

      <div class="section-label" style="margin-top:14px;">Rotation grid</div>
      ${renderRotationGrid(num)}
      <div class="legend">
        <span><span class="swatch" style="background:var(--surface-2);"></span> On court</span>
        <span><span class="swatch" style="background:var(--bg-alt);border:1px solid var(--border);"></span> Bench</span>
        <span><span class="swatch" style="outline:2px solid var(--danger);"></span> Off-preference</span>
        <span><span class="swatch" style="outline:2px dashed var(--warn);"></span> Fill-in</span>
        <span><span class="swatch" style="outline:2px solid var(--accent);"></span> Locked</span>
      </div>

      <div class="btn-row" style="margin-top:14px;">
        <button class="btn btn-sm ${game.isPlayed?'btn-danger':''}" data-toggleplayed="${num}">
          ${game.isPlayed?"Unlock (mark not played)":"Mark game as played (lock)"}
        </button>
      </div>
    </div>
  `;
}

function renderRotationGrid(num){
  const game = getGame(num);
  if(!game.schedule){
    return `<div class="empty-state" style="padding:20px;"><div class="cta">Not generated yet. Run Generate season above.</div></div>`;
  }
  const rows = game.schedule.quarters.map((q,qi)=>{
    const cells = POSITIONS.map(pos=>{
      const pid = q.onCourt[pos];
      const isFillIn = pid && STATE.fillIns.some(f=>f.id===pid);
      const isOffPref = q.offPreference && q.offPreference[pos];
      const lockKey = qi+"-"+pos;
      const isLocked = game.lockedSlots && game.lockedSlots[lockKey];
      const name = pid ? (byId(STATE.players,pid)||byId(STATE.fillIns,pid)||{}).name : "—";
      const classes = ["grid-cell","cell-oncourt","cell-clickable"];
      if(isFillIn) classes.push("cell-fillin");
      if(isOffPref) classes.push("cell-offpref");
      if(isLocked) classes.push("cell-locked");
      return `<td><div class="${classes.join(' ')}" data-slot="${num}|${qi}|${pos}"><div class="pname">${esc(name)}</div></div></td>`;
    }).join("");
    const benchNames = (q.bench||[]).map(pid=>{
      const isFillIn = STATE.fillIns.some(f=>f.id===pid);
      const p = byId(STATE.players,pid)||byId(STATE.fillIns,pid);
      return `<span class="grid-cell cell-bench ${isFillIn?'cell-fillin':''}" style="display:inline-block;margin:2px;">${esc(p?p.name:'?')}</span>`;
    }).join("") || '<span class="hint">—</span>';
    return `<tr><td class="mono">Q${qi+1}</td>${cells}<td>${benchNames}</td></tr>`;
  }).join("");
  return `<div class="table-scroll"><table>
    <thead><tr><th></th>${POSITIONS.map(p=>`<th><span class="pos-badge pos-${p}">${p}</span></th>`).join("")}<th>Bench</th></tr></thead>
    <tbody>${rows}</tbody>
  </table></div>`;
}

function wireGameCard(el, num){
  const card = el.querySelector(`[data-game="${num}"]`);
  if(!card) return;
  const toggleBtn = card.querySelector(`[data-toggle="${num}"]`);
  if(toggleBtn) toggleBtn.onclick=()=>{
    scheduleUiState.openGame = scheduleUiState.openGame===num ? null : num;
    renderGamesList(el);
  };
  if(scheduleUiState.openGame!==num) return;

  const off = card.querySelector(`#rosterOffOverride-${num}`);
  if(off) off.onchange=()=>{
    const v = off.value.trim();
    const game = getGame(num);
    game.rosterOffOverride = v===""?null:clamp(parseInt(v,10),0,STATE.players.length);
    game.rosteredOffIds = null; // clear manual selection lock when override count changes
    game.rosterOffLockIds = null;
    saveState(); toast("Roster-off override set. Regenerate to apply.");
  };
  const manageOff = card.querySelector(`[data-manageoff="${num}"]`);
  if(manageOff) manageOff.onclick=()=>openRosterOffDialog(num);
  const assignFillin = card.querySelector(`[data-assignfillin="${num}"]`);
  if(assignFillin) assignFillin.onclick=()=>openAssignFillInDialog(num);
  card.querySelectorAll("[data-rmfillin]").forEach(b=>b.onclick=()=>{
    const game=getGame(num); game.fillInIds=(game.fillInIds||[]).filter(id=>id!==b.dataset.rmfillin);
    saveState(); renderGamesList(el);
  });
  const togglePlayed = card.querySelector(`[data-toggleplayed="${num}"]`);
  if(togglePlayed) togglePlayed.onclick=()=>{
    const game = getGame(num);
    if(!game.isPlayed && !game.schedule){ toast("Generate this game's schedule before marking it played."); return; }
    game.isPlayed = !game.isPlayed;
    saveState(); toast(game.isPlayed?`Game ${num} locked as played.`:`Game ${num} unlocked.`);
    renderGamesList(el);
  };
  card.querySelectorAll("[data-slot]").forEach(cellEl=>{
    cellEl.onclick=()=>{
      const [g,qi,pos] = cellEl.dataset.slot.split("|");
      openSlotEditDialog(Number(g), Number(qi), pos);
    };
  });
}

function openRosterOffDialog(num){
  const game = getGame(num);
  const avail = planGameAvailability(num);
  const availIds = avail.availableRegularIds;
  const current = new Set(game.rosterOffLockIds || game.rosteredOffIds || []);
  const m = openModal(`
    <h3>Roster off — Game ${num}</h3>
    <p class="modal-sub">Manually choose who's rostered off. Leave unset to let the engine auto-select for fairness.</p>
    <div id="offList" style="max-height:280px;overflow-y:auto;"></div>
    <div class="modal-actions">
      <button class="btn" data-act="clear">Clear (auto)</button>
      <button class="btn" data-act="cancel">Cancel</button>
      <button class="btn btn-primary" data-act="save">Save</button>
    </div>
  `, modal=>{
    modal.querySelector("#offList").innerHTML = STATE.players.filter(p=>availIds.includes(p.id)).map(p=>`
      <label class="checkbox-row"><input type="checkbox" value="${p.id}" ${current.has(p.id)?"checked":""}>
        <span class="cb-label">${esc(p.name)}</span></label>`).join("");
    modal.querySelector('[data-act="cancel"]').onclick=closeModal;
    modal.querySelector('[data-act="clear"]').onclick=()=>{
      game.rosterOffLockIds=null; saveState(); closeModal(); toast("Cleared — engine will auto-select.");
      scheduleUiState.openGame=num; renderMain();
    };
    modal.querySelector('[data-act="save"]').onclick=()=>{
      const ids = Array.from(modal.querySelectorAll("#offList input:checked")).map(i=>i.value);
      game.rosterOffLockIds = ids; saveState(); closeModal();
      scheduleUiState.openGame=num; renderMain();
    };
  });
}

function openAssignFillInDialog(num){
  if(!STATE.fillIns.length){ toast("Add a fill-in player first, in the Fill-ins tab."); return; }
  const game = getGame(num);
  const assigned = new Set(game.fillInIds||[]);
  openModal(`
    <h3>Assign fill-in — Game ${num}</h3>
    <div id="finList" style="max-height:280px;overflow-y:auto;"></div>
    <div class="modal-actions">
      <button class="btn" data-act="cancel">Cancel</button>
      <button class="btn btn-primary" data-act="save">Save</button>
    </div>
  `, modal=>{
    modal.querySelector("#finList").innerHTML = STATE.fillIns.map(f=>`
      <label class="checkbox-row"><input type="checkbox" value="${f.id}" ${assigned.has(f.id)?"checked":""}>
        <span class="cb-label">${esc(f.name)}</span>
        <span class="cb-desc">${f.prefs.join(", ")||"no preferences set"}</span></label>`).join("");
    modal.querySelector('[data-act="cancel"]').onclick=closeModal;
    modal.querySelector('[data-act="save"]').onclick=()=>{
      game.fillInIds = Array.from(modal.querySelectorAll("#finList input:checked")).map(i=>i.value);
      saveState(); closeModal(); scheduleUiState.openGame=num; renderMain();
    };
  });
}

function openSlotEditDialog(num, qi, pos){
  const game = getGame(num);
  if(game.isPlayed){ toast("This game is locked as played. Unlock it first to edit."); return; }
  if(!game.schedule) return;
  const squadIds = game.squadIds||[];
  const options = squadIds.map(id=>byId(STATE.players,id)||byId(STATE.fillIns,id)).filter(Boolean);
  const lockKey = qi+"-"+pos;
  const isLocked = !!(game.lockedSlots && game.lockedSlots[lockKey]);
  openModal(`
    <h3>Game ${num} · Q${qi+1} · ${pos}</h3>
    <p class="modal-sub">${POS_LABEL[pos]}</p>
    <div class="field"><label>Assign player</label>
      <select id="slotSelect">
        <option value="">— unassigned —</option>
        ${options.map(p=>`<option value="${p.id}">${esc(p.name)}${p.prefs&&!p.prefs.includes(pos)?' (off-preference)':''}</option>`).join("")}
      </select>
    </div>
    <label class="checkbox-row"><input type="checkbox" id="slotLock" ${isLocked?"checked":""}>
      <span class="cb-label">Lock this slot</span>
      <span class="cb-desc">Rebalance won't change it</span></label>
    <div class="modal-actions">
      <button class="btn" data-act="cancel">Cancel</button>
      <button class="btn btn-primary" data-act="save">Save</button>
    </div>
  `, modal=>{
    const sel = modal.querySelector("#slotSelect");
    sel.value = game.schedule.quarters[qi].onCourt[pos]||"";
    modal.querySelector('[data-act="cancel"]').onclick=closeModal;
    modal.querySelector('[data-act="save"]').onclick=()=>{
      const pid = sel.value||null;
      const lock = modal.querySelector("#slotLock").checked;
      const q = game.schedule.quarters[qi];
      // remove player from bench / other position this quarter if present
      q.bench = (q.bench||[]).filter(id=>id!==pid);
      POSITIONS.forEach(p2=>{ if(p2!==pos && q.onCourt[p2]===pid) q.onCourt[p2]=null; });
      q.onCourt[pos]=pid;
      const player = pid ? (byId(STATE.players,pid)||byId(STATE.fillIns,pid)) : null;
      if(!q.offPreference) q.offPreference={};
      q.offPreference[pos] = !!(player && player.prefs && !player.prefs.includes(pos));
      game.lockedSlots = game.lockedSlots||{};
      if(lock) game.lockedSlots[lockKey]=pid; else delete game.lockedSlots[lockKey];
      saveState(); closeModal(); scheduleUiState.openGame=num; renderMain();
    };
  });
}

/* ============================================================
   RENDER: FILL-INS TAB
   ============================================================ */
function renderFillIns(root){
  root.innerHTML = `
    <div class="card">
      <div class="card-head">
        <div><h2>Fill-in players (${STATE.fillIns.length})</h2><p>Guests for short-staffed games. Saved for reuse; excluded from season fairness.</p></div>
        <button class="btn btn-primary btn-sm" id="addFillinBtn">+ Add fill-in</button>
      </div>
      <div id="fillinList"></div>
    </div>
  `;
  const listEl = document.getElementById("fillinList");
  if(!STATE.fillIns.length){
    listEl.innerHTML = `<div class="empty-state"><div class="glyph">&#128100;</div><div>No fill-ins saved yet.</div>
      <div class="cta">Add a guest player here, then assign them to specific games from the Schedule tab.</div></div>`;
  } else {
    listEl.innerHTML = STATE.fillIns.map(f=>{
      const usedIn = gameNums().filter(n=>(getGame(n).fillInIds||[]).includes(f.id));
      return `<div class="list-row">
        <div style="flex:1;min-width:0;">
          <div class="player-name">${esc(f.name)}</div>
          <div class="player-meta">${f.prefs.map(pos=>`<span class="pos-badge pos-${pos}">${pos}</span>`).join(" ")||'<span class="hint">no preferences set</span>'}
            ${usedIn.length?`<span class="pill pill-accent" style="margin-left:6px;">Used in ${usedIn.length} game(s)</span>`:""}</div>
        </div>
        <div class="btn-row" style="margin:0;">
          <button class="btn btn-sm" data-editfi="${f.id}">Edit</button>
          <button class="btn btn-sm btn-danger" data-delfi="${f.id}">Remove</button>
        </div>
      </div>`;
    }).join("");
    listEl.querySelectorAll("[data-editfi]").forEach(b=>b.onclick=()=>openFillInDialog(b.dataset.editfi));
    listEl.querySelectorAll("[data-delfi]").forEach(b=>b.onclick=()=>{
      confirmDialog("Remove fill-in", "Remove this fill-in and unassign them from any games?", ()=>{
        STATE.fillIns = STATE.fillIns.filter(f=>f.id!==b.dataset.delfi);
        gameNums().forEach(n=>{ const g=getGame(n); g.fillInIds=(g.fillInIds||[]).filter(id=>id!==b.dataset.delfi); });
        saveState(); renderMain();
      });
    });
  }
  document.getElementById("addFillinBtn").onclick=()=>openFillInDialog(null);
}

/* Cancel-safe: the draft object lives only inside this closure/modal and is
   never written into STATE until Save is clicked. Cancel (or the backdrop
   click / re-open) simply discards it — see SS-8 / SS-9. */
function openFillInDialog(fillInId){
  const existing = fillInId ? byId(STATE.fillIns, fillInId) : null;
  const draft = existing ? deepClone(existing) : {id:uid("fi"), name:"", prefs:[]};

  const m = openModal(`
    <h3>${existing?"Edit fill-in":"Add fill-in"}</h3>
    <p class="modal-sub">Guest player, reusable across games. Not part of the permanent roster or season fairness.</p>
    <div class="field"><label>Name</label><input type="text" id="fiName" value="${esc(draft.name)}" placeholder="e.g. Casey (guest)"></div>
    <div class="field">
      <label>Position preferences (optional, ordered)</label>
      <div id="fiChips" style="min-height:30px;"></div>
      <div class="btn-row" id="fiButtons"></div>
    </div>
    <div class="modal-actions">
      <button class="btn" data-act="cancel">Cancel</button>
      <button class="btn btn-primary" data-act="save">${existing?"Save changes":"Add fill-in"}</button>
    </div>
  `, modal=>{
    function paintChips(){
      modal.querySelector("#fiChips").innerHTML = draft.prefs.length
        ? draft.prefs.map((pos,i)=>`<span class="pref-chip"><span class="pref-rank">${i+1}</span><span class="pos-badge pos-${pos}">${pos}</span>${POS_LABEL[pos]}<button data-rm="${pos}">&times;</button></span>`).join("")
        : `<span class="hint">Flexible / no preference.</span>`;
      modal.querySelectorAll("[data-rm]").forEach(b=>b.onclick=()=>{ draft.prefs=draft.prefs.filter(p=>p!==b.dataset.rm); paintChips(); paintButtons(); });
    }
    function paintButtons(){
      modal.querySelector("#fiButtons").innerHTML = POSITIONS.filter(p=>!draft.prefs.includes(p))
        .map(pos=>`<button class="btn btn-sm" data-add="${pos}"><span class="pos-badge pos-${pos}">${pos}</span> ${POS_LABEL[pos]}</button>`).join("");
      modal.querySelectorAll("[data-add]").forEach(b=>b.onclick=()=>{ draft.prefs.push(b.dataset.add); paintChips(); paintButtons(); });
    }
    paintChips(); paintButtons();
    // Cancel: discard draft entirely, state untouched.
    modal.querySelector('[data-act="cancel"]').onclick=closeModal;
    modal.querySelector('[data-act="save"]').onclick=()=>{
      const name = modal.querySelector("#fiName").value.trim();
      if(!name){ toast("Enter a name first."); return; }
      draft.name = name;
      if(existing) Object.assign(existing, draft);
      else STATE.fillIns.push(draft);
      saveState(); closeModal(); renderMain();
    };
  });
}

/* ============================================================
   RENDER: REPORTS TAB
   ============================================================ */
function renderReports(root){
  const summaries = computePlayerSummaries();
  const offPref = computeOffPrefLog();
  const offPrefRate = computeOffPrefRate();
  const shortGames = gameNums().map(n=>({n,g:getGame(n)})).filter(x=>x.g.shortfall);
  const missedWarning = computeMissedGamesWarningForReports();
  const achievabilityNotes = computeRosterOffAchievabilityNotesForReports();

  root.innerHTML = `
    ${missedWarning? `
    <div class="card">
      <div class="card-head"><div><h2>Missed-games spread</h2><p>Informational — never overrides a generation decision on its own.</p></div></div>
      <div class="pill pill-warn" style="display:block;">
        Missed-games spread is ${missedWarning.spread} (most: ${esc(missedWarning.mostMissed.join(", "))} at ${missedWarning.max};
        least: ${esc(missedWarning.leastMissed.join(", "))} at ${missedWarning.min}). ${esc(missedWarning.suggestion)}
      </div>
    </div>` : ""}
    ${achievabilityNotes.length? `
    <div class="card">
      <div class="card-head"><div><h2>Roster-off evenness: structural limits</h2><p>Based on how thin certain positions are on this roster — not a settings effect.</p></div></div>
      ${achievabilityNotes.map(n=>`<div class="pill pill-warn" style="display:block;margin-bottom:6px;">${esc(n.message)}</div>`).join("")}
    </div>` : ""}
    <div class="card">
      <div class="card-head"><div><h2>Player summary</h2><p>On-court / bench / missed games and position breakdown, including off-preference quarters.</p></div></div>
      <div class="table-scroll"><table>
        <thead><tr><th>Player</th><th>Games</th><th>On-court Q</th><th>Bench Q</th><th>Missed</th>
          ${POSITIONS.map(p=>`<th>${p}</th>`).join("")}<th>Off-pref Q</th></tr></thead>
        <tbody>
        ${summaries.length? summaries.map(s=>`
          <tr><td><strong>${esc(s.name)}</strong></td><td class="mono">${s.gamesPlayedIn}</td>
            <td class="mono">${s.onCourt}</td><td class="mono">${s.bench}</td><td class="mono">${s.missed}</td>
            ${POSITIONS.map(pos=>`<td class="mono">${s.positions[pos]||0}${s.offPrefPositions[pos]?` <span class="pill pill-danger" style="padding:1px 6px;">${s.offPrefPositions[pos]} off-pref</span>`:""}</td>`).join("")}
            <td class="mono">${s.offPrefTotal}</td></tr>
        `).join("") : `<tr><td colspan="12" class="hint">No players yet.</td></tr>`}
        </tbody>
      </table></div>
    </div>

    <div class="card">
      <div class="card-head"><div><h2>Off-preference report</h2><p>Every slot filled outside a player's stated preferences, and why.</p></div></div>
      <div class="stat-grid" style="margin-bottom:14px;">
        <div class="stat-box"><div class="num">${offPref.length}</div><div class="lbl">off-preference fills</div></div>
        <div class="stat-box"><div class="num">${offPrefRate.totalSlots}</div><div class="lbl">total on-court slots</div></div>
        <div class="stat-box"><div class="num">${offPrefRate.rate.toFixed(1)}%</div><div class="lbl">season rate</div></div>
      </div>
      <div class="table-scroll"><table>
        <thead><tr><th>Game</th><th>Qtr</th><th>Player</th><th>Position</th><th>Why (specialists unavailable)</th></tr></thead>
        <tbody>
        ${offPref.length? offPref.map(o=>`
          <tr><td class="mono">${o.game}</td><td class="mono">${o.quarter}</td><td>${esc(o.playerName)}</td>
            <td><span class="pos-badge pos-${o.position}">${o.position}</span></td>
            <td class="hint">${o.unavailableSpecialists.length?esc(o.unavailableSpecialists.join(", ")):"no specialists on the roster"}</td></tr>
        `).join("") : `<tr><td colspan="5" class="hint">None yet — generate the season to populate this log.</td></tr>`}
        </tbody>
      </table></div>
    </div>

    <div class="card">
      <div class="card-head"><div><h2>Short-staffed game notes</h2><p>Games where availability drops below a full squad.</p></div></div>
      ${shortGames.length? shortGames.map(({n,g})=>{
        const gaps = fillInGapSuggestions(n);
        const unavail = (g.unavailableIds||[]).map(id=>playerLabel(byId(STATE.players,id))).join(", ");
        return `<div class="game-card"><div class="game-card-head"><h4>Game ${n}</h4>
          <span class="pill pill-danger">${g.minFillIns} min / ${g.recommendedFillIns} recommended fill-ins</span></div>
          <p class="hint" style="margin:8px 0 4px;">Unavailable: ${esc(unavail)||"—"}</p>
          ${gaps.length?`<p class="hint">Coverage gaps: ${gaps.join(", ")}</p>`:""}</div>`;
      }).join("") : `<p class="hint">No short-staffed games currently.</p>`}
    </div>
  `;
}

/* ============================================================
   RENDER: SETTINGS TAB
   ============================================================ */
/* Reusable labelled-slider markup: a range input + numeric readout + a small
   pair of end labels describing what each direction actually does. Used for
   every priority/weight slider on this tab so they're visually and
   structurally consistent. */
function labelledSliderHtml({id, dataWeight, min, max, step, value, valueId, leftLabel, rightLabel}){
  const idAttr = id ? ` id="${id}"` : "";
  const dataAttr = dataWeight ? ` data-weight="${dataWeight}"` : "";
  const valIdAttr = valueId ? ` id="${valueId}"` : "";
  return `
    <div class="slider-wrap">
      <input type="range"${idAttr}${dataAttr} min="${min}" max="${max}" step="${step}" value="${value}">
      <span class="slider-val mono"${valIdAttr}>${value}</span>
    </div>
    <div class="slider-endlabels"><span>${esc(leftLabel)}</span><span>${esc(rightLabel)}</span></div>
  `;
}

function renderSettings(root){
  const s = STATE.settings;
  const weightLabels = {
    bench: {
      title:"Playing-time evenness (on-court & bench)",
      left:"Ignore season-long playing time",
      right:"Actively even out playing time"
    },
    positionPurity: {
      title:"Position preference purity",
      left:"Repeat a player's favourite position",
      right:"Spread play across their whole preference list"
    }
  };
  root.innerHTML = `
    <div class="card">
      <div class="card-head"><div><h2>Preference vs. fairness</h2><p>How strongly the engine favors a player's stated preference rank over even rotation. Defaults to strongly favouring preference — placing players in their preferred positions, every game and across the season, is the dominant objective.</p></div></div>
      <div class="field">
        <label>Priority slider — fairness &#8596; strict preference</label>
        ${labelledSliderHtml({id:"prefSlider", min:0, max:10, step:1, value:s.preferenceSlider, valueId:"sliderVal",
          leftLabel:"Playing-time fairness & variety", rightLabel:"Strict preference honouring"})}
        <p class="hint">Higher values never increase off-preference fills for the same data — at maximum, off-preference is used only where truly unavoidable. Lower it to weight playing-time fairness and position variety more heavily against preference.</p>
      </div>
      <label class="checkbox-row">
        <input type="checkbox" id="allowOffPref" ${s.allowOffPreference?"checked":""}>
        <span class="cb-label">Allow off-preference positions</span>
        <span class="cb-desc">When off, a position with no eligible in-preference player raises an error instead of a fallback assignment</span>
      </label>
      <label class="checkbox-row">
        <input type="checkbox" id="topTwoOnly" ${s.topTwoOnly?"checked":""}>
        <span class="cb-label">Prefer top-2 positions only</span>
        <span class="cb-desc">Off: balances a player's on-court time across their entire preference list, not just their top 2</span>
      </label>
      <p class="hint">The app aims to keep rostered-off games even given known unavailability, and will warn you on the Reports tab if that spread gets large — it won't sacrifice preference quality just to force perfect evenness.</p>
    </div>
    <div class="card">
      <div class="card-head"><div><h2>Roster-off fairness vs. position coverage</h2><p>How strongly the season-wide roster-off search favours perfectly even missed-games counts versus protecting thin positions from losing coverage.</p></div></div>
      <div class="field">
        <label>Priority slider — roster-off fairness &#8596; position coverage</label>
        ${labelledSliderHtml({id:"rosterOffSlider", min:0, max:10, step:1, value:s.rosterOffWeight, valueId:"rosterOffSliderVal",
          leftLabel:"Roster-off fairness", rightLabel:"Position coverage"})}
        <p class="hint">With a roster that has good depth at every position, these two goals rarely conflict and this slider will have little visible effect — it mainly matters for positions only a few players prefer.</p>
      </div>
    </div>
    <div class="card">
      <div class="card-head"><div><h2>Fairness priority order</h2><p>Relative weight — higher number matters more when trade-offs arise.</p></div></div>
      ${["bench","positionPurity"].map(k=>{
        const l = weightLabels[k];
        return `<div class="field"><label>${l.title}</label>
          ${labelledSliderHtml({dataWeight:k, min:1, max:10, step:1, value:s.fairnessWeights[k], leftLabel:l.left, rightLabel:l.right})}
        </div>`;
      }).join("")}
      <p class="hint">These weights bias the preference/balance trade-off and bench-rotation ordering; regenerate after changing them.</p>
    </div>
  `;
  document.getElementById("prefSlider").oninput=e=>{ document.getElementById("sliderVal").textContent=e.target.value; };
  document.getElementById("prefSlider").onchange=e=>{ s.preferenceSlider=Number(e.target.value); saveState(); toast("Regenerate to apply."); };
  document.getElementById("rosterOffSlider").oninput=e=>{ document.getElementById("rosterOffSliderVal").textContent=e.target.value; };
  document.getElementById("rosterOffSlider").onchange=e=>{ s.rosterOffWeight=Number(e.target.value); saveState(); toast("Regenerate to apply."); };
  document.getElementById("allowOffPref").onchange=e=>{ s.allowOffPreference=e.target.checked; saveState(); toast("Regenerate to apply."); };
  document.getElementById("topTwoOnly").onchange=e=>{ s.topTwoOnly=e.target.checked; saveState(); toast("Regenerate to apply."); };
  root.querySelectorAll("[data-weight]").forEach(inp=>{
    inp.oninput=e=>{ e.target.nextElementSibling.textContent=e.target.value; };
    inp.onchange=e=>{ s.fairnessWeights[e.target.dataset.weight]=Number(e.target.value); saveState(); toast("Regenerate to apply."); };
  });
}

/* ============================================================
   RENDER: DATA TAB  (CSV export/import, XLSX export, reset)
   ============================================================ */
function renderData(root){
  root.innerHTML = `
    <div class="card">
      <div class="card-head"><div><h2>Share / back up (CSV)</h2><p>Full round-trip of every field — players, preferences, availability, fill-ins, per-game roster-off values, locks, played status and the generated schedule.</p></div></div>
      <div class="btn-row">
        <button class="btn btn-primary" id="exportCsvBtn">Export full CSV</button>
        <button class="btn" id="importCsvFullBtn">Import full CSV</button>
        <input type="file" id="csvFullInput" accept=".csv" hidden>
      </div>
      <p class="hint" style="margin-top:10px;">Export this file and send it to a co-coach — importing it on another device or browser continues editing exactly where you left off. This app has no server, so CSV is the only way to move data between devices.</p>
    </div>
    <div class="card">
      <div class="card-head"><div><h2>Export report (.xlsx)</h2><p>Rotation grid, player summary, and short-staffed notes as spreadsheet tabs.</p></div></div>
      <button class="btn btn-primary" id="exportXlsxBtn">Download .xlsx report</button>
    </div>
    <div class="card">
      <div class="card-head"><div><h2>Reset</h2><p>Clears everything stored in this browser.</p></div></div>
      <button class="btn btn-danger" id="resetBtn">Clear all data</button>
    </div>
  `;
  document.getElementById("exportCsvBtn").onclick=exportFullCsv;
  document.getElementById("importCsvFullBtn").onclick=()=>document.getElementById("csvFullInput").click();
  document.getElementById("csvFullInput").onchange=e=>{
    const f=e.target.files[0]; if(!f) return;
    const reader=new FileReader();
    reader.onload=ev=>importFullCsv(ev.target.result);
    reader.readAsText(f); e.target.value="";
  };
  document.getElementById("exportXlsxBtn").onclick=exportXlsx;
  document.getElementById("resetBtn").onclick=()=>{
    confirmDialog("Clear all data", "This permanently deletes every player, game, and setting stored in this browser. This cannot be undone.", ()=>{
      STATE = defaultState(); saveState(); render(); toast("All data cleared.");
    });
  };
}

function downloadBlob(filename, blob){
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href=url; a.download=filename; document.body.appendChild(a); a.click();
  setTimeout(()=>{ URL.revokeObjectURL(url); a.remove(); },1000);
}

function exportFullCsv(){
  const lines = [];
  const row = (...fields)=>lines.push(fields.map(toCsvField).join(","));
  row("#META"); row("version",1); row("appVersion",APP_VERSION); row("exportedAt",todayIso());
  row("#SEASON"); row("numGames",STATE.season.numGames); row("desiredBenchSize",STATE.season.desiredBenchSize);
  row("#SETTINGS");
  row("preferenceSlider",STATE.settings.preferenceSlider);
  row("allowOffPreference",STATE.settings.allowOffPreference?1:0);
  row("topTwoOnly",STATE.settings.topTwoOnly?1:0);
  row("rosterOffWeight",STATE.settings.rosterOffWeight);
  row("weight_bench",STATE.settings.fairnessWeights.bench);
  row("weight_positionPurity",STATE.settings.fairnessWeights.positionPurity);
  row("theme",STATE.theme);
  row("#PLAYERS","id","name","prefs","unavailable");
  STATE.players.forEach(p=>row(p.id,p.name,(p.prefs||[]).join("|"),(p.unavailable||[]).join("|")));
  row("#FILLINS","id","name","prefs");
  STATE.fillIns.forEach(f=>row(f.id,f.name,(f.prefs||[]).join("|")));
  row("#GAMES","gameNum","isPlayed","rosterOffOverride","rosterOffLockIds","rosteredOffIds","fillInIds","lockedSlots","error");
  gameNums().forEach(n=>{
    const g = getGame(n);
    const lockedSlotsStr = Object.entries(g.lockedSlots||{}).map(([k,v])=>k+"="+v).join("|");
    row(n, g.isPlayed?1:0, Number.isFinite(g.rosterOffOverride)?g.rosterOffOverride:"",
      (g.rosterOffLockIds||[]).join("|"), (g.rosteredOffIds||[]).join("|"), (g.fillInIds||[]).join("|"), lockedSlotsStr, g.error||"");
  });
  row("#SCHEDULE","gameNum","quarter","slot","playerId","offPreference");
  gameNums().forEach(n=>{
    const g = getGame(n);
    if(!g.schedule) return;
    g.schedule.quarters.forEach((q,qi)=>{
      POSITIONS.forEach(pos=>{
        if(q.onCourt[pos]) row(n,qi,pos,q.onCourt[pos], (q.offPreference&&q.offPreference[pos])?1:0);
      });
      (q.bench||[]).forEach(pid=>row(n,qi,"BENCH",pid,0));
    });
  });
  const csv = lines.join("\r\n");
  downloadBlob(`netball-roster-season-${STATE._lastGeneratedAt?"":"draft-"}${new Date().toISOString().slice(0,10)}.csv`, new Blob([csv],{type:"text/csv"}));
  toast("CSV exported.");
}

function importFullCsv(text){
  try{
    const rows = parseCsv(text);
    const sections = {};
    let cur = null;
    rows.forEach(r=>{
      if(r[0] && r[0].startsWith("#")){ cur = r[0].slice(1); sections[cur]=sections[cur]||[]; return; }
      if(cur) sections[cur].push(r);
    });
    if(!sections.PLAYERS && !sections.SEASON){ toast("This doesn't look like a season export CSV."); return; }

    const ns = defaultState();
    // META/SEASON/SETTINGS come as key/value pairs (skip header-less; each row is [key,value...])
    const kv = (sectionRows)=>{ const o={}; (sectionRows||[]).forEach(r=>{ o[r[0]]=r[1]; }); return o; };
    const season = kv(sections.SEASON);
    if(season.numGames) ns.season.numGames = parseInt(season.numGames,10)||1;
    if(season.desiredBenchSize!==undefined) ns.season.desiredBenchSize = parseInt(season.desiredBenchSize,10)||0;

    const set = kv(sections.SETTINGS);
    if(set.preferenceSlider!==undefined) ns.settings.preferenceSlider = Number(set.preferenceSlider);
    if(set.allowOffPreference!==undefined) ns.settings.allowOffPreference = set.allowOffPreference==="1";
    if(set.topTwoOnly!==undefined) ns.settings.topTwoOnly = set.topTwoOnly==="1";
    if(set.rosterOffWeight!==undefined) ns.settings.rosterOffWeight = Number(set.rosterOffWeight);
    ["bench","positionPurity"].forEach(k=>{
      const v = set["weight_"+k]; if(v!==undefined) ns.settings.fairnessWeights[k]=Number(v);
    });
    if(set.theme) ns.theme = set.theme;

    ns.players = (sections.PLAYERS||[]).filter(r=>r[0]).map(r=>({
      id:r[0], name:r[1]||"", prefs:(r[2]||"").split("|").filter(Boolean),
      unavailable:(r[3]||"").split("|").filter(Boolean).map(Number)
    }));
    ns.fillIns = (sections.FILLINS||[]).filter(r=>r[0]).map(r=>({
      id:r[0], name:r[1]||"", prefs:(r[2]||"").split("|").filter(Boolean)
    }));

    ns.games = {};
    (sections.GAMES||[]).filter(r=>r[0]).forEach(r=>{
      const [num,isPlayed,rosterOffOverride,rosterOffLockIds,rosteredOffIds,fillInIds,lockedSlotsStr,errorStr] = r;
      const g = newGameState();
      g.isPlayed = isPlayed==="1";
      g.rosterOffOverride = rosterOffOverride!==""&&rosterOffOverride!==undefined ? Number(rosterOffOverride) : null;
      g.rosterOffLockIds = (rosterOffLockIds||"").split("|").filter(Boolean);
      if(!g.rosterOffLockIds.length) g.rosterOffLockIds = null;
      g.rosteredOffIds = (rosteredOffIds||"").split("|").filter(Boolean); // frozen historical fact for played games; recomputed for others
      g.fillInIds = (fillInIds||"").split("|").filter(Boolean);
      g.lockedSlots = {};
      (lockedSlotsStr||"").split("|").filter(Boolean).forEach(pair=>{
        const eq = pair.indexOf("="); if(eq<0) return;
        g.lockedSlots[pair.slice(0,eq)] = pair.slice(eq+1);
      });
      g.error = errorStr||null;
      ns.games[String(num)] = g;
    });

    (sections.SCHEDULE||[]).filter(r=>r[0]!==undefined && r[0]!=="").forEach(r=>{
      const [num,qi,slot,playerId,offPref] = r;
      const g = ns.games[String(num)] || (ns.games[String(num)]=newGameState());
      if(!g.schedule) g.schedule = {quarters:[0,1,2,3].map(()=>({onCourt:{},bench:[],offPreference:{}}))};
      const q = g.schedule.quarters[Number(qi)];
      if(!q) return;
      if(slot==="BENCH") q.bench.push(playerId);
      else { q.onCourt[slot]=playerId; q.offPreference[slot]= offPref==="1"; }
      g.generated = true;
      g.squadIds = Array.from(new Set([...(g.squadIds||[]), playerId]));
    });

    STATE = ns;
    // recompute derived display-only fields without touching schedule/locks. Played games'
    // rosteredIds were loaded directly from the CSV above and are treated as a frozen fact;
    // everything else is re-derived (a fresh Phase 1 solve for roster-off, same as generation).
    computeSeasonRosterOff();
    saveState();
    render();
    toast(`Imported ${STATE.players.length} player(s), ${gameNums().length} game(s).`);
  }catch(e){
    console.error(e);
    toast("Import failed — the file looks malformed or corrupted: "+e.message);
  }
}

function exportXlsx(){
  if(typeof XLSX==="undefined"){ toast("Spreadsheet library failed to load — check your connection."); return; }
  const wb = XLSX.utils.book_new();

  const gridRows = [["Game","Quarter",...POSITIONS,"Bench"]];
  gameNums().forEach(n=>{
    const g = getGame(n); if(!g.schedule) return;
    g.schedule.quarters.forEach((q,qi)=>{
      const posCells = POSITIONS.map(pos=>{
        const pid=q.onCourt[pos]; const p = pid && (byId(STATE.players,pid)||byId(STATE.fillIns,pid));
        if(!p) return "";
        const offpref = q.offPreference&&q.offPreference[pos];
        return p.name + (offpref?" (off-pref)":"");
      });
      const benchNames = (q.bench||[]).map(pid=>{ const p=byId(STATE.players,pid)||byId(STATE.fillIns,pid); return p?p.name:pid; }).join(", ");
      gridRows.push([n,qi+1,...posCells,benchNames]);
    });
  });
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(gridRows), "Rotation Grid");

  const summaries = computePlayerSummaries();
  const sumRows = [["Player","Games Played","On-court Q","Bench Q","Missed", ...POSITIONS, "Off-pref Q"]];
  summaries.forEach(s=> sumRows.push([s.name,s.gamesPlayedIn,s.onCourt,s.bench,s.missed, ...POSITIONS.map(p=>s.positions[p]||0), s.offPrefTotal]));
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(sumRows), "Player Summary");

  const noteRows = [["Game","Unavailable","Min Fill-ins","Recommended Fill-ins","Coverage Gaps"]];
  gameNums().filter(n=>getGame(n).shortfall).forEach(n=>{
    const g = getGame(n);
    const unavail = (g.unavailableIds||[]).map(id=>playerLabel(byId(STATE.players,id))).join(", ");
    noteRows.push([n, unavail, g.minFillIns, g.recommendedFillIns, fillInGapSuggestions(n).join(", ")]);
  });
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(noteRows), "Short-Staffed Notes");

  const offRows = [["Game","Quarter","Player","Position","Unavailable Specialists"]];
  computeOffPrefLog().forEach(o=> offRows.push([o.game,o.quarter,o.playerName,o.position,o.unavailableSpecialists.join(", ")]));
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(offRows), "Off-Preference Log");

  XLSX.writeFile(wb, `netball-roster-${new Date().toISOString().slice(0,10)}.xlsx`);
  toast("Spreadsheet downloaded.");
}

/* ============================================================
   INIT
   ============================================================ */
document.addEventListener("DOMContentLoaded", function(){
  ensureGamesExist();
  render();
});

})();

