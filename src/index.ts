#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ListPromptsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import * as fs from "fs";
import * as path from "path";
import { spawn } from "child_process";
import * as readline from "readline";
import { rgPath } from "@vscode/ripgrep";

// In-memory Dev Mode state for shell execution (defaults to false on server startup)
let devModeEnabled = false;

// Initialize workspace root
const workspaceRootEnv = process.env.WORKSPACE_ROOT;
const workspaceRootArg = process.argv[2];
const workspaceRoot = path.resolve(workspaceRootArg || workspaceRootEnv || process.cwd());

// Verify workspace root exists and is a directory
try {
  const stat = fs.statSync(workspaceRoot);
  if (!stat.isDirectory()) {
    console.error(`[cli-bridge] Error: Workspace root "${workspaceRoot}" is not a directory.`);
    process.exit(1);
  }
} catch (err) {
  console.error(`[cli-bridge] Error: Workspace root "${workspaceRoot}" does not exist.`);
  process.exit(1);
}

console.error(`[cli-bridge] Workspace root set to: ${workspaceRoot}`);
console.error(`[cli-bridge] Using bundled ripgrep binary: ${rgPath}`);
console.error(`[cli-bridge] Dev Mode initialized: ${devModeEnabled ? "ON (shell execution ENABLED)" : "OFF (shell execution BLOCKED)"}`);

/**
 * Resolves user path relative to workspace root, checks for directory traversal,
 * absolute path escapes, and resolves symlinks securely.
 * Throws an error if the path resolves outside the workspace root.
 */
export function resolveSafePath(root: string, userPath: string): string {
  const resolvedRoot = path.resolve(root);
  let realRoot = resolvedRoot;
  try {
    realRoot = fs.realpathSync(resolvedRoot);
  } catch (err) {
    // Fall back to resolvedRoot if it cannot be resolved yet
  }

  const resolvedPath = path.resolve(realRoot, userPath);
  let realPath = resolvedPath;
  try {
    realPath = fs.realpathSync(resolvedPath);
  } catch (err) {
    // 1. Direct check: is the target path itself an existing dangling symlink?
    // (fs.realpathSync throws ENOENT for dangling symlinks, but fs.lstatSync can detect them)
    // Note: A microsecond TOCTOU window exists between this check and write_file in multi-user environments
    try {
      const stat = fs.lstatSync(resolvedPath);
      if (stat.isSymbolicLink()) {
        throw new Error(`Access denied: Path "${userPath}" resolves outside of workspace root "${realRoot}".`);
      }
    } catch (lstatErr: any) {
      if (lstatErr.code !== "ENOENT") {
        throw lstatErr;
      }
    }

    // 2. For non-existent files or nested paths (e.g. creating a new file in a new directory),
    // find the nearest existing ancestor directory, resolve its realpath, and ensure it's inside workspaceRoot.
    let current = path.dirname(resolvedPath);
    const segments: string[] = [path.basename(resolvedPath)];
    let realAncestor = "";
    let foundAncestor = false;

    while (true) {
      try {
        const stat = fs.lstatSync(current);
        if (stat.isSymbolicLink()) {
          const resolvedSymlink = fs.realpathSync(current);
          const rel = path.relative(realRoot, resolvedSymlink);
          if (rel.startsWith("..") || path.isAbsolute(rel)) {
            throw new Error(`Access denied: Ancestor directory "${current}" resolves outside workspace root "${realRoot}".`);
          }
        }
        realAncestor = fs.realpathSync(current);
        foundAncestor = true;
        break;
      } catch (ancestorErr: any) {
        if (ancestorErr.code === "ENOENT") {
          const parent = path.dirname(current);
          if (parent === current) {
            break; // reached filesystem root
          }
          segments.unshift(path.basename(current));
          current = parent;
        } else {
          throw new Error(`Access denied: Unable to verify ancestor directory for path "${userPath}".`);
        }
      }
    }

    if (!foundAncestor) {
      throw new Error(`Access denied: Unable to verify directory hierarchy for path "${userPath}".`);
    }

    const relAncestor = path.relative(realRoot, realAncestor);
    if (relAncestor.startsWith("..") || path.isAbsolute(relAncestor)) {
      throw new Error(`Access denied: Path "${userPath}" resolves outside of workspace root "${realRoot}".`);
    }

    // Reconstruct the realPath from the canonical ancestor + remaining relative segments
    realPath = path.resolve(realAncestor, ...segments);
  }

  const relative = path.relative(realRoot, realPath);
  const isOutside = relative.startsWith("..") || path.isAbsolute(relative);

  if (isOutside) {
    throw new Error(`Access denied: Path "${userPath}" resolves outside of workspace root "${realRoot}".`);
  }

  return realPath;
}

/**
 * Determines the top-level project subfolder scope for a path relative to workspaceRoot.
 * Returns "" if the path is at root level, empty, or outside workspace.
 */
export function determineProjectScope(userPath?: string): string {
  if (!userPath) return "";
  try {
    const resolved = resolveSafePath(workspaceRoot, userPath);
    const relative = path.relative(workspaceRoot, resolved).replace(/\\/g, "/");
    if (!relative || relative === "." || relative.startsWith("..")) {
      return "";
    }
    const parts = relative.split("/").filter(Boolean);
    if (parts.length === 0) return "";

    if (parts.length > 1) {
      return parts[0];
    }

    // parts.length === 1
    // Check if workspaceRoot/parts[0] is an existing directory
    const targetPath = path.join(workspaceRoot, parts[0]);
    try {
      const stat = fs.statSync(targetPath);
      if (stat.isDirectory()) {
        return parts[0];
      }
    } catch {
      // Not a directory or doesn't exist yet
    }
    return "";
  } catch {
    return "";
  }
}

