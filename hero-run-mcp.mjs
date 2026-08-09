// Hero Run — MCP gateway server (stdio JSON-RPC).
// Gives any MCP-speaking agent one tool surface to run 440+ AI models, paying in
// $HERO per call from the agent's own Base wallet. Usage funds open-source model
// training, and each run costs less $HERO over time as funded models get cheaper.
//
//   HERO_RUN_URL=https://herorunai.com \
//   AGENT_PRIVATE_KEY=0x...   node hero-run-mcp.mjs
//
// Without AGENT_PRIVATE_KEY, read-only tools (list_models, treasury_stats) still work.
import { createInterface } from "node:readline";
import { createWalletClient, createPublicClient, http, parseUnits, pad, encodeFunctionData } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";

const URL = process.env.HERO_RUN_URL || "https://herorunai.com";
const PK = process.env.AGENT_PRIVATE_KEY || "";
const RUNKEY = process.env.HERO_RUN_KEY || ""; // prepaid API key — no wallet needed
const ERC20 = [{ name: "transfer", type: "function", stateMutability: "nonpayable",
  inputs: [{ name: "to", type: "address" }, { name: "amount", type: "uint256" }], outputs: [{ type: "bool" }] }];

let account = null, wallet = null;
const pub = createPublicClient({ chain: base, transport: http("https://mainnet.base.org") });
if (PK) {
  account = privateKeyToAccount(PK.startsWith("0x") ? PK : `0x${PK}`);
  wallet = createWalletClient({ account, chain: base, transport: http("https://mainnet.base.org") });
}
const shortAddr = account ? account.address.slice(0, 6) + "…" + account.address.slice(-4) : "@agent";

// ---- Agent memory (Robinhood Chain) ----
// Lets a coding harness mint durable memory mid-session: OpenCode, Claude Code, Codex — anything
// that speaks MCP — can write a checkpoint the next session recovers. Without this the harness can
// spend $HERO on inference but cannot leave anything behind, which is the whole differentiator.
//
// The encryption and hash-chain logic is NOT reimplemented here on purpose. The blob format has to
// stay byte-identical across every surface (this server, the Node SDK, the browser at
// herorunai.com/agent) or a memory written by one becomes unreadable by the others, and a wrong
// key derivation is silently unrecoverable rather than loudly broken. So it imports the one
// implementation from hero-agent.
const AGENT_ID = process.env.HERO_AGENT_ID || "";
const HERO_AGENT_PATH = process.env.HERO_AGENT_PATH || `${process.env.HOME}/Desktop/hero-agent`;
// HERO_AGENT_KEY_FILE reads the wallet key from a chmod-600 file instead of an env var, matching
// `hero-agent --key-file`. It matters more here than in the CLI: MCP env vars live in the client's
// config file (~/.claude.json, opencode.json), which is plaintext, routinely pasted into issues,
// and often committed. A path is safe to put there; the key is not.
const KEY_FILE = process.env.HERO_AGENT_KEY_FILE || "";
let _pk = null;
async function agentKey() {
  if (_pk) return _pk;
  if (KEY_FILE) {
    const { readFile } = await import("node:fs/promises");
    const raw = (await readFile(KEY_FILE, "utf8")).trim();
    if (!/^(0x)?[0-9a-fA-F]{64}$/.test(raw)) throw new Error(`${KEY_FILE} does not contain a 32-byte hex private key.`);
    _pk = raw.startsWith("0x") ? raw : "0x" + raw;
    return _pk;
  }
  if (PK) return (_pk = PK.startsWith("0x") ? PK : "0x" + PK);
  return null;
}
const memCache = new Map();

// A swarm mints one agent per worker, so its size is a spend multiplier. Capped rather than
// trusted: "parallelise this" is a prompt an agent will answer with a very large number.
const SWARM_MAX = Number(process.env.HERO_SWARM_MAX || 8);

// ---- Agent NFTs (mint / list) ----
// Minting is what turns this from "talk to an agent" into "spin one up". Each agent is an NFT with
// its own encrypted memory, so it is the unit of delegation: give a long-running job its own agent
// and its context survives the session and is readable by any harness pointed at that id.
const MEM_CONTRACT = process.env.HERO_MEM_ADDR || "0xce4dc968827a996f7bd5bbdb0fcb72348b18d0dc";
const AGENT_ABI = [{ name: "mint", type: "function", stateMutability: "nonpayable", inputs: [{ name: "label", type: "string" }], outputs: [] }];

/**
 * Send a Robinhood Chain transaction with an explicitly re-read nonce.
 *
 * A swarm interleaves mint -> memory-append -> mint, and the append is ALSO a transaction from the
 * same address, so any locally cached nonce is stale by one the moment it lands. viem's own cache
 * hit exactly that: it sent 25 while the chain was already at 26, and the second worker died with
 * "nonce too low" after the first had already been created.
 *
 * So read `pending` immediately before every send, and retry on a nonce race rather than surfacing
 * it — RH's replicas lag, so a fresh read can still come back one behind.
 */
async function sendRh(wallet, account, data, tries = 3) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      const nonce = await rhPub.getTransactionCount({ address: account.address, blockTag: "pending" });
      const hash = await wallet.sendTransaction({ to: MEM_CONTRACT, data, nonce });
      await rhPub.waitForTransactionReceipt({ hash });
      return hash;
    } catch (e) {
      lastErr = e;
      if (!/nonce/i.test(e?.message || "")) throw e;
      await new Promise((r) => setTimeout(r, 600 * (i + 1))); // let the replica catch up
    }
  }
  throw lastErr;
}

/** The wallet that signs on Robinhood Chain — the SAME one that owns memory, so ids line up. */
async function rhSigner() {
  const pk = await agentKey();
  if (!pk) throw new Error("Needs the agent wallet — set HERO_AGENT_KEY_FILE (preferred) or AGENT_PRIVATE_KEY.");
  const acct = privateKeyToAccount(pk);
  return { account: acct, wallet: createWalletClient({ account: acct, chain: rhChain, transport: http(RH_RPC) }) };
}

/**
 * Agent ids owned by an address.
 *
 * NOT via eth_getLogs. Robinhood Chain caps the block range, so `fromBlock: 0x0` does not error —
 * it comes back EMPTY, and the caller reads that as "you own no agents" while happily minting a
 * duplicate. That exact failure has bitten this codebase before.
 *
 * So walk the supply instead: nextId() is the upper bound and ownerOf() is authoritative. Bounded,
 * range-limit-proof, and it also catches agents transferred in rather than minted by this wallet.
 */
async function ownedAgents(address) {
  const want = address.toLowerCase();
  const nextHex = await rhPub.call({ to: MEM_CONTRACT, data: "0x61b8ce8c" }).catch(() => null);
  const total = nextHex?.data ? Number(BigInt(nextHex.data)) - 1 : 0;
  if (total <= 0) return [];
  const ids = [];
  // Small, sequential supply — check every id. Concurrency-limited so a scan cannot hammer the RPC
  // into the rate limiting that caused the original "no agents" bug.
  for (let start = 1; start <= total; start += 10) {
    const batch = [];
    for (let id = start; id < Math.min(start + 10, total + 1); id++) {
      batch.push(
        rhPub.call({ to: MEM_CONTRACT, data: "0x6352211e" + BigInt(id).toString(16).padStart(64, "0") })
          .then((r) => (r?.data && "0x" + r.data.slice(-40) === want ? id : null))
          .catch(() => null),
      );
    }
    ids.push(...(await Promise.all(batch)).filter((x) => x !== null));
  }
  return ids;
}

