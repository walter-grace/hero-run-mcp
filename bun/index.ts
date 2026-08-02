#!/usr/bin/env node
// Hero Run MCP server — Node reference implementation (stdio JSON-RPC).
// Any MCP agent can run 500+ AI models paying $HERO per call. Key mode (prepaid
// credits) only; the API key is read from HERO_RUN_KEY, never hardcoded.
import { createInterface } from "node:readline";

const URL = process.env.HERO_RUN_URL || "https://herorunai.com";
const KEY = process.env.HERO_RUN_KEY || "";
const TIMEOUT_MS = 300000; // 300s budget for a request, same as every other port
const j = async (path, opt) => (await fetch(URL + path, { ...opt, signal: AbortSignal.timeout(TIMEOUT_MS) })).json();
const fmt = (n) => Math.round(Number(n) || 0).toLocaleString("en-US");
// A tool error that carries a JSON-RPC error code (-32602 = invalid params).
const rpcError = (code, message) => Object.assign(new Error(message), { rpcCode: code });
// Message of a truthy `error` key, if any. An error *object* (not just a
// string) counts as a failure, so an API error never renders as data.
const apiError = (d) => {
  const e = d == null ? undefined : d.error;
  if (e === undefined || e === null || e === false || e === "" || e === 0) return null;
  return typeof e === "string" ? e : JSON.stringify(e);
};
// Throws on an error envelope; otherwise passes the decoded body through.
const ok = (d) => { const e = apiError(d); if (e !== null) throw new Error(e); return d; };
// prompt is required and must be a string — reject before spending anything.
const promptOf = (a) => {
  if (typeof a.prompt !== "string") throw rpcError(-32602, "Invalid params: prompt must be a string");
  return a.prompt;
};

const TOOLS = [
  { name: "list_models", description: "List AI models available through the Hero Run gateway. Tip: append @gateway to a model id (e.g. openai/gpt-oss-120b@cerebras) to pin a specific gateway.", inputSchema: { type: "object", properties: { kind: { type: "string", enum: ["text", "image", "video", "audio", "all"] } } } },
  { name: "run_text", description: "Run a text model (default: auto). Pays $HERO via your key.", inputSchema: { type: "object", required: ["prompt"], properties: { prompt: { type: "string" }, model: { type: "string" }, consent: { type: "boolean" } } } },
  { name: "generate_image", description: "Generate an image. Pays $HERO via your key.", inputSchema: { type: "object", required: ["prompt"], properties: { prompt: { type: "string" }, model: { type: "string" }, consent: { type: "boolean" } } } },
  { name: "generate_video", description: "Generate a short video clip (~5s, default Wan 2.2 480p). Takes 1-3 minutes. Pays $HERO via your key.", inputSchema: { type: "object", required: ["prompt"], properties: { prompt: { type: "string" }, model: { type: "string" }, consent: { type: "boolean" } } } },
  { name: "generate_audio", description: "Generate speech or music (default: openai/gpt-audio-mini; music: google/lyria-3-clip-preview). Pays $HERO via your key.", inputSchema: { type: "object", required: ["prompt"], properties: { prompt: { type: "string" }, model: { type: "string" }, consent: { type: "boolean" } } } },
  { name: "treasury_stats", description: "Read the Hero Run treasury (live from Base).", inputSchema: { type: "object", properties: {} } },
  { name: "wallet_balance", description: "Your prepaid API key credit balance.", inputSchema: { type: "object", properties: {} } },
];

async function runModel(id, input, kind, consent) {
  if (!KEY) throw new Error("Set HERO_RUN_KEY (mint at /keys) to run models.");
  // consent gates public-dataset retention: only a real JSON true counts.
  const d = await j("/api/run", { method: "POST", headers: { "Content-Type": "application/json", "x-api-key": KEY }, body: JSON.stringify({ model: id, input, kind, consent: consent === true }) });
  return ok(d);
}

const IMPL = {
  async list_models(a = {}) {
    // A null or absent kind means "no filter"; only a string kind filters.
    const kind = typeof a.kind === "string" ? a.kind : "all";
    const ms = ok(await j("/api/models")).models.filter((m) => kind === "all" || m.kind === kind);
    return `${ms.length} models. Each costs $HERO per run.\n` + ms.slice(0, 60).map((m) => `  ${fmt(m.hero).padStart(9)} $HERO · ${m.kind}  ${m.id}`).join("\n");
  },
  async run_text(a) {
    const d = await runModel(a.model || "auto", promptOf(a), "text", a.consent);
    return `${d.text}\n\n— ${d.autoModel || d.model} · spent ${fmt(d.charged)} $HERO`;
  },
  async generate_image(a) {
    const d = await runModel(a.model || "google/gemini-2.5-flash-image", promptOf(a), "image", a.consent);
    return d.image ? `Image: ${d.image.slice(0, 80)}…\nspent ${fmt(d.charged)} $HERO` : "No image returned.";
  },
  async generate_video(a) {
    const d = await runModel(a.model || "wavespeed-ai/wan-2.2/t2v-480p-ultra-fast", promptOf(a), "video", a.consent);
    return d.video ? `Video ready: ${d.video}\nspent ${fmt(d.charged)} $HERO` : "No video returned.";
  },
  async generate_audio(a) {
    const d = await runModel(a.model || "openai/gpt-audio-mini", promptOf(a), "audio", a.consent);
    return d.audio ? `Audio: ${d.audio.slice(0, 80)}…\n${d.text || ""}\nspent ${fmt(d.charged)} $HERO` : "No audio returned.";
  },
  async treasury_stats() {
    const t = ok(await j("/api/treasury"));
    return `Treasury ${t.treasury}\nClaimable: ${t.claimable?.token0 ?? "?"} WETH + ${t.claimable?.token1 ?? "?"} HERO`;
  },
  async wallet_balance() {
    if (!KEY) return "Set HERO_RUN_KEY to see credits.";
    const d = await j("/api/keys/info", { headers: { "x-api-key": KEY } });
    // A transport/decode failure and an API error envelope are both real
    // failures, so both become an MCP error rather than a fabricated zero
    // balance. Only the "no key configured" case above stays advisory text.
    ok(d);
    return `Prepaid API key\n${fmt(d.balance)} $HERO credits (deposited ${fmt(d.deposited)}, spent ${fmt(d.spent)})`;
  },
};

const send = (o) => process.stdout.write(JSON.stringify(o) + "\n");
createInterface({ input: process.stdin }).on("line", async (line) => {
  if (!line.trim()) return;
  let m; try { m = JSON.parse(line); } catch { return; }
  if (m === null || typeof m !== "object") return;
  const { id, method, params } = m;
  // No id member at all = a notification: handle it, but never answer.
  const reply = "id" in m ? (o) => send({ jsonrpc: "2.0", id, ...o }) : () => {};
  if (method === "initialize") return reply({ result: { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "hero-run", version: "1.0.0" } } });
  if (method === "tools/list") return reply({ result: { tools: TOOLS } });
  if (method === "tools/call") {
    const name = typeof params?.name === "string" ? params.name : "";
    if (!Object.hasOwn(IMPL, name)) return reply({ error: { code: -32000, message: `Unknown tool: ${name}` } });
    try { reply({ result: { content: [{ type: "text", text: await IMPL[name](params.arguments || {}) }] } }); }
    catch (e) { reply({ error: { code: e.rpcCode || -32000, message: e.message } }); }
    return;
  }
  if ("id" in m && id !== null) reply({ error: { code: -32601, message: "Method not found" } });
});
