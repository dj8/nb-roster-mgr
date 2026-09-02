# Reports & Settings Tabs (`app.js`)

## Reports tab

Read-only — no dialogs, no writes to `STATE`. Everything is recomputed fresh on each
render from the functions in [`engine.md`](engine.md#report-aggregations).

`renderReports(root)` renders, in order:

1. **Missed-games spread** card — only shown when `computeMissedGamesWarningForReports()`
   returns non-null (spread beyond a threshold).
2. **Roster-off evenness: structural limits** card — only shown when
   `computeRosterOffAchievabilityNotesForReports()` returns entries (a position too thin
   to ever rest evenly, independent of settings).
3. **Player summary** table — a spread-stat row (on-court/bench/missed-games spread across
   the roster) above a per-player table: games played, on-court/bench quarters, missed
   games, a count per position (small `.offpref-dot` marker next to a position's count
   when some of those quarters were off-preference), total off-preference quarters.
4. **Off-preference report** — every off-preference fill this season with
   `describeOffPrefReason()`'s explanation of why (unavailable/benched specialists).
5. **Short-staffed game notes** — one card per shortfall game with min/recommended
   fill-in counts and coverage gaps.

## Settings tab

`renderSettings(root)` renders three cards of sliders/checkboxes bound directly to
`STATE.settings`. Every control's `onchange` handler does the same three things:
`saveState()`, set `dirtySinceGeneration = true`, and `toast("Regenerate to apply.")` —
none of these settings take effect until the next Generate/Rebalance. A persistent
`.alert-warn` banner appears at the top of the tab whenever `dirtySinceGeneration` is
already true from a previous change.

| Setting | Control | Range |
|---|---|---|
| `preferenceSlider` | slider | 0–10, fairness ↔ strict preference |
| `allowOffPreference` | checkbox | — |
| `topTwoOnly` | checkbox | — |
| `rosterOffWeight` | slider | 0–10, roster-off fairness ↔ position coverage |
| `fairnessWeights.bench` | slider | 1–10 |
| `fairnessWeights.positionPurity` | slider | 1–10 |

| Function | Purpose |
|---|---|
| `labelledSliderHtml({id, dataWeight, min, max, step, value, valueId, leftLabel, rightLabel})` | Shared markup for every slider on this tab — a `<input type=range>` + numeric readout + end-labels describing what each direction does, so all five sliders are structurally identical. `id`/`for` are wired for label association. |

Every slider's `oninput` also calls `syncRangeFill(e.target)` (see
[`ui-shell-and-modals.md`](ui-shell-and-modals.md)) so the filled-track visual updates
live while dragging, separately from the `onchange` that actually persists the value.

## Called by

Both are `renderMain` tab entry points; neither is called from anywhere else. Both read
functions defined in [`engine.md`](engine.md) and [`solver.md`](solver.md) but never call
into [`ui-schedule.md`](ui-schedule.md) directly.
