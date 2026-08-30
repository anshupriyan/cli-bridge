# cli-bridge

**A local Model Context Protocol (MCP) server that gives Claude Desktop — or any MCP-compatible client — sandboxed filesystem access and gated shell command execution, scoped entirely to a single workspace root directory.**

<p align="left">
  <img src="https://img.shields.io/badge/MCP-Server-6E56CF?style=for-the-badge&logo=anthropic&logoColor=white" alt="MCP Server"/>
  <img src="https://img.shields.io/badge/Node.js-18.17%2B-339933?style=for-the-badge&logo=node.js&logoColor=white" alt="Node.js 18.17+"/>
  <img src="https://img.shields.io/badge/TypeScript-5.3-3178C6?style=for-the-badge&logo=typescript&logoColor=white" alt="TypeScript"/>
  <img src="https://img.shields.io/badge/Claude%20Desktop-Compatible-D97757?style=for-the-badge&logo=claude&logoColor=white" alt="Claude Desktop Compatible"/>
</p>

<p align="left">
  <img src="https://img.shields.io/badge/Windows-Tested-0078D6?style=flat-square&logo=windows&logoColor=white" alt="Windows Tested"/>
  <img src="https://img.shields.io/badge/macOS-Untested-lightgrey?style=flat-square&logo=apple&logoColor=white" alt="macOS Untested"/>
  <img src="https://img.shields.io/badge/Linux-Untested-lightgrey?style=flat-square&logo=linux&logoColor=white" alt="Linux Untested"/>
  <img src="https://img.shields.io/badge/Dev%20Mode-OFF%20by%20default-critical?style=flat-square" alt="Dev Mode OFF by default"/>
  <img src="https://img.shields.io/badge/License-MIT-black?style=flat-square" alt="MIT License"/>
</p>

---

## What is this?

`cli-bridge` is a lightweight MCP server that plugs into Claude Desktop (or any MCP client) and gives it:

- 📂 **Filesystem tools** — read, write, edit, search, and grep files, all confined to one workspace root
- 💻 **Shell execution** — run real commands on your machine, gated behind an explicit **Dev Mode** toggle
- 📝 **Project memory** — an append-only journal (`PROJECT_LOG.md`) so an agent can pick up context across sessions
- 🔒 **Audit logging** — every tool call recorded to a local log file, nothing sent anywhere else

Everything runs **locally, on your machine** — no external API calls, no cloud dependency, no telemetry.

---

## ⚠️ Dev Mode — Read Before Enabling Shell Execution

> [!CAUTION]
> `execute_command` can run **any executable available on your system**, with the **same permissions as the app hosting the MCP client**. This is real shell execution, not a sandbox.

| | |
|---|---|
| **Default state** | Dev Mode is **OFF** every time the server starts. `execute_command` is blocked before anything spawns. |
| **Turning it on** | Requires an explicit `toggle_dev_mode({ enable_dev_mode: true })` call — nothing enables it silently. |
| **Your responsibility** | Once enabled, any command run — including destructive ones (deleting files, modifying system state, installing software, network calls) — executes for real. **There is no command allowlist, no confirmation beyond your MCP client's own approval settings, and no undo.** |
| **Liability** | This project's author/developer is **not responsible** for data loss, system damage, security incidents, or any other consequence of enabling Dev Mode or using `execute_command`. Enabling it is a decision you make, at your own risk. |

Everything else — reading, searching, editing files in the workspace — works fully with Dev Mode left off. If you're unsure, leave it off.

---

## Features

<details>
<summary><b>🔍 Read-Only Tools</b> (click to expand)</summary>

| Tool | Description |
|---|---|
| `read_file(path, start_line?, end_line?)` | Reads UTF-8 file contents, optional line-range support |
| `list_directory(path, recursive?)` | Lists directory contents (names, sizes, dir flags) |
| `search_files(pattern, path?)` | Recursive glob search (e.g. `*.ts`, `**/*.js`) |
| `grep_content(pattern, path?, case_sensitive?, max_results?)` | Fast fixed-string search via bundled `@vscode/ripgrep`, capped at `max_results` (default 50) |
| `get_dev_mode_status()` | Reports whether shell execution is ENABLED or BLOCKED |
| `get_recent_journal_entries(count?, project?)` | Reads the last N entries from `PROJECT_LOG.md` |

