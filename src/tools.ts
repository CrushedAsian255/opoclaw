import path from "path";
import { exec } from "child_process";
import { mkdir, readdir, readFile, writeFile, rm, stat as fsStat } from "fs/promises";
import { Ollama } from "ollama";
import { WasmShell } from "wasm-shell";
import { readFileAsync, getFilePath, editFile, listFiles, WORKSPACE_DIR } from "./workspace.ts";
import { getConfigPath, getExposedCommands, getSemanticSearchEnabled, parseTOML, toTOML, type OpoclawConfig } from "./config.ts";
import { listSkills, readSkill } from "./skills.ts";
import { DuckDuckGoSearch } from "./search/duckduckgo.ts";
import { TavilySearch } from "./search/tavily.ts";
import type { SearchResult } from "./search/base.ts";

type ToolArgs = Record<string, any>;
type PendingFileSend = { path: string; caption: string } | null;

type ToolSchema = {
    type: "function";
    function: {
        name: string;
        description: string;
        parameters: {
            type: "object";
            properties: Record<string, any>;
            required: string[];
        };
    };
};

type ToolContext = {
    config: OpoclawConfig;
    setPendingFileSend?: (value: PendingFileSend) => void;
};

type ToolHandler = (args: ToolArgs, context: ToolContext) => Promise<string>;

type ToolDefinition = {
    tool: ToolSchema;
    enabled?: (config: OpoclawConfig) => boolean;
    requiresApproval?: boolean;
    handler?: ToolHandler;
};

function defineTool(
    name: string,
    description: string,
    properties: Record<string, any>,
    required: string[],
    options: Omit<ToolDefinition, "tool"> = {},
): ToolDefinition {
    return {
        ...options,
        tool: {
            type: "function",
            function: {
                name,
                description,
                parameters: {
                    type: "object",
                    properties,
                    required,
                },
            },
        },
    };
}

function discordOnlyHandler(name: string): ToolHandler {
    return async () => {
        throw new Error(`${name} is only available in Discord.`);
    };
}

const CACHE_DIR = path.resolve(import.meta.dir, "../cache/embeddings");
const SIMILARITY_THRESHOLD = 0.65;

function cosineSimilarity(vecA: number[], vecB: number[]): number {
    const dotProduct = vecA.reduce((sum, a, i) => sum + a * vecB[i]!, 0);
    const magnitudeA = Math.sqrt(vecA.reduce((sum, a) => sum + a * a, 0));
    const magnitudeB = Math.sqrt(vecB.reduce((sum, b) => sum + b * b, 0));
    if (magnitudeA === 0 || magnitudeB === 0) return 0;
    return dotProduct / (magnitudeA * magnitudeB);
}

async function hashString(text: string): Promise<string> {
    const data = new TextEncoder().encode(text);
    const buf = await crypto.subtle.digest("SHA-256", data);
    return Array.from(new Uint8Array(buf))
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");
}

interface LineCache {
    text: string;
    hash: string;
    embedding: number[];
}

interface FileCache {
    fileHash: string;
    lines: LineCache[];
}

async function getOllamaEmbedding(ollama: Ollama, model: string, text: string): Promise<number[]> {
    const response = await ollama.embed({ model, input: text });
    return response.embeddings[0]!;
}

