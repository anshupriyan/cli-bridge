# cli-bridge MCP Server

`cli-bridge` is a Model Context Protocol (MCP) server that provides AI clients (such as Claude Desktop) with safe, constrained file system access and shell execution scoped to a single workspace root directory.

## Features

### Read-Only Tools

1. `read_file(path: string, start_line?: number, end_line?: number)`
   - Reads file contents as UTF-8 text.
   - Supports optional `start_line` and `end_line` parameters to read specific line ranges (1-based, inclusive).
   - Constrained to the workspace root directory.
   - annotations: `readOnlyHint: true, destructiveHint: false`.

2. `list_directory(path: string, recursive?: boolean)`
   - Lists directory contents including names, sizes, and directory flags.
   - Constrained to the workspace root directory.
   - Excludes `.cli-bridge-audit.log` from directory listings.
   - annotations: `readOnlyHint: true`.

3. `search_files(pattern: string, path?: string)`
   - Recursively searches for files matching a glob pattern (e.g., `*.ts`, `**/*.js`).
   - Constrained to the workspace root directory.
   - Excludes `.cli-bridge-audit.log` from search results.
   - annotations: `readOnlyHint: true`.

4. `grep_content(pattern: string, path?: string, case_sensitive?: boolean, max_results?: number)`
   - Performs token-efficient fixed-string pattern searches in files.
   - Spawns the bundled `@vscode/ripgrep` binary for high performance, with a recursive manual readline scanner fallback.
   - Returns only relative file paths, line numbers, and matching line text. Capped at `max_results` (defaults to 50).
   - annotations: `readOnlyHint: true`.

5. `get_dev_mode_status()`
   - Returns the current Dev Mode status (whether shell execution is ENABLED or BLOCKED).
   - In-memory state; resets to Dev Mode OFF on every server restart.
   - annotations: `readOnlyHint: true`.

6. `get_recent_journal_entries(count?: number, project?: string)`
   - Reads the last N entries from `PROJECT_LOG.md`.
   - Supports an optional `project` parameter to inspect project journal entries.
   - annotations: `readOnlyHint: true`.

### Write & Execution Tools

7. `write_file(path: string, content: string)`
   - Overwrites or creates a file with full text content. Automatically creates parent directories as needed.
   - Constrained to the workspace root directory.
   - annotations: `readOnlyHint: false, destructiveHint: true, idempotentHint: true`.

8. `edit_file(path: string, old_str: string, new_str: string)`
   - Performs a targeted find-and-replace on a unique string inside a file.
   - Errors if `old_str` matches zero times or multiple times in the file (rejects ambiguous edits).
     - *Note: `old_str` must appear exactly once in the file to prevent unintended multi-site replacements. Fall back to `write_file` if boilerplate repeats.*
   - Constrained to the workspace root directory.
   - annotations: `readOnlyHint: false, destructiveHint: true, idempotentHint: true`.

9. `execute_command(command: string, args: string[], cwd?: string, timeout?: number)`
   - Executes a command-line executable directly using Node's `child_process.spawn`.
   - **Gated by Dev Mode**: Blocked by default on server startup until `toggle_dev_mode({ enable_dev_mode: true })` is explicitly called.
   - Uses `shell: false` by default. On Windows, conditional `shell: true` is allowed ONLY for an allowlist of known package manager/build script wrappers (`npm`, `npx`, `yarn`, `pnpm`, `tsc`, `jest`, `eslint`, `prettier`).
   - `cwd` is validated to reside inside the workspace root; defaults to workspace root if omitted.
   - Automatically kills processes that exceed the timeout (defaults to 30 seconds).
   - annotations: `readOnlyHint: false, destructiveHint: true, openWorldHint: true`.

10. `toggle_dev_mode(enable_dev_mode: boolean)`
    - Toggles in-memory Dev Mode.
    - Setting `enable_dev_mode: true` enables shell command execution (`execute_command`).
    - Setting `enable_dev_mode: false` re-locks shell execution.
    - Session-scoped: state exists in process memory and automatically resets to Dev Mode OFF whenever the server restarts.
    - annotations: `readOnlyHint: false, destructiveHint: false, idempotentHint: false`.

11. `log_journal_entry(summary: string, files_changed?: string[], commit_hash?: string, project?: string)`
    - Appends a structured markdown entry to `PROJECT_LOG.md` detailing work done, changed files, and git commit hashes.
    - annotations: `readOnlyHint: false, destructiveHint: false, idempotentHint: false`.

---

## Dev Mode (Session-Scoped Shell Gating)

`cli-bridge` implements an in-memory **Dev Mode** toggle to protect host environments against unintended shell command execution:

- **OFF by Default**: Dev Mode is disabled automatically whenever the `cli-bridge` server process starts. While Dev Mode is OFF, any call to `execute_command` immediately returns a friendly diagnostic error message without spawning any shell or child process.
- **Session-Only State**: Dev Mode state is held in process memory (`devModeEnabled`). It is intentionally not saved to disk or configuration files, ensuring every server restart defaults to a secure, locked-down state (Dev Mode OFF).
- **Enabling Dev Mode**: To allow shell commands during a session, invoke `toggle_dev_mode({ enable_dev_mode: true })`. This enables command execution until Dev Mode is explicitly turned off via `toggle_dev_mode({ enable_dev_mode: false })` or the server process is restarted.
- **Checking Status**: Call `get_dev_mode_status()` at any time to inspect whether Dev Mode is currently active or disabled.

