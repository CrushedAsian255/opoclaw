import { resolve } from "path";
import { existsSync, unlinkSync, writeFileSync } from "fs";
import { startDiscord } from "./discord.ts";
import { startIRC } from "./irc.ts";
import { startOpenAI } from "./openai.ts";
import { AgentSession, summarizeToolBatch, type ToolCall } from "../agent.ts";
import { loadConfig, useTomlFiles, getSemanticSearchEnabled, type OpoclawConfig } from "../config.ts";
import { listSkills } from "../skills.ts";
import { readFileAsync } from "../workspace.ts";
import { requiresToolApproval } from "../tools.ts";

const OP_DIR = resolve(import.meta.dir, "../..");
const LOCK_FILE = resolve(OP_DIR, ".gateway.lock");
const HIBERNATE_FILE = resolve(OP_DIR, ".gateway.hibernate");
const SYSTEM_PROMPT_FILE = resolve(import.meta.dir, "../SYSTEM.md");
const CORE_HOST = "127.0.0.1";
const CORE_PORT = 6112;
const coreChatSessions = new Map<string, AgentSession>();

function clearGatewayPid(): void {
    try {
        unlinkSync(LOCK_FILE);
    } catch {
    }
}

function setGatewayPid(pid: number): void {
    try {
        writeFileSync(LOCK_FILE, String(pid));
    } catch {
    }
}

async function isHibernating(): Promise<boolean> {
    return existsSync(HIBERNATE_FILE);
}

async function setHibernating(value: boolean): Promise<void> {
    if (value) {
        writeFileSync(HIBERNATE_FILE, new Date().toISOString());
        return;
    }
    try {
        unlinkSync(HIBERNATE_FILE);
    } catch {
    }
}

async function loadSystemPromptBase(): Promise<string> {
    try {
        return await Bun.file(SYSTEM_PROMPT_FILE).text();
    } catch {
        return "";
    }
}

function renderSystemPrompt(template: string): string {
    const now = new Date();
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
    const date = now.toLocaleDateString("en-US", {
        timeZone: tz,
        year: "numeric",
        month: "long",
        day: "2-digit",
    });
    const time = now.toLocaleTimeString("en-US", {
        timeZone: tz,
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
    });
    return template
        .replaceAll("{{DATE}}", date)
        .replaceAll("{{TIME}}", time)
        .replaceAll("{{TIMEZONE}}", tz);
}

async function buildCoreSystemPrompt(config: OpoclawConfig): Promise<string> {
    const useToml = useTomlFiles(config);
    const [systemBase, agentsContent, soulContent, identityContent, memoryContent, skills] = await Promise.all([
        loadSystemPromptBase(),
        readFileAsync(useToml ? "agents.toml" : "AGENTS.md").catch(() => ""),
        readFileAsync(useToml ? "soul.toml" : "SOUL.md").catch(() => ""),
        readFileAsync(useToml ? "identity.toml" : "IDENTITY.md").catch(() => ""),
        readFileAsync(useToml ? "memory.toml" : "MEMORY.md").catch(() => ""),
        listSkills(),
    ]);

    const systemPromptParts: string[] = [];
    if (systemBase) systemPromptParts.push(renderSystemPrompt(systemBase));
    if (soulContent) systemPromptParts.push(soulContent);
    if (identityContent) {
        systemPromptParts.push(
            "\n## Your Identity\nThis is your " + (useToml ? "identity.toml" : "IDENTITY.md") + ".\n```\n" + identityContent + "\n```",
        );
    }
    if (agentsContent) systemPromptParts.push("\n## Operating Instructions\n" + agentsContent);
    if (memoryContent) {
        systemPromptParts.push(
            "\n## Memory\nThis is your " + (useToml ? "memory.toml" : "MEMORY.md") + ". You can edit that file, but be careful not to accidentally erase information in it.\n```\n" + memoryContent + "\n```",
        );
    }
    if (getSemanticSearchEnabled(config)) {
        systemPromptParts.push(
            "\n## Semantic Search\nYou have access to a semantic search command in your shell. Use `semantic-search <query>` and it'll return lines in any file that match embeddings. You don't need to worry about gaming this, remember it's semantic and not keyword based, so even just a description of what you're looking for can work. The command caches efficiently as well.\nThis is the recommended way to search through your memory. You can do multiple searches at once using normal shell syntax like semicolons: `semantic-search <query1>; semantic-search <query2>`",
        );
    }
    if (skills.length > 0) {
        systemPromptParts.push(
            `\n## Skills\nAvailable skills: ${skills.map((s) => `\`${s}\``).join(", ")}\nTo use a skill, call the use_skill tool with the skill name. It will return the skill's SKILL.md instructions before you apply them.`,
        );
    }
    if (useToml) {
        systemPromptParts.push(
            "\n## TOML Editing\nIn your shell, you have a convenient CLI for easy editing. You can use `toml <file> <key> push <value>` to push a value to a key, or `toml <file> <key> remove <value>` to remove a value. If the key or file doesn't exist, it will be created for you.\nThis is the primary way you should be managing memory. You can for example use `toml memory.toml notes push \"<something you want to remember>\"` to add a note to your memory, which will persist across sessions.",
        );
    }

    return systemPromptParts.join("\n") || "You are a helpful assistant.";
}