async function getCachedFileEmbeddings(
    relPath: string,
    content: string,
    ollama: Ollama,
    embedModel: string,
): Promise<LineCache[]> {
    const safeName = relPath.replace(/[/\\]/g, "__");
    const cacheFile = path.join(CACHE_DIR, safeName + ".json");
    const fileHash = await hashString(content);

    let existing: FileCache | null = null;
    try {
        const raw = await readFile(cacheFile, "utf-8");
        existing = JSON.parse(raw) as FileCache;
    } catch {
    }

    if (existing?.fileHash === fileHash) {
        return existing.lines;
    }

    const existingByHash = new Map<string, number[]>();
    if (existing) {
        for (const line of existing.lines) {
            if (line.hash && line.embedding.length) {
                existingByHash.set(line.hash, line.embedding);
            }
        }
    }

    const rawLines = content.split("\n");
    const newLines: LineCache[] = [];

    for (const lineText of rawLines) {
        const trimmed = lineText.trim();
        if (!trimmed) {
            newLines.push({ text: lineText, hash: "", embedding: [] });
            continue;
        }
        const lineHash = await hashString(trimmed);
        const cached = existingByHash.get(lineHash);
        if (cached) {
            newLines.push({ text: lineText, hash: lineHash, embedding: cached });
        } else {
            const embedding = await getOllamaEmbedding(ollama, embedModel, trimmed);
            newLines.push({ text: lineText, hash: lineHash, embedding });
        }
    }

    const newCache: FileCache = { fileHash, lines: newLines };
    await mkdir(path.dirname(cacheFile), { recursive: true });
    await writeFile(cacheFile, JSON.stringify(newCache));
    return newLines;
}

async function semanticSearch(query: string, config: OpoclawConfig): Promise<string[]> {
    const ollamaBaseUrl = config.provider?.ollama?.base_url ?? "http://localhost:11434";
    const embedModel = "nomic-embed-text";
    const ollama = new Ollama({ host: ollamaBaseUrl });

    const glob = new Bun.Glob("**/*");
    const files: string[] = [];
    for await (const file of glob.scan({ cwd: WORKSPACE_DIR, onlyFiles: true })) {
        files.push(file);
    }

    const queryEmbedding = await getOllamaEmbedding(ollama, embedModel, query);
    const results: { similarity: number; line: string; file: string }[] = [];

    for (const relPath of files) {
        let content: string;
        try {
            content = await readFile(path.join(WORKSPACE_DIR, relPath), "utf-8");
        } catch {
            continue;
        }
        const lines = await getCachedFileEmbeddings(relPath, content, ollama, embedModel);
        for (const line of lines) {
            if (!line.embedding.length) continue;
            const sim = cosineSimilarity(queryEmbedding, line.embedding);
            if (sim >= SIMILARITY_THRESHOLD) {
                results.push({ similarity: sim, line: line.text, file: relPath });
            }
        }
    }

    results.sort((a, b) => b.similarity - a.similarity);
    return results.map((result) => `[${result.file}] ${result.line.trim()} (score: ${result.similarity.toFixed(3)})`);
}

const shell = new WasmShell();
const toReal = (rel: string) => path.join(WORKSPACE_DIR, rel);

shell.mount("/home/", {
    async read(targetPath) {
        return readFile(toReal(targetPath));
    },
    async write(targetPath, data) {
        const full = toReal(targetPath);
        await mkdir(full.substring(0, full.lastIndexOf("/")), { recursive: true });
        await writeFile(full, data);
    },
    async list(targetPath) {
        const entries = await readdir(toReal(targetPath), { withFileTypes: true });
        return entries.map((entry) => entry.name);
    },
    async stat(targetPath) {
        const stats = await fsStat(toReal(targetPath));
        return { isFile: stats.isFile(), isDir: stats.isDirectory(), isDevice: false, size: stats.size };
    },
    async remove(targetPath) {
        await rm(toReal(targetPath), { recursive: true, force: true });
    },
});

shell.setEnv("HOME", "/home");
shell.setCwd("/home");

let shellSetUp = false;

const dec = new TextDecoder();
const enc = new TextEncoder();

function formatSearchResults(results: SearchResult[], count: number): string {
    if (!results.length) return "(no results)";
    return results
        .slice(0, count)
        .map((result, i) => `${i + 1}. ${result.title}\n${result.url}\n${result.snippet}`.trim())
        .join("\n\n");
}

