import { describe, expect, test, afterEach } from "bun:test";
import { loadPlugins, listLoadedPlugins, unloadPlugin } from "../src/plugins.ts";
import { handleToolCall, TOOLS, unregisterTool } from "../src/tools.ts";
import path from "path";
import { writeFile, mkdir, rm } from "fs/promises";
import { existsSync } from "fs";

const testPluginBase = path.resolve(process.cwd(), "workspace", "plugins");

async function cleanupPlugin(name: string) {
  await unloadPlugin(name).catch(() => {});
  const pluginDir = path.join(testPluginBase, name);
  if (existsSync(pluginDir)) {
    await rm(pluginDir, { recursive: true, force: true });
  }
}

async function createPlugin(name: string, tools: string[], handlerCode: string) {
  const pluginDir = path.join(testPluginBase, name);
  if (!existsSync(pluginDir)) await mkdir(pluginDir, { recursive: true });

  const manifest = {
    name,
    version: "0.0.1",
    entry: "plugin.ts",
    permissions: { fileSystem: ["workspace"], tools }
  };

  await writeFile(path.join(pluginDir, "plugin.json"), JSON.stringify(manifest, null, 2));

  const pluginTs = `export async function activate(context) {
  ${handlerCode}
}
export async function deactivate() {}`;
  await writeFile(path.join(pluginDir, "plugin.ts"), pluginTs);

  return pluginDir;
}

describe("plugins", () => {
  afterEach(async () => {
    await cleanupPlugin("test-echo-plugin");
    await cleanupPlugin("test-tool-check-plugin");
    await cleanupPlugin("test-config-access-plugin");
    await cleanupPlugin("test-unload-plugin");
  });

  test("loads a plugin and executes its registered tool", async () => {
    await createPlugin("test-echo-plugin", ["test_echo"], `
  context.registerTool({ 
    function: { 
      name: 'test_echo', 
      description: 'Echo test input with prefix.',
      parameters: { 
        type: 'object', 
        properties: { 
          text: { 
            type: 'string', 
            description: 'Text to echo back.' 
          } 
        }, 
        required: ['text'] 
      } 
    } }, async (args) => {
    return 'echo:' + String(args.text || '');
  });`);

    const cfg = { enable_plugins: true, plugin_dir: testPluginBase, mounts: {} } as any;
    await loadPlugins(cfg);
    const loaded = listLoadedPlugins();
    expect(loaded.includes("test-echo-plugin")).toBe(true);

    const out = await handleToolCall("test_echo", { text: "hello" }, cfg);
    expect(out).toBe("echo:hello");
  });

  test("tool is present in TOOLS after registration", async () => {
    await createPlugin("test-tool-check-plugin", ["test_tool_check"], `
  context.registerTool({ 
    function: { 
      name: 'test_tool_check', 
      description: 'Check tool registration.',
      parameters: { type: 'object', properties: {}, required: [] } 
    } 
  }, async () => 'ok');`);

    const cfg = { enable_plugins: true, plugin_dir: testPluginBase, mounts: {} } as any;
    await loadPlugins(cfg);

    expect(TOOLS.test_tool_check).toBeDefined();
    expect(TOOLS.test_tool_check.function.name).toBe("test_tool_check");
    expect(TOOLS.test_tool_check.function.description).toBe("Check tool registration.");
  });

  test("plugin can access config in handler", async () => {
    await createPlugin("test-config-access-plugin", ["test_config_access"], `
  context.registerTool({ 
    function: { 
      name: 'test_config_access', 
      description: 'Return config value.',
      parameters: { type: 'object', properties: {}, required: [] } 
    } 
  }, async (args, config) => {
    return config.customKey || 'none';
  });`);

    const cfg = { enable_plugins: true, plugin_dir: testPluginBase, mounts: {}, customKey: "test-value" } as any;
    await loadPlugins(cfg);

    const out = await handleToolCall("test_config_access", {}, cfg);
    expect(out).toBe("test-value");
  });

  test("plugin tool unregistered after unload", async () => {
    await createPlugin("test-unload-plugin", ["test_unload"], `
  context.registerTool({ 
    function: { name: 'test_unload', description: 'Test unload', parameters: { type: 'object', properties: {}, required: [] } } 
  }, async () => 'ok');`);

    const cfg = { enable_plugins: true, plugin_dir: testPluginBase, mounts: {} } as any;
    await loadPlugins(cfg);

    expect(TOOLS.test_unload).toBeDefined();

    await unloadPlugin("test-unload-plugin");

    expect(TOOLS.test_unload).toBeUndefined();
  });
});