# Hero Run MCP server

One MCP tool surface for running **500+ AI models** (text, image, video, audio), paid in **$HERO** per call. Any MCP-speaking agent (Claude Code, etc.) can list models, run text/image, and read the on-chain treasury. Usage funds open-source AI model training.

Implemented **eight ways** — Zig, Rust, Go, C++, Swift, Bun, Node, Python — so you can pick your runtime, and benchmarked so the choice is informed. Every one is a full server (all tools live). Most ports are **dependency-free** (stdlib / built-in fetch); Rust uses two small crates, and C++ links system libcurl with a vendored nlohmann/json header.

Learn more at [herorunai.com](https://herorunai.com).

## Tools

| Tool | What it does |
|---|---|
| `list_models` | List available models and their $HERO price (filter by `kind`: text, image, video, audio) |
| `run_text` | Run a text model (default `auto`, the best-value router) |
| `generate_image` | Generate an image |
| `generate_video` | Generate a ~5s video clip (default Wan 2.2 480p; takes 1–3 minutes) |
| `generate_audio` | Generate speech (GPT Audio) or music (Lyria) |
| `treasury_stats` | Read the treasury funding open-source AI (live from Base) |
| `wallet_balance` | Your prepaid API-key credit balance |

Tip: append `@gateway` to any model id (e.g. `openai/gpt-oss-120b@cerebras`) to pin a specific gateway — no failover, billed at that gateway's own price.

## Run it

All eight are stdio JSON-RPC servers with the same tool surface. Mint a prepaid key at [/keys](https://herorunai.com/keys) and set `HERO_RUN_KEY`.

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
(cd cpp   && ./build.sh && ./hero-run-mcp)                                      # C++ (clang++, links system libcurl)
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
| **Zig** | **2.2 ms** | 42,412 req/s | 1.3 MB static | nothing |
| Rust | 5.0 ms | 34,620 req/s | 1.3 MB static | nothing |
| Go | 6.9 ms | 31,960 req/s | 8.5 MB static | nothing |
| C++ | 7.2 ms | 42,781 req/s | 212 KB | system libcurl |
| Swift | 9.8 ms | 24,438 req/s | 105 KB | system Foundation |
| Bun | 15.2 ms | 34,518 req/s | one file | `bun` |
| Python | 30.6 ms | 36,417 req/s | one file | `python3` |
| Node | 43.5 ms | 49,867 req/s | one file | `node` |

*(macOS arm64, single run. Zig 0.16 / Rust 1.x / Go 1.26 / Apple clang 17 / Swift 6 / Bun 1.3 / Node 25 / Python 3.13.)*

### Reading the numbers honestly

- **Cold start splits cleanly by compilation.** The five compiled binaries (Zig, Rust, Go, C++, Swift) all boot in under 10 ms; the three runtimes (Bun, Python, Node) take 15 to 44 ms because they boot an interpreter/JIT first. **Zig is fastest at ~2 ms.** This is the only number that matters if a client spawns the server per session.
- **Throughput is effectively a wash** (~29 to 60k req/s). These are serial round-trips through a Node benchmark client, so the figure is dominated by pipe I/O and the harness, not the server. Every runtime handles orders of magnitude more than a real agent workload (a handful of calls).
- **End-to-end tool latency is identical** across all eight. It's a network call to the gateway plus inference; the runtime is noise next to that.
- **Size:** Swift (105 KB) and C++ (212 KB) are tiny but link system dylibs; Zig and Rust are ~1.3 MB fully static; Go is 8.5 MB static.

### Recommendation

- **Zig or Rust** for the smallest self-contained static binary and the fastest cold start.
- **Go** for a batteries-included static binary with the simplest toolchain.
- **Swift** in an Apple-native shop (105 KB artifact).
- **Node, Bun, or Python** as the easiest to read and hack on (and the production server's wallet mode lives in Node).

The takeaway: for an MCP gateway, **pick the runtime that's easiest to distribute and maintain**. The performance gap is real only at cold start, and irrelevant to per-request latency.

## Examples

- **[examples/python-agent](examples/python-agent)** — a tool-using agent in ~40 lines of Python via the standard `openai` client pointed at Hero Run's OpenAI-compatible `/v1` (model `"auto"` = the router).
- **[examples/go-agent](examples/go-agent)** — the same agent in Go with the standard library only, zero dependencies.
- **[examples/telegram-bot](examples/telegram-bot)** — a Go Telegram bot that drives the MCP server as a subprocess, turning each chat command (`/ask`, `/image`, `/models`, `/treasury`, `/balance`) into a real `tools/call`. A working reference for *consuming* the server.

- **[hero-run-market-maker](https://github.com/walter-grace/hero-run-market-maker)** — a Go market-making bot for $HERO whose optional `-brain` flag consults Hero Run itself for regime calls (routing modes as model ids, @gateway pinning, strict-JSON `response_format`) — the flywheel as a working example.

## Notes

- These are **key-mode** servers (prepaid credits). The production reference also supports **wallet mode** (`AGENT_PRIVATE_KEY`, pays per call on-chain via viem) — see the main app repo.
- The API key is always read from `HERO_RUN_KEY`. Never hardcode it.

## License

MIT
