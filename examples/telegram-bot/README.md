# Hero Run Telegram bot (Go)

A tiny Telegram bot that lets you run **340+ AI models** from a chat, paid in **$HERO**.

It is also a working example of **consuming** the Hero Run MCP server: the bot spawns one of the MCP server implementations in this repo as a subprocess and talks JSON-RPC 2.0 over stdio, so every Telegram command becomes a real MCP `tools/call`. Zero external dependencies (stdlib `net/http` + `os/exec` + `encoding/json`).

```
Telegram  ──long poll──▶  bot (this)  ──stdio JSON-RPC──▶  Hero Run MCP server  ──HTTPS──▶  hero-run.vercel.app
```

## Commands

| Command | MCP tool | Notes |
|---|---|---|
| `/models [text\|image\|audio]` | `list_models` | free |
| `/ask <prompt>` | `run_text` | needs `HERO_RUN_KEY` |
| `/image <prompt>` | `generate_image` | needs `HERO_RUN_KEY`, returns a photo |
| `/treasury` | `treasury_stats` | free |
| `/balance` | `wallet_balance` | shows your prepaid credits |
| `/help` | — | usage |

Plain text (no slash) is treated as `/ask`.

## Run it

1. **Create a bot** with [@BotFather](https://t.me/BotFather) and copy the token.
2. **Build the MCP server** the bot will drive (any language works; Go is the default):
   ```bash
   (cd ../../go && go build -o hero-run-mcp .)
   ```
3. **Mint a key** at [hero-run.vercel.app/keys](https://hero-run.vercel.app/keys) so paid tools (`/ask`, `/image`) work.
4. **Start the bot:**
   ```bash
   export TELEGRAM_BOT_TOKEN=123456:ABC...
   export HERO_RUN_KEY=hr_live_...        # optional, for paid tools
   go run .
   ```

### Point it at a different MCP server

The bot drives whatever `MCP_CMD` names, so you can swap the runtime without touching the bot:

```bash
MCP_CMD="node ../../node/index.mjs"                  go run .   # Node
MCP_CMD="python3 ../../python/server.py"             go run .   # Python
MCP_CMD="../../zig/hero-run-mcp"                      go run .   # Zig
MCP_CMD="../../rust/target/release/hero-run-mcp"     go run .   # Rust
```

`HERO_RUN_KEY` (and `HERO_RUN_URL`) are inherited by the subprocess automatically.

## Deploy your own (always-on)

Run your own bot with your own BotFather token and your own $HERO key, so you pay for your own usage and nothing is shared. Two env vars, no ports (it long-polls Telegram).

**Docker** (builds both binaries into one image, run from the repo root):

```bash
docker build -f examples/telegram-bot/Dockerfile -t hero-run-bot .
docker run -d --restart=always \
  -e TELEGRAM_BOT_TOKEN=123456:ABC... \
  -e HERO_RUN_KEY=hr_live_... \
  --name hero-run-bot hero-run-bot
```

**Fly.io** (free-tier eligible, always-on worker), from the repo root:

```bash
fly launch --no-deploy --copy-config --config examples/telegram-bot/fly.toml
fly secrets set TELEGRAM_BOT_TOKEN=123456:ABC... HERO_RUN_KEY=hr_live_... -c examples/telegram-bot/fly.toml
fly deploy -c examples/telegram-bot/fly.toml
```

**Railway / Render / any container host:** point it at this repo, set the Dockerfile path to `examples/telegram-bot/Dockerfile`, and add the two env vars.

## Demo mode

Set `DEMO_MODE=1` to run a **public** bot without draining its key: `/image` is disabled and `/ask` is capped per user and in total (defaults `DEMO_USER_LIMIT=3`, `DEMO_TOTAL_LIMIT=20`, in-memory). Free tools (`/models`, `/treasury`, `/balance`) stay open. Users are pointed to run their own bot for unlimited paid tools. Leave `DEMO_MODE` unset for your own private bot.

## Notes

- The bot serializes requests over the single MCP stdio pipe (a mutex), so concurrent chat users are handled one call at a time. For higher throughput, run a pool of MCP subprocesses.
- The API key is only ever read from `HERO_RUN_KEY` in the environment and passed to the MCP subprocess. Nothing is hardcoded.
