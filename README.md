# hero-run-mcp

One MCP server that turns any coding harness — Claude Code, OpenCode, Codex, Cursor, anything that
speaks MCP — into an agent platform: run 600+ models paid in $HERO, and spin up on-chain agents
that keep working after you close the laptop.

## Quick start (Claude Code)

```json
// ~/.claude.json → mcpServers
"hero-run": {
  "type": "stdio",
  "command": "node",
  "args": ["/path/to/hero-run-mcp/hero-run-mcp.mjs"],
  "env": {
    "HERO_RUN_KEY": "hr_live_...",
    "HERO_AGENT_KEY_FILE": "/home/you/.hero-agent/agent.key",
    "HERO_AGENT_ID": "6"
  }
}
```

- `HERO_RUN_KEY` — prepaid inference credits, minted at [herorunai.com/keys](https://herorunai.com/keys).
- `HERO_AGENT_KEY_FILE` — path to a chmod-600 file holding the wallet key that owns your agents.
  Use this instead of `AGENT_PRIVATE_KEY`: MCP env blocks live in plaintext config files that get
  pasted into issues and committed to repos. A path is safe there; a key is not.
- `HERO_AGENT_ID` — default agent for memory tools (optional; every memory tool takes `agent_id`).

## The tools (19)

**Inference** — `run_text`, `consult`, `list_models`, `pick_model`, `generate_image`,
`generate_video`, `generate_audio`. Paid per call in $HERO from the prepaid key.

**Agents** — `agent_mint` creates a new agent NFT on Robinhood Chain with its own encrypted memory;
`agent_list` shows what your wallet owns. An agent is the unit of delegation: any harness pointed at
its id reads the same durable context.

**Memory** — `memory_write` encrypts a note client-side and checkpoints it on-chain (~$0.003 gas);
`memory_read` walks the verified hash chain back. `memory_write` confirms by *reading the entry
back* before reporting success, so write-then-read is coherent even when the RPC replica lags.

**Swarms** — `swarm_spawn` mints one agent per slice of work, each seeded with its brief as a
`task::` entry; `swarm_collect` gathers the `handoff::` results. If the [durable
worker](../hero-agent/worker) is deployed with `AGENT_DISCOVER=1`, spawned workers **execute
themselves**: the cron finds each unanswered task, runs it (one paid call per tick, three attempts
max, then a visible `FAILED` handoff), and writes the result. Spawn, walk away, collect from any
machine. Capped at 8 workers per swarm (`HERO_SWARM_MAX`) — each is a real transaction.

**Sandboxes** — `sandbox_run` executes a command in a throwaway E2B VM. Needs your own
`E2B_API_KEY`; compute bills to your E2B account, not $HERO, because per-second compute behind a
flat token price is how a provider quietly sells below cost.

**Treasury / bridge** — `wallet_balance`, `treasury_stats`, `bridge_to_robinhood`,
`bridge_to_base`, `bridge_status`.

## The loop this enables

```
Claude Code                          Robinhood Chain              Cloudflare cron (5 min)
    │  swarm_spawn("audit", 3 slices)      │                            │
    ├──────────────────────────────────────► 3 agent NFTs + task:: ─────┤
    │                                       │                     picks up each task,
    │         (close the laptop)            │                     runs it, writes handoff::
    │                                       │                            │
    │  swarm_collect([16,17,18])            │                            │
    ◄────────────────────────────────────── handoff:: results ──────────┘
```

Every step is paid in $HERO, every result is an encrypted on-chain checkpoint owned by your wallet,
and no step depends on the machine that started it still being awake.

## Hard-won operational notes

- **Never enumerate history with `eth_getLogs` on Robinhood Chain.** The RPC caps the block range
  and returns *empty* rather than erroring, which reads as "no agents exist". Walk `nextId()` +
  `ownerOf()` instead. This has produced a false "you own nothing" twice in this codebase.
- **Never trust a cached nonce.** Interleaved mint/append transactions from one wallet go stale by
  one the moment anything else lands. Every send here re-reads `pending` first and retries only on
  a nonce error (safe: "nonce too low" means the signed tx never entered the pool).
- **A receipt is not readability.** RH read replicas lag behind inclusion, so "wait for the receipt
  then read" still misses your own write. Confirm by reading back, and say "replica catching up"
  rather than implying the write failed.

---

Looking for the eight-language ports (Zig/Rust/Go/C++/Swift/Bun/Node/Python) and their cold-start benchmark? See [docs/PORTS.md](docs/PORTS.md).
