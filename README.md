# Vibe Local History

`Vibe Local History` is a VS Code extension plus a small CLI that keeps local file history by watching real file system changes.

It is designed for workflows where file changes do not always come from a normal editor save:
- AI coding tools
- shell scripts
- `git restore` / checkout-like operations
- external editors
- generated files

Instead of relying only on `onDidSaveTextDocument`, it watches disk changes and writes timestamped snapshots into a `.history` directory.

## What It Solves

Normal local-history extensions often miss changes that happen outside the editor buffer. This project tracks file changes at the file system level, so history still exists when:

- a command rewrites a file
- an agent edits files directly
- Git rewinds the working tree
- a file is changed by another process

Snapshots are persisted on disk, so they survive VS Code restarts and window reloads.

## How It Works

When a file changes, the extension:

1. watches the file system for create/change events
2. debounces bursty updates to avoid snapshot spam
3. hashes the current content to skip duplicate revisions
4. writes a timestamped copy into `.history`

Example snapshot path:

```text
.history/src/example_20260325121530.ts
```

## Features

- File system based local history, not save-only tracking
- Snapshot deduplication with SHA-1 content checks
- Debounced capture for noisy AI / Git / script workflows
- Explorer view with timeline-style entries
- Relative time display such as `3m ago`, `2h ago`, `7d ago`
- Configurable retention window with automatic cleanup
- Git-like CLI for AI agents and terminal workflows
- VSIX build and GitHub Release CI

## VS Code UI

The extension adds a `Vibe Local History` view in the Explorer or its own activity bar container.

History entries are grouped by broad recency buckets like:
- `In the last hour`
- `Today`
- `Yesterday`
- `This week`

Each item shows:
- file name as the main label
- relative age as the description
- full snapshot path and absolute timestamp in the tooltip

Available view actions:
- Refresh
- See more history
- Delete history
- Set retention days
- Filter by current file / all / specific file

Context actions on history entries:
- Open
- Open to the side
- Compare with current version
- Compare with selected history entry
- Restore
- Delete

## Retention And Cleanup

History is automatically purged based on `local-history.daysLimit`.

You can change retention from the view menu:

- `7 days`
- `30 days`
- `90 days`
- `Keep forever`
- `Custom...`

After changing the value, expired snapshots are cleaned up immediately.

## CLI

The repository also ships a minimal git-like CLI for local history snapshots.

Command name:

```bash
vibe-history
```

Core commands:

```bash
vibe-history status
vibe-history log src/extension.ts
vibe-history show src/extension.ts 0
vibe-history diff src/extension.ts
vibe-history diff src/extension.ts 0 1
vibe-history restore src/extension.ts 1
```

Short aliases:

```bash
vibe-history st
vibe-history lg src/extension.ts
vibe-history sh src/extension.ts 0
vibe-history di src/extension.ts 0 1
vibe-history rs src/extension.ts 0
```

Command behavior:

- `status` / `st`: show files whose working copy differs from the latest snapshot
- `log` / `lg`: show numbered revisions, newest first
- `show` / `sh`: print a snapshot to stdout
- `diff` / `di`: diff current file vs a snapshot, or snapshot vs snapshot
- `restore` / `rs`: restore a snapshot back into the working tree

Revision syntax:

- revision indexes come from `log`
- `0` is the newest snapshot
- `1` is the previous snapshot

By default the CLI looks for the nearest `.history` directory from the current working directory. You can override that:

```bash
vibe-history log src/extension.ts --history-dir D:/cache/my-project/.history
```

This makes it easy for AI tools to inspect history from the terminal without touching the VS Code UI.

## Settings

```json
{
  "local-history.saveDelay": 0,
  "local-history.daysLimit": 30,
  "local-history.maxDisplay": 10,
  "local-history.dateLocale": "",
  "local-history.exclude": [
    "**/.history/**",
    "**/.vscode/**",
    "**/node_modules/**",
    "**/typings/**",
    "**/out/**",
    "**/Code/User/**"
  ],
  "local-history.enabled": 1,
  "local-history.path": "",
  "local-history.absolute": false,
  "local-history.treeLocation": "explorer"
}
```

Meaning:

- `local-history.saveDelay`: debounce delay in seconds before writing a snapshot
- `local-history.daysLimit`: retention in days, `0` disables cleanup
- `local-history.maxDisplay`: default number of entries shown in the tree
- `local-history.dateLocale`: locale used for absolute date formatting
- `local-history.exclude`: glob patterns excluded from tracking
- `local-history.enabled`:
  - `0` = disabled
  - `1` = always enabled
  - `2` = only within workspace folders
- `local-history.path`: optional custom base path for `.history`
- `local-history.absolute`: store absolute paths inside custom history path
- `local-history.treeLocation`: `explorer` or `localHistory`

### History Path Behavior

If `local-history.path` is not set and the file is inside the workspace, snapshots go to:

```text
<workspace>/.history
```

If `local-history.path` is set, the extension stores snapshots under:

```text
<configured-path>/.history
```

It also supports:
- `${workspaceFolder}`
- `${workspaceFolder: index}`
- environment variables like `%AppData%`
- `~` for home directory

## Commands In VS Code

Command Palette commands:

- `Local History: Show all`
- `Local History: Show current version`
- `Local History: Compare to current version`
- `Local History: Compare to active file`
- `Local History: Compare to previous`

## CI / Release

This repository includes GitHub Actions for packaging and releasing a VSIX.

On tag push such as:

```bash
git tag v1.8.2
git push origin v1.8.2
```

the workflow:

1. installs dependencies with `--ignore-scripts`
2. compiles the extension
3. packages a `.vsix`
4. creates a GitHub Release
5. uploads the VSIX artifact

Workflow file:

- [.github/workflows/release.yml](.github/workflows/release.yml)

## Development

Install dependencies:

```bash
npm install --ignore-scripts
```

Compile:

```bash
npm run compile
```

Package VSIX:

```bash
npm run package:vsix
```

Run CLI directly from build output:

```bash
node out/src/history-cli.js --help
```

## Notes

- History is stored on disk, not in memory, so it survives restarts.
- The current implementation captures create/change snapshots. Delete events currently clear pending timers but do not preserve a final deleted-file tombstone snapshot.
- If `.history` lives inside your workspace, you may want to hide it with `files.exclude`.