/**
 * Returns the target directory for a given project scope.
 */
function getScopeDirectory(scope: string): string {
  if (!scope) return workspaceRoot;
  try {
    return resolveSafePath(workspaceRoot, scope);
  } catch {
    return workspaceRoot;
  }
}

/**
 * Ensures that the target directory (workspaceRoot or a project subfolder) contains a .gitignore
 * with log exclusions (.cli-bridge-audit.log and PROJECT_LOG.md).
 */
function ensureGitignore(targetDir: string = workspaceRoot) {
  try {
    if (!fs.existsSync(targetDir)) {
      fs.mkdirSync(targetDir, { recursive: true });
    }
    const gitignorePath = path.join(targetDir, ".gitignore");
    const targets = [".cli-bridge-audit.log", "PROJECT_LOG.md"];

    if (!fs.existsSync(gitignorePath)) {
      fs.writeFileSync(gitignorePath, targets.join("\n") + "\n", "utf-8");
      console.error(`[cli-bridge] Created default .gitignore with log exclusions in: ${targetDir}`);
      return;
    }

    const content = fs.readFileSync(gitignorePath, "utf-8");
    const lines = content.split(/\r?\n/).map(line => line.trim());
    const toAppend: string[] = [];

    for (const target of targets) {
      if (!lines.includes(target)) {
        toAppend.push(target);
      }
    }

    if (toAppend.length > 0) {
      const needsLeadingNewline = content.length > 0 && !content.endsWith("\n") && !content.endsWith("\r");
      const appendStr = (needsLeadingNewline ? "\n" : "") + toAppend.join("\n") + "\n";
      fs.appendFileSync(gitignorePath, appendStr, "utf-8");
      console.error(`[cli-bridge] Appended missing entries to .gitignore in ${targetDir}: ${toAppend.join(", ")}`);
    }
  } catch (err: any) {
    console.error(`[cli-bridge] Warning: Failed to configure .gitignore in ${targetDir}: ${err.message}`);
  }
}

// Run gitignore check on workspaceRoot startup
ensureGitignore();

/**
 * Helper to check if a string matches url patterns (skipped by path heuristic scan)
 */
function isUrl(str: string): boolean {
  return str.startsWith("http://") ||
    str.startsWith("https://") ||
    str.startsWith("git@") ||
    str.includes("://");
}

/**
 * Tighter heuristic to identify if a string looks like a filesystem path.
 */
