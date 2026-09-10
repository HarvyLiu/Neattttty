// AI diagram generation for Neattttty (official-style: text -> mermaid).
// The model writes Mermaid diagram code; the editor's own
// @excalidraw/mermaid-to-excalidraw converter turns it into properly formed,
// editable canvas elements (preview first, Insert on confirm).
// Providers:
//  - offline: Ollama (/api/chat) or any OpenAI-compatible local server (LM Studio)
//  - byok: OpenAI / OpenRouter / Anthropic / Gemini / OpenCode Zen / custom
//    endpoints with user key

export type AIKind =
  | "ollama"
  | "local-openai"
  | "openai"
  | "openrouter"
  | "anthropic"
  | "gemini"
  | "opencode-zen"
  | "custom";

/** Wire format. Chat Completions (/chat/completions) is the default;
 *  Responses (/responses) covers OpenAI Responses-API models
 *  (e.g. most GPT/Grok/Claude entries on OpenCode Zen). */
export type APIStyle = "chat" | "responses";

export interface AIConfig {
  kind: AIKind;
  model: string;
  baseUrl: string; // for openai-compatible / local / zen / custom endpoints
  apiKey: string; // BYOK only; never committed anywhere
  apiStyle: APIStyle;
}

export const AI_DEFAULTS: Record<AIKind, { model: string; baseUrl: string }> = {
  ollama: { model: "llama3.1:8b", baseUrl: "http://localhost:11434" },
  "local-openai": { model: "local-model", baseUrl: "http://localhost:1234/v1" },
  openai: { model: "gpt-4o-mini", baseUrl: "https://api.openai.com/v1" },
  openrouter: { model: "meta-llama/llama-3.1-8b-instruct", baseUrl: "https://openrouter.ai/api/v1" },
  anthropic: { model: "claude-haiku-4-5", baseUrl: "https://api.anthropic.com/v1" },
  gemini: { model: "gemini-2.0-flash", baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai" },
  "opencode-zen": { model: "muse-spark-1.3-contributor-free", baseUrl: "https://opencode.ai/zen/v1" },
  custom: { model: "my-model", baseUrl: "https://api.example.com/v1" },
};

const SYSTEM_PROMPT = `You turn a short request into a Mermaid diagram.
Reply with ONLY one valid Mermaid diagram inside a single \`\`\`mermaid fence — no prose, no explanation.
Default to \`flowchart TD\` unless the request clearly calls for another type (sequenceDiagram for interactions over time, classDiagram for code structure, erDiagram for data models, stateDiagram-v2, mindmap, timeline).
Rules:
- One diagram only. Node labels short (max 5 words), plain text, no markdown, no HTML.
- Simple node ids (A, B, C…). Quote labels with special characters: A["label (x)"].
- Prefer TD (top-down) layout. Max ~12 nodes.
Example:
\`\`\`mermaid
flowchart TD
    A[Start] --> B{Logged in?}
    B -->|Yes| C[Show app]
    B -->|No| D[Show login]
\`\`\``;

const MERMAID_HEADS =
  /^\s*(flowchart|graph|sequenceDiagram|classDiagram|erDiagram|gantt|pie|mindmap|timeline|journey|stateDiagram(-v2)?|gitGraph|C4Context)\b/im;

function stripFences(text: string): string {
  const mermaidFence = text.match(/```mermaid\s*([\s\S]*?)```/i);
  if (mermaidFence) return mermaidFence[1].trim();
  const anyFence = text.match(/```(?:\w+)?\s*([\s\S]*?)```/i);
  if (anyFence && MERMAID_HEADS.test(anyFence[1])) return anyFence[1].trim();
  return text.trim();
}

/** Pull Mermaid source out of a model reply (fenced or raw). */
export function extractMermaid(text: string): string {
  const code = stripFences(text);
  if (!code) throw new Error("Model returned an empty reply.");
  if (!MERMAID_HEADS.test(code)) {
    throw new Error("Model did not return a Mermaid diagram. Try rephrasing, e.g. “as a flowchart”.");
  }
  if (code.length > 20000) throw new Error("Model reply too long to diagram.");
  return code;
}

/**
 * POST JSON to an AI endpoint.
 *
 * In the desktop app, requests go through the Rust `ai_fetch` relay:
 * providers that don't send CORS headers (e.g. OpenCode Zen) are
 * unreachable from the page itself ("Failed to fetch") but fine
 * server-side. In a plain browser (`npm run dev`) there is no backend,
 * so we fall back to direct fetch.
 */
async function postJson(
  url: string,
  headers: Record<string, string>,
  body: unknown,
): Promise<{ status: number; text: string }> {
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    const r = (await invoke("ai_fetch", {
      url,
      headers,
      body: JSON.stringify(body),
    })) as { status: number; body: string };
    if (typeof r?.status === "number" && typeof r?.body === "string") return { status: r.status, text: r.body };
  } catch {
    /* not in the desktop app (or relay unavailable) — direct fetch below */
  }
  const res = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  return { status: res.status, text: await res.text() };
}

