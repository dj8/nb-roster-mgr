/* Loads the app's inline engine script from index.html into a Node vm sandbox with
   stubbed document/localStorage/URL/Blob, and appends a module.exports block inside the
   IIFE so internal engine functions are reachable for testing (never shipped — index.html
   itself has no module.exports). */
"use strict";
const fs = require("fs");
const path = require("path");
const vm = require("vm");

function fakeEl(){
  const target = {style:{}, classList:{add(){},remove(){},toggle(){},contains(){return false;}}};
  return new Proxy(target, {
    get(t, prop){
      if(prop in t) return t[prop];
      if(prop === "querySelector") return () => fakeEl();
      if(prop === "querySelectorAll") return () => [];
      if(prop === "appendChild") return (c) => c;
      if(prop === "removeChild") return () => {};
      if(prop === "addEventListener") return () => {};
      if(prop === "removeEventListener") return () => {};
      if(prop === "remove") return () => {};
      if(prop === "setAttribute") return () => {};
      if(prop === "getAttribute") return () => null;
      if(prop === "cloneNode") return () => fakeEl();
      if(prop === "click") return () => {};
      if(prop === "focus") return () => {};
      if(typeof prop === "symbol") return undefined;
      return () => fakeEl();
    },
    set(t, prop, value){ t[prop] = value; return true; }
  });
}

function makeFakeDocument(){
  return new Proxy({}, {
    get(_t, prop){
      if(prop === "createElement") return () => fakeEl();
      if(prop === "getElementById") return () => fakeEl();
      if(prop === "querySelector") return () => fakeEl();
      if(prop === "querySelectorAll") return () => [];
      if(prop === "addEventListener") return () => {};
      if(prop === "documentElement") return fakeEl();
      if(prop === "body") return fakeEl();
      if(typeof prop === "symbol") return undefined;
      return () => fakeEl();
    }
  });
}

function makeFakeLocalStorage(){
  const store = {};
  return {
    getItem: k => (k in store ? store[k] : null),
    setItem: (k,v) => { store[k] = String(v); },
    removeItem: k => { delete store[k]; },
    clear: () => { Object.keys(store).forEach(k=>delete store[k]); }
  };
}

/* Captures the text passed to `new Blob([text])` so CSV export can be inspected
   without a real download — exportFullCsv() itself is never modified for this. */
class CapturingBlob {
  constructor(parts){ this.__text = (parts||[]).join(""); CapturingBlob.last = this.__text; }
}

function loadEngine(){
  const htmlPath = path.join(__dirname, "..", "index.html");
  const html = fs.readFileSync(htmlPath, "utf8");
  const scriptMatches = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m=>m[1]);
  const appScript = scriptMatches.find(s => s.includes('"use strict"'));
  if(!appScript) throw new Error("Could not locate the app's inline script in index.html");

  const closeIdx = appScript.lastIndexOf("})();");
  if(closeIdx < 0) throw new Error("Could not locate IIFE closer in app script");

  const exportsBlock = `
if(typeof module!=="undefined" && module.exports){
  module.exports = {
    _getState: function(){ return STATE; },
    _resetState: function(){ STATE = defaultState(); return STATE; },
    _setState: function(s){ STATE = s; return STATE; },
    runGeneration: runGeneration,
    planGameSquad: planGameSquad,
    assignQuarterPositions: assignQuarterPositions,
    chooseBenchGroup: chooseBenchGroup,
    selectRosterOff: selectRosterOff,
    rosterOffCoveragePenalty: rosterOffCoveragePenalty,
    rosterOffHasSevereGap: rosterOffHasSevereGap,
    futureAbsenceCount: futureAbsenceCount,
    computeCoverageWarnings: computeCoverageWarnings,
    computePlayerSummaries: computePlayerSummaries,
    computeOffPrefLog: computeOffPrefLog,
    computeOffPrefRate: computeOffPrefRate,
    newGameState: newGameState,
    defaultState: defaultState,
    emptyCumulative: emptyCumulative,
    getGame: getGame,
    ensureGamesExist: ensureGamesExist,
    gameNums: gameNums,
    POSITIONS: POSITIONS,
    uid: uid,
    byId: byId,
    exportFullCsv: exportFullCsv,
    importFullCsv: importFullCsv,
    saveState: saveState,
    loadState: loadState
  };
}
`;
  const patched = appScript.slice(0, closeIdx) + exportsBlock + appScript.slice(closeIdx);

  const sandbox = {
    module: { exports: {} },
    document: makeFakeDocument(),
    localStorage: makeFakeLocalStorage(),
    URL: { createObjectURL: () => "blob:fake", revokeObjectURL: () => {} },
    Blob: CapturingBlob,
    XLSX: undefined,
    console: console,
    setTimeout: setTimeout,
    clearTimeout: clearTimeout,
    Math: Math,
    Date: Date,
    JSON: JSON
  };
  sandbox.window = sandbox;
  sandbox.global = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(patched, sandbox, { filename: "index.html-inline-script.js" });

  const engine = sandbox.module.exports;
  engine.CapturingBlob = CapturingBlob;
  return engine;
}

module.exports = { loadEngine };
