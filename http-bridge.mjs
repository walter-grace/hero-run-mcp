// HTTP bridge: the same 22 tools, reachable from a BROWSER.
//
// The stdio server is perfect for Claude Code and OpenCode, and unreachable from a web page by
// nature — a browser cannot spawn a process. This bridge imports the same TOOLS registry (one
// implementation, two transports; a fork would drift within a week) and serves it over MCP
// Streamable HTTP, which is exactly what the Studio canvas's Plugins client speaks. Connect
// http://127.0.0.1:8618/mcp in the Plugins menu and every Hero node can call sandbox_run,
// memory_write, swarm_spawn, file_save — the canvas becomes as capable as the CLI harnesses.
//
// SECURITY, in order of the walls a request must pass:
//   1. Binds 127.0.0.1 only. This machine's browser, nobody else's.
//   2. Bearer token REQUIRED (printed on boot, or set BRIDGE_TOKEN). localhost is not privacy:
//      any web page you visit can fire requests at 127.0.0.1, and these tools spend money and
//      sign transactions. The token is what separates "my canvas" from "any tab I have open".
//   3. CORS answers the browser's preflight, including Private Network Access — Chrome requires
//      an explicit opt-in before letting a public page talk to a local server at all.
import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { TOOLS, SUPPORTED } from "./hero-run-mcp.mjs";

const PORT = Number(process.env.BRIDGE_PORT || 8618);
const TOKEN = process.env.BRIDGE_TOKEN || randomBytes(12).toString("hex");
const sessions = new Set();

const CORS = (origin) => ({
  "Access-Control-Allow-Origin": origin || "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, Mcp-Session-Id, MCP-Protocol-Version",
  "Access-Control-Expose-Headers": "Mcp-Session-Id",
  "Access-Control-Allow-Private-Network": "true",
  "Vary": "Origin",
});

const send = (res, status, headers, body) => { res.writeHead(status, headers); res.end(body ? JSON.stringify(body) : undefined); };

createServer(async (req, res) => {
  const origin = req.headers.origin;
  if (req.method === "OPTIONS") return send(res, 204, CORS(origin));
  if (req.method !== "POST") return send(res, 405, CORS(origin), { error: "POST only" });

  const auth = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  if (auth !== TOKEN) return send(res, 401, { ...CORS(origin), "Content-Type": "application/json" }, { jsonrpc: "2.0", id: null, error: { code: -32001, message: "Bad or missing bearer token. It is printed when the bridge starts." } });

  let body = "";
  for await (const chunk of req) body += chunk;
  let msg; try { msg = JSON.parse(body); } catch { return send(res, 400, { ...CORS(origin), "Content-Type": "application/json" }, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }); }
  const { id, method, params } = msg;
  const reply = (result) => send(res, 200, { ...CORS(origin), "Content-Type": "application/json", ...(method === "initialize" ? { "Mcp-Session-Id": [...sessions].pop() } : {}) }, { jsonrpc: "2.0", id, result });
  const fail = (message, code = -32000) => send(res, 200, { ...CORS(origin), "Content-Type": "application/json" }, { jsonrpc: "2.0", id, error: { code, message } });

  try {
    if (method === "initialize") {
      const sid = randomBytes(8).toString("hex");
      sessions.add(sid);
      const requested = params?.protocolVersion;
      return send(res, 200, { ...CORS(origin), "Content-Type": "application/json", "Mcp-Session-Id": sid }, {
        jsonrpc: "2.0", id,
        result: { protocolVersion: SUPPORTED.includes(requested) ? requested : SUPPORTED[0], capabilities: { tools: {} }, serverInfo: { name: "hero-run-bridge", version: "0.1.0" } },
      });
    }
    if (method === "notifications/initialized") return send(res, 202, CORS(origin));
    if (method === "ping") return reply({});
    if (method === "tools/list") return reply({ tools: Object.entries(TOOLS).map(([name, t]) => ({ name, description: t.description, inputSchema: t.inputSchema, ...(t.annotations ? { annotations: t.annotations } : {}) })) });
    if (method === "tools/call") {
      const t = TOOLS[params?.name];
      if (!t) return fail(`Unknown tool: ${params?.name}`, -32602);
      try {
        const out = await t.run(params.arguments || {});
        const content = [];
        if (out.image) content.push({ type: "image", data: out.image.data, mimeType: out.image.mimeType });
        if (out.audio) content.push({ type: "audio", data: out.audio.data, mimeType: out.audio.mimeType });
        if (out.text || !content.length) content.push({ type: "text", text: out.text || "" });
        return reply({ content });
      } catch (e) {
        // Tool failure is model-actionable information, not a protocol error — same rule as stdio.
        return reply({ content: [{ type: "text", text: e.message }], isError: true });
      }
    }
    return fail(`Unknown method: ${method}`, -32601);
  } catch (e) { return fail(e.message); }
}).listen(PORT, "127.0.0.1", () => {
  console.log(`Hero Run MCP bridge → http://127.0.0.1:${PORT}/mcp`);
  console.log(`token: ${TOKEN}`);
  console.log(`Studio: Plugins → paste the URL and token → Connect. ${Object.keys(TOOLS).length} tools.`);
});
