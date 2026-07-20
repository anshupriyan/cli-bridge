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
  old_str: z.string().describe("The exact unique string to search for in the file"),
  new_str: z.string().describe("The string to replace the old string with")
});

const ExecuteCommandSchema = z.object({
  command: z.string().describe("The executable file to run (must be in system PATH or absolute path)"),
  args: z.array(z.string()).describe("List of command-line arguments to pass"),
  cwd: z.string().optional().describe("Optional working directory relative to workspace root"),
  timeout: z.number().optional().describe("Timeout in milliseconds (defaults to 30000)")
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
    description: "Execute a command-line tool in the workspace. Timeout defaults to 30s. Spawns directly without a shell wrapper.",
    inputSchema: {
      type: "object",
      properties: {
        command: {
          type: "string",
          description: "The executable command to run (e.g. 'git', 'node')"
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
function appendAuditLog(tool: string, args: any, status: "success" | "error") {
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
  
  let status: "success" | "error" = "success";
  try {
    const response = await handleToolCall(toolName, args);
    if (response.isError) {
      status = "error";
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
      
      const resolvedCwd = resolveSafePath(workspaceRoot, parsed.data.cwd || ".");
      const timeoutMs = parsed.data.timeout || 30000;
      
      console.error(`[cli-bridge] Executing command: "${parsed.data.command}" with args: ${JSON.stringify(parsed.data.args)} in cwd: "${resolvedCwd}" (timeout: ${timeoutMs}ms)`);
      
      return new Promise<any>((resolve) => {
        let stdout = "";
        let stderr = "";
        let killedDueToTimeout = false;
        
        const child = spawn(parsed.data.command, parsed.data.args, {
          cwd: resolvedCwd,
          shell: false
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