export type CoreChatCallbacks = {
    approveTool?: (call: ToolCall, args: Record<string, any>) => Promise<boolean>;
    requestPermission?: (message: string, title?: string) => Promise<boolean>;
    askQuestion?: (question: string, options: string[], title?: string) => Promise<{ selected: string; userLabel?: string } | null>;
    onToolLine?: (line: string) => void;
};

export async function runCoreChatTurn(
    sessionKey: string,
    userText: string,
    callbacks: CoreChatCallbacks = {},
): Promise<{ text: string; reasoningSummary?: string }> {
    const config = loadConfig();
    const toolCallSummaries = config.tool_call_summaries ?? "full";
    const useSessionIds = config.provider?.openrouter?.use_session_ids !== false;
    let session = coreChatSessions.get(sessionKey);
    if (!session) {
        const sid = useSessionIds ? `opoclaw-core-${sessionKey}-${Date.now()}` : undefined;
        session = new AgentSession(sid);
        coreChatSessions.set(sessionKey, session);
    }

    if (await isHibernating()) {
        const approved = callbacks.requestPermission
            ? await callbacks.requestPermission("The gateway is hibernating. Wake it and continue?", "Wake Gateway?")
            : false;
        if (!approved) {
            return { text: "Gateway is hibernating. Approve wake-up to continue." };
        }
        await setHibernating(false);
    }

    session.addMessage({ role: "user", content: userText });
    const systemPrompt = await buildCoreSystemPrompt(config);

    const onToolCall = (call: ToolCall) => {
        if (toolCallSummaries === "off") return;
        if (call.function.name === "deep_research") {
            callbacks.onToolLine?.("Using Deep Research...");
            return;
        }
        if (call.function.name === "request_permission" || call.function.name === "question" || call.function.name === "poll") {
            return;
        }
        if (requiresToolApproval(call.function.name)) {
            return;
        }
        if (toolCallSummaries === "minimal") return;
        callbacks.onToolLine?.(`Tool: ${call.function.name}`);
    };

    const onToolCallError = (_id: string, error: Error) => {
        if (toolCallSummaries === "off") return;
        callbacks.onToolLine?.(`Tool error: ${error.message}`);
    };

    const onToolBatch = async (calls: ToolCall[], results: any[], sessionId?: string) => {
        if (toolCallSummaries !== "minimal") return;
        const summary = await summarizeToolBatch(calls, results, config, sessionId);
        const trimmed = summary.trim();
        if (trimmed && trimmed !== "(no summary)") callbacks.onToolLine?.(trimmed);
    };

    const requestToolApproval = async (call: ToolCall, _uniqueId: string) => {
        if (!requiresToolApproval(call.function.name)) return { approved: true };
        let args: Record<string, any> = {};
        try {
            args = JSON.parse(call.function.arguments || "{}");
        } catch {
        }
        const approved = callbacks.approveTool ? await callbacks.approveTool(call, args) : false;
        return approved ? { approved: true } : { approved: false, message: "Not authorized to perform this action." };
    };

    const executeTool = async (call: ToolCall, args: Record<string, any>): Promise<string | undefined> => {
        if (call.function.name === "request_permission") {
            const approved = callbacks.requestPermission
                ? await callbacks.requestPermission(String(args.message || ""), typeof args.title === "string" ? args.title : undefined)
                : false;
            return approved ? "Approved." : "Denied.";
        }
        if (call.function.name === "question") {
            const question = String(args.question || "");
            const options = Array.isArray(args.options) ? args.options.map(String) : [];
            if (options.length < 2 || options.length > 10) {
                return "Error: question requires between 2 and 10 options.";
            }
            const selected = callbacks.askQuestion
                ? await callbacks.askQuestion(question, options, typeof args.title === "string" ? args.title : undefined)
                : null;
            if (!selected) return "No selection (timed out or denied).";
            return `Selected: ${selected.selected}\nUser: ${selected.userLabel || "local-user"}`;
        }
        if (call.function.name === "poll") {
            const question = String(args.question || "");
            const options = Array.isArray(args.options) ? args.options.map(String) : [];
            if (options.length < 2 || options.length > 10) {
                return "Error: poll requires between 2 and 10 options.";
            }
            const selected = callbacks.askQuestion
                ? await callbacks.askQuestion(question, options, typeof args.title === "string" ? args.title : "Poll")
                : null;
            if (!selected) return "Poll closed without selection.";
            return `Poll result (single-user TUI): ${selected.selected}`;
        }
        return undefined;
    };

    const result = await session.evaluate(systemPrompt, config, {
        onFirstToken: () => {},
        onToolCall,
        onToolCallError,
        requestToolApproval,
        onToolBatch,
        onDeepResearchSummary: async (summary: string) => {
            const trimmed = summary.trim();
            if (trimmed) callbacks.onToolLine?.(trimmed);
        },
        executeTool,
    });

    return { text: result.text, reasoningSummary: result.reasoningSummary };
}

