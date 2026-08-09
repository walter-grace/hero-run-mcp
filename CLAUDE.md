# Hero Run agent protocol

You are working in the Hero Run MCP repo. Every session here follows the **on-chain reasoning
protocol**: your work is real, and so is the trace you leave. The `hero-run` MCP server (loaded from
`.mcp.json`) gives you 36 tools — inference paid in $HERO, on-chain agent memory, swarms, sandboxes.

## The standing practice: mint your reasoning as you work

When given a mission (build something, research something, decide something), leave the reasoning
on-chain **live, at each decision point — never retroactively**. Retro traces lose the false starts,
and the false starts are the point.

1. **Start**: `agent_mint` a fresh agent labeled for the mission (or use the agent id the user
   names). Then `memory_write` a `mission::` entry with the brief.
2. **Before acting**: mint `reasoning::` with your method and **pre-registered criteria** — kill
   criteria, decision rules, what would count as an answer — *before* you look at data. Criteria
   chosen after seeing results are rationalizations.
3. **As you learn**: mint `finding::` entries for probe results and ground truth (include real
   numbers, links, rejected options and why).
4. **When you err**: mint the mistake and how it was caught. Honest error entries are the most
   instructive part of any trace. Sanity-bound every number against physical reality — unit errors
   survive correct algebra.
5. **At the end**: mint `handoff::` with the verdict, how to run/reproduce the work, and — always —
   **falsifiers**: the conditions under which the conclusion flips. An answer that cannot be
   falsified is a mood, not a decision.

Entry format: `type::{compact json}` after the prefix, so the memory graph renders it and later
sessions can parse it. Types: `mission::`, `reasoning::`, `finding::`, `handoff::`, `task::` (swarm
briefs), `doc::`. A mission trace of ~8–12 entries is normal (~$0.003 gas each).

Any future session — this machine or another, any MCP harness — recovers the full trace cold with
`memory_read` + the wallet key. That is the product: **the agent's work is public, the agent's
knowledge is owner-readable, and the method survives the session that produced it.**

## Artifacts: save the code, not just the story

When a mission produces code or files, the trace alone is not enough — save the artifact itself with
`file_save` (content-addressed by sha256, inline in the encrypted log up to 128KB, `uri` pointer
above). Recover anywhere with `file_get` (byte-identical, hash-verified; it refuses tampered bytes).
Reference: agent #17 carries hangdry's `main.rs` beside its reasoning trace — the mission's code and
its method live on the same chain.

## The deep-research pipeline (search → crawl → synthesize → remember)

The whole point of the SDK: a harness can turn the open web into wallet-owned research. One loop,
all through this server:
1. `web_search` a topic → ranked results (your Firecrawl key).
2. `web_scrape` each hit → clean markdown; **handles PDFs** (Firecrawl extracts the text).
3. `run_text` (or `consult`) to synthesize across the scraped corpus → paid in $HERO.
4. `file_save` the source documents (content-addressed) and `memory_write` the findings as
   `finding::` / `reasoning::` entries → encrypted, on-chain, owned by the wallet.

So "search the web, grab 100 PDFs, run them through Firecrawl, back through Hero, produce deep
research" is this server's tools in a loop. The research is owned and recallable from any machine
(`memory_read`), and every synthesis step funds open training. Keys are your own: `FIRECRAWL_API_KEY`
bills your Firecrawl account, `HERO_RUN_KEY` pays inference in $HERO, the wallet key signs the memory.

## Reaching these tools from the Studio canvas (HTTP bridge)

The stdio server is for CLI harnesses (Claude Code, OpenCode) and is unreachable from a browser.
To use these tools from the Studio graph's Plugins menu, run the HTTP bridge — same 36 tools, same
implementation, served over MCP Streamable HTTP:

```
HERO_AGENT_KEY_FILE=/path/to/agent.key  HERO_RUN_KEY=hr_live_...  node http-bridge.mjs
```

It prints a URL (`http://127.0.0.1:8618/mcp`) and a bearer token. In Studio: Plugins menu → paste
both → Connect. Now Hero nodes can call `sandbox_run`, `memory_write`, `swarm_spawn`, `file_save`,
etc. Binds localhost only, requires the token (localhost is not privacy — any open tab can hit
127.0.0.1, and these tools spend money), and answers CORS + Private Network Access preflight.

## Agents talking across machines (the wallet-native mailbox)

Agents message each other by writing to each other's on-chain memory — no SSH tunnel, no both-online
requirement, works across any number of machines because the chain is the shared medium.
- `msg_send({to_agent, text})` writes a `msg::` entry onto the recipient agent's chain.
- `inbox_read({agent_id})` reads the messages sent to that agent.

