# Hero Run agent protocol

You are working in the Hero Run MCP repo. Every session here follows the **on-chain reasoning
protocol**: your work is real, and so is the trace you leave. The `hero-run` MCP server (loaded from
`.mcp.json`) gives you 19 tools — inference paid in $HERO, on-chain agent memory, swarms, sandboxes.

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