All tools are strictly confined to the workspace root directory.

</details>

<details>
<summary><b>✍️ Write & Execution Tools</b> (click to expand)</summary>

| Tool | Description |
|---|---|
| `write_file(path, content)` | Overwrites/creates a file, auto-creates parent directories |
| `edit_file(path, old_str, new_str)` | Targeted find-and-replace; errors on zero or multiple matches |
| `execute_command(command, args, cwd?, timeout?)` | Shell execution, **gated by Dev Mode** — see warning above |
| `toggle_dev_mode(enable_dev_mode)` | Enables/re-locks shell execution for the current session only |
| `log_journal_entry(summary, files_changed?, commit_hash?, project?)` | Appends a structured entry to `PROJECT_LOG.md` |

</details>

---

## Security Architecture

```
┌─────────────────────────────────────────────┐
│              MCP Client (Claude)             │
└────────────────────┬──────────────────────────┘
                      │ tool calls
┌────────────────────▼──────────────────────────┐
│                  cli-bridge                    │
│  ┌───────────────────────────────────────────┐ │
│  │ 1. Path Confinement (resolveSafePath)      │ │
│  │ 2. Symlink Resolution (fs.realpathSync)    │ │
│  │ 3. Dev Mode Gate (execute_command only)    │ │
│  │ 4. Shell Metacharacter Scan (Windows only) │ │
│  │ 5. Audit Log Write (.cli-bridge-audit.log) │ │
│  └───────────────────────────────────────────┘ │
└────────────────────┬──────────────────────────┘
                      │ confined to
              <workspaceRoot>/
```

- **Path Confinement** — every path (including command `cwd`) resolves strictly relative to the workspace root; traversal attempts are rejected.
- **Symlink Protection** — symlinks pointing outside the workspace boundary are resolved and blocked.
- **Dev Mode Gating** — `execute_command` is hard-blocked at the handler entry point until explicitly toggled on.
- **No Command Allowlist** — once Dev Mode is on, any executable on the host can run. See the warning above.
- **Shell Metacharacter Scanning** — Windows build-tool wrappers (`npm`, `npx`, `yarn`, `pnpm`, `tsc`, `jest`, `eslint`, `prettier`) run with `shell: true`; arguments are scanned for `& | ; $ > < ^` and blocked if found. Everything else runs with `shell: false`.
- **Audit Logging** — every tool call is recorded as JSON in `<workspaceRoot>/.cli-bridge-audit.log` (timestamp, arguments truncated to 200 chars, status: `success` / `error` / `blocked`).

---

## Compatibility

| Platform | Status |
|---|---|
| 🪟 Windows 11 (x64) | ✅ Tested and verified |
| 🍎 macOS (arm64 / x64) | ⚠️ Architecturally supported (pure ESM + auto-resolved `ripgrep` binary), not yet live-tested |
| 🐧 Linux (x64) | ⚠️ Architecturally supported, not yet live-tested |

Windows-specific handling (the `.cmd`/`.bat` wrapper allowlist and shell-metacharacter scan) only applies when `process.platform === 'win32'`. On macOS/Linux, all commands spawn directly with `shell: false`. If you run this on macOS or Linux, feedback/issues are welcome.

---

## Token-Efficient Workflows

1. Use `grep_content` to locate keywords/functions before reading full files.
2. Use `read_file` with `start_line`/`end_line` once you have coordinates.
3. Use `edit_file` for targeted changes instead of rewriting whole files.
4. Use `git diff` / `git log` / `git show` via `execute_command` (Dev Mode required) to verify changes on disk.

---

## Project Journal