async function tavilyExtract(url: string, apiKey: string, timeoutMs = 15000): Promise<string> {
    const res = await fetchWithTimeout("https://api.tavily.com/extract", timeoutMs, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${apiKey}`,
        },
        body: JSON.stringify({ urls: url, extract_depth: "basic", format: "markdown" }),
    });
    if (!res.ok) throw new Error(`tavily extract failed (${res.status})`);
    const data: any = await res.json();
    const result = data.results?.[0];
    if (!result) {
        const failed = data.failed_results?.[0];
        throw new Error(failed?.error ?? "tavily extract returned no results");
    }
    return result.raw_content as string;
}

async function webSearch(query: string, count = 5, config: OpoclawConfig): Promise<string> {
    if (config.search_provider === "tavily") {
        if (!config.tavily_api_key) return "Error: Tavily is selected as search provider but no tavily_api_key is set in config.";
        return formatSearchResults(await new TavilySearch(config.tavily_api_key).search(query, count), count);
    }
    return formatSearchResults(await new DuckDuckGoSearch().search(query, count), count);
}

async function fetchWithTimeout(url: string, timeoutMs = 5000, init?: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), timeoutMs);
    try {
        return await fetch(url, {
            headers: { "User-Agent": "opoclaw-bot/1.0" },
            ...init,
            signal: controller.signal,
        });
    } finally {
        clearTimeout(id);
    }
}

function setNestedValue(obj: Record<string, any>, keyPath: string, value: any): void {
    const parts = keyPath.split(".").map((part) => part.trim()).filter(Boolean);
    if (parts.length === 0) {
        throw new Error("Invalid key path.");
    }
    let cur: Record<string, any> = obj;
    for (let i = 0; i < parts.length - 1; i++) {
        const part = parts[i]!;
        if (typeof cur[part] !== "object" || cur[part] === null || Array.isArray(cur[part])) {
            cur[part] = {};
        }
        cur = cur[part] as Record<string, any>;
    }
    cur[parts[parts.length - 1]!] = value;
}

function coerceConfigValue(raw: string): any {
    const trimmed = raw.trim();
    if (
        (trimmed.startsWith("\"") && trimmed.endsWith("\"")) ||
        (trimmed.startsWith("'") && trimmed.endsWith("'"))
    ) {
        return trimmed.slice(1, -1);
    }
    if (trimmed === "true") return true;
    if (trimmed === "false") return false;
    if (trimmed === "null") return null;
    if (/^-?\d+$/.test(trimmed)) return parseInt(trimmed, 10);
    if (/^-?\d+\.\d+$/.test(trimmed)) return parseFloat(trimmed);
    return raw;
}

async function ensureShellTools(config: OpoclawConfig): Promise<void> {
    if (shellSetUp) return;
    shellSetUp = true;

    if (getSemanticSearchEnabled(config)) {
        shell.addProgram("semantic-search", async (ctx) => {
            const query = ctx.args.slice(1).join(" ").trim();
            if (!query || query === "--help") {
                await ctx.writeStderr(enc.encode("Usage: semantic-search <query>\n"));
                return 1;
            }
            const searchResults = await semanticSearch(query, config);
            const output = searchResults.length > 0
                ? searchResults.join("\n") + "\n"
                : "(no results)\n";
            await ctx.writeStdout(enc.encode(output));
            return 0;
        });
    }

    for (const command of getExposedCommands(config)) {
        shell.addProgram(command, async (ctx) => {
            const args = ctx.args.slice(1);
            return await new Promise<number>((resolve) => {
                exec(`${command} ${args.join(" ")}`, (error, stdout, stderr) => {
                    if (stderr.trim().length > 0) {
                        ctx.writeStderr(enc.encode(stderr.trim() + "\n"));
                    }
                    if (stdout.trim().length > 0) {
                        ctx.writeStdout(enc.encode(stdout.trim() + "\n"));
                    }
                    resolve(error ? 1 : 0);
                });
            });
        });
    }
}

const TOOL_DEFINITIONS = {
    read_file: defineTool(
        "read_file",
        "Read the contents of a file in the workspace. Only files in the workspace directory can be read.",
        {
            path: {
                type: "string",
                description: "Relative path to the file within the workspace (e.g. 'AGENTS.md').",
            },
        },
        ["path"],
        {
            enabled: (config) => config.basic_tools ?? true,
            handler: async (args, { config }) => {
                if (!args.path) throw new Error("Missing 'path' argument for read_file.");
                return await readFileAsync(String(args.path), config.mounts);
            },
        },
    ),
    edit_file: defineTool(
        "edit_file",
        "Overwrite the contents of an existing file in the workspace. You cannot create new files or delete files - only edit files that already exist.",
        {
            path: {
                type: "string",
                description: "Relative path to the file within the workspace.",
            },
            content: {
                type: "string",
                description: "The new complete content to write to the file.",
            },
        },
        ["path", "content"],
        {
            enabled: (config) => config.basic_tools ?? true,
            handler: async (args, { config }) => {
                if (!args.path) throw new Error("Missing 'path' argument for edit_file.");
                if (args.content === undefined) throw new Error("Missing 'content' argument for edit_file.");
                await editFile(String(args.path), String(args.content), config.mounts);
                return `Successfully wrote ${String(args.content).length} characters to "${args.path}".`;
            },
        },
    ),
    list_files: defineTool(
        "list_files",
        "List all files currently in the workspace directory.",
        {},
        [],
        {
            enabled: (config) => config.basic_tools ?? true,
            handler: async (_args, { config }) => {
                const files = await listFiles(config.mounts);
                return files.length > 0 ? files.map((file) => `• ${file}`).join("\n") : "(workspace is empty)";
            },
        },
    ),
    send_file: defineTool(
        "send_file",
        "Send a file from the workspace as a Discord attachment. The file will be sent after the agent's response.",
        {
            path: {
                type: "string",
                description: "Relative path to the file within the workspace.",
            },
            caption: {
                type: "string",
                description: "Optional caption for the file.",
            },
        },
        ["path"],
        {
            handler: async (args, { config, setPendingFileSend }) => {
                if (!args.path) throw new Error("Missing 'path' argument for send_file.");
                getFilePath(String(args.path), config.mounts);
                setPendingFileSend?.({ path: String(args.path), caption: String(args.caption || "") });
                return `File "${args.path}" queued for sending.`;
            },
        },
    ),
    edit_config: defineTool(
        "edit_config",
        "Update a single key in config.toml at the project root. This is restricted and requires user approval.",
        {
            key: {
                type: "string",
                description: "Config key to update. Use dot notation for sections (e.g. 'provider.ollama.base_url').",
            },
            value: {
                type: "string",
                description: "New value for the key.",
            },
        },
        ["key", "value"],
        {
            requiresApproval: true,
            handler: async (args) => {
                if (!args.key) throw new Error("Missing 'key' argument for edit_config.");
                if (args.value === undefined) throw new Error("Missing 'value' argument for edit_config.");
                const configPath = getConfigPath();
                const raw = await readFile(configPath, "utf-8");
                const parsed = parseTOML(raw);
                setNestedValue(parsed, String(args.key), coerceConfigValue(String(args.value)));
                await writeFile(configPath, toTOML(parsed), "utf-8");
                return `Updated config key "${args.key}".`;
            },
        },
    ),
    restart_gateway: defineTool(
        "restart_gateway",
        "Restart the opoclaw gateway. This is restricted and requires user approval.",
        {},
        [],
        {
            requiresApproval: true,
            handler: async () => {
                const proc = Bun.spawn({
                    cmd: ["bash", "-lc", "sleep 1; bun run src/cli.ts gateway restart"],
                    cwd: path.resolve(import.meta.dir, ".."),
                    stdout: "ignore",
                    stderr: "ignore",
                    detached: true,
                });
                if (typeof (proc as any).unref === "function") {
                    (proc as any).unref();
                }
                return "Gateway restart initiated.";
            },
        },
    ),
    hibernate_gateway: defineTool(
        "hibernate_gateway",
        "Hibernate the opoclaw gateway (stop responses until approved to wake). This is restricted and requires user approval.",
        {},
        [],
        {
            requiresApproval: true,
            handler: async () => {
                const hibernatePath = path.resolve(import.meta.dir, "..", ".gateway.hibernate");
                await writeFile(hibernatePath, new Date().toISOString(), "utf-8");
                return "Gateway hibernation enabled.";
            },
        },
    ),
    update_opoclaw: defineTool(
        "update_opoclaw",
        "Update opoclaw to the latest version. This is restricted and requires user approval.",
        {},
        [],
        {
            requiresApproval: true,
            handler: async () => {
                const proc = Bun.spawn({
                    cmd: ["bash", "-lc", "sleep 1; bun run src/cli.ts update"],
                    cwd: path.resolve(import.meta.dir, ".."),
                    stdout: "ignore",
                    stderr: "ignore",
                    detached: true,
                });
                if (typeof (proc as any).unref === "function") {
                    (proc as any).unref();
                }
                return "Update initiated.";
            },
        },
    ),
    search: defineTool(
        "search",
        "Search the web and return top results.",
        {
            query: {
                type: "string",
                description: "Search query.",
            },
            count: {
                type: "number",
                description: "Max results to return (1-10). Defaults to 5.",
            },
        },
        ["query"],
        {
            handler: async (args, { config }) => {
                if (!args.query) throw new Error("Missing 'query' argument for search.");
                const countRaw = Number(args.count ?? 5);
                const count = Number.isFinite(countRaw) ? Math.min(Math.max(1, countRaw), 10) : 5;
                return await webSearch(String(args.query), count, config);
            },
        },
    ),
    use_skill: defineTool(
        "use_skill",
        "Load a skill by name from workspace/skills/<skill>/SKILL.md. Use this before applying a skill's instructions.",
        {
            name: {
                type: "string",
                description: "Skill folder name under workspace/skills.",
            },
        },
        ["name"],
        {
            handler: async (args) => {
                if (!args.name) throw new Error("Missing 'name' argument for use_skill.");
                return await readSkill(String(args.name));
            },
        },
    ),
    list_skills: defineTool(
        "list_skills",
        "List available skills from workspace/skills.",
        {},
        [],
        {
            handler: async () => {
                const skills = await listSkills();
                return skills.length > 0 ? skills.join("\n") : "(no skills)";
            },
        },
    ),
    deep_research: defineTool(
        "deep_research",
        "Enable Deep Research mode to perform multi-step research and return synthesized markdown documents.",
        {
            query: {
                type: "string",
                description: "Research query or question.",
            },
        },
        ["query"],
    ),
    compact: defineTool(
        "compact",
        "Compress prior conversation context into a few paragraphs via a subagent and replace older context with that summary.",
        {
            preserve_recent_messages: {
                type: "number",
                description: "How many recent messages to preserve verbatim after compaction. Defaults to 6.",
            },
        },
        [],
    ),
    run_subagent: defineTool(
        "run_subagent",
        "Run a subagent instance with a request and return its final response.",
        {
            request: {
                type: "string",
                description: "Task/request for the subagent.",
            },
            include_context: {
                type: "boolean",
                description: "Whether to include recent parent context when running the subagent. Defaults to true.",
            },
        },
        ["request"],
    ),
    run_background_subagent: defineTool(
        "run_background_subagent",
        "Run a subagent in the background and continue immediately. Result is injected later as a follow-up request to the agent.",
        {
            request: {
                type: "string",
                description: "Task/request for the background subagent.",
            },
            include_context: {
                type: "boolean",
                description: "Whether to include recent parent context when running the subagent. Defaults to true.",
            },
            label: {
                type: "string",
                description: "Optional label to identify the background subagent run.",
            },
        },
        ["request"],
    ),
    timer: defineTool(
        "timer",
        "Set a timer for a given duration in seconds. When the timer expires, a message will be sent to you with the current time.",
        {
            seconds: {
                type: "number",
                description: "Duration in seconds.",
            },
            label: {
                type: "string",
                description: "Optional label for the timer.",
            },
        },
        ["seconds"],
    ),
    web_fetch: defineTool(
        "web_fetch",
        "Fetch a web page and return its text content.",
        {
            url: {
                type: "string",
                description: "The URL to fetch.",
            },
        },
        ["url"],
        {
            enabled: (config) => config.enable_web_fetch ?? true,
            handler: async (args, { config }) => {
                if (!args.url) throw new Error("Missing 'url' argument for web_fetch.");
                const url = String(args.url);
                if (config.search_provider === "tavily") {
                    if (!config.tavily_api_key) return "Error: Tavily is selected as search provider but no tavily_api_key is set in config.";
                    return await tavilyExtract(url, config.tavily_api_key);
                }
                const res = await fetch(url, { headers: { "User-Agent": "opoclaw-bot/1.0" } });
                if (!res.ok) throw new Error(`web_fetch failed (${res.status})`);
                return await res.text();
            },
        },
    ),
    react_message: defineTool(
        "react_message",
        "React to a Discord message by ID in a given channel.",
        {
            channel_id: {
                type: "string",
                description: "Discord channel ID containing the message.",
            },
            message_id: {
                type: "string",
                description: "Discord message ID to react to.",
            },
            emoji: {
                type: "string",
                description: "Emoji to react with (unicode or custom emoji like name:id).",
            },
        },
        ["channel_id", "message_id", "emoji"],
        {
            handler: async (args, { config }) => {
                const channelId = String(args.channel_id || "");
                const messageId = String(args.message_id || "");
                const emoji = String(args.emoji || "");
                if (!channelId || !messageId || !emoji) {
                    throw new Error("Missing 'channel_id', 'message_id', or 'emoji' argument for react_message.");
                }
                const token = config.channel?.discord?.token;
                if (!token) throw new Error("Discord token missing in config.");
                const url = `https://discord.com/api/v10/channels/${channelId}/messages/${messageId}/reactions/${encodeURIComponent(emoji)}/@me`;
                const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
                let lastErr = "";
                for (let attempt = 1; attempt <= 3; attempt++) {
                    const res = await fetch(url, { method: "PUT", headers: { Authorization: `Bot ${token}` } });
                    if (res.ok) return "Reaction added.";

                    if (res.status === 429) {
                        let retryAfterMs = 1000;
                        try {
                            const body: any = await res.json();
                            if (typeof body?.retry_after === "number") {
                                retryAfterMs = Math.max(0, Math.ceil(body.retry_after * 1000));
                            }
                        } catch {
                        }
                        await delay(retryAfterMs);
                        continue;
                    }

                    const body = await res.text().catch(() => "");
                    lastErr = `react_message failed (${res.status}): ${body.slice(0, 200)}`;
                    break;
                }
                throw new Error(lastErr || "react_message failed after retries.");
            },
        },
    ),
    request_permission: defineTool(
        "request_permission",
        "Request authorization from the configured authorized_user_id with a custom message. Discord-only.",
        {
            message: {
                type: "string",
                description: "Message describing what approval is needed.",
            },
            title: {
                type: "string",
                description: "Optional title for the approval prompt.",
            },
        },
        ["message"],
        {
            handler: discordOnlyHandler("request_permission"),
        },
    ),
    question: defineTool(
        "question",
        "Ask a multiple-choice question in Discord and return the selected option.",
        {
            question: {
                type: "string",
                description: "The question to ask.",
            },
            options: {
                type: "array",
                items: { type: "string" },
                description: "Answer options (2-10).",
            },
            title: {
                type: "string",
                description: "Optional title for the embed.",
            },
        },
        ["question", "options"],
        {
            handler: discordOnlyHandler("question"),
        },
    ),
    poll: defineTool(
        "poll",
        "Create a live poll in Discord with dynamic results.",
        {
            question: {
                type: "string",
                description: "The poll question.",
            },
            options: {
                type: "array",
                items: { type: "string" },
                description: "Poll options (2-10).",
            },
            title: {
                type: "string",
                description: "Optional title for the poll embed.",
            },
        },
        ["question", "options"],
        {
            handler: discordOnlyHandler("poll"),
        },
    ),
    shell: defineTool(
        "shell",
        "Run a shell command. This is in a sandboxed environment with a bash-like shell. `~` is your workspace, and is the default working directory. You've got all the commands you'd expect, like `grep`, `cat`, `sed`, and so on. However, you don't have access to Python or other runtimes. Treat this as a way to interact with the workspace and files. You can use `grep -ri 'some text'` to search for text recursively from the working directory.",
        {
            description: {
                type: "string",
                description: "User-facing description of what you're doing. Like: \"Searching through memory files\", \"Writing to MEMORY.md\", and so on. Don't add an elipsis at the end. Keep this concise.",
            },
            shell_command: {
                type: "string",
                description: "The shell command to run.",
            },
        },
        ["description", "shell_command"],
        {
            handler: async (args, { config }) => {
                if (!args.shell_command) throw new Error("Missing 'shell_command' argument for shell.");
                await ensureShellTools(config);
                const result = await shell.exec(String(args.shell_command));
                let output = "";

                if (result.stdout) output += `stdout:\n\`\`\`${dec.decode(result.stdout).trim()}\`\`\`\n`;
                if (result.stderr) output += `stderr:\n\`\`\`${dec.decode(result.stderr).trim()}\`\`\`\n`;
                if (output.length === 0) output = "(no shell output)";
                if (result.code !== 0) output = `Command exited with code ${result.code}.\n${output}`;

                const home = shell.getEnv("HOME") ?? "/home";
                const cwd = shell.getCwd();
                const display = cwd === home ? "~" : cwd.startsWith(home + "/") ? "~" + cwd.slice(home.length) : cwd;
                return `${output.trim()}\n(Current directory: ${display})`;
            },
        },
    ),
} satisfies Record<string, ToolDefinition>;

