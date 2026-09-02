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
  // The body has a CSS background/color transition — a screenshot taken
  // immediately after paint can catch it mid-fade. Settle briefly first.
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

  // ---- DM-2: adding a duplicate name is blocked, not silently overwritten ----
  await page.click("#addPlayerBtn");
  await page.waitForSelector(".modal #pfName");
  await page.fill("#pfName", PLAYERS[0][0]); // exact duplicate of an existing player's name
  const dupWarnVisible = await page.locator(".modal #dupWarn").isVisible();
  await page.click('.modal [data-act="save"]');
  const dupStillOpen = await page.locator(".modal-backdrop").count();
  check(dupWarnVisible, "the duplicate-name warning is shown while typing an existing name");
  check(dupStillOpen>0, "saving a duplicate name is blocked — the dialog stays open rather than silently overwriting");
  check((await page.locator(".list-row").count())===PLAYERS.length,
    `duplicate-name save attempt does not change the player count (still ${PLAYERS.length})`);
  await page.click('.modal [data-act="cancel"]');
  await page.waitForSelector(".modal-backdrop", {state:"detached", timeout:2000}).catch(()=>{});

  await page.fill("#numGames","10"); await page.press("#numGames","Tab");
  await page.fill("#benchSize","2"); await page.press("#benchSize","Tab");

  // ---- Schedule: generate, check for errors, inspect a game's rotation grid ----
  await page.click('.tab-btn[data-tab="schedule"]');
  await page.click("#genBtn");
  // runGeneration() is deferred via setTimeout(...,0), so the busy state is
  // observable only in the instant right after the click, before it runs.
  const genBtnTextWhileBusy = await page.locator("#genBtn").textContent();
  const genBtnDisabledWhileBusy = await page.locator("#genBtn").isDisabled();
  check(/generating/i.test(genBtnTextWhileBusy) && genBtnDisabledWhileBusy,
    `Generate button shows a disabled busy state immediately after clicking (text="${genBtnTextWhileBusy}", disabled=${genBtnDisabledWhileBusy})`);
  await page.waitForTimeout(50);
  check((await page.locator("#genBtn").textContent())==="Generate season",
    "Generate button returns to its normal label once generation finishes");
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

  // ---- Manual slot-edit swap: the displaced player must be relocated via
  // the follow-up dialog, never lost or duplicated on-court ----
  const q1Slots = await page.locator('#gameBody-1 [data-slot*="|0|"]').all();
  const q1Before = [];
  for(const cell of q1Slots){
    const slot = await cell.getAttribute("data-slot");
    const name = (await cell.locator(".pname").textContent()).trim();
    q1Before.push({ pos: slot.split("|")[2], name });
  }
  const editPos = q1Before[1].pos; // a different slot than the one just locked/edited above
  const otherEntry = q1Before.find(e=>e.pos!==editPos);
  await page.locator(`#gameBody-1 [data-slot$="|0|${editPos}"]`).click();
  await page.waitForSelector(".modal #slotSelect");
  const targetOption = page.locator(".modal #slotSelect option").filter({ hasText: otherEntry.name });
  const targetValue = await targetOption.first().getAttribute("value");
  await page.selectOption(".modal #slotSelect", targetValue);
  await page.click('.modal [data-act="save"]');
  await page.waitForSelector(".modal #vacantSelect", {timeout:2000});
  const vacancyHeading = (await page.locator(".modal h3").textContent());
  check(/is now empty/i.test(vacancyHeading), `follow-up dialog appears for the vacated position (${vacancyHeading})`);
  await page.click('.modal [data-act="save"]'); // default selection = the displaced player
  await page.waitForSelector(".modal-backdrop", {state:"detached", timeout:2000}).catch(()=>{});
  await page.click('[data-toggle="1"]'); await page.click('[data-toggle="1"]');

  const q1After = [];
  for(const cell of await page.locator('#gameBody-1 [data-slot*="|0|"]').all()){
    q1After.push((await cell.locator(".pname").textContent()).trim());
  }
  check(q1After.every(n=>n && n!=="—"), `no on-court slot is empty after the swap (${JSON.stringify(q1After)})`);
  check(new Set(q1After).size===q1After.length, `no player appears twice on-court after the swap (${JSON.stringify(q1After)})`);
  await shot(page, "04b-after-slot-swap.png");

  // ---- H5 regression: dismissing the follow-up dialog (Cancel or backdrop)
  // must discard the whole edit, not partially save it. Uses quarter 2 so it
  // doesn't interfere with the swap just verified above. ----
  async function snapshotQuarter(qi){
    const cells = await page.locator(`#gameBody-1 [data-slot*="|${qi}|"]`).all();
    const snap = [];
    for(const cell of cells){
      const slot = await cell.getAttribute("data-slot");
      const name = (await cell.locator(".pname").textContent()).trim();
      snap.push({ pos: slot.split("|")[2], name });
    }
    return snap;
  }
  async function startVacancyFlow(qi){
    const before = await snapshotQuarter(qi);
    const editPos = before[2].pos;
    const otherEntry = before.find(e=>e.pos!==editPos);
    await page.locator(`#gameBody-1 [data-slot$="|${qi}|${editPos}"]`).click();
    await page.waitForSelector(".modal #slotSelect");
    const targetValue = await page.locator(".modal #slotSelect option").filter({ hasText: otherEntry.name }).first().getAttribute("value");
    await page.selectOption(".modal #slotSelect", targetValue);
    await page.click('.modal [data-act="save"]');
    await page.waitForSelector(".modal #vacantSelect", {timeout:2000});
    return before;
  }

  // Variant 1: dismiss via the vacancy dialog's own Cancel button.
  const q2Before = await startVacancyFlow(1);
  check(!!(await page.locator('.modal [data-act="cancel"]').count()), "the follow-up vacancy dialog has a Cancel button");
  await page.click('.modal [data-act="cancel"]');
  await page.waitForSelector(".modal-backdrop", {state:"detached", timeout:2000}).catch(()=>{});
  await page.click('[data-toggle="1"]'); await page.click('[data-toggle="1"]');
  const q2AfterCancel = await snapshotQuarter(1);
  check(JSON.stringify(q2AfterCancel)===JSON.stringify(q2Before),
    `Cancelling the follow-up "now empty" dialog leaves the quarter completely unchanged (before=${JSON.stringify(q2Before)}, after=${JSON.stringify(q2AfterCancel)})`);

  // Variant 2: dismiss via a backdrop click (no button at all) — the original
  // bug report's exact path, since openModal always closes on backdrop mousedown.
  const q3Before = await startVacancyFlow(2);
  await page.locator(".modal-backdrop").click({ position: { x: 10, y: 10 } });
  await page.waitForSelector(".modal-backdrop", {state:"detached", timeout:2000}).catch(()=>{});
  await page.click('[data-toggle="1"]'); await page.click('[data-toggle="1"]');
  const q3AfterBackdrop = await snapshotQuarter(2);
  check(JSON.stringify(q3AfterBackdrop)===JSON.stringify(q3Before),
    `Dismissing the follow-up dialog via a backdrop click leaves the quarter completely unchanged (before=${JSON.stringify(q3Before)}, after=${JSON.stringify(q3AfterBackdrop)})`);

  // ---- Strict specialist pairing (§5.5): toggle the per-game checkbox and
  // confirm it persists across a collapse/reopen of the game card. ----
  const strictBoxSel = '#gameBody-1 #strictPairing-1';
  await page.waitForSelector(strictBoxSel);
  check(!(await page.isChecked(strictBoxSel)), "strict specialist pairing defaults to off for a new game");
  await page.check(strictBoxSel);
  await page.click('[data-toggle="1"]'); await page.click('[data-toggle="1"]');
  check(await page.isChecked(strictBoxSel), "strict specialist pairing checkbox stays checked after collapse/reopen");

  // ---- Manual roster-off dialog (E2/E3): saving a specific pick must show up
  // immediately in the "Rostered off" line, without needing to regenerate. ----
  const rosteredOffLine = page.locator('#gameBody-1 .section-label', { hasText: "Rostered off" }).locator('xpath=following-sibling::div[contains(@class,"hint")][1]');
  await page.click('[data-manageoff="1"]');
  await page.waitForSelector('.modal #offList');
  await page.locator('.modal #offList input[type="checkbox"]').evaluateAll(boxes=>boxes.forEach(b=>{ if(b.checked) b.click(); }));
  const amyCheckbox = page.locator('.modal #offList label', { hasText: "Amy" }).locator('input[type="checkbox"]');
  await amyCheckbox.check();
  await page.click('.modal [data-act="save"]');
  await page.waitForSelector(".modal-backdrop", {state:"detached", timeout:2000}).catch(()=>{});
  check((await rosteredOffLine.textContent())==="Amy",
    `manually saving a roster-off pick updates the "Rostered off" line immediately (got "${await rosteredOffLine.textContent()}")`);

  // ---- Fill-ins: a one-off created via "+ New fill-in" inside
  // Assign-a-fill-in (§6) must not appear as a candidate for a different
  // game (M4: the save-vs-one-off choice must be enforced). ----
  await page.click('[data-assignfillin="1"]');
  await page.waitForSelector('.modal #newFillinBtn');
  await page.click('#newFillinBtn');
  await page.waitForSelector('.modal #fiName');
  await page.fill('#fiName', 'OneOffGuest');
  await page.click('#prefButtons button[data-add="GK"]').catch(()=>{});
  await page.uncheck('.modal #fiSaved');
  await page.click('.modal [data-act="save"]');
  await page.waitForSelector('#finList', {timeout:2000});
  const oneOffChecked = await page.locator('#finList input[type="checkbox"]').evaluateAll(
    (boxes, name) => boxes.some(b => b.closest('label').textContent.includes(name) && b.checked),
    'OneOffGuest'
  );
  check(oneOffChecked, "a new one-off fill-in is auto-assigned (checked) in the game it was created for");
  await page.click('.modal [data-act="save"]');
  await page.waitForSelector(".modal-backdrop", {state:"detached", timeout:2000}).catch(()=>{});

  await page.click('.tab-btn[data-tab="fillins"]');
  const fillinsText = await page.locator("body").textContent();
  check(/One-off/.test(fillinsText), "the Fill-ins tab marks a one-off fill-in distinctly");

  // ---- SS-8/SS-9: the "Add fill-in" dialog's Cancel button must fully
  // discard entered data, and reopening afterward must be fresh, not
  // pre-filled with the cancelled entry. ----
  const fillinCountBefore = await page.locator("#fillinList .list-row").count();
  await page.click('#addFillinBtn');
  await page.waitForSelector('.modal #fiName');
  await page.fill('#fiName', 'CancelledGuest');
  await page.click('#fiButtons button[data-add="WD"]');
  await page.click('.modal [data-act="cancel"]');
  await page.waitForSelector(".modal-backdrop", {state:"detached", timeout:2000}).catch(()=>{});
  const fillinCountAfterCancel = await page.locator("#fillinList .list-row").count();
  check(fillinCountAfterCancel===fillinCountBefore,
    `Cancel on the Add-fill-in dialog creates no fill-in (before=${fillinCountBefore}, after=${fillinCountAfterCancel})`);
  check(!(await page.locator("body").textContent()).includes('CancelledGuest'),
    "the cancelled fill-in's name does not appear anywhere on the page");

  await page.click('#addFillinBtn');
  await page.waitForSelector('.modal #fiName');
  const reopenedName = await page.locator('.modal #fiName').inputValue();
  const reopenedChipsText = await page.locator('.modal #fiChips').textContent();
  check(reopenedName==="", `reopening the dialog after Cancel starts with an empty name field (got "${reopenedName}")`);
  check(!reopenedChipsText.includes('WD'), "reopening the dialog after Cancel starts with no preferences pre-filled");
  await page.click('.modal [data-act="cancel"]');
  await page.waitForSelector(".modal-backdrop", {state:"detached", timeout:2000}).catch(()=>{});

  await page.click('.tab-btn[data-tab="schedule"]');
  await page.click('[data-toggle="2"]');
  await page.waitForSelector('#gameBody-2');
  await page.click('[data-assignfillin="2"]');
  await page.waitForSelector('.modal #finList');
  const leaksToOtherGame = await page.locator('#finList').textContent();
  check(!leaksToOtherGame.includes('OneOffGuest'), "a one-off fill-in scoped to game 1 does not appear as a candidate for game 2");
  await page.click('.modal [data-act="cancel"]');
  await page.waitForSelector(".modal-backdrop", {state:"detached", timeout:2000}).catch(()=>{});
  await page.click('[data-toggle="2"]');

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

  // ---- XLSX export (M8: proves the locally-vendored library works) ----
  await page.click('.tab-btn[data-tab="data"]');
  const [xlsxDownload] = await Promise.all([
    page.waitForEvent("download"),
    page.click("#exportXlsxBtn")
  ]);
  const xlsxPath = path.join(SCREENSHOT_DIR, "export.xlsx");
  await xlsxDownload.saveAs(xlsxPath);
  const xlsxStat = fs.statSync(xlsxPath);
  check(xlsxStat.size > 1000, `XLSX export downloads a non-trivial file (${xlsxStat.size} bytes)`);

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
