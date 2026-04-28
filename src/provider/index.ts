import { getActiveProvider, type OpoclawConfig } from "../config.ts";
import { generateCompletion as openaiGenerate } from "./openai.ts";
import { generateCompletion as anthropicGenerate } from "./anthropic.ts";
import type { Message, CompletionResult, ProviderFn } from "./types.ts";
import { type ToolSchema } from "../tools";

export type { Message, ToolCall, CompletionResult, ProviderFn } from "./types.ts";

function defaultGenerateCompletion(
    messages: Message[],
    config: OpoclawConfig,
    onFirstToken: () => void,
    tools: ToolSchema[],
    sessionId: string,
): Promise<CompletionResult> {
    
    if (getActiveProvider(config) === "custom" && config.provider?.custom?.api_type === "anthropic") {
        return anthropicGenerate(messages, config, onFirstToken, tools);
    }
    return openaiGenerate(messages, config, onFirstToken, tools, sessionId);
}

export const provider: { generateCompletion: ProviderFn } = {
    generateCompletion: defaultGenerateCompletion,
};
