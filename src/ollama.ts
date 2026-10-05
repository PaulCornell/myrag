// Minimal client for a local Ollama server (https://ollama.com): streaming chat for answers and
// JSON-schema-constrained output for the eval judge. No API key; everything runs on this machine.
import { OLLAMA_URL } from "./config.js";

export interface OllamaMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface OllamaResult {
  text: string;
  model: string;
  promptTokens: number;
  outputTokens: number;
  doneReason: string | null;
}

/** Thrown when the Ollama server isn't reachable or the model isn't pulled; message says how to fix it. */
export class OllamaUnavailableError extends Error {}

interface ChatChunk {
  model: string;
  message?: { content: string };
  done: boolean;
  done_reason?: string;
  prompt_eval_count?: number;
  eval_count?: number;
  error?: string;
}

const OPTIONS = {
  // Low temperature: grounded answers should be stable, not creative.
  temperature: 0.1,
  // Six ~250-token passages plus instructions and the answer fit comfortably in 6k tokens.
  num_ctx: 6144,
  // Hard cap on output. Without it, a small model constrained to a JSON schema can loop for
  // minutes (one judge call produced ~4,900 tokens over 5 minutes before being cut off).
  num_predict: 1024,
};

async function post(body: object): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(`${OLLAMA_URL}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (err) {
    // Only a refused connection means Ollama isn't running; anything else is a real request failure.
    const code = (err as { cause?: { code?: string } }).cause?.code;
    if (code === "ECONNREFUSED" || code === "ENOTFOUND") {
      throw new OllamaUnavailableError(
        `Can't reach Ollama at ${OLLAMA_URL}. Start it with \`brew services start ollama\` (or \`ollama serve\`).`,
      );
    }
    throw new Error(`Ollama request failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (res.status === 404) {
    const model = (body as { model: string }).model;
    throw new OllamaUnavailableError(`Ollama doesn't have the model "${model}". Download it with \`ollama pull ${model}\`.`);
  }
  if (!res.ok || !res.body) throw new Error(`Ollama error: HTTP ${res.status} ${await res.text().catch(() => "")}`);
  return res;
}

/** Streams a chat completion, calling onText for each token batch. */
export async function chatStream(model: string, messages: OllamaMessage[], onText?: (t: string) => void): Promise<OllamaResult> {
  return readStream(await post({ model, messages, stream: true, options: OPTIONS }), onText);
}

async function readStream(res: Response, onText?: (t: string) => void): Promise<OllamaResult> {
  const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader();
  let buf = "";
  let text = "";
  let last: ChatChunk | undefined;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += value;
    let nl: number;
    while ((nl = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      const chunk: ChatChunk = JSON.parse(line);
      if (chunk.error) throw new Error(`Ollama error: ${chunk.error}`);
      const piece = chunk.message?.content ?? "";
      if (piece) {
        text += piece;
        onText?.(piece);
      }
      last = chunk;
    }
  }
  return {
    text,
    model: last?.model ?? "",
    promptTokens: last?.prompt_eval_count ?? 0,
    outputTokens: last?.eval_count ?? 0,
    doneReason: last?.done_reason ?? null,
  };
}

/**
 * Chat whose output is constrained to a JSON schema (Ollama structured outputs). Streamed even
 * though only the final text is used: a non-streamed request sends no response headers until
 * generation finishes, and Node's fetch gives up after 5 minutes without headers.
 */
export async function chatJSON(model: string, messages: OllamaMessage[], schema: object): Promise<{ json: unknown } & OllamaResult> {
  const res = await post({ model, messages, stream: true, format: schema, options: { ...OPTIONS, temperature: 0 } });
  const result = await readStream(res);
  if (result.doneReason === "length") throw new Error(`Ollama hit the ${OPTIONS.num_predict}-token output cap before finishing the JSON`);
  let json: unknown;
  try {
    json = JSON.parse(result.text);
  } catch {
    throw new Error(`Ollama returned invalid JSON: ${result.text.slice(0, 200)}`);
  }
  return { json, ...result };
}
