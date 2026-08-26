/* Headless-browser smoke test for the real UI (not the Node-vm engine harness
   used by tests/run.js). Serves the repo statically and drives it with
   Playwright + headless Chromium, exercising the golden path a coach would
   actually click through.
   Run with: npm run test:ui   (requires `npx playwright install chromium` once) */
"use strict";
const http = require("http");
const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");

const ROOT = path.join(__dirname, "..");
const PORT = 8934;
const SCREENSHOT_DIR = path.join(__dirname, "ui-screenshots");

function startServer(){
  const server = http.createServer((req,res)=>{
    const urlPath = decodeURIComponent(req.url.split("?")[0]);
    const filePath = path.join(ROOT, urlPath==="/" ? "/index.html" : urlPath);
    if(!filePath.startsWith(ROOT)){ res.writeHead(403); res.end(); return; }
    fs.readFile(filePath, (err,data)=>{
      if(err){ res.writeHead(404); res.end("Not found: "+urlPath); return; }
      const ext = path.extname(filePath);
      const type = {".html":"text/html", ".css":"text/css", ".js":"text/javascript"}[ext] || "application/octet-stream";
      res.writeHead(200, {"Content-Type":type});
      res.end(data);
    });
  });
  return new Promise(resolve=>server.listen(PORT, ()=>resolve(server)));
}

const failures = [];
function check(cond, msg){
  if(cond){ console.log("OK    "+msg); }
  else { failures.push(msg); console.log("FAIL  "+msg); }
}

const PLAYERS = [
  ["Amy",["GS","GA"]], ["Bea",["GA","GS","WA"]], ["Cat",["WA","C","GA"]],
  ["Dee",["C","WA","WD"]], ["Eve",["WD","C","GD"]], ["Fay",["GD","WD","GK"]],
  ["Gia",["GK","GD"]], ["Hal",["GS","GA","WA"]], ["Ivy",["WA","C"]]
];

async function shot(page, name){
  // The app's body has a CSS background/color transition (pre-existing, not part of this
  // rewrite); a screenshot taken immediately after a paint can catch it mid-fade and look
  // washed out even though the underlying styles are already correct. A short settle avoids that.
  await page.waitForTimeout(250);
  await page.screenshot({ path: path.join(SCREENSHOT_DIR, name), fullPage:true });
}

