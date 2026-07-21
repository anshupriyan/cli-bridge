import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import * as fs from "fs";
import * as path from "path";
import { spawn } from "child_process";

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

/**
 * Ensures that WORKSPACE_ROOT/.gitignore exists and contains the required log exclusions.
 */
function ensureGitignore(root: string) {
  try {
    const gitignorePath = path.join(root, ".gitignore");
    const targets = [".cli-bridge-audit.log", "PROJECT_LOG.md"];
    
    if (!fs.existsSync(gitignorePath)) {
      fs.writeFileSync(gitignorePath, targets.join("\n") + "\n", "utf-8");
      console.error("[cli-bridge] Created default .gitignore with log exclusions.");
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
      console.error(`[cli-bridge] Appended missing entries to .gitignore: ${toAppend.join(", ")}`);
    }
  } catch (err: any) {
    console.error(`[cli-bridge] Warning: Failed to configure .gitignore: ${err.message}`);
  }
}

// Run gitignore check on startup
ensureGitignore(workspaceRoot);

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
    // If the path doesn't exist (e.g. for write_file creating a new file),
    // resolve the realpath of the parent directory instead and join the basename.
    const parentDir = path.dirname(resolvedPath);
    const filename = path.basename(resolvedPath);
    try {
      const realParent = fs.realpathSync(parentDir);
      realPath = path.resolve(realParent, filename);
    } catch (parentErr) {
      // Fall back to resolvedPath if parent directory doesn't exist
    }
  }

  const relative = path.relative(realRoot, realPath);
  const isOutside = relative.startsWith("..") || path.isAbsolute(relative);

  if (isOutside) {
    throw new Error(`Access denied: Path "${userPath}" resolves outside of workspace root "${realRoot}".`);
  }

  return realPath;
}

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
  path: z.string().describe("Path to the file to read, relative to workspace root")
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
  commit_hash: z.string().optional().describe("Optional short git commit hash")
});

const GetRecentJournalEntriesSchema = z.object({
  count: z.number().optional().describe("Number of recent entries to retrieve (defaults to 5)")
});

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

// Define tools list with annotations
const TOOLS = [
  {
    name: "read_file",
    description: "Read the contents of a file as UTF-8 text from the workspace.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Path to the file to read, relative to workspace root"
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
    description: "Execute a command-line tool in the workspace. Timeout defaults to 30s. Spawns directly without a shell wrapper by default, but supports allowlisted wrappers on Windows.",
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
          description: "Optional git short commit hash"
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
          description: "Number of entries to retrieve (defaults to 5)"
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
      tools: {}
    }
  }
);

// Register list tools handler
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: TOOLS
  };
});

/**
 * Appends a JSON structured audit log line to workspaceRoot/.cli-bridge-audit.log
 */
function appendAuditLog(tool: string, args: any, status: string) {
  try {
    const logPath = path.join(workspaceRoot, ".cli-bridge-audit.log");
    
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
  const args = request.params.arguments || {};
  
  // Log every tool call to stderr
  console.error(`[cli-bridge] Tool invocation: ${toolName} with args ${JSON.stringify(args)}`);
  
  let status = "success";
  try {
    const response = await handleToolCall(toolName, args);
    if (response.isError) {
      if (response.content && response.content[0] && response.content[0].text && response.content[0].text.includes("Blocked:")) {
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
      
      const content = await fs.promises.readFile(resolvedPath, "utf-8");
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
      
      // Validate files_changed relative paths if provided
      if (parsed.data.files_changed) {
        for (const file of parsed.data.files_changed) {
          resolveSafePath(workspaceRoot, file);
        }
      }
      
      const logPath = path.join(workspaceRoot, "PROJECT_LOG.md");
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
        await fs.promises.writeFile(logPath, header + entry, "utf-8");
      } else {
        await fs.promises.appendFile(logPath, "\n" + entry, "utf-8");
      }
      
      return {
        content: [{ type: "text", text: `Successfully logged journal entry.` }]
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
      
      const logPath = path.join(workspaceRoot, "PROJECT_LOG.md");
      if (!fs.existsSync(logPath)) {
        return {
          content: [{ type: "text", text: "No project log file found." }]
        };
      }
      
      const count = parsed.data.count || 5;
      const content = await fs.promises.readFile(logPath, "utf-8");
      const entries = content.split(/(?:\r?\n)?---(?:\r?\n)?/).map(e => e.trim()).filter(Boolean);
      
      // Take last N entries
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