function looksLikePath(str: string): boolean {
  if (isUrl(str)) return false;

  // 1. Relative traversal
  if (str.includes("../") || str.includes("..\\")) {
    return true;
  }

  // 2. Drive letter prefix
  if (/^[A-Za-z]:[/\\]/.test(str)) {
    return true;
  }

  // 3. Leading dot/dot-dot or slash patterns
  if (str.startsWith("./") || str.startsWith(".\\") || str.startsWith("/") || str.startsWith("\\")) {
    return true;
  }

  // 4. Contains at least two path separators
  const slashCount = (str.match(/\//g) || []).length + (str.match(/\\/g) || []).length;
  if (slashCount >= 2) {
    return true;
  }

  // 5. Contains exactly one path separator and has a recognizable file extension
  if (slashCount === 1 && /\.[A-Za-z0-9]{1,5}$/.test(str)) {
    return true;
  }

  return false;
}

/**
 * Heuristically extracts and checks paths referenced in commands/args.
 * Returns array of paths that resolve outside the root.
 */
export function scanForUnsafePaths(command: string, args: string[]): string[] {
  const candidates = [command, ...args];
  const unsafePaths: string[] = [];

  for (const str of candidates) {
    if (looksLikePath(str)) {
      try {
        resolveSafePath(workspaceRoot, str);
      } catch (err) {
        unsafePaths.push(str);
      }
    }
  }

  return unsafePaths;
}

// Windows wrappers that require shell execution
const WINDOWS_WRAPPERS = ["npm", "npx", "yarn", "pnpm", "tsc", "jest", "eslint", "prettier"];
const SHELL_METACHARS = ["&", "|", ";", "`", "$", ">", "<", "^"];

/**
 * Check if the given command is a known Windows wrapper script.
 */
function shouldWinShell(command: string): boolean {
  if (process.platform !== "win32") return false;
  const basename = path.basename(command).toLowerCase();
  return WINDOWS_WRAPPERS.some(wrapper =>
    basename === wrapper ||
    basename === `${wrapper}.cmd` ||
    basename === `${wrapper}.bat`
  );
}

/**
 * Check if the arguments contain shell metacharacters.
 */
function hasShellMetacharacters(args: string[]): boolean {
  return args.some(arg =>
    SHELL_METACHARS.some(char => arg.includes(char))
  );
}

// Zod schemas for input validation
const ReadFileSchema = z.object({
  path: z.string().describe("Path to the file to read, relative to workspace root"),
  start_line: z.number().optional().describe("Optional 1-based start line to read from"),
  end_line: z.number().optional().describe("Optional 1-based end line to read to (inclusive)")
});

const ListDirectorySchema = z.object({
  path: z.string().describe("Path to the directory to list, relative to workspace root"),
  recursive: z.boolean().optional().describe("If true, list directory contents recursively")
});

const SearchFilesSchema = z.object({
  pattern: z.string().describe("Simple glob pattern to match filenames (e.g. '*.ts', '**/*.js')"),
  path: z.string().optional().describe("Path to search within, relative to workspace root (defaults to root)")
});

const WriteFileSchema = z.object({
  path: z.string().describe("Path to write the file to, relative to workspace root"),
  content: z.string().describe("Full content to write to the file")
});

const EditFileSchema = z.object({
  path: z.string().describe("Path to the file to edit, relative to workspace root"),
  old_str: z.string().describe("The exact unique string to search for in the file (must appear exactly once)"),
  new_str: z.string().describe("The string to replace the old string with")
});

const ExecuteCommandSchema = z.object({
  command: z.string().describe("The executable file to run (must be in system PATH or absolute path)"),
  args: z.array(z.string()).describe("List of command-line arguments to pass"),
  cwd: z.string().optional().describe("Optional working directory relative to workspace root"),
  timeout: z.number().optional().describe("Timeout in milliseconds (defaults to 30000)")
});

const JournalEntrySchema = z.object({
  summary: z.string().describe("Short natural-language description of work completed"),
  files_changed: z.array(z.string()).optional().describe("Optional list of relevant files changed"),
  commit_hash: z.string().optional().describe("Optional short git commit hash"),
  project: z.string().optional().describe("Optional target project subfolder name (e.g. 'snake-game')")
});

const GetRecentJournalEntriesSchema = z.object({
  count: z.number().optional().describe("Number of recent entries to retrieve (defaults to 5)"),
  project: z.string().optional().describe("Optional target project subfolder name (e.g. 'snake-game')")
});

const GrepContentSchema = z.object({
  pattern: z.string().describe("Fixed string pattern to search for in files"),
  path: z.string().optional().describe("Optional subdirectory path to search within, relative to workspace root (defaults to root)"),
  case_sensitive: z.boolean().optional().describe("Whether the search should be case-sensitive (defaults to false)"),
  max_results: z.number().optional().describe("Maximum number of results to return (defaults to 50)")
});

const ToggleDevModeSchema = z.object({
  enable_dev_mode: z.boolean().describe("Set to true to enable Dev Mode and allow shell execution, or false to disable Dev Mode and block shell execution.")
});

const GetDevModeStatusSchema = z.object({});

interface DirectoryEntry {
  name: string;
  size: number;
  isDirectory: boolean;
}

/**
 * Recursively walks directory to build the list of entries (excluding the audit log)
 */
async function walkDirectory(dir: string, baseDir: string, entries: DirectoryEntry[] = []): Promise<DirectoryEntry[]> {
  const dirents = await fs.promises.readdir(dir, { withFileTypes: true });
  for (const dirent of dirents) {
    if (dirent.name === ".cli-bridge-audit.log") {
      continue;
    }
    const fullPath = path.join(dir, dirent.name);
    let resolvedPath: string;
    try {
      resolvedPath = resolveSafePath(workspaceRoot, fullPath);
    } catch {
      // Skip if it escapes the workspace root
      continue;
    }

    const name = path.relative(baseDir, resolvedPath).replace(/\\/g, '/');
    let size = 0;
    let isDirectory = dirent.isDirectory();

    if (dirent.isSymbolicLink()) {
      try {
        const stat = await fs.promises.stat(resolvedPath);
        isDirectory = stat.isDirectory();
        size = isDirectory ? 0 : stat.size;
      } catch {
        continue;
      }
    } else if (!isDirectory) {
      try {
        const stat = await fs.promises.stat(resolvedPath);
        size = stat.size;
      } catch {
        continue;
      }
    }

    entries.push({ name, size, isDirectory });

    if (isDirectory) {
      await walkDirectory(resolvedPath, baseDir, entries);
    }
  }
  return entries;
}

/**
 * Lists the directory entries, either recursively or just the top level (excluding the audit log)
 */
async function listDirectory(dirPath: string, recursive: boolean): Promise<DirectoryEntry[]> {
  if (recursive) {
    return walkDirectory(dirPath, dirPath);
  }

  const dirents = await fs.promises.readdir(dirPath, { withFileTypes: true });
  const result: DirectoryEntry[] = [];
  for (const dirent of dirents) {
    if (dirent.name === ".cli-bridge-audit.log") {
      continue;
    }
    const fullPath = path.join(dirPath, dirent.name);
    let resolvedPath: string;
    try {
      resolvedPath = resolveSafePath(workspaceRoot, fullPath);
    } catch {
      continue;
    }

    let isDirectory = dirent.isDirectory();
    let size = 0;

    if (dirent.isSymbolicLink()) {
      try {
        const stat = await fs.promises.stat(resolvedPath);
        isDirectory = stat.isDirectory();
        size = isDirectory ? 0 : stat.size;
      } catch {
        continue;
      }
    } else if (!isDirectory) {
      try {
        const stat = await fs.promises.stat(resolvedPath);
        size = stat.size;
      } catch {
        continue;
      }
    }

    result.push({
      name: dirent.name,
      size,
      isDirectory
    });
  }
  return result;
}

/**
 * Translates a glob pattern to a RegExp
 */
function globToRegex(glob: string): RegExp {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  const regexStr = '^' + escaped.replace(/\*/g, '.*').replace(/\?/g, '.') + '$';
  return new RegExp(regexStr, 'i');
}

/**
 * Searches for files matching the glob pattern
 */
async function searchFiles(searchDir: string, pattern: string): Promise<string[]> {
  const entries = await walkDirectory(searchDir, searchDir);
  const regex = globToRegex(pattern);
  const matchedFiles: string[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory) {
      const relativePath = entry.name;
      const fileName = path.basename(relativePath);
      if (regex.test(relativePath) || regex.test(fileName)) {
        matchedFiles.push(relativePath);
      }
    }
  }
  return matchedFiles;
}

interface GrepMatch {
  path: string;
  line: number;
  text: string;
}

/**
 * Performs search using either @vscode/ripgrep or falling back to manual readline matching.
 */
async function performGrep(
  targetDir: string,
  pattern: string,
  caseSensitive: boolean,
  maxResults: number
): Promise<GrepMatch[]> {
  try {
    return await ripgrepGrep(targetDir, pattern, caseSensitive, maxResults);
  } catch (err: any) {
    console.error(`[cli-bridge] Ripgrep failed, falling back to manual grep: ${err.message}`);
    return manualGrep(targetDir, pattern, caseSensitive, maxResults);
  }
}

async function ripgrepGrep(
  targetDir: string,
  pattern: string,
  caseSensitive: boolean,
  maxResults: number
): Promise<GrepMatch[]> {
  return new Promise((resolve, reject) => {
    const matches: GrepMatch[] = [];
    const args = ["-n", "-H", "--no-heading", "-F"];
    if (!caseSensitive) {
      args.push("-i");
    }
    // Search inside targetDir (passed as ".")
    args.push(pattern, ".");

    const child = spawn(rgPath, args, {
      cwd: targetDir
    });

    let stdout = "";
    let parseError: any = null;

    child.stdout.on("data", (data) => {
      stdout += data.toString();
      const lines = stdout.split(/\r?\n/);
      stdout = lines.pop() || "";

      for (const line of lines) {
        if (!line.trim()) continue;

        const firstColon = line.indexOf(":");
        const secondColon = line.indexOf(":", firstColon + 1);
        if (firstColon !== -1 && secondColon !== -1) {
          const relPath = line.substring(0, firstColon);
          const lineNo = parseInt(line.substring(firstColon + 1, secondColon), 10);
          const text = line.substring(secondColon + 1);

          const fullPath = path.join(targetDir, relPath);
          let resolvedRelPath: string;
          try {
            const realP = resolveSafePath(workspaceRoot, fullPath);
            resolvedRelPath = path.relative(workspaceRoot, realP).replace(/\\/g, "/");
          } catch {
            continue;
          }

          matches.push({
            path: resolvedRelPath,
            line: lineNo,
            text
          });

          if (matches.length >= maxResults) {
            child.kill();
            break;
          }
        }
      }
    });

    child.on("error", (err) => {
      parseError = err;
    });

    child.on("close", (code) => {
      if (parseError) {
        reject(parseError);
      } else {
        resolve(matches);
      }
    });
  });
}

async function manualGrep(
  targetDir: string,
  pattern: string,
  caseSensitive: boolean,
  maxResults: number
): Promise<GrepMatch[]> {
  const matches: GrepMatch[] = [];

  async function search(dir: string) {
    if (matches.length >= maxResults) return;

    const dirents = await fs.promises.readdir(dir, { withFileTypes: true });
    for (const dirent of dirents) {
      if (matches.length >= maxResults) return;

      const name = dirent.name;
      if (name === "node_modules" || name === "build" || name === ".git" || name === ".cli-bridge-audit.log") {
        continue;
      }

      const fullPath = path.join(dir, name);
      let resolvedPath: string;
      try {
        resolvedPath = resolveSafePath(workspaceRoot, fullPath);
      } catch {
        continue;
      }

      if (dirent.isDirectory()) {
        await search(resolvedPath);
      } else if (dirent.isFile()) {
        await searchFile(resolvedPath);
      }
    }
  }

  async function searchFile(filePath: string) {
    const stream = fs.createReadStream(filePath, { encoding: "utf-8" });
    const rl = readline.createInterface({
      input: stream,
      crlfDelay: Infinity
    });

    const relativePath = path.relative(workspaceRoot, filePath).replace(/\\/g, "/");
    let lineNumber = 0;

    let matcher: (text: string) => boolean;
    if (caseSensitive) {
      matcher = (text) => text.includes(pattern);
    } else {
      const lowerPattern = pattern.toLowerCase();
      matcher = (text) => text.toLowerCase().includes(lowerPattern);
    }

    for await (const line of rl) {
      lineNumber++;
      if (matcher(line)) {
        matches.push({
          path: relativePath,
          line: lineNumber,
          text: line
        });
        if (matches.length >= maxResults) {
          rl.close();
          stream.destroy();
          break;
        }
      }
    }
  }

  await search(targetDir);
  return matches;
}

// Define tools list with annotations
const TOOLS = [
  {
    name: "read_file",
    description: "Read the contents of a file as UTF-8 text from the workspace. Supports start_line and end_line parameters.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Path to the file to read, relative to workspace root"
        },
        start_line: {
          type: "number",
          description: "Optional 1-based start line to read from"
        },
        end_line: {
          type: "number",
          description: "Optional 1-based end line to read to (inclusive)"
        }
      },
      required: ["path"]
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false
    }
  },
  {
    name: "list_directory",
    description: "List the contents of a directory in the workspace.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Path to the directory, relative to workspace root"
        },
        recursive: {
          type: "boolean",
          description: "If true, list directory contents recursively"
        }
      },
      required: ["path"]
    },
    annotations: {
      readOnlyHint: true
    }
  },
  {
    name: "search_files",
    description: "Search for files within the workspace matching a glob pattern.",
    inputSchema: {
      type: "object",
      properties: {
        pattern: {
          type: "string",
          description: "Simple glob pattern to match filenames (e.g. '*.ts', '**/*.js')"
        },
        path: {
          type: "string",
          description: "Optional subdirectory path to search within, relative to workspace root"
        }
      },
      required: ["pattern"]
    },
    annotations: {
      readOnlyHint: true
    }
  },
  {
    name: "grep_content",
    description: "Search for a fixed string pattern in files within the workspace. Returns only matching lines, capped at max_results.",
    inputSchema: {
      type: "object",
      properties: {
        pattern: {
          type: "string",
          description: "Fixed string pattern to search for in files"
        },
        path: {
          type: "string",
          description: "Optional subdirectory path to search within, relative to workspace root"
        },
        case_sensitive: {
          type: "boolean",
          description: "Whether the search should be case-sensitive (defaults to false)"
        },
        max_results: {
          type: "number",
          description: "Maximum number of results to return (defaults to 50)"
        }
      },
      required: ["pattern"]
    },
    annotations: {
      readOnlyHint: true
    }
  },
  {
    name: "write_file",
    description: "Write content to a file in the workspace, overwriting it if it already exists. Creates parent directories if needed.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Path to write the file to, relative to workspace root"
        },
        content: {
          type: "string",
          description: "Full content to write to the file"
        }
      },
      required: ["path", "content"]
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true
    }
  },
  {
    name: "edit_file",
    description: "Edit a file in the workspace by performing a find-and-replace on a unique string. Errors if the search string is not found or matches multiple times.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Path to the file to edit, relative to workspace root"
        },
        old_str: {
          type: "string",
          description: "The exact unique string to search for in the file (must appear exactly once)"
        },
        new_str: {
          type: "string",
          description: "The string to replace the old string with"
        }
      },
      required: ["path", "old_str", "new_str"]
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true
    }
  },
  {
    name: "execute_command",
    description: "Execute a command-line tool in the workspace. Gated by Dev Mode (OFF by default; must be enabled via toggle_dev_mode before executing commands). Timeout defaults to 30s. Spawns directly without a shell wrapper by default, but supports allowlisted wrappers on Windows.",
    inputSchema: {
      type: "object",
      properties: {
        command: {
          type: "string",
          description: "The executable command to run (e.g. 'git', 'node', 'npm')"
        },
        args: {
          type: "array",
          items: {
            type: "string"
          },
          description: "Arguments to pass to the command as an array"
        },
        cwd: {
          type: "string",
          description: "Optional working directory relative to workspace root"
        },
        timeout: {
          type: "number",
          description: "Optional timeout in milliseconds (defaults to 30000)"
        }
      },
      required: ["command", "args"]
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      openWorldHint: true
    }
  },
  {
    name: "toggle_dev_mode",
    description: "Toggle session-only Dev Mode. Setting enable_dev_mode: true enables Dev Mode and permits shell command execution until server restart or turned off. Resets to Dev Mode OFF on every server restart.",
    inputSchema: {
      type: "object",
      properties: {
        enable_dev_mode: {
          type: "boolean",
          description: "Set to true to enable Dev Mode and allow shell execution, or false to disable Dev Mode."
        }
      },
      required: ["enable_dev_mode"]
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false
    }
  },
  {
    name: "get_dev_mode_status",
    description: "Get current Dev Mode status for shell command execution. State is in-memory and resets to Dev Mode OFF on every server restart.",
    inputSchema: {
      type: "object",
      properties: {}
    },
    annotations: {
      readOnlyHint: true
    }
  },
  {
    name: "log_journal_entry",
    description: "Append a structured log entry to PROJECT_LOG.md detailing completed work and changed files.",
    inputSchema: {
      type: "object",
      properties: {
        summary: {
          type: "string",
          description: "Description of the work done and why (natural language)"
        },
        files_changed: {
          type: "array",
          items: {
            type: "string"
          },
          description: "Optional list of relevant files changed (relative paths)"
        },
        commit_hash: {
          type: "string",
          description: "Optional short git commit hash"
        },
        project: {
          type: "string",
          description: "Optional target project subfolder name (e.g. 'snake-game')"
        }
      },
      required: ["summary"]
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false
    }
  },
  {
    name: "get_recent_journal_entries",
    description: "Read the last N entries from PROJECT_LOG.md.",
    inputSchema: {
      type: "object",
      properties: {
        count: {
          type: "number",
          description: "Number of recent entries to retrieve (defaults to 5)"
        },
        project: {
          type: "string",
          description: "Optional target project subfolder name (e.g. 'snake-game')"
        }
      }
    },
    annotations: {
      readOnlyHint: true
    }
  }
];

