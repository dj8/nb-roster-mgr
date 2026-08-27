# Season Roster — Netball

A season-long roster planner for a netball coach/manager: who plays which position each
quarter of each game, who's on the bench, who's rostered off, and how to handle
short-staffed games. Runs entirely in the browser — no server, no build step, no account.

## Features

- **Player preferences** — each player has an ordered list of preferred positions
  (`GS, GA, WA, C, WD, GD, GK`); the engine honours preference order as its dominant goal.
- **Exact position assignment** — each quarter's on-court/bench assignment is solved with
  the Hungarian algorithm (minimum-cost bipartite matching), not a heuristic.
- **Season-wide roster-off search** — who's rostered off each game is decided across the
  whole season at once, balancing missed-games fairness against position coverage via a
  tunable slider.
- **Fill-ins** — add guest players for short-staffed games, either saved for reuse or as
  a one-off for a single game.
- **Manual overrides** — lock any slot or roster-off decision, then rebalance the rest of
  the season around it. Mark a game "played" to freeze its lineup permanently.
- **Reports** — season-wide fairness stats, an off-preference log, and warnings when
  perfectly even missed-games isn't achievable given the roster's position depth.
- **CSV import/export** — full round-trip of players, preferences, settings, and the
  generated schedule, for backing up or sharing between coaches.
- **XLSX export** — rotation grid, player summary, and short-staffed-game notes as
  spreadsheet tabs.

## Running it

This is a static site — no build step, no server. Open `index.html` directly in a
browser, or serve the folder with any static file server:

```bash
npx serve .
```

Data is stored in the browser's `localStorage`, so it persists across reloads on the
same device/browser.

## Development

The `package.json` in this repo is dev-tooling only (tests), not required to run the app.

```bash
npm install
npm test        # unit tests for the roster/assignment engine (tests/run.js)
npm run test:ui # headless browser smoke test (tests/ui-smoke.js, needs Playwright)
```

## Project structure

```
index.html    entry point
app.js        UI + application state + CSV/XLSX import-export
solver.js     roster-off search (Phase 1) and cost model (Phase 2)
hungarian.js  the Hungarian algorithm, standalone and unit-testable
styles.css    styling
vendor/       vendored third-party library (SheetJS xlsx)
docs/         requirements spec and test plan
tests/        unit tests and a Playwright UI smoke test
```

## Docs

See [`docs/Netball_Roster_App_Requirements.md`](docs/Netball_Roster_App_Requirements.md)
for the full domain/requirements spec and
[`docs/Netball_Roster_App_Test_Plan.md`](docs/Netball_Roster_App_Test_Plan.md) for the
test plan.
