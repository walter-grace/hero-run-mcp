#!/usr/bin/env node
// Hero Run MCP server — Node reference implementation (stdio JSON-RPC).
// Any MCP agent can run 340+ AI models paying $HERO per call. Key mode (prepaid
// credits) only; the API key is read from HERO_RUN_KEY, never hardcoded.
import { createInterface } from "node:readline";

const URL = process.env.HERO_RUN_URL || "https://hero-run.vercel.app";
const KEY = process.env.HERO_RUN_KEY || "";
const j = async (path, opt) => (await fetch(URL + path, opt)).json();
const fmt = (n) => Math.round(Number(n) || 0).toLocaleString("en-US");

const TOOLS = [
  { name: "list_models", description: "List AI models available through the Hero Run gateway.", inputSchema: { type: "object", properties: { kind: { type: "string", enum: ["text", "image", "audio", "all"] } } } },
  { name: "run_text", description: "Run a text model (default: auto). Pays $HERO via your key.", inputSchema: { type: "object", required: ["prompt"], properties: { prompt: { type: "string" }, model: { type: "string" }, consent: { type: "boolean" } } } },
  { name: "generate_image", description: "Generate an image. Pays $HERO via your key.", inputSchema: { type: "object", required: ["prompt"], properties: { prompt: { type: "string" }, model: { type: "string" }, consent: { type: "boolean" } } } },
  { name: "treasury_stats", description: "Read the Hero Run treasury (live from Base).", inputSchema: { type: "object", properties: {} } },
  { name: "wallet_balance", description: "Your prepaid API key credit balance.", inputSchema: { type: "object", properties: {} } },
];

async function runModel(id, input, kind, consent) {
  if (!KEY) throw new Error("Set HERO_RUN_KEY (mint at /keys) to run models.");
  const d = await j("/api/run", { method: "POST", headers: { "Content-Type": "application/json", "x-api-key": KEY }, body: JSON.stringify({ model: id, input, kind, consent: !!consent }) });
  if (d.error) throw new Error(d.error);
  return d;
}

const IMPL = {
  async list_models({ kind = "all" } = {}) {
    const ms = (await j("/api/models")).models.filter((m) => kind === "all" || m.kind === kind);
    return `${ms.length} models. Each costs $HERO per run.\n` + ms.slice(0, 60).map((m) => `  ${fmt(m.hero).padStart(9)} $HERO · ${m.kind}  ${m.id}`).join("\n");
  },
  async run_text({ prompt, model, consent }) {
    const d = await runModel(model || "auto", prompt, "text", consent);
    return `${d.text}\n\n— ${d.autoModel || d.model} · spent ${fmt(d.charged)} $HERO`;
  },
  async generate_image({ prompt, model, consent }) {
    const d = await runModel(model || "google/gemini-2.5-flash-image", prompt, "image", consent);
    return d.image ? `Image: ${d.image.slice(0, 80)}…\nspent ${fmt(d.charged)} $HERO` : "No image returned.";
  },
  async treasury_stats() {
    const t = await j("/api/treasury");
    return `Treasury ${t.treasury}\nClaimable: ${t.claimable?.token0 ?? "?"} WETH + ${t.claimable?.token1 ?? "?"} HERO`;
  },
  async wallet_balance() {
    if (!KEY) return "Set HERO_RUN_KEY to see credits.";
    const d = await j("/api/keys/info", { headers: { "x-api-key": KEY } });
    if (d.error) return "API key error: " + d.error;
    return `Prepaid API key\n${fmt(d.balance)} $HERO credits (deposited ${fmt(d.deposited)}, spent ${fmt(d.spent)})`;
  },
};

const send = (o) => process.stdout.write(JSON.stringify(o) + "\n");
createInterface({ input: process.stdin }).on("line", async (line) => {
  if (!line.trim()) return;
  let m; try { m = JSON.parse(line); } catch { return; }
  const { id, method, params } = m;
  if (method === "initialize") return send({ jsonrpc: "2.0", id, result: { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "hero-run", version: "1.0.0" } } });
  if (method === "tools/list") return send({ jsonrpc: "2.0", id, result: { tools: TOOLS } });
  if (method === "tools/call") {
    try { send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: await IMPL[params.name](params.arguments || {}) }] } }); }
    catch (e) { send({ jsonrpc: "2.0", id, error: { code: -32000, message: e.message } }); }
    return;
  }
  if (id !== undefined && id !== null) send({ jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found" } });
});
