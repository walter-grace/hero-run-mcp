# Hero Run MCP server

One MCP tool surface for running **340+ AI models**, paid in **$HERO** per call. Any MCP-speaking agent (Claude Code, etc.) can list models, run text/image, and read the on-chain treasury. Usage funds open-source AI model training.

Implemented **four ways** — Go, Bun, Node, Python — so you can pick your runtime, and benchmarked so the choice is informed. All four are **dependency-free** (key mode uses only the standard library / built-in fetch).

Learn more at [hero-run.vercel.app](https://hero-run.vercel.app).

## Tools

| Tool | What it does |
|---|---|
| `list_models` | List available models and their $HERO price (filter by `kind`) |
| `run_text` | Run a text model (default `auto`, the best-value router) |
| `generate_image` | Generate an image |
| `treasury_stats` | Read the treasury funding open-source AI (live from Base) |
| `wallet_balance` | Your prepaid API-key credit balance |

## Run it

All four are stdio JSON-RPC servers. Mint a prepaid key at [/keys](https://hero-run.vercel.app/keys) and set `HERO_RUN_KEY`.

```bash
export HERO_RUN_KEY=hr_live_...

node   node/index.mjs         # Node
bun    bun/index.ts           # Bun
python3 python/server.py      # Python
(cd go && go build -o hero-run-mcp . && ./hero-run-mcp)   # Go (single binary)
```

Register with a client, e.g.:

```bash
claude mcp add hero-run -e HERO_RUN_KEY=hr_live_... -- node /abs/path/node/index.mjs
```

## Benchmark

An MCP server is **I/O-bound**: real latency is dominated by the HTTP call to the gateway plus model inference, so language choice barely moves end-to-end time. What it *does* affect is **cold-start** and **distribution**. The benchmark measures exactly those (local only, no network, no $HERO spent): median cold-start over 15 spawns, and serial `tools/list` dispatch (a no-network handler).

Run it yourself: `node bench/bench.mjs`

| Runtime | Cold start (median) | `tools/list` throughput | Distribution |
|---|---|---|---|
| **Go** | **5.7 ms** | 43,481 req/s | single static binary, no runtime |
| Bun | 17.7 ms | 36,280 req/s | one file, needs `bun` |
| Python | 30.6 ms | 45,769 req/s | one file, needs `python3` |
| Node | 43.9 ms | 53,434 req/s | one file, needs `node` |

*(macOS, Go 1.26 / Bun 1.3 / Node 25 / Python 3.13. Illustrative single run.)*

### Reading the numbers honestly

- **Cold start: Go wins decisively** (~5.7 ms, a compiled binary with no runtime to boot). This matters if a client spawns the server per-session.
- **Throughput: effectively a tie** (~36–53k req/s). These are serial round-trips through a Node benchmark client, so the number is dominated by pipe I/O and the harness, not the server runtime. Any of them handles orders of magnitude more than a real agent workload (a handful of calls).
- **End-to-end tool latency: identical** across all four. It's a network call to the gateway; the runtime is noise next to that.

### Recommendation

- **Ship Go** if you want the best distribution: one static binary, no runtime, fastest cold start.
- **Node or Bun** as the reference / easiest to hack on (and the production server's wallet mode lives in Node).
- **Python** if that's your stack.

The takeaway: for an MCP gateway, **pick the runtime that's easiest to distribute and maintain** — the performance difference is real only at cold start, and irrelevant to per-request latency.

## Notes

- These are **key-mode** servers (prepaid credits). The production reference also supports **wallet mode** (`AGENT_PRIVATE_KEY`, pays per call on-chain via viem) — see the main app repo.
- The API key is always read from `HERO_RUN_KEY`. Never hardcode it.

## License

MIT
