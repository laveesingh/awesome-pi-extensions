/**
 * Out-of-context chat. A single lazily-created ModelRuntime reuses Pi's
 * providers and stored credentials but shares nothing with the session: no
 * entries, no context builders, no accounting. The recap call can therefore
 * never leak into — or be billed to — the conversation.
 */
import { ModelRuntime, getAgentDir } from "@earendil-works/pi-coding-agent";
import type { RecapModelRef } from "./config.js";

export interface ChatModel extends RecapModelRef {
  name?: string;
}

export interface ChatResult {
  text: string;
  costUsd: number;
}

export interface ChatBackend {
  listChatModels(): Promise<ChatModel[]>;
  complete(model: RecapModelRef, prompt: string, opts: { maxTokens: number; signal?: AbortSignal }): Promise<ChatResult>;
}

type Runtime = {
  getModels(providerId?: string): Array<{ provider: string; id: string; name?: string } & Record<string, unknown>>;
  completeSimple(
    model: unknown,
    context: unknown,
    options?: { maxTokens?: number; reasoning?: string; signal?: AbortSignal },
  ): Promise<unknown>;
};

let sharedRuntime: Runtime | null = null;
/** Test seam: drop the cached runtime so tests never share production state. */
export function resetChatRuntime(): void {
  sharedRuntime = null;
}

async function runtime(): Promise<Runtime> {
  if (!sharedRuntime) {
    // No allowModelNetwork: no catalog refresh, local files only. Created once
    // per process and reused, so the one-time provider setup never repeats.
    sharedRuntime = (await ModelRuntime.create({
      authPath: `${getAgentDir()}/auth.json`,
    })) as unknown as Runtime;
  }
  return sharedRuntime;
}

function textOf(result: unknown): string {
  const content = (result as { content?: Array<{ type?: string; text?: string }> })?.content;
  if (Array.isArray(content)) {
    return content
      .filter((b) => b?.type === "text" && typeof b.text === "string")
      .map((b) => (b.text as string).trim())
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

function costOf(result: unknown): number {
  const cost = (result as { usage?: { cost?: { total?: unknown } } })?.usage?.cost?.total;
  return typeof cost === "number" && Number.isFinite(cost) && cost >= 0 ? cost : 0;
}

/** Cheapest fast default: prefer mini/nano/haiku/flash-class ids, else first. */
export function pickDefaultModel(models: ChatModel[]): ChatModel | null {
  if (models.length === 0) return null;
  const cheap = models.find((m) => /mini|nano|haiku|flash|lite|light|small/i.test(`${m.provider}/${m.id} ${m.name ?? ""}`));
  if (cheap && !/pro|ultra|max|opus/i.test(`${cheap.provider}/${cheap.id}`)) return cheap;
  return models[0];
}

export function modelLabel(model: RecapModelRef): string {
  return `${model.provider}/${model.id}`;
}

export class PiChatBackend implements ChatBackend {
  async listChatModels(): Promise<ChatModel[]> {
    const rt = await runtime();
    return rt
      .getModels()
      .filter((m) => m && typeof m.provider === "string" && typeof m.id === "string")
      .map((m) => ({ provider: m.provider, id: m.id, ...(typeof m.name === "string" ? { name: m.name } : {}) }));
  }

  async complete(model: RecapModelRef, prompt: string, opts: { maxTokens: number; signal?: AbortSignal }): Promise<ChatResult> {
    const rt = await runtime();
    const resolved = rt.getModels().find((m) => m.provider === model.provider && m.id === model.id);
    if (!resolved) throw new Error(`Unknown chat model "${modelLabel(model)}". Pick one with /recap model.`);
    const result = await rt.completeSimple(
      resolved,
      { messages: [{ role: "user", content: [{ type: "text", text: prompt }] }] },
      { maxTokens: opts.maxTokens, reasoning: "off", signal: opts.signal },
    );
    const text = textOf(result).trim();
    if (!text) throw new Error(`Model "${modelLabel(model)}" returned an empty reply.`);
    return { text, costUsd: costOf(result) };
  }
}