export type ToolName = keyof typeof TOOL_DEFINITIONS;

export const TOOLS = Object.fromEntries(
    Object.entries(TOOL_DEFINITIONS).map(([name, definition]) => [name, definition.tool]),
) as Record<ToolName, ToolSchema>;

export const APPROVAL_TOOL_NAMES = new Set<ToolName>(
    (Object.entries(TOOL_DEFINITIONS) as [ToolName, ToolDefinition][])
        .filter(([, definition]) => definition.requiresApproval)
        .map(([name]) => name),
);

export function requiresToolApproval(name: string): boolean {
    return APPROVAL_TOOL_NAMES.has(name as ToolName);
}

export function getTools(config: OpoclawConfig): ToolSchema[] {
    return (Object.entries(TOOL_DEFINITIONS) as [ToolName, ToolDefinition][])
        .filter(([, definition]) => definition.enabled?.(config) ?? true)
        .map(([, definition]) => definition.tool);
}

export function getToolDefinition(name: string): ToolDefinition | undefined {
    return TOOL_DEFINITIONS[name as ToolName];
}

export async function handleToolCall(
    name: string,
    args: ToolArgs,
    config: OpoclawConfig,
    setPendingFileSend?: (value: PendingFileSend) => void,
): Promise<string> {
    console.log(`Handling tool call: ${name} with args ${JSON.stringify(args)}`);
    const definition = getToolDefinition(name);
    if (!definition) {
        throw new Error(`Unknown tool: ${name}`);
    }
    if (!definition.handler) {
        throw new Error(`Tool "${name}" is not handled locally.`);
    }
    return await definition.handler(args, { config, setPendingFileSend });
}
