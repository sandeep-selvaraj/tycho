<p align="center">
  <img src="design/logo/tycho-icon-1024.png" width="112" height="112" alt="">
</p>

<h1 align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="design/logo/tycho-wordmark-dark.svg">
    <img src="design/logo/tycho-wordmark-light.svg" height="64" alt="Tycho">
  </picture>
</h1>

<p align="center"><b>One local view of every AI coding agent on your machine.</b></p>

Tycho is a desktop app that reads the session history your coding agents already write to disk, including Claude Code, OpenCode, Cursor, and Codex. It shows every chat, every tool call, and what the tokens would have cost, in one searchable place. It backfills your existing history on first launch and then updates live while agents run.

> Named after Tycho Brahe, who recorded the raw observations that Kepler later turned into laws. Tycho does the same for coding agents: it records what happened and leaves the conclusions to you.

- **Zero-touch.** Nothing is installed or configured inside any harness: no plugins, hooks, proxies or environment variables. Tycho only reads files that already exist.
- **Read-only.** Harness files and databases are never written to, locked or migrated. SQLite stores are opened read-only.
- **Local-only.** Your transcripts never leave your machine. There is no telemetry and no account.
- **Honest about cost.** Every cost is labeled with where it came from, and estimates are never shown as exact.

> **Status: early (0.1.0).** It works day to day on macOS. Windows and Linux builds are configured but haven't been tested yet, and there are no prebuilt downloads yet. See [Installation](#installation).

---

## Contents

