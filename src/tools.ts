import { readFileAsync, getFilePath, editFile, listFiles, WORKSPACE_DIR } from "./workspace.ts";

export const TOOLS: { [id: string]: any } = {
    read_file: {
        type: "function",
        function: {
            name: "read_file",
            description:
                "Read the contents of a file in the workspace. Only files in the workspace directory can be read.",
            parameters: {
                type: "object",
                properties: {
                    path: {
                        type: "string",
                        description: "Relative path to the file within the workspace (e.g. 'AGENTS.md').",
                    },
                },
                required: ["path"],
            },
        },
    },
    edit_file: {
        type: "function",
        function: {
            name: "edit_file",
            description:
                "Overwrite the contents of an existing file in the workspace. You cannot create new files or delete files — only edit files that already exist.",
            parameters: {
                type: "object",
                properties: {
                    path: {
                        type: "string",
                        description: "Relative path to the file within the workspace.",
                    },
                    content: {
                        type: "string",
                        description: "The new complete content to write to the file.",
                    },
                },
                required: ["path", "content"],
            },
        },
    },
    list_files: {
        type: "function",
        function: {
            name: "list_files",
            description: "List all files currently in the workspace directory.",
            parameters: {
                type: "object",
                properties: {},
                required: [],
            },
        },
    },
    send_file: {
        type: "function",
        function: {
            name: "send_file",
            description:
                "Send a file from the workspace as a Discord attachment. The file will be sent after the agent's response.",
            parameters: {
                type: "object",
                properties: {
                    path: {
                        type: "string",
                        description: "Relative path to the file within the workspace.",
                    },
                    caption: {
                        type: "string",
                        description: "Optional caption for the file.",
                    },
                },
                required: ["path"],
            },
        },
    },
    shell: {
        type: "function",
        function: {
            name: "shell",
            description:
                "Run a shell command. This is in a sandboxed environment with a bash-like shell. `~` is your workspace, and is the default working directory. You've got all the commands you'd expect, like `grep`, `cat`, `sed`, and so on. However, you don't have access to Python or other runtimes. Treat this as a way to interact with the workspace and files. You can use `grep -ri 'some text'` to search for text recursively from the working directory.",
            parameters: {
                type: "object",
                properties: {
                    description: {
                        type: "string",
                        description: "User-facing description of what you're doing. Like: \"Searching through memory files\", \"Writing to MEMORY.md\", and so on. Don't add an elipsis at the end. Keep this concise.",
                    },
                    shell_command: {
                        type: "string",
                        description: "The shell command to run.",
                    },
                },
                required: ["description", "shell_command"],
            },
        },
    }
} as const;

// Track pending file sends (picked up by index.ts after tool execution)
export let pendingFileSend: { path: string; caption: string } | null = null;

export function clearPendingFileSend(): void {
    pendingFileSend = null;
}

import { WasmShell } from "wasm-shell";
const shell = new WasmShell();

import path from "path";
import { mkdir, readdir, readFile, writeFile, rm, stat as fsStat } from "fs/promises";
const toReal = (rel: string) => path.join(WORKSPACE_DIR, rel);

shell.mount("/home/", {
    async read(path) {
        return readFile(toReal(path));
    },
    async write(path, data) {
        const full = toReal(path);
        await mkdir(full.substring(0, full.lastIndexOf("/")), { recursive: true });
        await writeFile(full, data);
    },
    async list(path) {
        const entries = await readdir(toReal(path), { withFileTypes: true });
        return entries.map(e => e.name);
    },
    async stat(path) {
        const s = await fsStat(toReal(path));
        return { isFile: s.isFile(), isDir: s.isDirectory(), isDevice: false, size: s.size };
    },
    async remove(path) {
        await rm(toReal(path), { recursive: true, force: true });
    },
});

shell.setEnv("HOME", "/home");
shell.setCwd("/home");

const dec = new TextDecoder();

export async function handleToolCall(
    name: string,
    args: Record<string, string>
): Promise<string> {
    console.log(`Handling tool call: ${name} with args ${JSON.stringify(args)}`);
    switch (name) {
        case "read_file": {
            if (!args.path) throw new Error("Missing 'path' argument for read_file.");
            const content = await readFileAsync(args.path);
            return content;
        }
        case "edit_file": {
            if (!args.path) throw new Error("Missing 'path' argument for edit_file.");
            if (args.content === undefined)
                throw new Error("Missing 'content' argument for edit_file.");
            await editFile(args.path, args.content);
            return `Successfully wrote ${args.content.length} characters to "${args.path}".`;
        }
        case "list_files": {
            const files = await listFiles();
            return files.length > 0
                ? files.map((f) => `• ${f}`).join("\n")
                : "(workspace is empty)";
        }
        case "send_file": {
            if (!args.path) throw new Error("Missing 'path' argument for send_file.");
            // Validate file exists
            getFilePath(args.path);
            // Queue file for sending after response
            pendingFileSend = { path: args.path, caption: args.caption || "" };
            return `File "${args.path}" queued for sending.`;
        }
        case "shell": {
            if (!args.shell_command) throw new Error("Missing 'shell_command' argument for shell.");
            const result = await shell.exec(args.shell_command);
            let output = "";
            
            if (result.stdout) output += `stdout:\n\`\`\`${dec.decode(result.stdout).trim()}\`\`\`\n`;
            if (result.stderr) output += `stderr:\n\`\`\`${dec.decode(result.stderr).trim()}\`\`\`\n`;
            if (output.length === 0) output = "(no shell output)";
            if (result.code !== 0) output = `Command exited with code ${result.code}.\n` + output;
            const home = shell.getEnv("HOME") ?? "/home";
            const cwd = shell.getCwd();
            const display = cwd === home
                ? "~"
                : cwd.startsWith(home + "/")
                    ? "~" + cwd.slice(home.length)
                    : cwd;
            return output.trim() + `\n(Current directory: ${display})`;
        }
        default:
            throw new Error(`Unknown tool: ${name}`);
    }
}
