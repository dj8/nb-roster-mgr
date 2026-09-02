# UI Shell & Modal Kernel (`app.js`)

## Responsibility

The framework-free plumbing every tab and dialog is built on: the top-level tab shell,
toasts, and — the biggest piece — the shared modal system (`openModal`/`closeModal`) that
every one of the app's ~10 dialogs is a thin wrapper around. There's no templating
library; every `render*` function returns a template-literal HTML string assigned to
`.innerHTML`, then wires up event listeners by querying the DOM it just created.

## Tab shell

| Function | Params | Returns | Side effects |
|---|---|---|---|
| `render()` | — | — | Sets `<html data-theme>`, rebuilds the entire `#app` shell (brand, theme toggle, tab bar), wires the theme toggle and tab-click/arrow-key handlers, then calls `renderMain()`. Called once at boot and after anything that changes `STATE.theme`. |
| `syncTabButtons()` | — | — | Updates `.active`/`aria-selected` on the tab buttons without a full `render()` — used after `renderMain()` so switching tabs doesn't also re-render the topbar |
| `renderMain()` | — | — | Looks up `STATE.activeTab` in a `{tabId: renderFn}` map and calls the matching tab's render function into a fresh `#panelRoot` |

The tab bar is a real `role="tablist"` with arrow-key navigation (`ArrowLeft`/`ArrowRight`
cycles `STATE.activeTab`) and a scroll-fade cue (`wireScrollFade`, below) for narrow
viewports where not all 6 tabs fit.

## Toasts

`toast(msg)` — appends a `.toast` element to a lazily-created `.toast-stack` container
(`role="status" aria-live="polite"`, so screen readers announce it), auto-removes after
2.6s. Fire-and-forget; no queue/dedup logic beyond the DOM naturally stacking multiple
toasts if fired in quick succession. Used throughout for confirmations and — for
non-blocking notices — validation ("Regenerate to apply.", etc.); **blocking** field
validation uses `showFieldError` instead (below), not a toast.

## The modal kernel

Every dialog in the app (`openPlayerDialog`, `openFillInDialog`, `openRosterOffDialog`,
`openAssignFillInDialog`, `openSlotEditDialog`, `openFillVacancyDialog`,
`confirmDialog`) is built by calling `openModal(html, onMount)` — this is the one place
focus handling, Escape-to-close, and Tab-trapping are implemented, so fixing/changing
behavior here fixes it for every dialog at once rather than needing per-dialog changes.

| Function | Params | Returns | Side effects |
|---|---|---|---|
| `openModal(html, onMount)` | `html`: the modal's inner markup (expected to start with an `<h3>`); `onMount(modalEl)`: callback to wire up the just-created DOM | the modal `<div>` element | Closes any existing modal first. Records `document.activeElement` to restore later. Builds `<div class="modal-backdrop"><div class="modal" role="dialog" aria-modal="true" aria-labelledby="...">`, assigns the generated id to the `<h3>` it finds inside `html`. Sets `document.body.style.overflow="hidden"`. Attaches a document-level `keydown` listener (`handleModalKeydown`). Calls `onMount`, then focuses the first focusable element inside the modal (falls back to the modal itself). |
| `closeModal()` | — | — | Removes the backdrop, restores `body.style.overflow`, removes the keydown listener, restores focus to whatever had it before `openModal` was called |
| `handleModalKeydown(e)` | keyboard event | — | `Escape` → `closeModal()`. `Tab`/`Shift+Tab` on the first/last focusable element wraps around instead of leaving the modal (a manual focus trap — no library) |
| `focusableEls(container)` | a DOM element | array of focusable elements inside it | Used both to pick initial focus and to compute the Tab-trap boundaries |
| `confirmDialog(title, msg, onYes, opts?)` | `opts: {confirmLabel, danger}` | the modal element | A thin `openModal` wrapper for yes/no confirmations. `opts.danger` swaps the confirm button to `.btn-danger-solid` (solid red) instead of `.btn-primary`; `opts.confirmLabel` replaces the generic "Confirm" with the actual verb (e.g. `"Remove Amy Richardson"`) — see [`ui-schedule.md`](ui-schedule.md) and [`ui-setup-and-fillins.md`](ui-setup-and-fillins.md) for call sites. |

**Every dialog's Save handler follows the same "draft, then commit" pattern**: build a
local draft object, validate/mutate it, and only write to `STATE` in the final step —
`closeModal()` (via Escape, backdrop click, or a Cancel button) never has to unwind
partial state because nothing was written yet. See
[`flows.md`](../flows.md#2-manual-slot-edit--the-swap-cascade) for the most involved
example of this.

## Inline validation

| Function | Params | Side effects |
|---|---|---|
| `showFieldError(modal, afterSelector, msg, focusSelector?)` | the modal, a selector for the element the error should appear after, the message, optional selector for what to focus | Adds `.input-error` to the target, inserts (or updates) a `.field-error` element right after it, focuses `focusSelector` or the target itself |
| `clearFieldErrors(modal)` | the modal | Removes every `.field-error`/`.input-error` in it — called at the top of a Save handler before re-validating |

Used by `openPlayerDialog` (name required, must not duplicate an existing name, at least
one preference) and `openFillInDialog` (name required) so a failed submission puts the
error right next to the field that caused it, with focus moved there — not a toast far
from the form.

## Misc shared helpers

| Function | Purpose |
|---|---|
| `wireScrollFade(el)` | Toggles an `.at-end` class based on scroll position so a CSS fade-out gradient (on `.table-scroll`/`.tabs`) disappears once there's nothing further to scroll to. Called after any render that creates a new scrollable region. |
| `syncRangeFill(input)` | Sets a `--range-pct` CSS custom property on a `<input type=range>` so its track shows a filled/unfilled split at the current value — native range inputs don't do this themselves. |

## Called by

Every `render*` function in the other UI modules. This section has no dependency on any
of them — it's the lowest layer of the UI code, sitting directly on top of the DOM.