(async()=>{
  fs.mkdirSync(SCREENSHOT_DIR, {recursive:true});
  const server = await startServer();
  const browser = await chromium.launch({headless:true});
  const page = await browser.newPage({viewport:{width:1320,height:960}});

  const consoleErrors = [];
  page.on("console", msg=>{ if(msg.type()==="error") consoleErrors.push(msg.text()); });
  page.on("pageerror", err=>consoleErrors.push("pageerror: "+err.message));

  await page.goto(`http://localhost:${PORT}/index.html`);
  await page.evaluate(()=>localStorage.clear());
  await page.reload();
  await page.waitForSelector(".tabs");
  await shot(page, "01-initial-setup.png");

  // ---- Setup: add the full roster via the real Add-player modal ----
  for(const [name, prefs] of PLAYERS){
    await page.click("#addPlayerBtn");
    await page.waitForSelector(".modal #pfName");
    await page.fill("#pfName", name);
    for(const pos of prefs){
      await page.click(`#prefButtons button[data-add="${pos}"]`);
    }
    await page.click('.modal [data-act="save"]');
    await page.waitForSelector(".modal-backdrop", {state:"detached", timeout:2000}).catch(()=>{});
  }
  check((await page.locator(".list-row").count())===PLAYERS.length, `all ${PLAYERS.length} players added via the UI`);
  await shot(page, "02-players-added.png");

  await page.fill("#numGames","10"); await page.press("#numGames","Tab");
  await page.fill("#benchSize","2"); await page.press("#benchSize","Tab");

  // ---- Schedule: generate, check for errors, inspect a game's rotation grid ----
  await page.click('.tab-btn[data-tab="schedule"]');
  await page.click("#genBtn");
  await page.waitForTimeout(50);
  let errorPills = await page.locator(".pill-danger").allTextContents();
  check(errorPills.length===0, `no error pills after generation (found: ${JSON.stringify(errorPills)})`);
  await shot(page, "03-schedule-generated.png");

  await page.click('[data-toggle="1"]');
  await page.waitForSelector("#gameBody-1 table");
  const posBadgeCount = await page.locator("#gameBody-1 .pos-badge").count();
  check(posBadgeCount>0, `game 1's rotation grid renders position badges (found ${posBadgeCount})`);
  await shot(page, "04-game1-detail.png");

  // ---- Lock a slot, rebalance, confirm the lock is honored ----
  const firstSlot = page.locator("#gameBody-1 [data-slot]").first();
  await firstSlot.click();
  await page.waitForSelector(".modal #slotSelect");
  const lockedPlayerId = await page.locator(".modal #slotSelect").inputValue();
  await page.check(".modal #slotLock");
  await page.click('.modal [data-act="save"]');
  await page.waitForSelector(".modal-backdrop", {state:"detached", timeout:2000}).catch(()=>{});
  await page.click('[data-toggle="1"]'); await page.click('[data-toggle="1"]'); // collapse/reopen to re-render fresh
  await page.click("#rebalBtn");
  await page.waitForTimeout(50);
  const afterLockValue = await page.evaluate(()=>{
    const cell = document.querySelector("#gameBody-1 [data-slot].cell-locked");
    return cell ? cell.dataset.slot : null;
  });
  check(!!afterLockValue, `locked slot still shows a lock indicator after rebalance (${afterLockValue})`);

  // ---- Settings: verify the new default and that the old toggle is gone ----
  await page.click('.tab-btn[data-tab="settings"]');
  const sliderVal = (await page.locator("#sliderVal").textContent()).trim();
  check(sliderVal==="9", `preference slider defaults to 9 (got ${sliderVal})`);
  const settingsText = await page.locator("body").textContent();
  check(!/strict specialist/i.test(settingsText), "no leftover 'strict specialist pairing' UI text anywhere on the page");
  await shot(page, "05-settings.png");

  // ---- Reports: force a lopsided roster and confirm the missed-games warning appears ----
  await page.click('.tab-btn[data-tab="setup"]');
  await page.click('[data-edit]');
  await page.waitForSelector(".modal #pfUnavail");
  await page.fill("#pfUnavail", "1,2,3,4,5,6,7,8");
  await page.click('.modal [data-act="save"]');
  await page.waitForSelector(".modal-backdrop", {state:"detached", timeout:2000}).catch(()=>{});
  await page.click('.tab-btn[data-tab="schedule"]');
  await page.click("#genBtn");
  await page.waitForTimeout(50);
  await page.click('.tab-btn[data-tab="reports"]');
  const reportsText = await page.locator("body").textContent();
  check(/Missed-games spread/i.test(reportsText), "missed-games spread warning appears on a deliberately lopsided roster");
  await shot(page, "06-reports-warning.png");

  // ---- Theme toggle ----
  const themeBefore = await page.getAttribute("html","data-theme");
  await page.click("#themeToggle");
  const themeAfter = await page.getAttribute("html","data-theme");
  check(themeBefore!==themeAfter, `theme toggles on click (before=${themeBefore}, after=${themeAfter})`);

  // ---- CSV export -> reset -> import round trip ----
  await page.click('.tab-btn[data-tab="data"]');
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.click("#exportCsvBtn")
  ]);
  const csvPath = path.join(SCREENSHOT_DIR, "export.csv");
  await download.saveAs(csvPath);
  const csvText = fs.readFileSync(csvPath, "utf8");
  check(csvText.includes("#PLAYERS") && csvText.includes("Amy") && csvText.includes("rosteredOffIds"),
    "exported CSV contains expected sections and the new rosteredOffIds column");

  await page.click("#resetBtn");
  await page.click('.modal [data-act="yes"]');
  await page.waitForSelector(".empty-state");
  await page.click('.tab-btn[data-tab="data"]');
  await page.setInputFiles("#csvFullInput", csvPath);
  await page.waitForTimeout(100);
  await page.click('.tab-btn[data-tab="setup"]');
  const restoredCount = await page.locator(".list-row").count();
  check(restoredCount===PLAYERS.length, `CSV import restored all ${PLAYERS.length} players (got ${restoredCount})`);

  check(consoleErrors.length===0, `no console/page errors during the whole flow (found: ${JSON.stringify(consoleErrors)})`);

  await browser.close();
  await server.close();

  console.log(`\nScreenshots written to ${SCREENSHOT_DIR}`);
  console.log(failures.length===0 ? "ALL UI CHECKS PASSED" : `${failures.length} UI CHECK(S) FAILED`);
  process.exit(failures.length ? 1 : 0);
})().catch(e=>{ console.error(e); process.exit(1); });
