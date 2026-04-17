# TJA New Biz Dashboard

Internal productivity dashboard for The James Agency new business tracking.

## Pages

- **Weekly Priorities** (`weekly-priorities.html`) — the main view. Kanban-style weekly planner with per-day task lists, week-jump dropdown, Priority Matrix and Status Report pull-in tabs, End-of-Week report, and standup mode.
- **Priority Matrix** (`eisenhower-matrix.html`) — Eisenhower matrix (Do / Decide / Delegate / Upcoming) with auto-pull from Status Report for tasks due today/tomorrow, plus AM/PM daily planning sidebar.
- **Status Report** (`task-list.html`) — master list of all active pursuits / clients with status, due date, priority, and description. Feeds the other two pages.

All three pages share data via `localStorage`. Since Pages are served from the same origin on GitHub Pages, the integrations (auto-pull, Push to Priority Matrix, link back to Status Report) all work.

## Hosted

Deployed via GitHub Pages. The `index.html` at the repo root redirects to Weekly Priorities.

## Local development

Open any of the HTML files directly in a browser — no build step, no dependencies. All logic is vanilla JS in a single file per page.

## Data storage

Everything lives in browser `localStorage` under these keys:

| Key                     | Contents                                               |
| ----------------------- | ------------------------------------------------------ |
| `wp_weeks`              | Map of week Monday ISO → week object (days, sections). |
| `wp_current_week`       | ISO Monday of the currently-viewed week.               |
| `wp_selected_day`       | Map of week ISO → selected day key (carousel state).   |
| `wp_view_mode`          | `"day"` (carousel) or `"week"` (full-week grid).       |
| `sr_tasks`              | Active Status Report tasks.                            |
| `sr_archived_tasks`     | Completed / killed SR tasks.                           |
| `sr_statusOptions`      | Status picklist values.                                |
| `eisenhower_tasks`      | Priority Matrix tasks.                                 |

**Back up your data before deploying new versions.** See `CHANGELOG.md` for version history.

## Browser support

Tested in current Chrome / Safari / Firefox. Uses standard HTML5 drag-and-drop, `localStorage`, CSS grid, and ES2017+ syntax.
