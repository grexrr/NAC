import Anthropic from "@anthropic-ai/sdk";

export type AgentMessage = Anthropic.MessageParam;

export interface CallClaudeOptions {
    client: Anthropic;
    model: string;
    systemPrompt?: string,
    tools?: Anthropic.Tool[];
    maxTokens?: number;
}

export async function callClaude(
    messages: AgentMessage[],
    options: CallClaudeOptions
): Promise<Anthropic.Message> {
    const { client, model, systemPrompt, tools, maxTokens=1024 } = options;

    return client.messages.create({
        model,
        max_tokens: maxTokens,
        system: systemPrompt,
        tools,
        messages
    });
}