async function memory(agentId) {
  const id = String(agentId ?? AGENT_ID ?? "").trim();
  if (!id) throw new Error("Set HERO_AGENT_ID (or pass agent_id). Mint an agent at https://herorunai.com/agent.");
  const pk = await agentKey();
  if (!pk) throw new Error("Memory needs the wallet that owns the agent NFT — set HERO_AGENT_KEY_FILE (preferred) or AGENT_PRIVATE_KEY. Its signature derives the encryption key, so no other wallet can read or write this memory.");
  if (memCache.has(id)) return memCache.get(id);
  let OnchainMemory;
  try {
    ({ OnchainMemory } = await import(`${HERO_AGENT_PATH}/src/memory/onchain.mjs`));
  } catch {
    throw new Error(`Could not load agent memory from ${HERO_AGENT_PATH}. Clone hero-agent there, or set HERO_AGENT_PATH to where it lives.`);
  }
  const m = new OnchainMemory({ agentId: id, privateKey: pk });
  memCache.set(id, m);
  return m;
}

// ---- $HERO bridge (Base <-> Robinhood Chain, LayerZero OFT) ----
const RH_RPC = "https://rpc.mainnet.chain.robinhood.com";
const rhChain = { id: 4663, name: "Robinhood Chain", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [RH_RPC] } } };
const rhPub = createPublicClient({ chain: rhChain, transport: http(RH_RPC) });
const rhWallet = account ? createWalletClient({ account, chain: rhChain, transport: http(RH_RPC) }) : null;
const BR = {
  hero: "0x9250532BE90CC24E77A7cb160c4092c607242bA3",
  adapter: "0x40cF976ACd78aF082146D4ECC5C189d44166d3a2", // Base lockbox
  oft: "0xbA221e393645901C962Ad21E4e7FA097d550B67c", // Robinhood Chain OFT
  eidRH: 30416, eidBase: 30184,
};
const _sp = { name: "p", type: "tuple", components: [{ name: "dstEid", type: "uint32" }, { name: "to", type: "bytes32" }, { name: "amountLD", type: "uint256" }, { name: "minAmountLD", type: "uint256" }, { name: "extraOptions", type: "bytes" }, { name: "composeMsg", type: "bytes" }, { name: "oftCmd", type: "bytes" }] };
const _fe = { name: "f", type: "tuple", components: [{ name: "nativeFee", type: "uint256" }, { name: "lzTokenFee", type: "uint256" }] };
const QUOTE_ABI = [{ name: "quoteSend", type: "function", stateMutability: "view", inputs: [_sp, { type: "bool" }], outputs: [_fe] }];
const SEND_ABI = [{ name: "send", type: "function", stateMutability: "payable", inputs: [_sp, _fe, { type: "address" }], outputs: [] }];
const APPROVE_ABI = [{ name: "approve", type: "function", stateMutability: "nonpayable", inputs: [{ type: "address" }, { type: "uint256" }], outputs: [{ type: "bool" }] }];
const BAL_ABI = [{ name: "balanceOf", type: "function", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] }];

// send OFT/adapter cross-chain; `viaAdapter` locks (Base->RH), else burns (RH->Base)
async function bridgeSend({ w, p, tokenAddr, spendAddr, dstEid, amt, viaAdapter }) {
  const to32 = pad(account.address, { size: 32 });
  const sp = { dstEid, to: to32, amountLD: amt, minAmountLD: (amt * 995n) / 1000n, extraOptions: "0x", composeMsg: "0x", oftCmd: "0x" };
  if (viaAdapter) await p.waitForTransactionReceipt({ hash: await w.writeContract({ address: tokenAddr, abi: APPROVE_ABI, functionName: "approve", args: [spendAddr, amt] }) });
  const fee = await p.readContract({ address: spendAddr, abi: QUOTE_ABI, functionName: "quoteSend", args: [sp, false] });
  const hash = await w.writeContract({ address: spendAddr, abi: SEND_ABI, functionName: "send", args: [sp, fee, account.address], value: fee.nativeFee });
  await p.waitForTransactionReceipt({ hash });
  return hash;
}

// Cached with a TTL, not forever. `??=` meant a server left running overnight kept its first
// catalog and its first price table for the life of the process, so new models never appeared and
// every quote drifted as $HERO moved. Five minutes is short enough to track price and long enough
// that a burst of calls costs one fetch.
const TTL_MS = Number(process.env.HERO_CACHE_MS || 300_000);
const FETCH_MS = Number(process.env.HERO_FETCH_MS || 30_000);
// Nothing here retried or timed out, so one hung gateway hung the tool indefinitely, and MCP has
// no cancellation for a client to escape with.
const getJson = async (path, ms = FETCH_MS) => {
  const r = await fetch(`${URL}${path}`, { signal: AbortSignal.timeout(ms) });
  if (!r.ok) throw new Error(`${path} returned ${r.status}`);
  return r.json();
};
let _cfg = null, _cfgAt = 0, _models = null, _modelsAt = 0;
const cfg = async () => {
  if (!_cfg || Date.now() - _cfgAt > TTL_MS) { _cfg = await getJson('/api/config'); _cfgAt = Date.now(); }
  return _cfg;
};
const models = async () => {
  if (!_models || Date.now() - _modelsAt > TTL_MS) { _models = (await getJson('/api/models')).models; _modelsAt = Date.now(); }
  return _models;
};
async function costOf(id) { const m = (await models()).find((x) => x.id === id); if (!m) throw new Error(`Unknown model: ${id}`); return m; }

// pay `hero` $HERO to the gateway's collection wallet, return the tx hash
async function payHero(hero) {
  if (!wallet) throw new Error("Set AGENT_PRIVATE_KEY to pay for model runs.");
  const c = await cfg();
  const amount = BigInt(Math.round(hero)) * (10n ** 18n);
  const hash = await wallet.writeContract({ address: c.tokenAddress, abi: ERC20, functionName: "transfer", args: [c.paymentAddress, amount] });
  await pub.waitForTransactionReceipt({ hash });
  return hash;
}
async function runModel(id, input, kind, consent) {
  const m = await costOf(id);
  const headers = { "Content-Type": "application/json" };
  let tx = null, paySignature = null;
  if (RUNKEY) headers["x-api-key"] = RUNKEY;             // prepaid credits, no gas
  else if (wallet) {
    tx = await payHero(m.hero);                          // per-call on-chain payment
    // Prove the payment is ours. A payment tx hash is public the moment it confirms, so without
    // this anyone watching Base can spend our payment on their own run before we use it.
    paySignature = await wallet
      .signMessage({ message: `Hero Run: authorize run payment ${String(tx).toLowerCase()}` })
      .catch(() => null);
  }
  else throw new Error("Set HERO_RUN_KEY (minted at /keys) or AGENT_PRIVATE_KEY to run models.");
  const r = await fetch(`${URL}/api/run`, { signal: AbortSignal.timeout(kind === "video" ? 300_000 : 180_000), method: "POST", headers, body: JSON.stringify({ model: id, input, kind: kind || m.kind, tx, paySignature, user: shortAddr, consent: !!consent }) });
  const d = await r.json();
  if (!r.ok) throw new Error(d.error || "run failed");
  return { ...d, spentHero: m.hero };
}

