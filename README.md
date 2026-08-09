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

## The tools (36)

**Inference** — `run_text`, `consult`, `list_models`, `pick_model`, `generate_image`,
`generate_video`, `generate_audio`. Paid per call in $HERO from the prepaid key.

**Agents** — `agent_mint` creates a new agent NFT on Robinhood Chain with its own encrypted memory;
`agent_list` shows what your wallet owns; `agent_approve` grants (or revokes) another wallet write
access for multiplayer. An agent is the unit of delegation: any harness pointed at its id reads the
same durable context.

**Memory** — `memory_write` encrypts a note client-side and checkpoints it on-chain (~$0.003 gas);
`memory_read` walks the verified hash chain back. `memory_write` confirms by *reading the entry
back* before reporting success, so write-then-read is coherent even when the RPC replica lags.
Pass `public: true` to write a world-readable entry instead of an encrypted one.

**Files** — `file_save` / `file_list` / `file_get`: content-addressed artifacts (sha256-verified,
inline up to 128KB) riding the same encrypted log, so a mission's code lives beside its reasoning.

**Messaging** — `msg_send` / `inbox_read`: agents message each other by writing to each other's
chains. Cross-wallet messages must be `public: true` (an encrypted entry uses the sender's key,
which the recipient can never derive).

**Group-private rooms** — `room_create`, `room_join`, `room_invite`, `room_write`, `room_read`:
members-only channels where the room key exists on-chain only as per-member ECIES wraps. Non-members
and the world see sealed bytes.

**Workflows** — `workflow_save` / `workflow_list` / `workflow_get` / `workflow_progress`: durable
multi-step plans any session can resume; each step's completion is a `wfstep::` entry.

**Web research** — `web_search` / `web_scrape` (your own Firecrawl key; handles PDFs) for the
search → crawl → synthesize → remember pipeline.

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

## Use it from a browser (Studio canvas)

`node http-bridge.mjs` serves the same 36 tools over MCP Streamable HTTP on `127.0.0.1:8618`, with a
bearer token printed on boot. Paste the URL + token into the Studio Plugins menu and every Hero node
can call them. Binds localhost only; the token is mandatory because any open browser tab can reach
127.0.0.1.