// Instantiate Server
const server = new Server(
  {
    name: "cli-bridge",
    version: "1.0.0"
  },
  {
    capabilities: {
      tools: {},
      resources: {},
      prompts: {}
    }
  }
);

// Register list tools handler
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: TOOLS
  };
});

server.setRequestHandler(ListResourcesRequestSchema, async () => {
  return {
    resources: []
  };
});

server.setRequestHandler(ListPromptsRequestSchema, async () => {
  return {
    prompts: []
  };
});

/**
 * Appends a JSON structured audit log line directly to the target project's or root's .cli-bridge-audit.log
 */
function appendAuditLog(tool: string, args: any, status: string) {
  try {
    let targetPathArg = "";
    if (args) {
      if (typeof args.path === "string") {
        targetPathArg = args.path;
      } else if (typeof args.cwd === "string") {
        targetPathArg = args.cwd;
      } else if (typeof args.project === "string") {
        targetPathArg = args.project;
      }
    }

    const scope = determineProjectScope(targetPathArg);
    const targetDir = getScopeDirectory(scope);

    ensureGitignore(targetDir);

    if (!fs.existsSync(targetDir)) {
      fs.mkdirSync(targetDir, { recursive: true });
    }
    const logPath = path.join(targetDir, ".cli-bridge-audit.log");

    // Create copy of args and truncate content fields if necessary
    const formattedArgs = { ...args };
    if (tool === "write_file" && typeof formattedArgs.content === "string") {
      formattedArgs.content = formattedArgs.content.substring(0, 200) + (formattedArgs.content.length > 200 ? "..." : "");
    } else if (tool === "edit_file") {
      if (typeof formattedArgs.old_str === "string") {
        formattedArgs.old_str = formattedArgs.old_str.substring(0, 200) + (formattedArgs.old_str.length > 200 ? "..." : "");
      }
      if (typeof formattedArgs.new_str === "string") {
        formattedArgs.new_str = formattedArgs.new_str.substring(0, 200) + (formattedArgs.new_str.length > 200 ? "..." : "");
      }
    }

    const logEntry = {
      timestamp: new Date().toISOString(),
      tool,
      args: formattedArgs,
      status
    };

    fs.appendFileSync(logPath, JSON.stringify(logEntry) + "\n", "utf-8");
  } catch (err) {
    console.error(`[cli-bridge] Failed to write audit log:`, err);
  }
}

