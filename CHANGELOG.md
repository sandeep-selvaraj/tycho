# Changelog

What changed in each release of Tycho, written for the people using it. The newest release is first.

This file is the single source for release notes: the GitHub Release for a version and the
"What's new" list inside the app are both taken from that version's section. Add entries under
`Unreleased` as you build; `npm run release -- <version>` turns that section into the release.
Screenshots are welcome (`![Costs view](docs/releases/costs.png)`): they appear on the GitHub
Release, and the app shows the text.

## Unreleased

- **Costs view.** See cost by day, month or year, and pick any period to list the sessions that spent something in it, how much each spent, and its share of the total.
- **Activity graph.** A year of days at the top of Costs, one square each: brighter for more spend, coloured by harness, and blended on days that used several. Click a square to open that day.
- **Settings and updates.** A new Settings panel shows the version you are running and what changed in it, and can check whether a newer release is available. On macOS, **Install and restart** downloads the new version, verifies it and reopens Tycho on it.
- **Codex support.** Sessions from the Codex CLI and desktop app are read alongside Claude Code, OpenCode and Cursor.
- **Cursor cost estimates.** Cursor chats now show an estimated cost even when Cursor recorded no token counts, always marked as an estimate.
- **Running subagents are named.** A session row says which of its subagents are in flight right now.
- Chats running in Cursor and OpenCode now appear under Running while they run, instead of only after the harness next saves its store.
- "Running" follows what the harness itself reports, so a session waiting on a long tool stays listed and one that just finished drops off promptly.
- Busy sessions show up while they are being written, not only once they go quiet.
- Blank chat tabs opened in Cursor are no longer listed as sessions.
- A session keeps its first prompt as its title instead of taking on later prompts.

## 0.1.0 - 2026-11-10

- First release: one local, read-only view of Claude Code, OpenCode and Cursor sessions.
- **Overview** with cost for today, 7 days and 30 days, running sessions, a 14-day cost chart and cost by model.
- **Sessions** with a tool-call timeline and per-turn token bars, and a full transcript for each session.
- **Tools**: call counts, error rates and durations per tool and harness.
- **Search** across every message from every harness.
- **Sources**: every file and database Tycho reads, with its health.
- A menu-bar item with today's cost and the sessions running now.