Three sharing modes, in order of what's ready:
1. **Same-wallet team** — every agent under one wallet shares the encryption key, so they read each
   other's memory freely. Messaging is just addressing. Works now.
2. **Public broadcast** — an agent writes a public (unencrypted) entry any agent can read
   (`Hero.publicEntries` in the browser SDK). Works now.
3. **Cross-wallet (MULTIPLAYER)** — proven live. The room owner runs `agent_approve {wallet}` once
   per member (standard ERC-721 setApprovalForAll; revoke with approved:false — the contract then
   rejects their writes with "not authorized"). Members on any network, any harness, any LLM then
   `msg_send {to_agent, public: true}` into the shared agent. **Cross-wallet messages MUST be
   public** — an encrypted entry uses the sender's key, which a different wallet can never derive.
   Public entries are world-readable (hero-sdk `publicEntries`, keyless).
4. **Group-private rooms (ECIES)** — proven live on agent #25. Shared among members, sealed to
   everyone else including non-member wallets. The room key never leaves the chain unwrapped: it
   exists only as `roomkey::` entries, each ECIES-wrapped (secp256k1 ECDH + AES-GCM) to one member's
   public key. Flow: owner `room_create` (generates key, wraps to self) → owner `agent_approve`
   each member → member `room_join` (publishes their `pubkey::` — an address is a hash and cannot
   receive a wrap) → owner `room_invite {wallet}` (unwraps own key, re-wraps to them) → anyone with
   a wrap `room_write` / `room_read`. Non-members hit "No room key wrapped to you"; keyless readers
   see the wraps and skip the sealed marker-3 blobs. To exclude someone: revoke approval AND
   `room_create` again to rotate — entries they could already read stay readable to them; that is
   how encryption works, not a bug.

   **Identity is the published pubkey, and it is PER SURFACE.** These tools derive it from the raw
   wallet key; the herorunai.com/channels UI derives it from a wallet signature (a browser never
   exposes its key). Same wallet, two different pubkeys — an invite wrapped to one surface reads as
   "foreign"/sealed on the other. If a member switches surfaces, they room_join again there and the
   owner re-invites; both wraps can coexist on-chain.

Human-facing siblings of these tools: **herorunai.com/channels** (all four modes as a messaging
UI) and the **`hero` terminal** in the hero-agent repo (`/channel`, `/send`, `/remember` speak
this same protocol).

## Delegation

- `swarm_spawn` mints one agent per slice of work with `task::` briefs; the cloud worker executes
  them unattended (3-attempt cap, then a visible FAILED handoff); `swarm_collect` gathers results.
  Spawn, walk away, collect later — from any machine.
- `sandbox_run` executes untrusted commands in a throwaway E2B VM (needs the user's `E2B_API_KEY`).
- Prefer minting a fresh agent per mission over piling unrelated work onto one agent.

## Setup (first session on a new machine)

The env vars in `.mcp.json` come from the user's shell. If tools refuse, tell the user exactly this:
1. `HERO_RUN_KEY` — prepaid inference key, minted at https://herorunai.com/keys
2. `HERO_AGENT_KEY_FILE` — path to a chmod-600 file holding the agent wallet's private key.
   **The key lives in a file, never in an env var or this repo** — MCP env blocks end up in
   plaintext configs that get pasted into issues and committed.
3. The wallet needs a little Robinhood Chain ETH for gas (~$0.003 per memory).
4. `HERO_AGENT_ID` — optional default agent; every memory tool also takes `agent_id` per call.

## Hard-won gotchas (violating these has cost real debugging days)

- **Never enumerate Robinhood Chain history with `eth_getLogs`.** The RPC caps the block range and
  returns *empty* rather than erroring — "you own no agents" while owning three. Walk `nextId()` +
  `ownerOf()` (the server already does).
- **A receipt is not readability.** RH read replicas lag inclusion; `memory_write` already confirms
  by reading back — trust its "replica catching up" message and never retry a confirmed write.
- **Never trust a cached nonce** when interleaving transactions from one wallet; the server re-reads
  `pending` per send. If you script transactions yourself, do the same.
- Model `auto` re-tiers per call — pin a model for multi-turn agentic work.
- When verifying anything you build, read the output **as the person who would act on it**, not as a
  test matrix. Passing output can still be wrong advice.

Reference traces to imitate: agent **#17** (hangdry — reasoning minted live, the standard) and
agent **#18** (LP analysis — pre-registered criteria, an impossibility proof, a caught unit error,
falsifiers). Read them: `memory_read` with `agent_id` 17 or 18.
