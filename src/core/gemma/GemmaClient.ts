import { GoogleGenAI, FunctionDeclaration, Type, Content } from "@google/genai";
import type { ConversationTurn } from "../../types/domain";

export interface ToolCall {
  name: string;
  args: Record<string, unknown>;
}

export interface GemmaResponse {
  text: string | null;
  toolCalls: ToolCall[];
  rawContent: Content | null; // needed to continue the conversation after tool execution
  latencyMs?: number;
}

export interface ToolResult {
  name: string;
  response: Record<string, unknown>;
}

export class GemmaClient {
  private client: GoogleGenAI;
  private model: string;

  constructor(apiKey: string, model: string) {
    if (!apiKey) {
      throw new Error("GEMMA_API_KEY is missing. Set it in .env.");
    }
    this.client = new GoogleGenAI({ apiKey });
    this.model = model;
  }

  async converse(
    systemPrompt: string,
    history: ConversationTurn[],
    userMessage: string,
    tools: FunctionDeclaration[]
  ): Promise<GemmaResponse> {
    const contents: Content[] = [
      ...history.map((turn) => ({
        role: turn.role === "user" ? ("user" as const) : ("model" as const),
        parts: [{ text: turn.content }],
      })),
      { role: "user" as const, parts: [{ text: userMessage }] },
    ];

    return this.callModel(systemPrompt, contents, tools);
  }

  /**
   * Continues a conversation after tool execution, feeding the REAL tool
   * output back to the model so its final answer is grounded in what
   * actually happened (not guessed). This is what fixes both the
   * chain-of-thought leak (model gets a clean second turn to answer from)
   * and hallucinated IDs (model sees real data, doesn't have to invent it).
   */
  async continueWithToolResults(
    systemPrompt: string,
    history: ConversationTurn[],
    userMessage: string,
    modelContent: Content,
    toolResults: ToolResult[],
    tools: FunctionDeclaration[]
  ): Promise<GemmaResponse> {
    const contents: Content[] = [
      ...history.map((turn) => ({
        role: turn.role === "user" ? ("user" as const) : ("model" as const),
        parts: [{ text: turn.content }],
      })),
      { role: "user" as const, parts: [{ text: userMessage }] },
      modelContent, // the model's own prior turn, including its functionCall parts
      {
        role: "user" as const,
        parts: toolResults.map((r) => ({
          functionResponse: { name: r.name, response: r.response },
        })),
      },
    ];

    return this.callModel(systemPrompt, contents, tools);
  }

  private async callModel(
    systemPrompt: string,
    contents: Content[],
    tools: FunctionDeclaration[]
  ): Promise<GemmaResponse> {
    const maxRetries = 3;
    let lastError: unknown;
    const startTime = Date.now();

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const result = await this.client.models.generateContent({
          model: this.model,
          contents,
          config: {
            systemInstruction: systemPrompt,
            tools: tools.length > 0 ? [{ functionDeclarations: tools }] : undefined,
            temperature: 0.6,
          },
        });

        const latencyMs = Date.now() - startTime;
        const candidate = result.candidates?.[0];
        const parts = candidate?.content?.parts ?? [];
        const textParts = parts
          .filter((p): p is { text: string } => typeof p.text === "string")
          .map((p) => p.text);
        const toolCalls: ToolCall[] = parts
          .filter((p) => p.functionCall)
          .map((p) => ({
            name: p.functionCall!.name ?? "",
            args: (p.functionCall!.args as Record<string, unknown>) ?? {},
          }));

        return {
          text: textParts.length > 0 ? textParts.join("\n") : null,
          toolCalls,
          rawContent: candidate?.content ?? null,
          latencyMs,
        };
      } catch (err: unknown) {
        lastError = err;
        const is429 = err instanceof Error && err.message.includes("429");
        if (!is429 || attempt === maxRetries) throw err;

        const delayMs = 2000 * Math.pow(2, attempt); // 2s, 4s, 8s
        console.warn(`Gemma rate-limited, retrying in ${delayMs / 1000}s (attempt ${attempt + 1}/${maxRetries})...`);
        await new Promise((r) => setTimeout(r, delayMs));
      }
    }
    throw lastError;
  }
}

export { Type };

/**
 * Extracts only the text after "REPLY:" — discards any chain-of-thought
 * the model wrote before it. If the marker is missing:
 * - Checks for obvious reasoning/thought patterns to avoid leaking CoT.
 * - If clean conversational text, returns it safely.
 */
export function extractReply(rawText: string | null): string | null {
  if (!rawText) return null;
  const marker = "REPLY:";
  const idx = rawText.lastIndexOf(marker);
  if (idx !== -1) {
    const reply = rawText.slice(idx + marker.length).trim();
    return reply.length > 0 ? reply : null;
  }

  // Fallback heuristic: check if raw text looks like leaked internal reasoning
  const lower = rawText.toLowerCase();
  const reasoningIndicators = [
    "i need to",
    "i will call",
    "i should call",
    "calling tool",
    "the user wants",
    "plan:",
    "thinking:",
    "reasoning:",
    "thought:",
  ];

  const hasReasoningLeak = reasoningIndicators.some((ind) => lower.includes(ind));
  if (hasReasoningLeak) {
    return null; // drop to safe fallback rather than leaking internal reasoning
  }

  const cleaned = rawText.trim();
  return cleaned.length > 0 ? cleaned : null;
}