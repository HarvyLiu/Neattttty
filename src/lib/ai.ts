// AI diagram generation for Neattttty.
// Original prompts + layout code. Two provider families:
//  - offline: Ollama (/api/chat) or any OpenAI-compatible local server (LM Studio)
//  - byok: OpenAI / OpenRouter / Anthropic / Gemini (or compatible) with user key
// The model returns a small JSON plan; we convert it to editable Excalidraw elements.

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

const SYSTEM_PROMPT = `You turn a short request into a simple flowchart plan.
Reply with ONLY a JSON array, no prose, no code fences. Each item:
{"label":"short text max 28 chars","shape":"rect"|"diamond"|"ellipse"}
Rules: 3 to 7 nodes, first node is the start, last node is the end state.
Use "diamond" for decisions, "ellipse" for start/end, "rect" otherwise.
Example: [{"label":"Start","shape":"ellipse"},{"label":"Login?","shape":"diamond"},{"label":"Show app","shape":"rect"}]`;

interface PlanNode {
  label: string;
  shape: "rect" | "diamond" | "ellipse";
}

function extractJsonArray(text: string): PlanNode[] {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = (fenced ? fenced[1] : text).trim();
  const start = candidate.indexOf("[");
  const end = candidate.lastIndexOf("]");
  if (start === -1 || end === -1 || end <= start) throw new Error("Model did not return a node list.");
  const arr = JSON.parse(candidate.slice(start, end + 1)) as PlanNode[];
  if (!Array.isArray(arr) || arr.length === 0) throw new Error("Model returned an empty plan.");
  return arr.slice(0, 8).map((n) => ({
    label: String(n.label ?? "Node").slice(0, 32) || "Node",
    shape: n.shape === "diamond" || n.shape === "ellipse" ? n.shape : "rect",
  }));
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

/** Convert a node plan into editable Excalidraw elements (vertical flow). */
export function planToElements(plan: PlanNode[], originX: number, originY: number): any[] {
  const W = 260;
  const H = 110;
  const GAP = 90;
  const elements: any[] = [];
  let y = originY;

  const boxType = (shape: PlanNode["shape"]) =>
    shape === "diamond" ? "diamond" : shape === "ellipse" ? "ellipse" : "rectangle";

  plan.forEach((node, i) => {
    const id = nid();
    const textId = nid();
    elements.push({
      id,
      type: boxType(node.shape),
      x: originX,
      y,
      width: W,
      height: H,
      angle: 0,
      strokeColor: "#1e1e2e",
      backgroundColor: i === 0 ? "#A6D189" : "transparent",
      fillStyle: "solid",
      strokeWidth: 2,
      strokeStyle: "solid",
      roughness: 1,
      opacity: 100,
      roundness: node.shape === "rect" ? { type: 3 } : { type: 2 },
      boundElements: [{ id: textId, type: "text" }],
      link: null,
      locked: false,
    });
    elements.push({
      id: textId,
      type: "text",
      x: originX + 16,
      y: y + H / 2 - 14,
      width: W - 32,
      height: 28,
      angle: 0,
      strokeColor: "#1e1e2e",
      backgroundColor: "transparent",
      fillStyle: "solid",
      strokeWidth: 1,
      roughness: 0,
      opacity: 100,
      fontSize: 20,
      fontFamily: 1,
      textAlign: "center",
      verticalAlign: "middle",
      baseline: 24,
      text: node.label,
      originalText: node.label,
      autoResize: true,
      containerId: id,
      locked: false,
    });
    if (i < plan.length - 1) {
      elements.push({
        id: nid(),
        type: "arrow",
        x: originX + W / 2,
        y: y + H,
        width: 0,
        height: GAP,
        angle: 0,
        strokeColor: "#1e1e2e",
        backgroundColor: "transparent",
        fillStyle: "solid",
        strokeWidth: 2,
        strokeStyle: "solid",
        roughness: 1,
        opacity: 100,
        roundness: { type: 2 },
        points: [
          [0, 0],
          [0, GAP],
        ],
        elbowed: false,
        startBinding: null,
        endBinding: null,
        startArrowhead: null,
        endArrowhead: "arrow",
        locked: false,
      });
    }
    y += H + GAP;
  });
  return elements;
}

export async function generateDiagram(cfg: AIConfig, prompt: string): Promise<any[]> {
  const clean = prompt.trim();
  if (!clean) throw new Error("Type what to diagram first.");
  let raw: string;
  if (cfg.kind === "ollama") raw = await chatOllamaNative(cfg, clean);
  else if (cfg.kind === "anthropic") raw = await chatAnthropic(cfg, clean);
  else raw = await chatOpenAICompatible(cfg, clean);
  const plan = extractJsonArray(raw);
  // Place new diagrams right of existing content; App passes a better origin.
  return planToElements(plan, 120, 120);
}