// Register call tool handler
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const toolName = request.params.name;
  const args: any = request.params.arguments || {};

  // Log every tool call to stderr
  console.error(`[cli-bridge] Tool invocation: ${toolName} with args ${JSON.stringify(args)}`);

  let status = "success";
  try {
    const response = await handleToolCall(toolName, args);
    if (response.isError) {
      if (response.content && response.content[0] && response.content[0].text && (response.content[0].text.includes("Blocked:") || response.content[0].text.toLowerCase().includes("blocked"))) {
        status = "blocked";
      } else {
        status = "error";
      }
    }
    appendAuditLog(toolName, args, status);
    return response;
  } catch (error: any) {
    appendAuditLog(toolName, args, "error");
    console.error(`[cli-bridge] Tool error in ${toolName}: ${error.stack || error.message || error}`);
    return {
      content: [{ type: "text", text: error.message || String(error) }],
      isError: true
    };
  }
});

/**
 * Handles individual tool requests.
 */
async function handleToolCall(toolName: string, args: any): Promise<any> {
  switch (toolName) {
    case "toggle_dev_mode": {
      const parsed = ToggleDevModeSchema.safeParse(args);
      if (!parsed.success) {
        return {
          content: [{ type: "text", text: `Invalid arguments: ${parsed.error.message}` }],
          isError: true
        };
      }

      devModeEnabled = parsed.data.enable_dev_mode;
      const message = parsed.data.enable_dev_mode
        ? "Dev Mode is now ON. Shell command execution is enabled until you turn it off or restart the server."
        : "Dev Mode is now OFF. Shell command execution is blocked.";

      console.error(`[cli-bridge] ${message}`);
      return {
        content: [{ type: "text", text: message }]
      };
    }

    case "get_dev_mode_status": {
      const message = devModeEnabled
        ? "Dev Mode is currently ON (shell command execution is ENABLED)."
        : "Dev Mode is currently OFF (shell command execution is BLOCKED).";
      return {
        content: [{ type: "text", text: message }]
      };
    }

    case "read_file": {
      const parsed = ReadFileSchema.safeParse(args);
      if (!parsed.success) {
        return {
          content: [{ type: "text", text: `Invalid arguments: ${parsed.error.message}` }],
          isError: true
        };
      }

      const resolvedPath = resolveSafePath(workspaceRoot, parsed.data.path);

      const stat = await fs.promises.stat(resolvedPath);
      if (!stat.isFile()) {
        return {
          content: [{ type: "text", text: `Path "${parsed.data.path}" is not a file.` }],
          isError: true
        };
      }

      let content = await fs.promises.readFile(resolvedPath, "utf-8");

      const startLine = parsed.data.start_line;
      const endLine = parsed.data.end_line;
      if (startLine !== undefined || endLine !== undefined) {
        const lines = content.split(/\r?\n/);
        const start = startLine !== undefined ? Math.max(1, startLine) - 1 : 0;
        const end = endLine !== undefined ? Math.min(lines.length, endLine) : lines.length;
        content = lines.slice(start, end).join("\n");
      }

      return {
        content: [{ type: "text", text: content }]
      };
    }

    case "list_directory": {
      const parsed = ListDirectorySchema.safeParse(args);
      if (!parsed.success) {
        return {
          content: [{ type: "text", text: `Invalid arguments: ${parsed.error.message}` }],
          isError: true
        };
      }

      const resolvedPath = resolveSafePath(workspaceRoot, parsed.data.path);

      const stat = await fs.promises.stat(resolvedPath);
      if (!stat.isDirectory()) {
        return {
          content: [{ type: "text", text: `Path "${parsed.data.path}" is not a directory.` }],
          isError: true
        };
      }

      const entries = await listDirectory(resolvedPath, !!parsed.data.recursive);
      return {
        content: [{ type: "text", text: JSON.stringify(entries, null, 2) }]
      };
    }

    case "search_files": {
      const parsed = SearchFilesSchema.safeParse(args);
      if (!parsed.success) {
        return {
          content: [{ type: "text", text: `Invalid arguments: ${parsed.error.message}` }],
          isError: true
        };
      }

      const targetDir = resolveSafePath(workspaceRoot, parsed.data.path || ".");

      const stat = await fs.promises.stat(targetDir);
      if (!stat.isDirectory()) {
        return {
          content: [{ type: "text", text: `Path "${parsed.data.path || "."}" is not a directory.` }],
          isError: true
        };
      }

      const results = await searchFiles(targetDir, parsed.data.pattern);
      return {
        content: [{ type: "text", text: JSON.stringify(results, null, 2) }]
      };
    }

    case "grep_content": {
      const parsed = GrepContentSchema.safeParse(args);
      if (!parsed.success) {
        return {
          content: [{ type: "text", text: `Invalid arguments: ${parsed.error.message}` }],
          isError: true
        };
      }

      const targetDir = resolveSafePath(workspaceRoot, parsed.data.path || ".");
      const stat = await fs.promises.stat(targetDir);
      if (!stat.isDirectory()) {
        return {
          content: [{ type: "text", text: `Path "${parsed.data.path || "."}" is not a directory.` }],
          isError: true
        };
      }

      const pattern = parsed.data.pattern;
      const caseSensitive = !!parsed.data.case_sensitive;
      const maxResults = parsed.data.max_results || 50;

      console.error(`[cli-bridge] Performing grep_content search for pattern "${pattern}" in "${targetDir}" (caseSensitive: ${caseSensitive}, maxResults: ${maxResults})`);

      const matches = await performGrep(targetDir, pattern, caseSensitive, maxResults);
      return {
        content: [{ type: "text", text: JSON.stringify(matches, null, 2) }]
      };
    }

    case "write_file": {
      const parsed = WriteFileSchema.safeParse(args);
      if (!parsed.success) {
        return {
          content: [{ type: "text", text: `Invalid arguments: ${parsed.error.message}` }],
          isError: true
        };
      }

      const resolvedPath = resolveSafePath(workspaceRoot, parsed.data.path);
      console.error(`[cli-bridge] Writing file: "${resolvedPath}" (content length: ${parsed.data.content.length} characters)`);

      await fs.promises.mkdir(path.dirname(resolvedPath), { recursive: true });
      await fs.promises.writeFile(resolvedPath, parsed.data.content, "utf-8");
      return {
        content: [{ type: "text", text: `Successfully wrote file: ${parsed.data.path}` }]
      };
    }

    case "edit_file": {
      const parsed = EditFileSchema.safeParse(args);
      if (!parsed.success) {
        return {
          content: [{ type: "text", text: `Invalid arguments: ${parsed.error.message}` }],
          isError: true
        };
      }

      const resolvedPath = resolveSafePath(workspaceRoot, parsed.data.path);
      console.error(`[cli-bridge] Editing file: "${resolvedPath}"`);

      const stat = await fs.promises.stat(resolvedPath);
      if (!stat.isFile()) {
        return {
          content: [{ type: "text", text: `Path "${parsed.data.path}" is not a file.` }],
          isError: true
        };
      }

      const content = await fs.promises.readFile(resolvedPath, "utf-8");
      const oldStr = parsed.data.old_str;
      const newStr = parsed.data.new_str;

      let count = 0;
      let pos = content.indexOf(oldStr);
      while (pos !== -1) {
        count++;
        if (count > 1) break;
        pos = content.indexOf(oldStr, pos + oldStr.length);
      }

      if (count === 0) {
        return {
          content: [{ type: "text", text: `Error: The search string ("${oldStr}") was not found in the file.` }],
          isError: true
        };
      }

      if (count > 1) {
        return {
          content: [{ type: "text", text: `Error: The search string ("${oldStr}") was found multiple times. Edits must be unique.` }],
          isError: true
        };
      }

      const updatedContent = content.replace(oldStr, newStr);
      await fs.promises.writeFile(resolvedPath, updatedContent, "utf-8");
      return {
        content: [{ type: "text", text: `Successfully edited file: ${parsed.data.path}` }]
      };
    }

    case "execute_command": {
      // Hard early return if Dev Mode is not enabled before any path/cwd resolution or spawn logic
      if (!devModeEnabled) {
        const blockedMsg = "Shell execution is currently blocked. Ask the user if they'd like you to call toggle_dev_mode with enable_dev_mode: true before proceeding.";
        console.error(`[cli-bridge] ${blockedMsg}`);
        return {
          content: [{ type: "text", text: blockedMsg }],
          isError: true
        };
      }

      const parsed = ExecuteCommandSchema.safeParse(args);
      if (!parsed.success) {
        return {
          content: [{ type: "text", text: `Invalid arguments: ${parsed.error.message}` }],
          isError: true
        };
      }

      // Pre-flight path safety scan
      const unsafePaths = scanForUnsafePaths(parsed.data.command, parsed.data.args);
      if (unsafePaths.length > 0) {
        const blockedMsg = `Blocked: command references path(s) outside workspace root: ${JSON.stringify(unsafePaths)}. If this is intentional, note this tool only allows execution scoped to the workspace root.`;
        console.error(`[cli-bridge] ${blockedMsg}`);
        return {
          content: [{ type: "text", text: blockedMsg }],
          isError: true
        };
      }

      const resolvedCwd = resolveSafePath(workspaceRoot, parsed.data.cwd || ".");
      const timeoutMs = parsed.data.timeout || 30000;

      // Determine if command needs shell wrapper on Windows
      const useShell = shouldWinShell(parsed.data.command);

      // Hardened metacharacter scan for shell: true path to prevent cmd breakout vulnerabilities
      if (useShell && hasShellMetacharacters(parsed.data.args)) {
        const blockedMsg = `Blocked: command arguments contain characters not permitted for shell wrapper scripts: ${JSON.stringify(parsed.data.args)}. Permitted arguments cannot contain the following characters: ${SHELL_METACHARS.join(" ")}`;
        console.error(`[cli-bridge] ${blockedMsg}`);
        return {
          content: [{ type: "text", text: blockedMsg }],
          isError: true
        };
      }

      console.error(`[cli-bridge] Executing command: "${parsed.data.command}" with args: ${JSON.stringify(parsed.data.args)} in cwd: "${resolvedCwd}" (timeout: ${timeoutMs}ms, shell: ${useShell})`);

      return new Promise<any>((resolve) => {
        let stdout = "";
        let stderr = "";
        let killedDueToTimeout = false;

        const child = spawn(parsed.data.command, parsed.data.args, {
          cwd: resolvedCwd,
          shell: useShell
        });

        const timer = setTimeout(() => {
          killedDueToTimeout = true;
          child.kill("SIGKILL");
        }, timeoutMs);

        child.stdout.on("data", (data) => {
          stdout += data.toString();
        });

        child.stderr.on("data", (data) => {
          stderr += data.toString();
        });

        child.on("error", (error) => {
          clearTimeout(timer);
          resolve({
            content: [{ type: "text", text: `Failed to start command: ${error.message}` }],
            isError: true
          });
        });

        child.on("close", (code) => {
          clearTimeout(timer);
          if (killedDueToTimeout) {
            resolve({
              content: [{ type: "text", text: `Error: Command execution timed out after ${timeoutMs}ms.` }],
              isError: true
            });
          } else {
            resolve({
              content: [
                {
                  type: "text",
                  text: JSON.stringify({
                    stdout,
                    stderr,
                    exitCode: code
                  }, null, 2)
                }
              ]
            });
          }
        });
      });
    }

    case "log_journal_entry": {
      const parsed = JournalEntrySchema.safeParse(args);
      if (!parsed.success) {
        return {
          content: [{ type: "text", text: `Invalid arguments: ${parsed.error.message}` }],
          isError: true
        };
      }

      // Determine target log directory based on project parameter
      let targetDir = workspaceRoot;
      if (parsed.data.project && parsed.data.project.trim() !== "") {
        try {
          targetDir = resolveSafePath(workspaceRoot, parsed.data.project);
        } catch (err: any) {
          return {
            content: [{ type: "text", text: `Invalid project path: ${err.message}` }],
            isError: true
          };
        }
      }

      // Validate files_changed relative paths if provided
      if (parsed.data.files_changed) {
        for (const file of parsed.data.files_changed) {
          resolveSafePath(targetDir, file);
        }
      }

      ensureGitignore(targetDir);
      const logPath = path.join(targetDir, "PROJECT_LOG.md");
      const timestamp = new Date().toISOString();
      const files = parsed.data.files_changed && parsed.data.files_changed.length > 0
        ? parsed.data.files_changed.join(", ")
        : "none specified";
      const commit = parsed.data.commit_hash || "not committed";

      const entry = `## ${timestamp}
**Summary:** ${parsed.data.summary}
**Files:** ${files}
**Commit:** ${commit}

---
`;

      if (!fs.existsSync(logPath)) {
        const header = `# Project Journal

This log tracks development history and work continuity.

`;
        await fs.promises.mkdir(path.dirname(logPath), { recursive: true });
        await fs.promises.writeFile(logPath, header + entry, "utf-8");
      } else {
        await fs.promises.appendFile(logPath, "\n" + entry, "utf-8");
      }

      return {
        content: [{ type: "text", text: `Successfully logged journal entry to ${path.relative(workspaceRoot, logPath) || "PROJECT_LOG.md"}.` }]
      };
    }

    case "get_recent_journal_entries": {
      const parsed = GetRecentJournalEntriesSchema.safeParse(args);
      if (!parsed.success) {
        return {
          content: [{ type: "text", text: `Invalid arguments: ${parsed.error.message}` }],
          isError: true
        };
      }

      let targetDir = workspaceRoot;
      if (parsed.data.project && parsed.data.project.trim() !== "") {
        try {
          targetDir = resolveSafePath(workspaceRoot, parsed.data.project);
        } catch (err: any) {
          return {
            content: [{ type: "text", text: `Invalid project path: ${err.message}` }],
            isError: true
          };
        }
      }

      const logPath = path.join(targetDir, "PROJECT_LOG.md");
      if (!fs.existsSync(logPath)) {
        const targetRel = path.relative(workspaceRoot, logPath);
        return {
          content: [{ type: "text", text: `No project log file found at ${targetRel}.` }]
        };
      }

      const count = parsed.data.count || 5;
      const content = await fs.promises.readFile(logPath, "utf-8");
      const entries = content.split(/(?:\r?\n)?---(?:\r?\n)?/).map(e => e.trim()).filter(Boolean);

      const lastN = entries.slice(-count);
      const cleanedN = lastN.map(entry => {
        if (entry.includes("# Project Journal")) {
          const index = entry.indexOf("## ");
          if (index !== -1) {
            return entry.substring(index);
          }
        }
        return entry;
      });

      const resultText = cleanedN.join("\n\n---\n\n");
      return {
        content: [{ type: "text", text: resultText }]
      };
    }

    default:
      return {
        content: [{ type: "text", text: `Unknown tool: ${toolName}` }],
        isError: true
      };
  }
}

// Run server using Stdio transport
async function run() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[cli-bridge] Server connected and listening on stdin/stdout");
}

run().catch((error) => {
  console.error(`[cli-bridge] Server startup failed: ${error.stack || error.message || error}`);
  process.exit(1);
});