function parseJson(text: string): any {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("Model returned a non-JSON reply.");
  }
}

/** Pull a human-readable message out of a provider error payload, if any. */
function serverMessage(text: string): string {
  try {
    const j = JSON.parse(text);
    const e = j?.error;
    if (typeof e === "string" && e) return e;
    if (e && typeof e.message === "string" && e.message) return e.message;
    if (typeof j?.message === "string" && j.message) return j.message;
  } catch {
    /* not JSON — fall through */
  }
  return "";
}

/** Status-aware error that prefers the server's own explanation. */
function httpError(status: number, text: string): Error {
  const m = serverMessage(text);
  if (status === 0) return new Error("Network unreachable. Check connection / endpoint.");
  if (status === 401 || status === 403) {
    return new Error(
      m ? `Rejected (${status}): ${m.slice(0, 200)}` : `Rejected (${status}). Check your API key.`,
    );
  }
  if (status === 404) {
    return new Error(
      m
        ? `Endpoint not found (404): ${m.slice(0, 200)}`
        : "Endpoint not found (404). Check base URL / model / API style.",
    );
  }
  return new Error(
    m ? `AI error ${status}: ${m.slice(0, 200)}` : `AI error ${status}. Check model name / key / endpoint.`,
  );
}

async function chatOllamaNative(cfg: AIConfig, prompt: string): Promise<string> {
  const { status, text } = await postJson(`${cfg.baseUrl.replace(/\/$/, "")}/api/chat`, { "Content-Type": "application/json" }, {
    model: cfg.model,
    stream: false,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: prompt },
    ],
  });
  if (status === 0) throw new Error("Ollama not reachable. Is Ollama running? (ollama serve)");
  if (status < 200 || status >= 300) throw httpError(status, text);
  const json = parseJson(text);
  const content = json?.message?.content;
  if (!content) throw new Error("Empty reply from model.");
  return String(content);
}

async function chatOpenAICompatible(cfg: AIConfig, prompt: string): Promise<string> {
  const base = cfg.baseUrl.replace(/\/$/, "");
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : {}),
  };
  if (cfg.apiStyle === "responses") {
    const { status, text } = await postJson(`${base}/responses`, headers, {
      model: cfg.model,
      input: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: prompt },
      ],
    });
    if (status < 200 || status >= 300) throw httpError(status, text);
    return extractResponsesText(parseJson(text));
  }
  const { status, text } = await postJson(`${base}/chat/completions`, headers, {
    model: cfg.model,
    temperature: 0.3,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: prompt },
    ],
  });
  if (status < 200 || status >= 300) throw httpError(status, text);
  const json = parseJson(text);
  const content = json?.choices?.[0]?.message?.content;
  if (!content) throw new Error("Empty reply from model.");
  return String(content);
}