// Newest first. initialize echoes whichever of these the client asked for.
const SUPPORTED = ["2026-07-28", "2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];

const TOOLS = {
  list_models: {
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    description: "List the AI models available through the Hero Run gateway (440+), optionally filtered by kind (text|image|video|audio). Tip: append @gateway to any model id (e.g. openai/gpt-oss-120b@cerebras) to pin a specific gateway.",
    inputSchema: { type: "object", properties: { kind: { type: "string", enum: ["text", "image", "video", "audio", "all"] } } },
    async run({ kind = "all" }) {
      const rows = await models();
      const f = kind === "all" ? rows : rows.filter((r) => r.kind === kind);
      // Say when the list was cut. It printed the full count and then rendered 60 rows with no
      // signal, so a model was told "450 models", shown 60, and reasoned as though it had seen the
      // catalog — concluding a model was unavailable when it was simply below the fold.
      const SHOWN = 60;
      const cut = f.length > SHOWN ? `, showing the first ${SHOWN} — use pick_model to search the rest` : "";
      return { text: `${f.length} models${cut}. Each costs $HERO per run (paid from your wallet).\n` +
        f.slice(0, SHOWN).map((r) => `${String(r.hero).padStart(9)} $HERO · ${r.kind.padEnd(5)} ${r.id}`).join("\n") };
    },
  },
  pick_model: {
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    description: "Choose a model for a task WITHOUT spending anything. Narrows the 440-model catalog to a ranked shortlist using kind, budget, context window and words from the task, so you pick with the task in front of you instead of guessing from a dump of 60 rows. Reads the catalog only, costs nothing. Follow up with run_text or consult.",
    inputSchema: {
      type: "object", required: ["task"],
      properties: {
        task: { type: "string", description: "What the model has to do, in a sentence." },
        kind: { type: "string", enum: ["text", "image", "video", "audio"], description: "Default text." },
        prefer: { type: "string", enum: ["cheap", "fast", "smart", "balanced"], description: "Default balanced. 'smart' ranks by price and context as a proxy for capability, which is a correlation and not a guarantee." },
        max_hero: { type: "number", description: "Skip anything costing more than this per run." },
        min_context: { type: "number", description: "Minimum context window in tokens." },
        limit: { type: "number", description: "Shortlist size, default 8." },
      },
    },
    async run({ task, kind = "text", prefer = "balanced", max_hero, min_context, limit = 8 }) {
      const rows = (await models()).filter((m) => m.kind === kind);
      const pool = rows.filter((m) =>
        (max_hero == null || Number(m.hero) <= max_hero) &&
        (min_context == null || Number(m.ctx || 0) >= min_context));
      if (!pool.length) return { text: `No ${kind} model matches those limits. ${rows.length} exist for that kind; loosen max_hero or min_context.` };

      // Score task words against id, name and description. Crude on purpose: it surfaces
      // specialists ("coder", "vision", "search") that a price sort alone would bury.
      const stop = new Set("the a an and or of to for with in on at is are be do does this that i we you it my our your me us as by from into about".split(" "));
      const words = [...new Set(String(task).toLowerCase().match(/[a-z0-9.+-]{3,}/g) || [])].filter((w) => !stop.has(w));
      const relevance = (m) => {
        const hay = `${m.id} ${m.name || ""} ${m.desc || ""}`.toLowerCase();
        return words.reduce((s, w) => s + (hay.includes(w) ? 1 : 0), 0);
      };

      const cost = (m) => Number(m.hero) || 0;
      const speed = (m) => Number(m.speed) || 0;
      const ctx = (m) => Number(m.ctx) || 0;
      const maxCost = Math.max(...pool.map(cost), 1);
      const maxCtx = Math.max(...pool.map(ctx), 1);
      const maxSpd = Math.max(...pool.map(speed), 1);

      const score = (m) => {
        const rel = relevance(m);
        if (prefer === "cheap") return rel * 2 - cost(m) / maxCost;
        if (prefer === "fast") return rel * 2 + speed(m) / maxSpd;
        if (prefer === "smart") return rel * 2 + cost(m) / maxCost + ctx(m) / maxCtx;
        return rel * 3 + ctx(m) / maxCtx - cost(m) / maxCost;   // balanced: value for money
      };

      // Diversify by provider. A shortlist that is four near-identical siblings from one lab is
      // not a choice, and for `consult` it is actively misleading: siblings agree with each other
      // rather than with reality. Two per provider first, then backfill if that leaves gaps.
      const ranked = [...pool].sort((a, b) => score(b) - score(a));
      const want = Math.max(1, Math.min(limit, 20));
      const perProvider = new Map();
      const short = [];
      for (const m of ranked) {
        if (short.length >= want) break;
        const p = m.provider || m.gateway || m.id.split("/")[0];
        const n = perProvider.get(p) || 0;
        if (n >= 2) continue;
        perProvider.set(p, n + 1);
        short.push(m);
      }
      for (const m of ranked) {
        if (short.length >= want) break;
        if (!short.includes(m)) short.push(m);
      }
      const lines = short.map((m) => {
        const bits = [`${String(m.hero).padStart(9)} $HERO`, m.gateway || "?"];
        if (ctx(m)) bits.push(`${Math.round(ctx(m) / 1000)}k ctx`);
        if (relevance(m)) bits.push(`matches: ${words.filter((w) => `${m.id} ${m.name || ""} ${m.desc || ""}`.toLowerCase().includes(w)).slice(0, 3).join("/")}`);
        return `${m.id}\n    ${bits.join(" · ")}\n    ${(m.desc || "").slice(0, 130)}`;
      });
      return { text:
        `${short.length} of ${pool.length} candidate ${kind} models, ranked for "${String(task).slice(0, 80)}" (prefer: ${prefer}).\n` +
        `Ranking is heuristic: it reads price, context, speed and keyword overlap, not benchmarks. Pick with your own judgement.\n\n` +
        lines.join("\n\n") +
        `\n\n"auto" is always available and lets the router pick at one flat price.` };
    },
  },
  consult: {
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    description: "Ask 2 to 4 models the SAME prompt in parallel and return every answer side by side. Use when independent disagreement is the signal you want: a second opinion on a judgement call, a design tradeoff, or checking whether a claim survives contact with a different model. Pays $HERO for each model, so the cost is the sum. For one model use run_text.",
    inputSchema: {
      type: "object", required: ["prompt", "models"],
      properties: {
        prompt: { type: "string" },
        models: { type: "array", items: { type: "string" }, description: "2 to 4 model ids. Prefer models from different providers; two siblings tend to agree with each other rather than with reality." },
        consent: { type: "boolean", description: "opt in to contribute this to open training data" },
      },
    },
    async run({ prompt, models: ids, consent }) {
      if (!Array.isArray(ids) || ids.length < 2) throw new Error("consult needs at least 2 model ids. Use run_text for a single model.");
      if (ids.length > 4) throw new Error("consult takes at most 4 models; past that the spend grows faster than the signal.");

      // Price every model before running any, so an unknown id fails free rather than
      // after two of its siblings have already been paid for.
      const priced = await Promise.all(ids.map(costOf));
      const quoted = priced.reduce((s, m) => s + Number(m.hero || 0), 0);

      const settled = await Promise.allSettled(ids.map((id) => runModel(id, prompt, "text", consent)));
      let spent = 0;
      const blocks = settled.map((r, i) => {
        if (r.status === "fulfilled") {
          spent += Number(r.value.spentHero || 0);
          return `### ${ids[i]}\n${(r.value.text || "(empty answer)").trim()}`;
        }
        return `### ${ids[i]}\nFAILED: ${String(r.reason?.message || r.reason).slice(0, 200)}`;
      });
      const ok = settled.filter((r) => r.status === "fulfilled").length;
      return { text:
        `${ok} of ${ids.length} models answered. Quoted ${quoted} $HERO, spent ${spent} $HERO.\n` +
        `These are independent opinions, not verdicts. Where they disagree, that is the useful part; where they agree they may still all be wrong.\n\n` +
        blocks.join("\n\n") };
    },
  },
  run_text: {
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    description: "Run a text model and return its completion. Pays $HERO from your wallet. Default model: anthropic/claude-fable-5.",
    inputSchema: { type: "object", required: ["prompt"], properties: { prompt: { type: "string" }, model: { type: "string" }, consent: { type: "boolean", description: "opt in to contribute this to open training data" } } },
    async run({ prompt, model = "anthropic/claude-fable-5", consent }) {
      const o = await runModel(model, prompt, "text", consent);
      return { text: `${o.text || ""}\n\n— ${model} · spent ${o.spentHero} $HERO${o.tx ? ` · ${o.tx}` : ""}` };
    },
  },
  generate_image: {
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    description: "Generate an image (default Nano Banana 2 / google/gemini-3-pro-image). Pays $HERO from your wallet.",
    inputSchema: { type: "object", required: ["prompt"], properties: { prompt: { type: "string" }, model: { type: "string" }, consent: { type: "boolean" } } },
    async run({ prompt, model = "google/gemini-3-pro-image", consent }) {
      const o = await runModel(model, prompt, "image", consent);
      if (!o.image) throw new Error("model returned no image");
      // Gateways disagree on the shape. OpenRouter returns a `data:` URI; WaveSpeed, FLUX and the
      // rest return a plain https URL. This only handled the first, so every URL-returning gateway
      // produced `{type:"image", mimeType:"image/png"}` with NO data field: an empty image block,
      // reported as success. MCP image content has to be base64, so fetch the URL case.
      const inline = o.image.match(/^data:([^;]+);base64,(.+)$/);
      if (inline) return { image: { data: inline[2], mimeType: inline[1] } };
      const res = await fetch(o.image);
      if (!res.ok) throw new Error(`generated image could not be fetched (${res.status}) — ${o.image}`);
      const bytes = Buffer.from(await res.arrayBuffer());
      if (!bytes.length) throw new Error(`generated image was empty — ${o.image}`);
      return { image: { data: bytes.toString("base64"), mimeType: res.headers.get("content-type") || "image/png" } };
    },
  },
  generate_video: {
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    description: "Generate a short video clip (~5s; default Wan 2.2 480p ultra-fast at ~$0.05, premium options via list_models kind video). Pays $HERO. Returns the clip URL — can take 1-3 minutes.",
    inputSchema: { type: "object", required: ["prompt"], properties: { prompt: { type: "string" }, model: { type: "string" }, consent: { type: "boolean" } } },
    async run({ prompt, model = "wavespeed-ai/wan-2.2/t2v-480p-ultra-fast", consent }) {
      const o = await runModel(model, prompt, "video", consent);
      if (!o.video) throw new Error("model returned no video");
      return { text: `Video ready: ${o.video}\n— ${model} · spent ${o.spentHero} $HERO${o.tx ? ` · ${o.tx}` : ""}` };
    },
  },
  generate_audio: {
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    description: "Generate speech (default openai/gpt-audio-mini) or music (google/lyria-3-clip-preview). Pays $HERO. Returns playable WAV audio plus the transcript.",
    inputSchema: { type: "object", required: ["prompt"], properties: { prompt: { type: "string" }, model: { type: "string" }, consent: { type: "boolean" } } },
    async run({ prompt, model = "openai/gpt-audio-mini", consent }) {
      const o = await runModel(model, prompt, "audio", consent);
      if (!o.audio) throw new Error("model returned no audio");
      const [, mime] = o.audio.match(/^data:([^;]+);base64,/) || [];
      return { audio: { data: o.audio.split(",")[1], mimeType: mime || "audio/wav" }, text: `${o.text || "(audio)"}\n— ${model} · spent ${o.spentHero} $HERO` };
    },
  },
  treasury_stats: {
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    description: "Read the Hero Run treasury: claimable fees funding open-source AI (live from Base).",
    inputSchema: { type: "object", properties: {} },
    async run() {
      const t = await (await fetch(`${URL}/api/treasury`)).json();
      return { text: `Treasury ${t.treasury} · ${t.share} creator share\nClaimable: ${t.claimable?.token0} WETH + ${t.claimable?.token1} HERO` };
    },
  },
  agent_mint: {
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    description: "Spin up a NEW agent: mints an agent NFT on Robinhood Chain that you own, with its own encrypted memory. This is the unit of delegation — give each long-running job its own agent and it keeps its own durable context, readable by any harness you point at that id. Costs a little RH gas. Needs the agent wallet (HERO_AGENT_KEY_FILE or AGENT_PRIVATE_KEY).",
    inputSchema: {
      type: "object", required: ["label"],
      properties: { label: { type: "string", description: "Short name for the agent, e.g. 'refactor-auth' or 'nightly-triage'." } },
    },
    async run({ label }) {
      const name = String(label || "").trim();
      if (!name) throw new Error("A label is required — it is how you will recognise this agent later.");
      const { wallet, account } = await rhSigner();
      const before = await ownedAgents(account.address);
      const tx = await sendRh(wallet, account, encodeFunctionData({ abi: AGENT_ABI, functionName: "mint", args: [name] }));
      // The mint event is the source of truth for the new id; diffing owned ids avoids depending on
      // a return value the contract does not actually give us through sendTransaction.
      const after = await ownedAgents(account.address);
      const id = after.find((x) => !before.includes(x)) ?? (after.length ? Math.max(...after) : null);
      return { text: `Agent #${id} "${name}" minted on Robinhood Chain, owned by ${account.address}.\nhttps://robinhoodchain.blockscout.com/tx/${tx}\n\nUse it: memory_write / memory_read with agent_id ${id}, or set HERO_AGENT_ID=${id}.` };
    },
  },
  agent_list: {
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    description: "List the agents your wallet owns, with how many memory checkpoints each holds. Use this to find an existing agent before minting another.",
    inputSchema: { type: "object", properties: {} },
    async run() {
      const { account } = await rhSigner();
      const ids = await ownedAgents(account.address);
      if (!ids.length) return { text: `${account.address} owns no agents yet. Mint one with agent_mint.` };
      const rows = await Promise.all(ids.map(async (id) => {
        const head = await rhPub.call({ to: MEM_CONTRACT, data: "0x5ad8a111" + BigInt(id).toString(16).padStart(64, "0") }).catch(() => null);
        const hex = (head?.data || "").replace(/^0x/, "").padEnd(256, "0");
        const cps = hex ? Number(BigInt("0x" + hex.slice(64, 128))) : 0;
        return `  #${id} — ${cps} checkpoint${cps === 1 ? "" : "s"}`;
      }));
      return { text: `${account.address} owns ${ids.length} agent(s):\n${rows.join("\n")}` };
    },
  },
  sandbox_run: {
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    description: "Run a shell command in a fresh, isolated cloud sandbox and return its output. Nothing touches the caller's machine, so it is safe for untrusted code, throwaway installs, or work a swarm worker needs to actually execute. Needs your own E2B_API_KEY (e2b.dev) — the sandbox is billed to that key, not to $HERO.",
    inputSchema: {
      type: "object", required: ["command"],
      properties: {
        command: { type: "string", description: "Shell command to run, e.g. \"python3 -c 'print(2**64)'\"." },
        timeout_ms: { type: "number", description: "Kill the command after this long. Default 60000, max 300000." },
      },
    },
    async run({ command, timeout_ms }) {
      const cmd = String(command || "").trim();
      if (!cmd) throw new Error("Nothing to run.");
      // Deliberately the user's OWN E2B key, not ours. Compute is metered by the second and this
      // tool is callable in a loop; billing it to $HERO without a meter would be exactly the
      // sell-below-cost hole we just closed on inference. A $HERO-metered sandbox needs a billing
      // design first, not a convenient default.
      if (!process.env.E2B_API_KEY) {
        throw new Error("Set E2B_API_KEY (free tier at e2b.dev) in this MCP server's environment. Sandbox compute bills to your own E2B account — Hero Run does not meter it yet.");
      }
      const ms = Math.min(Math.max(Number(timeout_ms) || 60_000, 1_000), 300_000);
      let Sandbox;
      try { ({ Sandbox } = await import("@e2b/code-interpreter")); }
      catch { throw new Error("Sandboxes need the e2b SDK: npm i @e2b/code-interpreter in " + process.cwd()); }
      const sbx = await Sandbox.create({ apiKey: process.env.E2B_API_KEY });
      try {
        // timeoutMs is passed explicitly: the SDK default is 60s and a longer command dies silently
        // at the one-minute mark, which reads as the command failing rather than being cut off.
        const r = await sbx.commands.run(cmd, { timeoutMs: ms });
        const body = [r.stdout && `stdout:\n${r.stdout}`, r.stderr && `stderr:\n${r.stderr}`].filter(Boolean).join("\n\n");
        return { text: `exit ${r.exitCode}\n\n${body || "(no output)"}` };
      } finally {
        await sbx.kill().catch(() => {}); // never leave a sandbox billing after the call returns
      }
    },
  },
  swarm_spawn: {
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    description: "Spin up a swarm: mint one agent per slice of work and seed each with its brief as an on-chain task:: entry. Returns the agent ids. Each worker owns its own durable memory, so a harness can drive them in parallel, walk away, and pick the results up later from any machine with swarm_collect. Costs a little RH gas per agent.",
    inputSchema: {
      type: "object", required: ["label", "slices"],
      properties: {
        label: { type: "string", description: "Swarm name, e.g. 'migrate-auth'. Workers are labelled <name>-0, <name>-1, …" },
        slices: { type: "array", items: { type: "string" }, description: "One brief per worker. Each becomes that agent's task." },
      },
    },
    async run({ label, slices }) {
      const name = String(label || "").trim();
      if (!name) throw new Error("A swarm label is required.");
      const work = (Array.isArray(slices) ? slices : []).map((s) => String(s || "").trim()).filter(Boolean);
      if (!work.length) throw new Error("Give at least one slice of work.");
      // Bounded on purpose. Every worker is a real transaction and real gas, and an agent asked to
      // "parallelise this" will happily request a hundred. A cap turns a bad prompt into a small
      // bill instead of an incident.
      if (work.length > SWARM_MAX) throw new Error(`At most ${SWARM_MAX} workers per swarm (asked for ${work.length}). Split the job or run a second swarm.`);
      const { wallet, account } = await rhSigner();
      const out = [];
      let failed = null;
      for (let i = 0; i < work.length && !failed; i++) {
        try {
          const before = await ownedAgents(account.address);
          await sendRh(wallet, account, encodeFunctionData({ abi: AGENT_ABI, functionName: "mint", args: [`${name}-${i}`] }));
          const after = await ownedAgents(account.address);
          const id = after.find((x) => !before.includes(x)) ?? Math.max(...after);
          const mem = await memory(id);
          const seed = await mem.append([{ role: "system", text: `task::${JSON.stringify({ swarm: name, index: i, brief: work[i], at: new Date().toISOString() })}` }]);
          await rhPub.waitForTransactionReceipt({ hash: seed }).catch(() => {}); // readable before we return

          out.push({ id, brief: work[i] });
        } catch (e) { failed = { index: i, message: e.message }; }
      }
      // Never throw away a partial swarm. Minting is irreversible and costs gas, so an agent created
      // before the failure exists whether or not this call succeeds — reporting only the error would
      // orphan it, leaving the caller paying for workers it does not know it has.
      if (failed) {
        const made = out.length
          ? `Created ${out.length} worker(s) before failing: ${out.map((w) => "#" + w.id).join(", ")}. They are real and yours — reuse or ignore them, but they exist.\n\n`
          : "No workers were created.\n\n";
        throw new Error(`${made}Worker ${failed.index} failed: ${failed.message}`);
      }
      // Tell the shared worker about the swarm so the workers run THEMSELVES. Chain discovery from
      // the worker was tried first and hung on RH's rate limits; the registry is one subrequest.
      // Registration failing is not a failed spawn — the agents exist and can be driven by hand —
      // but it must be SAID, or the caller waits forever for a cron that does not know about them.
      let autonomy = "";
      if (RUNKEY) {
        try {
          const rr = await fetch(`${URL}/api/swarm/register`, {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${RUNKEY}` },
            body: JSON.stringify({ label: name, agentIds: out.map((w) => w.id) }),
          });
          const rd = await rr.json().catch(() => ({}));
          autonomy = rr.ok
            ? `\nRegistered as "${rd.swarmId}" — the cloud worker will execute each task within ~5 minutes. Just swarm_collect later.`
            : `\n⚠ Could not register for autonomous execution (${rd.error || rr.status}). Drive the workers with run_text, or re-register later.`;
        } catch (e) { autonomy = `\n⚠ Could not register for autonomous execution (${e.message}). Drive the workers with run_text.`; }
      } else {
        autonomy = "\n⚠ No HERO_RUN_KEY set, so the swarm was not registered for autonomous execution.";
      }
      return {
        text: `Swarm "${name}" spun up with ${out.length} worker(s):\n` +
          out.map((w) => `  #${w.id} — ${w.brief.slice(0, 70)}${w.brief.length > 70 ? "…" : ""}`).join("\n") +
          autonomy +
          `\n\nCollect results with swarm_collect agent_ids [${out.map((w) => w.id).join(", ")}].`,
      };
    },
  },
  swarm_collect: {
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    description: "Read back a swarm: for each agent, its task:: brief and any handoff:: results it recorded. Use this to gather parallel work, or at the start of a session to recover a swarm you left running.",
    inputSchema: {
      type: "object", required: ["agent_ids"],
      properties: { agent_ids: { type: "array", items: { type: "number" }, description: "The ids swarm_spawn returned." } },
    },
    async run({ agent_ids }) {
      const ids = (Array.isArray(agent_ids) ? agent_ids : []).map(Number).filter(Number.isInteger);
      if (!ids.length) throw new Error("Pass the agent ids to collect.");
      const parts = [];
      let pending = 0;
      for (const id of ids) {
        try {
          const entries = await (await memory(id)).raw();
          const task = entries.filter((e) => e.text?.startsWith("task::")).pop();
          const results = entries.filter((e) => e.text?.startsWith("handoff::"));
          let brief = "";
          try { brief = JSON.parse(task.text.slice(6)).brief; } catch { brief = task?.text?.slice(6) || "(no task recorded)"; }
          if (!results.length) pending++;
          parts.push(`#${id} — ${brief}\n` + (results.length
            ? results.map((r) => {
                // Handoffs come in two shapes: JSON {text, spentHero, failed} (workers that report
                // cost) and the legacy bare string. Read both, show cost when it is known.
                const raw = r.text.slice(9);
                try { const j = JSON.parse(raw); return `   ${j.failed ? "✗" : "✓"} ${j.text}${Number.isFinite(j.spentHero) ? ` (${j.spentHero.toLocaleString()} $HERO)` : ""}`; }
                catch { return "   ✓ " + raw; }
              }).join("\n")
            : "   … no handoff:: recorded yet"));
        } catch (e) { parts.push(`#${id} — unreadable (${e.message})`); }
      }
      // Say plainly how much is still outstanding. A partial collection that reads as complete is
      // how a caller ends up summarising half a swarm as if it were the whole answer.
      return { text: `${ids.length} worker(s), ${pending} still without a result:\n\n${parts.join("\n\n")}` };
    },
  },
  file_save: {
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    description: "Save a FILE (code, config, any artifact) into an agent's on-chain memory, content-addressed by sha256. This is how code produced in a mission survives the machine that wrote it: inline in the encrypted checkpoint log up to 128KB, readable back byte-identical from any machine with the wallet key via file_get. For bigger files pass a uri pointer instead (R2/IPFS/https) and only the hash goes on-chain. Costs RH gas (~$0.005).",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Local file path to read and attach (the MCP server runs on this machine)." },
        content: { type: "string", description: "Alternative to path: the file content as a UTF-8 string." },
        name: { type: "string", description: "Filename to record. Defaults to the path's basename." },
        uri: { type: "string", description: "Store a POINTER instead of bytes: the file stays at this uri, only {sha256, uri} goes on-chain. Requires path or content to hash." },
        agent_id: { type: "string", description: "Agent to attach to. Defaults to HERO_AGENT_ID." },
      },
    },
    async run({ path, content, name, uri, agent_id }) {
      if (!path && content == null) throw new Error("Give a path or content.");
      const { readFile } = await import("node:fs/promises");
      const { basename, extname } = await import("node:path");
      const buf = path ? await readFile(path) : Buffer.from(String(content), "utf8");
      const fileName = name || (path ? basename(path) : "file.txt");
      const MIME = { ".js": "text/javascript", ".mjs": "text/javascript", ".ts": "text/plain", ".rs": "text/plain", ".py": "text/plain", ".json": "application/json", ".md": "text/markdown", ".html": "text/html", ".txt": "text/plain", ".css": "text/css" };
      let files;
      try { files = await import(`${HERO_AGENT_PATH}/src/files.mjs`); }
      catch { throw new Error(`Could not load the file store from ${HERO_AGENT_PATH} — clone hero-agent there or set HERO_AGENT_PATH.`); }
      const entry = uri
        ? files.makeFilePointerEntry({ name: fileName, mime: MIME[extname(fileName)] || "application/octet-stream", size: buf.length, sha256: files.sha256hex(buf), uri })
        : files.makeFileEntry(buf, { name: fileName, mime: MIME[extname(fileName)] || "application/octet-stream" });
      const mem = await memory(agent_id);
      const hash = await mem.append([entry]);
      await rhPub.waitForTransactionReceipt({ hash }).catch(() => {});
      const sha = JSON.parse(entry.text.slice(6)).sha256;
      return { text: `File "${fileName}" (${(buf.length / 1024).toFixed(1)}KB, sha256 ${sha.slice(0, 16)}…) saved to agent ${agent_id ?? AGENT_ID}${uri ? ` as a pointer to ${uri}` : " inline, encrypted on-chain"}.\nhttps://robinhoodchain.blockscout.com/tx/${hash}\n\nRecover it anywhere with file_get "${sha.slice(0, 12)}" or by name.` };
    },
  },
  file_list: {
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    description: "List the files attached to an agent's memory: name, size, sha256, and whether the bytes are inline on-chain or an off-chain pointer.",
    inputSchema: { type: "object", properties: { agent_id: { type: "string", description: "Defaults to HERO_AGENT_ID." } } },
    async run({ agent_id }) {
      let files;
      try { files = await import(`${HERO_AGENT_PATH}/src/files.mjs`); } catch { throw new Error("file store unavailable — set HERO_AGENT_PATH"); }
      const found = files.parseFiles(await (await memory(agent_id)).raw());
      if (!found.size) return { text: `No files on agent ${agent_id ?? AGENT_ID}. Save one with file_save.` };
      return { text: `${found.size} file(s) on agent ${agent_id ?? AGENT_ID}:\n` + [...found.values()].map((f) => `  ${f.sha256.slice(0, 12)}  ${((f.size / 1024).toFixed(1) + "KB").padEnd(8)} ${(f.uri ? "pointer" : "inline").padEnd(8)} ${f.name}`).join("\n") };
    },
  },
  file_get: {
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    description: "Recover a file from an agent's memory by sha256 prefix or name. Inline files come back byte-identical (hash-verified); pointer files return their uri. Optionally write to a local path.",
    inputSchema: {
      type: "object", required: ["ref"],
      properties: {
        ref: { type: "string", description: "sha256 (or prefix) or the filename." },
        out: { type: "string", description: "Local path to write the recovered bytes to." },
        agent_id: { type: "string", description: "Defaults to HERO_AGENT_ID." },
      },
    },
    async run({ ref, out, agent_id }) {
      let files;
      try { files = await import(`${HERO_AGENT_PATH}/src/files.mjs`); } catch { throw new Error("file store unavailable — set HERO_AGENT_PATH"); }
      const entries = await (await memory(agent_id)).raw();
      // extractFile matches full sha256 or exact name; resolve a prefix to the full hash first so
      // the "recover with the first 12 chars" promise in file_save's output actually holds.
      let key = ref;
      if (/^[0-9a-f]{6,63}$/i.test(ref)) {
        const hit = [...files.parseFiles(entries).keys()].find((h) => h.startsWith(ref.toLowerCase()));
        if (hit) key = hit;
      }
      const f = files.extractFile(entries, key);
      if (!f) throw new Error(`No file matching "${ref}" on agent ${agent_id ?? AGENT_ID}. See file_list.`);
      if (f.external) return { text: `"${f.name}" is a pointer: bytes live at ${f.uri} (sha256 ${f.sha256.slice(0, 16)}… verifies them).` };
      const buf = f.buf; // extractFile returns decoded bytes with its own verification verdict
      if (f.verified === false) throw new Error(`Hash mismatch recovering "${f.name}" — refusing to return tampered bytes.`);
      if (out) { const { writeFile } = await import("node:fs/promises"); await writeFile(out, buf); return { text: `"${f.name}" (${(buf.length / 1024).toFixed(1)}KB) recovered, hash-verified, written to ${out}.` }; }
      const text = buf.toString("utf8");
      return { text: `"${f.name}" (${(buf.length / 1024).toFixed(1)}KB, hash-verified):\n\n${text.slice(0, 4000)}${text.length > 4000 ? "\n… (truncated for display; use out to write the full file)" : ""}` };
    },
  },
  web_search: {
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    description: "Search the web and get back ranked results (title, url, snippet). The first step of a research pipeline: search a topic, then web_scrape the hits, then run_text to synthesize, then memory_write/file_save to keep what you learned. Uses YOUR Firecrawl key (fc-…), billed to your Firecrawl account, not $HERO.",
    inputSchema: {
      type: "object", required: ["query"],
      properties: { query: { type: "string" }, limit: { type: "number", description: "Max results, default 10, cap 30." } },
    },
    async run({ query, limit = 10 }) {
      const key = process.env.FIRECRAWL_API_KEY;
      if (!key) throw new Error("Set FIRECRAWL_API_KEY (fc-… from firecrawl.dev) in this server's environment. Web crawl bills to your Firecrawl account, not $HERO.");
      const r = await fetch("https://api.firecrawl.dev/v1/search", {
        method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
        body: JSON.stringify({ query, limit: Math.min(Math.max(1, limit), 30) }),
        signal: AbortSignal.timeout(60_000),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || `Firecrawl search ${r.status}`);
      const rows = (d.data || d.results || []).map((x) => `- ${x.title || "(untitled)"}\n  ${x.url}\n  ${(x.description || x.snippet || "").slice(0, 160)}`);
      return { text: rows.length ? `${rows.length} results for "${query}":\n\n${rows.join("\n")}` : `No results for "${query}".` };
    },
  },
  web_scrape: {
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    description: "Fetch one URL as clean markdown — handles HTML pages AND PDFs (Firecrawl extracts PDF text). This is the crawl step: point it at a document from web_search and get readable content back to feed run_text. Uses YOUR Firecrawl key.",
    inputSchema: {
      type: "object", required: ["url"],
      properties: { url: { type: "string" }, max_chars: { type: "number", description: "Truncate the returned text, default 12000." } },
    },
    async run({ url, max_chars = 12000 }) {
      const key = process.env.FIRECRAWL_API_KEY;
      if (!key) throw new Error("Set FIRECRAWL_API_KEY (fc-… from firecrawl.dev) in this server's environment.");
      const r = await fetch("https://api.firecrawl.dev/v1/scrape", {
        method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
        body: JSON.stringify({ url, formats: ["markdown"] }),
        signal: AbortSignal.timeout(120_000),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || `Firecrawl scrape ${r.status}`);
      const md = d.data?.markdown || d.markdown || "";
      if (!md) return { text: `Fetched ${url} but got no extractable text (a paywall, an image-only PDF, or a JS wall).` };
      const cap = Math.min(Math.max(1000, max_chars), 40_000);
      return { text: `# ${d.data?.metadata?.title || url}\n${url}\n\n${md.slice(0, cap)}${md.length > cap ? `\n\n…(${md.length - cap} more chars — raise max_chars or scrape the section you need)` : ""}` };
    },
  },
  memory_write: {
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    description: "Mint a memory: encrypt a note and write it as a checkpoint on Robinhood Chain, owned by your agent NFT. This is what makes a coding session durable — anything written here survives the session and is readable by every other harness pointed at the same agent. Costs a little RH gas (~$0.003). Needs AGENT_PRIVATE_KEY and HERO_AGENT_ID.",
    inputSchema: {
      type: "object", required: ["text"],
      properties: {
        text: { type: "string", description: "What to remember. Write the durable fact, not the conversation." },
        role: { type: "string", enum: ["user", "agent", "system"], description: "Who this came from. Defaults to agent." },
        agent_id: { type: "string", description: "Agent NFT id. Defaults to HERO_AGENT_ID." },
      },
    },
    async run({ text, role = "agent", agent_id }) {
      if (!String(text || "").trim()) throw new Error("Nothing to remember — 'text' is empty.");
      const mem = await memory(agent_id);
      const hash = await mem.append([{ role, text: String(text) }]);
      // append() returns as soon as the tx is broadcast, and waiting for the RECEIPT is still not
      // enough: RH's read replicas lag behind inclusion, so a read issued straight afterwards misses
      // the checkpoint. Measured twice — swarm_collect reported "no result recorded" for a write
      // that had already landed, first without the receipt wait and again with it. A caller acting
      // on that redoes the work or concludes the memory was lost.
      //
      // So confirm by READING IT BACK, which is the only check that matches what the next caller
      // will actually do. Bounded, and honest when it does not converge: a slow read is not a
      // failed write, and claiming either one wrongly is worse than saying which happened.
      await rhPub.waitForTransactionReceipt({ hash }).catch(() => {});
      let visible = false;
      for (let i = 0; i < 8 && !visible; i++) {
        await new Promise((r) => setTimeout(r, 1000));
        visible = (await mem.raw().catch(() => [])).some((e) => e.text === String(text));
      }
      if (!visible) {
        return { text: `Memory written and confirmed on chain (agent ${agent_id ?? AGENT_ID}), but the read replica has not caught up yet.\nhttps://robinhoodchain.blockscout.com/tx/${hash}\n\nThe write is safe — do NOT retry it. It will appear in memory_read shortly.` };
      }
      return { text: `Memory minted on Robinhood Chain (agent ${agent_id ?? AGENT_ID}).\nhttps://robinhoodchain.blockscout.com/tx/${hash}\n\nEncrypted with your wallet's key before it left this machine — on-chain observers see random bytes.` };
    },
  },
  memory_read: {
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    description: "Read your agent's memory back: walks the on-chain checkpoint chain, verifies the hash links, and decrypts. Use this at the START of a session to recover what past sessions learned. Needs AGENT_PRIVATE_KEY and HERO_AGENT_ID.",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "number", description: "How many of the most recent entries to return. Default 20." },
        agent_id: { type: "string", description: "Agent NFT id. Defaults to HERO_AGENT_ID." },
      },
    },
    async run({ limit = 20, agent_id }) {
      const mem = await memory(agent_id);
      const all = await mem.raw();
      if (!all.length) return { text: "No memories yet for this agent. Write one with memory_write." };
      const rows = all.slice(-Math.max(1, Math.min(200, limit)));
      return { text: `${all.length} memories on chain, showing the last ${rows.length}:\n\n` + rows.map((e) => `[${e.role}] ${e.text}`).join("\n") };
    },
  },
  wallet_balance: {
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    description: "Your $HERO balance: prepaid API-key credits (HERO_RUN_KEY) or on-chain wallet balance (AGENT_PRIVATE_KEY).",
    inputSchema: { type: "object", properties: {} },
    async run() {
      if (RUNKEY) {
        const r = await fetch(`${URL}/api/keys/info`, { headers: { "x-api-key": RUNKEY } });
        const d = await r.json();
        if (!r.ok) return { text: `API key error: ${d.error || "invalid key"}` };
        return { text: `Prepaid API key\n${Number(d.balance).toLocaleString()} $HERO credits available (deposited ${Number(d.deposited).toLocaleString()}, spent ${Number(d.spent).toLocaleString()})` };
      }
      if (!account) return { text: "No HERO_RUN_KEY or AGENT_PRIVATE_KEY set — read-only mode." };
      const c = await cfg();
      const hero = await pub.readContract({ address: c.tokenAddress, abi: [{ name: "balanceOf", type: "function", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] }], functionName: "balanceOf", args: [account.address] });
      const eth = await pub.getBalance({ address: account.address });
      return { text: `${account.address}\n${(Number(hero) / 1e18).toLocaleString()} $HERO · ${(Number(eth) / 1e18).toFixed(5)} ETH` };
    },
  },
  bridge_to_robinhood: {
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    description: "Bridge $HERO from Base to Robinhood Chain. Locks your HERO in a LayerZero lockbox on Base; the same amount mints 1:1 on Robinhood Chain, delivered automatically in ~1-2 min. Needs AGENT_PRIVATE_KEY with HERO + a little ETH on Base for gas.",
    inputSchema: { type: "object", required: ["amount"], properties: { amount: { type: "string", description: "HERO amount, e.g. '1000000'" } } },
    async run({ amount }) {
      if (!wallet) throw new Error("Set AGENT_PRIVATE_KEY to bridge.");
      const amt = parseUnits(String(amount), 18);
      const hash = await bridgeSend({ w: wallet, p: pub, tokenAddr: BR.hero, spendAddr: BR.adapter, dstEid: BR.eidRH, amt, viaAdapter: true });
      return { text: `Bridged ${amount} HERO Base → Robinhood Chain.\nLocked on Base: https://basescan.org/tx/${hash}\nMints 1:1 to ${account.address} on Robinhood Chain within ~1-2 min (delivery auto-finalizes).` };
    },
  },
  bridge_to_base: {
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    description: "Bridge $HERO from Robinhood Chain back to Base. Burns your HERO on Robinhood Chain; the same amount unlocks 1:1 on Base. Needs AGENT_PRIVATE_KEY with HERO + a little ETH on Robinhood Chain for gas.",
    inputSchema: { type: "object", required: ["amount"], properties: { amount: { type: "string", description: "HERO amount, e.g. '1000000'" } } },
    async run({ amount }) {
      if (!rhWallet) throw new Error("Set AGENT_PRIVATE_KEY to bridge.");
      const amt = parseUnits(String(amount), 18);
      const hash = await bridgeSend({ w: rhWallet, p: rhPub, tokenAddr: BR.oft, spendAddr: BR.oft, dstEid: BR.eidBase, amt, viaAdapter: false });
      return { text: `Bridged ${amount} HERO Robinhood Chain → Base.\nBurned on RH: https://robinhoodchain.blockscout.com/tx/${hash}\nUnlocks 1:1 to ${account.address} on Base within ~1-2 min.` };
    },
  },
  bridge_status: {
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    description: "Show your $HERO balance on both Base and Robinhood Chain (the bridged token).",
    inputSchema: { type: "object", properties: {} },
    async run() {
      if (!account) return { text: "Set AGENT_PRIVATE_KEY to check bridge balances." };
      const [b, r] = await Promise.all([
        pub.readContract({ address: BR.hero, abi: BAL_ABI, functionName: "balanceOf", args: [account.address] }),
        rhPub.readContract({ address: BR.oft, abi: BAL_ABI, functionName: "balanceOf", args: [account.address] }),
      ]);
      return { text: `${account.address}\nBase: ${(Number(b) / 1e18).toLocaleString()} HERO\nRobinhood Chain: ${(Number(r) / 1e18).toLocaleString()} HERO` };
    },
  },
};