- [What you get](#what-you-get)
- [Supported harnesses](#supported-harnesses)
- [Installation](#installation)
- [Using Tycho](#using-tycho)
- [How cost is calculated](#how-cost-is-calculated)
- [Privacy and security](#privacy-and-security)
- [Roadmap](#roadmap)
- [License](#license)

## What you get

| View | What it shows |
|---|---|
| **Overview** | Cost for today, 7 days and 30 days. Running sessions. A 14-day cost chart stacked by harness. Cost by model, cache-read share, and a side-by-side comparison of harnesses (cost per session, tokens, tool error rate). |
| **Sessions** | Every session across harnesses, newest first, filterable by harness. Click a row to unfold a timeline of its tool calls and per-turn token bars. |
| **Session detail** | The full transcript (subagent messages indented), cost, tokens, model, and the tool-call timeline. |
| **Tools** | Each tool by harness: call count, error rate, average and p90 duration. Sortable, and filterable by time range. |
| **Search** | Full-text search across every message from every harness, with highlighted matches. |
| **Sources** | Every file or database Tycho reads, with its health, last ingest time and record count. |
| **Menu bar / tray** | Today's cost at a glance and the sessions running now. Click one to open it. |

## Supported harnesses

| Harness | Where Tycho reads | Cost |
|---|---|---|
| **Claude Code** | `~/.claude/projects/**.jsonl`, or `$CLAUDE_CONFIG_DIR/projects` (also `~/.config/claude/projects`) | **Computed** from token counts. Matches `ccusage` to the cent. |
| **OpenCode** | `$XDG_DATA_HOME/opencode` or `~/.local/share/opencode`: `opencode.db` (current and older SQLite layouts) and the legacy `storage/` JSON files | **Reported** by OpenCode when it's above $0, otherwise computed |
| **Cursor** | macOS `~/Library/Application Support/Cursor/User`, Linux `~/.config/Cursor/User`, Windows `%APPDATA%\Cursor\User` (`globalStorage/state.vscdb`) | **Estimated**, and only where Cursor recorded tokens or its own charge. See below. |
| **Codex** | Local CLI and Desktop `rollout-*.jsonl` logs under `sessions/` and `archived_sessions/` in `$CODEX_HOME` (defaults to `~/.codex`) | **Computed** from recorded token counts at API prices. |

Subagents and sidechains appear as part of their parent session, and nothing is counted twice.

## Installation

Tycho runs on **macOS, Windows and Linux**. Prebuilt installers aren't published yet, so for now you build Tycho from source. The build produces a normal app for your OS.

### Prerequisites (all platforms)

- **Node.js 22 or newer** (development uses Node 26) and **npm**
- **Git**

No C/C++ toolchain is needed: the SQLite driver (`better-sqlite3`) ships ready-made binaries for macOS (arm64 and x64), Linux (x64 and arm64, glibc and musl) and Windows (x64 and arm64).

### 1. Get the code

```bash
git clone https://github.com/sandeep-selvaraj/tycho.git
```

```bash
cd tycho
```

```bash
npm install
```

### 2. Try it without installing

```bash
npm start
```

This opens Tycho in development mode. On first launch it reads your existing history in the background. Claude Code and OpenCode usually take a second or two; a large Cursor history can take about a minute, and the app stays responsive meanwhile.

### 3. Build an installable app

```bash
npm run make
```

The output lands in `apps/desktop/out/make/`. Build on the OS you want to install on.

#### macOS

`npm run make` produces `zip/darwin/<arch>/Tycho-darwin-<arch>-0.1.0.zip`. Unzip it and move **Tycho.app** to `/Applications`.

The app isn't signed or notarized yet, so macOS blocks it on first launch. Either right-click **Tycho.app**, choose **Open**, then **Open** again, or clear the quarantine flag:

```bash
xattr -dr com.apple.quarantine /Applications/Tycho.app
```

*Tested on macOS (Apple Silicon).*

#### Windows

`npm run make` produces a Squirrel installer at `apps\desktop\out\make\squirrel.windows\x64\Tycho-Setup.exe`. Run it to install Tycho for your user and add it to the Start menu. Because the installer isn't code-signed yet, SmartScreen may warn you: choose **More info → Run anyway**.

*Configured but not tested on Windows yet.*

#### Linux

`npm run make` builds both a `.deb` and an `.rpm` under `apps/desktop/out/make/`. Building them needs the packaging tools for your distro:

| Distro | Build tools | Install the result |
|---|---|---|
| Debian / Ubuntu | `sudo apt install dpkg fakeroot` | `sudo apt install ./apps/desktop/out/make/deb/x64/tycho_*.deb` |
| Fedora / RHEL | `sudo dnf install rpm-build` | `sudo dnf install ./apps/desktop/out/make/rpm/x64/tycho-*.rpm` |

If you only want a runnable folder without an installer, use `npm run package`; the app lands in `apps/desktop/out/Tycho-linux-x64/` (run `./tycho`).

The tray icon needs a desktop with StatusNotifier/AppIndicator support (most do; on GNOME install the *AppIndicator* extension).

*Configured but not tested on Linux yet.*

### Updating

```bash
git pull
```

```bash
npm install
```

Then run `npm run make` again and reinstall. Your data is kept, and Tycho only reads what changed since last time.

### Uninstalling

Remove the app. To also remove Tycho's own database (your harness files are never touched), delete its data folder:

| OS | Data folder |
|---|---|
| macOS | `~/Library/Application Support/Tycho` |
| Windows | `%APPDATA%\Tycho` |
| Linux | `~/.config/Tycho` |

## Using Tycho

1. **Launch Tycho.** It finds supported harnesses automatically. There is nothing to configure.
2. **Check spend.** The top bar and the menu-bar/tray item show today, 7-day and 30-day cost, plus how many sessions are running.
3. **Dig into a session.** Click any row to see its tool-call timeline. Failed calls are red, and pale bars are tokens served from cache. Choose **Open transcript** for the full conversation.
4. **Find past work.** Use **Search** for anything you or an agent wrote, in any harness. Every word you type matches as a prefix, so `migr` finds "migration".
5. **Compare harnesses.** The **By harness** table on the Overview, and the **Tools** view, show which agent costs more per session and which tools fail most.
6. **Check sources.** If a harness changes its file format, the affected source shows as *degraded* or *failing* under **Sources**, and everything else keeps working.

A session counts as *running* if its harness wrote to it in the last two minutes.

## How cost is calculated

Tycho shows **API-equivalent cost**: what the tokens would cost at the provider's pay-per-token prices. On a subscription plan you aren't billed per token, so treat it as a consistent way to compare usage, not as your bill.

For each API response:

```
cost = input × input price
     + output × output price
     + cache read × cache-read price
     + 5-minute cache write × cache-write price
     + 1-hour cache write × 1-hour cache-write price
```

When a model has a higher rate above 200k tokens, only the excess tokens get that rate. Prices come from a bundled snapshot of [LiteLLM's model price table](https://github.com/BerriAI/litellm). Model names are matched loosely, so date suffixes, `[1m]`, `-thinking` and Cursor-style names like `claude-4.5-sonnet` all resolve.

Every cost carries a stamp showing where it came from:

| Stamp | Meaning |
|---|---|
| **C** computed | Priced by Tycho from token counts (Claude Code, Codex, and OpenCode when it reports $0) |
| **R** reported | The harness reported the cost itself (OpenCode) |
| **E** estimated | Approximate (Cursor) |
| `—` | The harness recorded no token or cost data for this session |
| `unpriced` / `+` | The model isn't in the price table, so the cost is unknown or a lower bound |

**Cursor:** model calls go through Cursor's own servers, and Cursor rarely stores token counts locally. Tycho shows a cost only where tokens or Cursor's own per-chat charge exist, always marked as estimated. Most Cursor chats therefore show `—`. That's deliberate, not a bug.

## Privacy and security

- **Nothing leaves your machine.** Tycho makes no network requests at runtime. The price table is bundled, and refreshing it (`npm run prices`) is a manual build-time step.
- **Secrets are redacted before storage and search indexing.** Known key formats (Anthropic, OpenAI, GitHub, AWS, Slack, Google, Stripe), JWTs, `Bearer` tokens, `KEY=value` / `password: …` assignments, passwords in connection URLs, and private keys are masked, e.g. `AKIA…[redacted]`. Redaction is pattern-based, so treat the database as sensitive anyway.
- **Harness data is never modified.** SQLite sources open read-only, falling back to a temporary snapshot copy if the file is locked. A test checks that a harness database's `data_version` is unchanged after ingestion.
- **The UI is sandboxed.** The window runs with `contextIsolation`, `sandbox` and no Node integration, under a strict Content-Security-Policy. It can only call a small typed API, and every request is validated in the main process.

## Roadmap

- Signed and notarized releases, with prebuilt downloads for macOS, Windows and Linux
- Verified Windows and Linux builds
- An in-app price refresh, and recalculating stored costs after a refresh
- More harnesses: Gemini CLI, Aider, Copilot
- An optional *precise mode* local proxy for harnesses that support a custom base URL

## License

[MIT](LICENSE) © 2026 Sandeep Selvaraj
