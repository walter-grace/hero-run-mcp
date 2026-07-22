# Hero Run MCP server

One MCP tool surface for running **340+ AI models**, paid in **$HERO** per call. Any MCP-speaking agent (Claude Code, etc.) can list models, run text/image, and read the on-chain treasury. Usage funds open-source AI model training.

Implemented **seven ways** — Zig, Rust, Go, Swift, Bun, Node, Python — so you can pick your runtime, and benchmarked so the choice is informed. Every one is a full server (all tools live). The four scripting/compiled-with-stdlib ports are **dependency-free**; Rust uses two small crates.

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

All seven are stdio JSON-RPC servers with the same tool surface. Mint a prepaid key at [/keys](https://hero-run.vercel.app/keys) and set `HERO_RUN_KEY`.

```bash
export HERO_RUN_KEY=hr_live_...

# scripting runtimes — run directly
node    node/index.mjs        # Node
bun     bun/index.ts          # Bun
python3 python/server.py      # Python

# compiled — build once, then run the binary
(cd go    && go build -o hero-run-mcp . && ./hero-run-mcp)                      # Go
(cd rust  && cargo build --release && ./target/release/hero-run-mcp)            # Rust
(cd zig   && zig build-exe main.zig -O ReleaseSafe -lc --name hero-run-mcp && ./hero-run-mcp)   # Zig 0.16
(cd swift && swiftc -O main.swift -o hero-run-mcp && ./hero-run-mcp)            # Swift
```

Register with a client, e.g.:

```bash
claude mcp add hero-run -e HERO_RUN_KEY=hr_live_... -- node /abs/path/node/index.mjs
```

## Benchmark

An MCP server is **I/O-bound**: real latency is dominated by the HTTP call to the gateway plus model inference, so language choice barely moves end-to-end time. What it *does* affect is **cold-start** and **distribution**. The benchmark measures exactly those (local only, no network, no $HERO spent): median cold-start over 15 spawns, and serial `tools/list` dispatch (a no-network handler).

Run it yourself: `node bench/bench.mjs`

| Runtime | Cold start (median) | `tools/list` throughput | Binary | Needs |
|---|---|---|---|---|
| **Zig** | **1.8 ms** | 60,166 req/s | 1.3 MB static | nothing |
| Rust | 2.6 ms | 29,446 req/s | 1.3 MB static | nothing |
| Go | 4.2 ms | 51,564 req/s | 8.5 MB static | nothing |
| Swift | 6.7 ms | 29,380 req/s | 105 KB | system Foundation |
| Bun | 15.8 ms | 38,127 req/s | one file | `bun` |
| Python | 30.8 ms | 45,809 req/s | one file | `python3` |
| Node | 45.6 ms | 50,208 req/s | one file | `node` |

*(macOS arm64, single run. Zig 0.16 / Rust 1.x / Go 1.26 / Swift 6 / Bun 1.3 / Node 25 / Python 3.13.)*

### Reading the numbers honestly

- **Cold start splits cleanly by compilation.** The four compiled binaries (Zig, Rust, Go, Swift) all boot in under 7 ms; the three runtimes (Bun, Python, Node) take 16 to 46 ms because they boot an interpreter/JIT first. **Zig is fastest at 1.8 ms.** This is the only number that matters if a client spawns the server per session.
- **Throughput is effectively a wash** (~29 to 60k req/s). These are serial round-trips through a Node benchmark client, so the figure is dominated by pipe I/O and the harness, not the server. Every runtime handles orders of magnitude more than a real agent workload (a handful of calls).
- **End-to-end tool latency is identical** across all seven. It's a network call to the gateway plus inference; the runtime is noise next to that.
- **Size:** Swift is tiny (105 KB, links the system Foundation dylib); Zig and Rust are ~1.3 MB fully static; Go is 8.5 MB static.

### Recommendation

- **Zig or Rust** for the smallest self-contained static binary and the fastest cold start.
- **Go** for a batteries-included static binary with the simplest toolchain.
- **Swift** in an Apple-native shop (105 KB artifact).
- **Node, Bun, or Python** as the easiest to read and hack on (and the production server's wallet mode lives in Node).

The takeaway: for an MCP gateway, **pick the runtime that's easiest to distribute and maintain**. The performance gap is real only at cold start, and irrelevant to per-request latency.

## Examples

- **[examples/telegram-bot](examples/telegram-bot)** — a Go Telegram bot that drives the MCP server as a subprocess, turning each chat command (`/ask`, `/image`, `/models`, `/treasury`, `/balance`) into a real `tools/call`. A working reference for *consuming* the server.

## Notes

- These are **key-mode** servers (prepaid credits). The production reference also supports **wallet mode** (`AGENT_PRIVATE_KEY`, pays per call on-chain via viem) — see the main app repo.
- The API key is always read from `HERO_RUN_KEY`. Never hardcode it.

## License

MIT