function json(data: unknown, status = 200): Response {
    return new Response(JSON.stringify(data), {
        status,
        headers: { "content-type": "application/json" },
    });
}

export async function handleCoreRequest(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (req.method === "GET" && url.pathname === "/health") {
        const config = loadConfig();
        return json({
            ok: true,
            pid: process.pid,
            hibernating: await isHibernating(),
            channels: {
                discord: !!config.channel?.discord?.enabled,
                irc: !!config.channel?.irc?.enabled,
                openai: !!config.channel?.openai?.enabled,
            },
        });
    }

    if (req.method === "POST" && url.pathname === "/control/hibernate") {
        await setHibernating(true);
        return json({ ok: true, hibernating: true });
    }

    if (req.method === "POST" && url.pathname === "/control/stop") {
        const response = json({ ok: true, stopping: true });
        setTimeout(() => {
            clearGatewayPid();
            process.exit(0);
        }, 50);
        return response;
    }

    if (req.method === "POST" && url.pathname === "/chat") {
        let body: any = {};
        try {
            body = await req.json();
        } catch {
            return json({ error: "Invalid JSON body." }, 400);
        }
        const sessionKey = String(body.session_id || "default");
        const message = String(body.message || "").trim();
        if (!message) {
            return json({ error: "Missing message." }, 400);
        }
        const out = await runCoreChatTurn(sessionKey, message, {});
        return json({ ok: true, ...out });
    }

    return json({ error: "Not found" }, 404);
}

export async function startCore() {
    setGatewayPid(process.pid);

    const cleanup = () => clearGatewayPid();
    process.on("exit", cleanup);
    process.on("SIGTERM", () => {
        cleanup();
        process.exit(0);
    });
    process.on("SIGINT", () => {
        cleanup();
        process.exit(0);
    });

    const server = Bun.serve({
        hostname: CORE_HOST,
        port: CORE_PORT,
        fetch: handleCoreRequest,
    });

    console.log(`[core] Control server listening on http://${CORE_HOST}:${server.port}`);

    try {
        await startDiscord();
    } catch (err: any) {
        console.error(`Discord channel failed to start: ${err.message}`);
        throw err;
    }

    try {
        await startIRC();
    } catch (err: any) {
        console.error(`IRC channel failed to start: ${err.message}`);
    }

    try {
        await startOpenAI();
    } catch (err: any) {
        console.error(`OpenAI channel failed to start: ${err.message}`);
        throw err;
    }

    return server;
}
