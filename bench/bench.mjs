// Runtime benchmark for the Hero Run MCP server across Zig / Rust / Go / Swift / Bun / Node / Python.
// Measures what language choice actually affects: cold-start (spawn -> first response)
// and serial JSON-RPC dispatch throughput (tools/list, a no-network handler). End-to-end
// tool latency is network-bound and near-identical across runtimes, so it is not the point.
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const R = (p) => join(HERE, "..", p);
const BUN = process.env.HOME + "/.bun/bin/bun";

const SERVERS = [
  { name: "Go", cmd: R("go/hero-run-mcp"), args: [] },
  { name: "Zig", cmd: R("zig/hero-run-mcp"), args: [] },
  { name: "Rust", cmd: R("rust/target/release/hero-run-mcp"), args: [] },
  { name: "Swift", cmd: R("swift/hero-run-mcp"), args: [] },
  { name: "C++", cmd: R("cpp/hero-run-mcp"), args: [] },
  { name: "Bun", cmd: BUN, args: [R("bun/index.ts")] },
  { name: "Node", cmd: "node", args: [R("node/index.mjs")] },
  { name: "Python", cmd: "python3", args: [R("python/server.py")] },
];

function spawnSrv(s) {
  const c = spawn(s.cmd, s.args, { stdio: ["pipe", "pipe", "ignore"] });
  const pending = new Map();
  let buf = "";
  c.stdout.on("data", (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const l = buf.slice(0, i); buf = buf.slice(i + 1);
      if (!l.trim()) continue;
      let m; try { m = JSON.parse(l); } catch { continue; }
      const p = pending.get(m.id); if (p) { pending.delete(m.id); p(m); }
    }
  });
  let id = 0;
  const rpc = (method, params) => new Promise((res) => { const i = ++id; pending.set(i, res); c.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: i, method, params }) + "\n"); });
  return { c, rpc };
}
const now = () => Number(process.hrtime.bigint()) / 1e6;
const median = (a) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };

async function coldStart(s, runs = 15) {
  const times = [];
  for (let i = 0; i < runs; i++) {
    const t0 = now();
    const { c, rpc } = spawnSrv(s);
    await rpc("initialize", {});
    times.push(now() - t0);
    c.kill();
    await new Promise((r) => setTimeout(r, 25));
  }
  return median(times);
}
async function dispatch(s, n = 2000) {
  const { c, rpc } = spawnSrv(s);
  await rpc("initialize", {});
  const t0 = now();
  for (let i = 0; i < n; i++) await rpc("tools/list", {});
  const el = now() - t0;
  c.kill();
  return Math.round(n / (el / 1000));
}

console.log("Hero Run MCP — runtime benchmark (local only, no network, no $HERO spent)\n");
const rows = [];
for (const s of SERVERS) {
  process.stdout.write(`  ${s.name.padEnd(7)} …`);
  try {
    const cold = await coldStart(s);
    const rps = await dispatch(s);
    rows.push({ name: s.name, cold, rps });
    console.log(` cold ${cold.toFixed(1)}ms · ${rps.toLocaleString()} req/s`);
  } catch (e) { console.log(" ERROR:", e.message); }
}
rows.sort((a, b) => a.cold - b.cold);
console.log("\n| Runtime | Cold start (median) | tools/list throughput |");
console.log("|---|---|---|");
for (const r of rows) console.log(`| ${r.name} | ${r.cold.toFixed(1)} ms | ${r.rps.toLocaleString()} req/s |`);
process.exit(0);