---

## Security Architecture

The security model of `cli-bridge` relies on the following defense-in-depth layers:

- **Path Confinement**: All file paths (including working directories for command execution) are strictly resolved relative to the workspace root using `resolveSafePath`. Any traversal attempt outside the workspace root throws an access denied error.
- **Absolute Path & Symlink Protection**: Resolves absolute paths and symbolic links using `fs.realpathSync` to ensure symlinks inside the workspace pointing outside the boundary are trapped and blocked.
- **Dev Mode Shell Gating**: Subprocess execution (`execute_command`) is hard-blocked at the tool handler entry point until explicitly enabled via `toggle_dev_mode({ enable_dev_mode: true })`.
- **Command Security & Shell Breakout Scans**:
  > [!WARNING]
  > The `execute_command` tool has **no command allowlist**. It executes executables available on the host system with the same user permissions as the host MCP client app.
  >
  > Commands spawn directly via `child_process.spawn` with `shell: false`. On Windows, an allowlist of script wrappers (`npm`, `npx`, `yarn`, `pnpm`, `tsc`, `jest`, `eslint`, `prettier`) is conditionally spawned with `shell: true`.
  >
  > **Shell Metacharacter Mitigation**: Any command routed through the `shell: true` path is scanned for shell metacharacters (`&`, `|`, `;`, `` ` ``, `$`, `>`, `<`, `^`). If any argument contains shell metacharacters, execution is immediately blocked to prevent CVE breakout vulnerabilities.
  >
  > Pre-flight heuristic path safety scans block commands that explicitly reference filesystem paths outside the workspace root.
  >
  > Write and execute tools are annotated with `destructiveHint: true`, prompting MCP clients (like Claude Desktop) for explicit approval before running.
- **Workspace Audit Logging**: Every tool execution records a JSON entry to `<workspaceRoot>/.cli-bridge-audit.log` containing timestamps, tool arguments (with content fields truncated to 200 characters), and execution status (`success`, `error`, or `blocked`).

---

## Token-Efficient Workflows

To optimize context window usage when working with AI coding assistants:

1. **Targeted Search**: Always use `grep_content` to locate keywords or functions before reading files.
2. **Selective Range Reading**: Use `read_file` with `start_line` and `end_line` once code coordinates are located.
3. **Contiguous Edits**: Use `edit_file` for targeted search-and-replace updates instead of transmitting full file overlays.
4. **Factual Verification**: Use Git commands (`git diff`, `git log`, `git show`) via `execute_command` to verify changes on disk.

---

## Project Journal (`PROJECT_LOG.md`)

`cli-bridge` features an append-only human-readable continuity journal at `<workspaceRoot>/PROJECT_LOG.md`:

- **Purpose**: Acts as a development log for AI agents to read at the start of new sessions to understand past changes, context, and project history.
- **Git Grounding**: Agents invoke `log_journal_entry` autonomously after completing work units, compiling commit hashes and file lists.

---

## Installation and Setup

### Prerequisites for a Fresh Machine
- **Node.js (v18.17.0+)**: Required to run the server runtime and package manager (`node` and `npm`). Recommended: Node.js v20 LTS or v24 LTS.
- **Git** (Optional): Recommended if you intend to run Git commands (`git diff`, `git log`, `git show`) via `execute_command` in Dev Mode.

> [!NOTE]
> **No System Ripgrep Installation Required**: You do **NOT** need to install `ripgrep` (`rg`) separately on your operating system. Running `npm install` automatically downloads the correct prebuilt binary (`rg.exe` on Windows, `rg` on macOS/Linux) for your OS architecture via `@vscode/ripgrep`.

### Setup & Build Steps
1. **Clone or download the repository**:
   ```bash
   git clone https://github.com/anshupriyan/cli-bridge.git
   cd cli-bridge
   ```
2. **Install dependencies**:
   ```bash
   npm install
   ```
3. **Build the TypeScript binary**:
   ```bash
   npm run build
   ```

---

## Configuration in Claude Desktop

Add `cli-bridge` to your Claude Desktop configuration file (typically `%APPDATA%\Claude\claude_desktop_config.json` on Windows or `~/Library/Application Support/Claude/claude_desktop_config.json` on macOS):

```json
{
  "mcpServers": {
    "cli-bridge": {
      "command": "node",
      "args": [
        "<YOUR_DEFAULT_INSTALLATION_PATH>/build/index.js",
        "<YOUR_DEFAULT_WORKSPACE_PATH>"
      ],
      "env": {
        "WORKSPACE_ROOT": "<YOUR_DEFAULT_WORKSPACE_PATH>"
      }
    }
  }
}
```

- Replace `<YOUR_DEFAULT_INSTALLATION_PATH>` with the folder where you cloned `cli-bridge` (e.g. `C:/Projects/cli-bridge` on Windows or `/Users/username/Projects/cli-bridge` on macOS/Linux).
- Replace `<YOUR_DEFAULT_WORKSPACE_PATH>` with the target project workspace folder you want `cli-bridge` to manage.

---

## Testing and Debugging

Test the server locally using `@modelcontextprotocol/inspector`:

```bash
npx @modelcontextprotocol/inspector node build/index.js <YOUR_DEFAULT_WORKSPACE_PATH>
```