/** Tolerant text extractor for OpenAI Responses-API payloads. */
function extractResponsesText(json: any): string {
  if (typeof json?.output_text === "string" && json.output_text) return json.output_text;
  const out = json?.output;
  if (Array.isArray(out)) {
    const parts: string[] = [];
    for (const item of out) {
      if (item && typeof item === "object") {
        if (item.type === "message" && Array.isArray(item.content)) {
          for (const c of item.content) {
            if (c && typeof c.text === "string" && (c.type === "output_text" || c.type === "text" || !c.type)) {
              parts.push(c.text);
            }
          }
        } else if (typeof item.text === "string") {
          parts.push(item.text);
        }
      }
    }
    if (parts.length > 0) return parts.join("\n");
  }
  // Some gateways wrap responses in a chat-like envelope.
  const ch = json?.choices?.[0]?.message?.content;
  if (typeof ch === "string" && ch) return ch;
  throw new Error("Empty reply from model.");
}

async function chatAnthropic(cfg: AIConfig, prompt: string): Promise<string> {
  const { status, text } = await postJson(
    "https://api.anthropic.com/v1/messages",
    {
      "Content-Type": "application/json",
      "x-api-key": cfg.apiKey,
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true",
    },
    {
      model: cfg.model,
      max_tokens: 800,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: prompt }],
    },
  );
  if (status < 200 || status >= 300) throw httpError(status, text);
  const json = parseJson(text);
  const reply = (json?.content ?? [])
    .filter((b: any) => b.type === "text")
    .map((b: any) => b.text)
    .join("\n");
  if (!reply) throw new Error("Empty reply from model.");
  return reply;
}

function nid(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `n-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
  }
}

export interface MermaidScene {
  mermaid: string;
  elements: any[];
  files: Record<string, any>;
}

/**
 * Ask the model for a diagram. Returns Mermaid source — the caller previews
 * it and inserts the converted scene on confirm (official-style flow).
 */
export async function generateMermaid(cfg: AIConfig, prompt: string): Promise<string> {
  const clean = prompt.trim();
  if (!clean) throw new Error("Type what to diagram first.");
  let raw: string;
  if (cfg.kind === "ollama") raw = await chatOllamaNative(cfg, clean);
  else if (cfg.kind === "anthropic") raw = await chatAnthropic(cfg, clean);
  else raw = await chatOpenAICompatible(cfg, clean);
  return extractMermaid(raw);
}

/**
 * Convert Mermaid source to a canvas scene with the editor's own converter.
 * Returned elements are fully formed (correct text binding etc.).
 *
 * NOTE: the parser yields *skeletons* — they must go through
 * convertToExcalidrawElements first, exactly like the editor's own
 * paste-as-mermaid flow does. Raw skeletons have no real ids/coords and
 * render as an unreachable, NaN-zoomed mess.
 */
export async function mermaidToScene(definition: string): Promise<MermaidScene> {
  const mermaid = definition.trim();
  if (!mermaid) throw new Error("Nothing to convert.");
  const { parseMermaidToExcalidraw } = await import("@excalidraw/mermaid-to-excalidraw");
  const { convertToExcalidrawElements } = await import("@excalidraw/excalidraw");
  let skeleton: unknown;
  let files: Record<string, any> = {};
  try {
    const result = (await parseMermaidToExcalidraw(mermaid)) as unknown as {
      elements: unknown;
      files?: Record<string, any>;
    };
    skeleton = result?.elements;
    files = result?.files ?? {};
  } catch (err: any) {
    throw new Error(`Could not read that diagram: ${String(err?.message ?? err).slice(0, 200)}`);
  }
  if (!Array.isArray(skeleton) || skeleton.length === 0) {
    throw new Error("Converter produced an empty diagram.");
  }
  const elements = convertToExcalidrawElements(skeleton as any, { regenerateIds: true }) as any[];
  if (!Array.isArray(elements) || elements.length === 0) {
    throw new Error("Converter produced an empty diagram.");
  }
  return { mermaid, elements, files };
}

/** Shift a scene so its left edge lands at targetX (for Insert placement). */
export function shiftScene(elements: any[], targetX: number): any[] {
  let minX = Infinity;
  for (const e of elements) {
    if (typeof e?.x === "number") minX = Math.min(minX, e.x);
  }
  if (!isFinite(minX)) return elements;
  const dx = targetX - minX;
  if (dx === 0) return elements;
  return elements.map((e: any) => ({ ...e, x: (e?.x ?? 0) + dx }));
}
