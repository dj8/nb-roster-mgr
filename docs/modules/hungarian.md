# `hungarian.js` — Assignment Algorithm

## Responsibility

A single, pure, standalone implementation of the Kuhn-Munkres (Hungarian) algorithm:
exact minimum-cost bipartite matching on a square cost matrix. No DOM, no app knowledge,
no dependency on anything else in this repo. Attached to `window.Hungarian` (and
`module.exports` under Node) as `{ solve }`.

This is the only place in the codebase that decides "which row goes to which column
optimally" — `solver.js` builds the cost matrices; this file just solves them.

## Public API

| Function | Params | Returns | Side effects |
|---|---|---|---|
| `solve(costMatrix)` | `costMatrix`: array of `n` arrays of `n` numbers (square). Use a large finite sentinel for "this cell is disallowed" — see [`gotchas.md`](../gotchas.md#big_m-not-infinity-marks-a-disqualified-hungarian-cell) | `assignment`: array of length `n`, `assignment[row] = col` | None — pure function |

Throws if any row's length doesn't match `n` (non-square matrix). Returns `[]` for
`n === 0`.

## Algorithm notes

Classic shortest-augmenting-path formulation with row/column potentials (`u`, `v`) —
1-indexed internally, converted back to 0-indexed on return. O(n³). This is an *exact*
solver, not a heuristic — for a given cost matrix there is no better assignment by total
cost, which is what lets `solver.js`'s cost design (not this file) carry all the actual
domain logic (preference honoring, fairness, etc.) while this file just guarantees the
optimum is found for whatever costs it's handed.

## Callers

Only `solver.js`, and only in one place: `RosterSolver.solveQuarterPositions()` builds a
`(squad size) × (open positions + bench slots)` cost matrix and calls
`Hungarian.solve(matrix)` once per quarter. See [`solver.md`](solver.md).
