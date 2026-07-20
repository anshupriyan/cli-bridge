# cli-bridge MCP Server

`cli-bridge` is a Model Context Protocol (MCP) server that gives a client (like Claude Desktop) file system access and shell execution, safely scoped to a single workspace root directory.

## Features

### Read-Only Tools

1. `read_file(path: string)`
   - Reads file contents as UTF-8 text.
   - Constrained to the workspace root directory.
   - annotations: `readOnlyHint: true, destructiveHint: false`.

2. `list_directory(path: string, recursive?: boolean)`
   - Lists the directory contents including names, sizes, and whether each item is a directory.
   - Constrained to the workspace root directory.
   - Excludes the audit log file (`.cli-bridge-audit.log`) by default.
   - annotations: `readOnlyHint: true`.

3. `search_files(pattern: string, path?: string)`
   - Recursively searches for files matching a glob pattern (e.g. `*.ts`, `**/*.js`).
   - Constrained to the workspace root directory.
   - Excludes the audit log file (`.cli-bridge-audit.log`) by default.
   - annotations: `readOnlyHint: true`.

### Write & Execution Tools (Phase 2)

4. `write_file(path: string, content: string)`
   - Full file overwrite (creates or replaces files). Automatically creates parent directories if needed.
   - Constrained to the workspace root directory.
   - annotations: `readOnlyHint: false, destructiveHint: true, idempotentHint: true`.
   - Logs resolved path and content length to stderr and the audit log.

5. `edit_file(path: string, old_str: string, new_str: string)`
   - Performs find-and-replace on a unique string inside a file.
   - Errors if `old_str` matches zero times or more than once in the file (ambiguous edits are rejected).
     - *Note: `old_str` must appear exactly once in the file — this is intentionally strict to prevent ambiguous edits, but means `edit_file` will fail on files with repeated boilerplate or whitespace-sensitive matches. If this happens, fall back to `write_file` with the full new content.*
   - Constrained to the workspace root directory.
   - annotations: `readOnlyHint: false, destructiveHint: true, idempotentHint: true`.

6. `execute_command(command: string, args: string[], cwd?: string, timeout?: number)`
   - Spawns a process directly using Node's `child_process.spawn`.
   - Uses `shell: false` by default. On Windows, conditional `shell: true` is allowed ONLY for an allowlist of known package manager/build script wrappers (`npm`, `npx`, `yarn`, `pnpm`, `tsc`, `jest`, `eslint`, `prettier`).
   - `cwd` is validated to reside inside the workspace root; defaults to workspace root if not provided.
   - Automatically kills the command and returns a timeout error if execution exceeds the timeout (defaults to 30 seconds).
   - annotations: `readOnlyHint: false, destructiveHint: true, openWorldHint: true`.
   - Logs command, args, and cwd to stderr and the audit log before executing.

---

## Security Model

The security model of `cli-bridge` relies on the following boundaries:

- **Path Confinement**: All file paths (including working directories for execution) are strictly resolved relative to the workspace root using the safety resolver. Any traversal attempt out of the workspace root throws an access denied error.
- **Absolute Path Traversal Protection**: The server validates resolved absolute paths (e.g., `C:\Windows\System32\...` or `/etc/...`) to ensure they reside strictly within the workspace root.
- **Symlink Escape Protection**: Symlinks within the workspace root that point to files or directories outside of the workspace root are resolved and blocked by `resolveSafePath` check.
- **Command Security & Heuristic Safety Scan**:
  > [!WARNING]
  > The `execute_command` tool has **no command allowlist**. It executes any executable available on the host system with the same user permissions as the Claude Desktop app.
  >
  > By default, all commands are spawned directly using Node's `child_process.spawn` with `shell: false` to eliminate shell injection risks. On Windows, a small allowlist of common script wrapper commands (`npm`, `npx`, `yarn`, `pnpm`, `tsc`, `jest`, `eslint`, `prettier`) is conditionally spawned with `shell: true` to resolve batch wrapper executables.
  >
  > **Shell Escape Mitigation (Windows wrappers)**: To mitigate argument breakout vulnerabilities (like the general class of command injection exploits seen in Windows batch spawning), any command routed through the `shell: true` path is subject to strict argument scanning. If any argument contains shell metacharacters (`&`, `|`, `;`, `` ` ``, `$`, `>`, `<`, `^`), the execution is immediately blocked.
  >
  > To improve defense-in-depth, `execute_command` also performs a best-effort pre-flight path safety scan for filesystem paths outside the workspace root before running any command, and blocks execution if found. This is a heuristic string-scan, not a hard sandboxing boundary — it will not catch every case (e.g. paths read from environment variables, obfuscated/encoded paths, or non-filesystem risks like network requests to arbitrary hosts).
  >
  > Write and execute tools are annotated with `destructiveHint: true`. This causes Claude Desktop (and other standard MCP clients) to prompt you for confirmation before executing these actions. Do not disable or bypass these prompts, as manual approval of each `execute_command` call remains the primary safeguard.
- **Audit Logging**:
  Every tool invocation is logged to an append-only JSON file at `WORKSPACE_ROOT/.cli-bridge-audit.log` for safety verification and tracking. The log records:
  - Timestamp (ISO format)
  - Tool name invoked
  - Input arguments (with content fields truncated to 200 characters for `write_file`/`edit_file` to keep the logs readable)
  - Result status (`success`, `error`, or `blocked`)
  
  This audit file is automatically filtered out of `list_directory` and `search_files` results to avoid cluttering the workspace.

---

## Installation and Setup

### Prerequisites
- Node.js (v18.17.0+)

### Build the Server
1. Install dependencies:
   ```bash
   npm install
   ```
2. Build the project:
   ```bash
   npm run build
   ```

## Configuration in Claude Desktop

To register `cli-bridge` in Claude Desktop, open your Claude Desktop configuration file (typically at `%APPDATA%\Claude\claude_desktop_config.json` on Windows or `~/Library/Application Support/Claude/claude_desktop_config.json` on macOS) and add the server definition under `mcpServers`:

```json
{
  "mcpServers": {
    "cli-bridge": {
      "command": "node",
      "args": [
        "c:/Projects/cli-bridge/build/index.js",
        "c:/Projects/cli-bridge"
      ],
      "env": {
        "WORKSPACE_ROOT": "c:/Projects/cli-bridge"
      }
    }
  }
}
```

*Note: Replace `c:/Projects/cli-bridge` with your target workspace root folder.*

## Testing and Debugging

You can test the server locally using the `@modelcontextprotocol/inspector`:

```bash
npx @modelcontextprotocol/inspector node build/index.js c:/Projects/cli-bridge
```
