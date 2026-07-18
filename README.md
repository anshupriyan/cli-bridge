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
   - annotations: `readOnlyHint: true`.

3. `search_files(pattern: string, path?: string)`
   - Recursively searches for files matching a glob pattern (e.g. `*.ts`, `**/*.js`).
   - Constrained to the workspace root directory.
   - annotations: `readOnlyHint: true`.

### Write & Execution Tools (Phase 2)

4. `write_file(path: string, content: string)`
   - Full file overwrite (creates or replaces files). Automatically creates parent directories if needed.
   - Constrained to the workspace root directory.
   - annotations: `readOnlyHint: false, destructiveHint: true, idempotentHint: true`.
   - Logs resolved path and content length to stderr.

5. `edit_file(path: string, old_str: string, new_str: string)`
   - Performs find-and-replace on a unique string inside a file.
   - Errors if `old_str` matches zero times or more than once in the file (ambiguous edits are rejected).
   - Constrained to the workspace root directory.
   - annotations: `readOnlyHint: false, destructiveHint: true, idempotentHint: true`.

6. `execute_command(command: string, args: string[], cwd?: string, timeout?: number)`
   - Spawns a process directly using Node's `child_process.spawn` (with `shell: false` to avoid shell injection vulnerabilities).
   - `cwd` is validated to reside inside the workspace root; defaults to workspace root if not provided.
   - Automatically kills the command and returns a timeout error if execution exceeds the timeout (defaults to 30 seconds).
   - annotations: `readOnlyHint: false, destructiveHint: true, openWorldHint: true`.
   - Logs command, args, and cwd to stderr before executing.

---

## Safety Constraints

- **Path Confinement**: All file paths (including working directories for execution) are strictly resolved relative to the workspace root using the safety resolver. Any traversal attempt out of the workspace root throws an access denied error.
- **Protocol Safety**: All console logs and debug outputs are written to `stderr` so as not to corrupt JSON-RPC communication on `stdout`.
- **Command Security & Approval**:
  > [!WARNING]
  > The `execute_command` tool has **no command allowlist**. It executes any executable available on the host system with the same user permissions as the Claude Desktop app.
  >
  > To protect your system, write and execute tools are annotated with `destructiveHint: true`. This causes Claude Desktop (and other standard MCP clients) to prompt you for confirmation before executing these actions. Do not disable or bypass these prompts.

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
