# Codebase Review Handoff

**Purpose of this doc:** context for a fresh code review of this repo. It exists so the
reviewer doesn't have to re-derive project history from scratch, and — just as
importantly — doesn't waste effort re-reporting defects that were already found and
fixed in a prior pass (listed below). The review this doc accompanies should focus on
**dead code, remaining errors, and improvement opportunities**, not a repeat of what's
already been through remediation.

## What this app is

A static, client-only netball season roster planner (`app.js` + `solver.js` +
`hungarian.js` + `index.html` + `styles.css`, no build step, no server). A coach enters
players and their ordered position preferences, sets season parameters, and the app
generates a full season's rotation: who plays which of the 7 netball positions each
quarter of each game, who's on the bench, and who's rostered off — using an exact
Hungarian-algorithm solve per quarter plus a season-wide roster-off search. Full
requirements are in [`Netball_Roster_App_Requirements.md`](Netball_Roster_App_Requirements.md)
and the test plan in [`Netball_Roster_App_Test_Plan.md`](Netball_Roster_App_Test_Plan.md) —
**read those two files first**; most of what "correct" means for this codebase is
defined there, not inferable from the code alone.

Current version: `1.0.1`. Working tree is clean; `node tests/run.js` (55 tests) and
`node tests/ui-smoke.js` (Playwright, needs `npx playwright install chromium` once) both
pass fully as of this writing.

## File map

| File | Role |
|---|---|
| `app.js` | UI rendering, application state, CSV/XLSX import-export, DOM event wiring |
| `solver.js` | Season-wide roster-off search (Phase 1) and the Phase 2 cost model |
| `hungarian.js` | Standalone Kuhn-Munkres minimum-cost bipartite matching |
| `index.html` / `styles.css` | Entry point / styling |
| `vendor/xlsx.full.min.js` | Vendored third-party library (SheetJS), not a CDN dependency |
| `tests/run.js` | Node-based unit tests against the engine (via `tests/harness.js`, a vm-sandboxed load of the app) |
| `tests/ui-smoke.js` | Headless Playwright smoke test against the real rendered UI |

## Prior review round — already fixed, don't re-report

A full review-and-remediation pass was completed against this codebase earlier. It found
and fixed real bugs across the following categories, each backed by a reproduction and a
regression test that's now in `tests/run.js` / `tests/ui-smoke.js`:

- **Crash/security:** a malformed CSV import (non-numeric settings) could crash the
  solver and leave corrupted state live; imported preference strings weren't sanitized
  before being rendered (stored XSS).
- **Solver correctness:** the "prefer top-2 positions" toggle was a hard eligibility rule
  instead of a soft nudge; an empty preference list was the *cheapest* possible
  candidate at any position; a played (locked) game's roster-off record wasn't actually
  immutable; the position-purity and bench-weight cost terms were nearly inert (capped
  below a useful range) and bench cost wasn't scaled by the preference slider, which
  could make raising bench weight *increase* off-preference fills even at max
  preference.
- **UI data integrity:** a manual slot-swap follow-up dialog could be dismissed after the
  swap was already committed, silently corrupting a quarter.
- **CSV round-trip:** import silently re-solved each game's roster-off selection instead
  of restoring the exported values exactly.
- **Missing features that the requirements doc calls for but the code didn't have:** the
  per-game "strict specialist pairing" toggle (§5.5), and the fill-in save-vs-one-off
  choice (§6).
- **Misc:** Generate/Rebalance had no busy-state indicator (looked identical to a hang);
  the XLSX library was loaded from a CDN instead of vendored locally.

If the review surfaces something that looks like one of the above, check whether it's
actually a *new* instance/variant before flagging it as unaddressed — but genuine gaps
or incomplete fixes in this list are fair game to report.

## Two known behaviors, discussed but not changed (deliberately, so far)

Two things came up recently in normal use of the app that turned out to be intended
behavior, not bugs — flagging them here as candidates for either (a) confirming they're
fine as-is, or (b) improving the wording/UX, since both caused real user confusion:

1. **"Coverage gaps" wording is ambiguous.** `fillInGapSuggestions()` in `app.js` flags a
   position as a "coverage gap" for a shortfall game whenever `coverage <= 1` among
   available players — i.e. *zero or one* covering player, not just zero. A coach who
   knows a specific player covers that position (the "one") reasonably reads "Coverage
   gaps: GS" as "nobody covers GS," which is wrong — it means "only one specialist, no
   backup." The underlying logic is arguably fine; the label doesn't distinguish "thin"
   from "empty" and doesn't name who the lone specialist is (unlike the similarly-themed
   coverage-warning pills elsewhere in the Schedule tab, which do name names).
2. **A squad of exactly 7 shows no rotation at all.** When a shortfall game's available
   regulars plus assigned fill-ins add up to exactly 7, bench is `squad size - 7 = 0` by
   design (documented, tested behavior — `noBenchOnly`/`RO-4`/`QR-5`) — every player is
   on court every quarter, and if there's also no numerical slack in position coverage,
   the same assignment can legitimately repeat every quarter with nothing to swap
   against. This surprised a user expecting "rotation" in the everyday sense. Worth
   considering whether the existing "no bench this game" messaging is surfaced clearly
   enough in this specific (shortfall + exactly-7) case, since right now it shares a pill
   with an unrelated non-shortfall case.

## What this review should focus on

- **Dead code**: unused exports, unreachable branches, constants declared but never
  read (there's at least one already known — see if you find others), functions with no
  call sites.
- **Errors**: anything that produces a wrong result, crashes, or violates something
  stated in the requirements/test-plan docs, that isn't already covered by the "prior
  review round" list above.
- **Improvements**: simplification opportunities, redundant computation, inconsistent
  patterns between similar pieces of code, missing test coverage for something
  user-facing and non-trivial, anything that would trip up the next person to touch this
  codebase.

Please **do not modify any files** — this is a read-only review. Report findings with
enough detail (file, line, concrete reasoning, and — where relevant — a reproduction or
example) that someone else can act on them without re-deriving your analysis.