// ---- minimal MCP (newline-delimited JSON-RPC 2.0 over stdio) ----
const send = (m) => process.stdout.write(JSON.stringify(m) + "\n");
const reply = (id, result) => send({ jsonrpc: "2.0", id, result });
const fail = (id, message, code = -32000) => send({ jsonrpc: "2.0", id, error: { code, message } });

export { TOOLS, SUPPORTED };
// Start the stdio loop only when run directly. The HTTP bridge imports { TOOLS } from this file,
// and an import that silently grabbed stdin would be a strange gift to give a caller.
const IS_MAIN = process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop());
if (IS_MAIN) createInterface({ input: process.stdin }).on("line", async (line) => {
  line = line.trim(); if (!line) return;
  let req; try { req = JSON.parse(line); } catch { return; }
  const { id, method, params } = req;
  try {
    if (method === "initialize") {
      // Echo the client's revision when we can speak it. We were pinned to 2024-11-05 while
      // returning audio content blocks, a type that revision does not define, so we advertised a
      // protocol we then violated.
      const asked = params?.protocolVersion;
      reply(id, {
        protocolVersion: SUPPORTED.includes(asked) ? asked : SUPPORTED[0],
        capabilities: { tools: {} },
        serverInfo: { name: "hero-run", version: "0.2.0" },
      });
    }
    else if (method === "notifications/initialized") { /* noop */ }
    // Liveness check. Defined in every revision including the one we used to claim, but it fell
    // through to "Unknown method", so a client pinging us got an error back.
    else if (method === "ping") reply(id, {});
    else if (method === "tools/list") reply(id, { ttlMs: 3_600_000, cacheScope: "server", tools: Object.entries(TOOLS).map(([name, t]) => ({
      name, description: t.description, inputSchema: t.inputSchema,
      ...(t.annotations ? { annotations: t.annotations } : {}),
    })) });
    else if (method === "tools/call") {
      const t = TOOLS[params?.name];
      // A missing tool genuinely IS a protocol error; -32602 is the right code for a bad param.
      if (!t) return fail(id, `Unknown tool: ${params?.name}`, -32602);
      try {
        const out = await t.run(params.arguments || {});
        const content = [];
        if (out.image) content.push({ type: "image", data: out.image.data, mimeType: out.image.mimeType });
        if (out.audio) content.push({ type: "audio", data: out.audio.data, mimeType: out.audio.mimeType });
        if (out.text || !content.length) content.push({ type: "text", text: out.text || "" });
        reply(id, { content });
      } catch (e) {
        // A tool that failed is not a broken protocol. `isError` puts the message in front of the
        // MODEL, which can act on it: "Unknown model: x" is something it fixes by calling
        // pick_model. Sent as a JSON-RPC error it never reaches the model and the turn just dies.
        reply(id, { content: [{ type: "text", text: e.message }], isError: true });
      }
    } else if (id != null) fail(id, `Unknown method: ${method}`, -32601);
  } catch (e) { if (id != null) fail(id, e.message); }
});
if (IS_MAIN) process.stderr.write(`Hero Run MCP → ${URL} · wallet ${account ? account.address : "read-only"}\n`);