An append-only development log at `<workspaceRoot>/PROJECT_LOG.md`, meant to be read by an agent at the start of a new session to recover prior context. Agents call `log_journal_entry` after completing work, including file lists and commit hashes.

---

## Installation

**Prerequisites:** Node.js v18.17.0+ (v20 or v24 LTS recommended)

```bash
npm install
npm run build
```

---

## Configuration in Claude Desktop

### Finding your config file (Windows)

Depending on how Claude Desktop was installed (standard installer vs. MSIX/Microsoft Store package), its configuration file location differs. You can run this PowerShell command to locate your `claude_desktop_config.json` automatically:

```powershell
Get-ChildItem -Path "$env:APPDATA\Claude\claude_desktop_config.json", "$env:LOCALAPPDATA\Packages\Claude_*\LocalCache\Roaming\Claude\claude_desktop_config.json" -ErrorAction SilentlyContinue | Select-Object FullName
```

> [!NOTE]
> If neither path returns a result, the configuration file has likely not been created yet (which happens after opening Claude Desktop for the first time) or is installed in a non-standard location.

#### Manual File Paths Reference
- **Windows**: `%APPDATA%\Claude\claude_desktop_config.json` (or `%LOCALAPPDATA%\Packages\Claude_...\LocalCache\Roaming\Claude\claude_desktop_config.json` for Store/MSIX installs)
- **macOS**: `~/Library/Application Support/Claude/claude_desktop_config.json`

### Registering cli-bridge

#### Claude Desktop

Add `cli-bridge` to the `mcpServers` object inside your `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "cli-bridge": {
      "command": "node",
      "args": [
        "<PATH_TO_CLI_BRIDGE>/build/index.js",
        "<PATH_TO_YOUR_WORKSPACE>"
      ],
      "env": {
        "WORKSPACE_ROOT": "<PATH_TO_YOUR_WORKSPACE>"
      }
    }
  }
}
```

#### Qwen Studio

Add `cli-bridge` to the `mcpServers` object in your Qwen Studio configuration:

```json
{
  "mcpServers": {
    "cli-bridge": {
      "command": "npx",
      "args": [
        "node",
        "<PATH_TO_CLI_BRIDGE>/build/index.js",
        "<PATH_TO_YOUR_WORKSPACE>"
      ],
      "env": {
        "WORKSPACE_ROOT": "<PATH_TO_YOUR_WORKSPACE>"
      }
    }
  }
}
```

> [!IMPORTANT]
> **Windows Path Formatting in JSON**:
> Because `claude_desktop_config.json` is a standard JSON file, single backslashes copied directly from File Explorer's address bar (e.g. `C:\Projects\cli-bridge`) will cause JSON parsing errors unless escaped.
> 
> You have two valid options for Windows paths:
> 1. **Double Backslashes**: `"C:\\Projects\\cli-bridge\\build\\index.js"`
> 2. **Forward Slashes (Recommended)**: `"C:/Projects/cli-bridge/build/index.js"` (works natively in Node.js on Windows and is easier to type)
> 
> | Format | Example Path | Status |
> |---|---|---|
> | ❌ Single Backslash | `"C:\Projects\cli-bridge"` | **Fails JSON Parsing** |
> | ✅ Double Backslash | `"C:\\Projects\\cli-bridge"` | **Valid JSON** |
> | ✅ Forward Slash | `"C:/Projects/cli-bridge"` | **Valid & Recommended** |

- Replace `<PATH_TO_CLI_BRIDGE>` with the folder where you cloned `cli-bridge`.
- Replace `<PATH_TO_YOUR_WORKSPACE>` with the target project workspace folder you want `cli-bridge` to manage.

---

## Testing and Debugging

```bash
npx @modelcontextprotocol/inspector node build/index.js <YOUR_DEFAULT_WORKSPACE_PATH>
```

---

<p align="center">
  <sub>Built as a local-first MCP tool. No cloud dependency, no telemetry, no data leaves your machine.</sub>
</p>
