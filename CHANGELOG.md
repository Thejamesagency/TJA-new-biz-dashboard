# Changelog

All notable changes to the TJA New Biz Dashboard.

## [0.1.1] — 2026-04-17

### Weekly Priorities
- Added an inline `Add task...` input at the bottom of every day column (both single-day carousel and full-week grid views). Input re-focuses after submit for fast consecutive entry.

### Status Report
- Priority pills are now colored: High = red, Medium = yellow, Low = dull sage green (previously Low was an inert gray).
- **Removed the Sales Stage column.** Removed from the table header, filter bar, modal, dropdown-editor, and archive view. Removed the `salesStage` reference from the Priority Matrix task-detail popup. The `salesStage` field in existing stored tasks is preserved but no longer read by any code.

## [0.1.0] — 2026-04-17

Initial repo import. Captures the current state of the dashboard prior to GitHub hosting.

### Weekly Priorities
- Week-jump dropdown (date picker + Jump to Today + recent 12 weeks).
- Support/Proof sub-section removed; single flat priority list per day.
- Day carousel view with 5 chunky week-strip pills; drag cards onto pills to re-assign day.
- Full Week View toggle for standup / whole-week review.
- Weekly sections shown as a 4-column always-visible grid (Team Training Focus removed). Card bodies are vertically resizable.
- "From Priority Matrix" sidebar tab grouped by quadrant (Q1/Q2/Q3/Q4) with per-task day picker.
- Import modal — paste Google Doc-style weekly priority docs, preview parsed weeks, merge or replace per-week, skipped-lines diagnostic.

### Priority Matrix
- On "Update & Keep Active" with a new due date beyond tomorrow, the matrix task is now removed (auto re-pulled by `syncFromStatusReport()` when due date approaches).

## Version scheme

`MAJOR.MINOR.PATCH`
- **MAJOR** — localStorage schema changes or breaking behavior.
- **MINOR** — new features.
- **PATCH** — bug fixes / tweaks only.
