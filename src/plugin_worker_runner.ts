import type { HostInitMessage, OpenAIFunctionTool, PluginHostMessage, PluginInvokeContext, PluginModule } from "./plugin_api.ts";
import { isOpenAIFunctionTool } from "./plugin_api.ts";
import { resolve, sep } from "path";
import { mkdir, readdir, readFile, rm, stat, writeFile } from "fs/promises";

function getExportedTools(mod: PluginModule): OpenAIFunctionTool[] {
    if (!Array.isArray(mod.tools)) return [];
    return mod.tools.filter(isOpenAIFunctionTool);
}

let pluginModule: PluginModule | null = null;
let pluginContext: PluginInvokeContext = {
    config: {},
    root: "",
    workspaceRoot: "",
    manifest: { name: "" },
    fs: {
        plugin: {
            readText: async () => "",
            readJson: async <T = unknown>() => ({} as T),
            writeText: async () => {},
            writeJson: async () => {},
            exists: async () => false,
            list: async () => [],
            mkdir: async () => {},
            remove: async () => {},
        },
        workspace: {
            readText: async () => "",
            readJson: async <T = unknown>() => ({} as T),
            writeText: async () => {},
            writeJson: async () => {},
            exists: async () => false,
            list: async () => [],
            mkdir: async () => {},
            remove: async () => {},
        },
    },
};

function resolveInside(baseDir: string, relativePath: string): string {
    const base = resolve(baseDir);
    const candidate = resolve(base, relativePath || ".");
    if (candidate !== base && !candidate.startsWith(base + sep)) {
        throw new Error("Path escapes allowed root");
    }
    return candidate;
}

function createScopedFs(baseDir: string) {
    return {
        readText: async (relativePath: string): Promise<string> => {
            const full = resolveInside(baseDir, relativePath);
            return await readFile(full, "utf-8");
        },
        readJson: async <T = unknown>(relativePath: string): Promise<T> => {
            const text = await readFile(resolveInside(baseDir, relativePath), "utf-8");
            return JSON.parse(text) as T;
        },
        writeText: async (relativePath: string, content: string): Promise<void> => {
            const full = resolveInside(baseDir, relativePath);
            await mkdir(resolve(full, ".."), { recursive: true });
            await writeFile(full, content, "utf-8");
        },
        writeJson: async (relativePath: string, value: unknown): Promise<void> => {
            const full = resolveInside(baseDir, relativePath);
            await mkdir(resolve(full, ".."), { recursive: true });
            await writeFile(full, JSON.stringify(value, null, 2), "utf-8");
        },
        exists: async (relativePath: string): Promise<boolean> => {
            try {
                await stat(resolveInside(baseDir, relativePath));
                return true;
            } catch {
                return false;
            }
        },
        list: async (relativePath = "."): Promise<string[]> => {
            return await readdir(resolveInside(baseDir, relativePath));
        },
        mkdir: async (relativePath: string): Promise<void> => {
            await mkdir(resolveInside(baseDir, relativePath), { recursive: true });
        },
        remove: async (relativePath: string, recursive = false): Promise<void> => {
            await rm(resolveInside(baseDir, relativePath), { recursive, force: true });
        },
    };
}

async function initializePlugin(msg: HostInitMessage): Promise<void> {
    if (!msg.entry || typeof msg.entry !== "string") {
        throw new Error("Plugin worker init requires entry");
    }

    const mod = await import(msg.entry) as PluginModule;
    if (typeof mod.invoke !== "function") {
        throw new Error("Plugin must export invoke(toolName, args, context)");
    }

    pluginModule = mod;
    pluginContext = {
        config: msg.config ?? {},
        root: msg.root ?? "",
        workspaceRoot: msg.workspaceRoot ?? resolve(msg.root ?? "", ".."),
        manifest: msg.manifest ?? { name: "" },
        fs: {
            plugin: createScopedFs(msg.root ?? ""),
            workspace: createScopedFs(msg.workspaceRoot ?? resolve(msg.root ?? "", "..")),
        },
    };

    (globalThis as any).postMessage({
        type: "ready",
        tools: getExportedTools(mod),
    });
}

(globalThis as any).onmessage = async (ev: MessageEvent<PluginHostMessage>) => {
    const msg = ev.data;
    if (!msg || typeof msg !== "object") return;

    if (msg.type === "init") {
        try {
            await initializePlugin(msg);
        } catch (err: any) {
            (globalThis as any).postMessage({ type: "fatal", message: err?.message || String(err) });
        }
        return;
    }

    if (msg.type === "invoke") {
        if (!pluginModule || typeof pluginModule.invoke !== "function") {
            (globalThis as any).postMessage({ type: "invokeResult", callId: msg.callId, error: "Plugin is not initialized" });
            return;
        }

        try {
            const result = await pluginModule.invoke(msg.toolName, msg.args ?? {}, pluginContext);
            (globalThis as any).postMessage({ type: "invokeResult", callId: msg.callId, result });
        } catch (err: any) {
            (globalThis as any).postMessage({ type: "invokeResult", callId: msg.callId, error: err?.message || String(err) });
        }
        return;
    }

    if (msg.type === "shutdown") {
        if (!pluginModule || typeof pluginModule.deactivate !== "function") {
            (globalThis as any).postMessage({ type: "shutdownAck" });
            return;
        }
        try {
            await pluginModule.deactivate();
        } catch (err: any) {
            (globalThis as any).postMessage({ type: "error", message: err?.message || String(err) });
        } finally {
            (globalThis as any).postMessage({ type: "shutdownAck" });
        }
    }
};
