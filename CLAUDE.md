# CLAUDE.md

Netball season roster planner. A static browser app (no build step, no server, no framework) that
generates a season's rotation: who plays which of 7 positions each quarter, who's on the bench, and
who's rostered off. State lives in `localStorage`. `package.json` is dev tooling only.

## Commands

```bash
npm run lint      # ESLint over all JS (eslint.config.js) — must be clean before every commit
npm test          # tests/run.js — unit tests against the engine (Node only, no browser)
npm run test:ui   # tests/ui-smoke.js — headless Playwright walk-through (needs `npx playwright install chromium` once)
npm run test:settings  # tests/settings-sweep.js — sweeps every Settings control; hard checks + per-step findings (-- --detail for numbers)
npx serve .       # or just open index.html
```

Node is installed via Homebrew on this machine (`/opt/homebrew/bin`); if `node` isn't on PATH in a
non-login shell, prefix with `export PATH="/opt/homebrew/bin:$PATH"`. Run `npm test` after any
change to `solver.js`, `hungarian.js` or the engine half of `app.js`; run `test:ui` after UI changes, and `test:settings` after retuning the cost model or any setting.

## Layout

| File | Role |
|---|---|
| `index.html` | Entry point; loads `vendor/xlsx.full.min.js`, then `hungarian.js`, `solver.js`, `app.js` as classic scripts |
| `hungarian.js` | Standalone Hungarian algorithm (`Hungarian`). Pure math. |
| `solver.js` | `RosterSolver`. Phase 1 = season-wide roster-off search; Phase 2a = per-quarter cost model + Hungarian; Phase 2b = within-game refinement. **Pure: plain data in/out, no DOM, no `localStorage`.** |
| `app.js` | One ~2,200-line IIFE: `STATE`, generation orchestration, all UI rendering, JSON backup + XLSX/CSV I/O |
| `styles.css` | All styling; theme tokens under `html[data-theme]` |
| `tests/harness.js` | Loads `app.js` into a Node `vm` sandbox for unit tests (see Gotchas) |

## Docs — read before non-trivial changes

Start at [`docs/README.md`](docs/README.md); it indexes everything below.

- `docs/Netball_Roster_App_Requirements.md` — the domain spec. Code comments cite its sections
  (`§5.5`, `§8.1`, …); when behaviour looks odd, find the section before "fixing" it.
- `docs/Netball_Roster_App_Test_Plan.md` — numbered test IDs (`OP-9`, `P1-5`, …) used in `tests/run.js`.
- `docs/modules/*.md` — per-area function reference (solver, engine, each UI area, CSV/XLSX).
- `docs/data-model.md`, `docs/flows.md` — `STATE` shape and sequence diagrams.
- `docs/gotchas.md` — non-obvious design decisions. Read it.

Keep docs in step with code: if you change a function signature, `STATE` field or flow, update the
matching `docs/modules/*.md` / `data-model.md`.

## Invariants and gotchas (details in `docs/gotchas.md`)

- **Played games are frozen (§8.1).** Anything that writes to a game must check `game.isPlayed` first
  and skip it. Nothing enforces this structurally.
- **Fill-ins are excluded from season fairness.** Any new aggregate over a quarter's `onCourt`/`bench`
  must filter out fill-ins (`isFillInId(pid)`).
- **`rosterOffLockIds`: `null` ≠ `[]`.** `null` = auto, `[]` = explicit "nobody off". Use
  `Array.isArray`, not a length/truthy check. Both the JSON backup and localStorage preserve the distinction.
- **Disqualified Hungarian cells use `BIG_M` (1e9), never `Infinity`** — `Infinity` yields NaN in the
  potentials arithmetic.
- **Off-preference costs every player with a preference list the same flat `OFF_PREFERENCE_COST`** (a
  no-preference fill-in costs `NO_PREFERENCE_COST`), and the variety term in
  `buildQuarterCostFns` is capped below it, so raising position variety can never make an off-preference
  cell cheaper than an in-preference one. The preference slider's weights (`derivePreferenceWeights`)
  are geometric with tuned endpoints. Re-run `npm run test:settings` if retuning any of it.
- **Phase 1 is deterministic** (seeded `mulberry32`, never `Math.random()`); tests assert exact results.
- **Hardcoded shape:** 4 quarters, 7 positions (`GS GA WA C WD GD GK`). Not configurable.
- **No auto re-render.** Handlers mutate `STATE`, then explicitly call `saveState()` and the relevant
  `render*()`. Set `dirtySinceGeneration = true` when a change makes the schedule stale.
- **`app.js` exports nothing.** `tests/harness.js` splices a `module.exports` block in before the closing
  `})();`. A new function that needs a unit test must be added to the export list in `tests/harness.js`.
- **Two different imports:** Setup → players-only CSV, additive; Data → full JSON backup, replaces `STATE`.

## Adding a `STATE` field — checklist

1. Default it in `defaultState()` (settings/season) or `newGameState()` (per-game) so old saves pick it
   up via the merge in `loadState()`. Per-game fields must tolerate `undefined` on old saves.
2. Sanitize if it can arrive from an untrusted source (`sanitizeSettingsAndSeason`, `sanitizePrefs`, …).
3. If it should survive export/import, add it to **both** `buildBackup` and `importBackup` (under `plan` if the
   coach sets it, `results` if the engine produces it), validating its type on import. Adding an
   *optional* field needs no schema bump (a missing value falls back to its default on import).
   Renaming, removing or changing the meaning of a field **does**: bump `BACKUP_SCHEMA_VERSION` in
   `app.js`, add a migration in `importBackup` that upgrades each older `schemaVersion` to the current
   shape before it's read (today there are none — files are only checked as `<=` current; the v1→v2 settings change was deliberately not migrated: retired settings are ignored and `preferenceSlider` keeps its number on the new scale), and add a
   test that imports a saved old-format file. Also update the example file in
   `docs/modules/csv-xlsx-io.md`.
4. If the engine consumes it, thread it through `app.js` into the plain-data input of `solver.js`.
5. Add a test in `tests/run.js` and update `docs/data-model.md` plus the relevant `docs/modules/*.md`.

Worked example: per-game `allowOffPreference` (`null` = follow Settings, else boolean), via
`gameAllowsOffPreference()` in `app.js` and `allowOffFor()` in `solver.js`; test `OP-12`.

## Conventions

- Match the surrounding style: terse, comment only the non-obvious and cite `§` spec sections where relevant.
- Plain ES (no modules, no transpiling, no new runtime dependencies); `vendor/` holds the only third-party code.
- Escape every user-supplied string with `esc()` when building HTML; treat everything in an imported backup as untrusted
  (type-check it in `importBackup`).
- Create a new branch off an up-to-date `main` for each new set of features or fixes (named succinctly for the update, e.g. `per-game-off-preference` or `fix-roster-off-dialog`); don't commit feature work directly to `main`. Merge via PR (`gh pr create --base main`) and delete the branch afterwards. There is no long-lived `dev` branch.
- **Before every commit:** run `npm run lint` and `npm test` and fix anything they report (lint must be clean, not just "no new errors"); run `npm run test:ui` too if you touched the UI. Don't commit while either fails.
- **Before every merge:** run `/simplify` on the branch's diff and apply what it finds, then run `/code-review` and fix or explicitly dismiss each finding. Re-run the pre-commit checks above after any resulting change. Only then merge the PR.
- Bump `BUILD_NUMBER` (top of `app.js`) by 1 in every commit, as part of that commit. It's a plain integer shown in the app header and written into backup files as `buildNumber`; it replaced the old `APP_VERSION` string.
