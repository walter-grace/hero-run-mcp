#!/usr/bin/env python3
"""Hero Run MCP server — Python implementation (stdio JSON-RPC).
Any MCP agent can run 340+ AI models paying $HERO per call. Key mode only; the API
key is read from HERO_RUN_KEY, never hardcoded. Pure stdlib (no pip deps)."""
import os
import sys
import json
import urllib.request
import urllib.error

URL = os.environ.get("HERO_RUN_URL", "https://hero-run.vercel.app")
KEY = os.environ.get("HERO_RUN_KEY", "")


def http(path, method="GET", body=None, use_key=False):
    headers = {"Content-Type": "application/json"}
    if use_key and KEY:
        headers["x-api-key"] = KEY
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(URL + path, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req) as r:
            return json.load(r)
    except urllib.error.HTTPError as e:
        try:
            return json.load(e)
        except Exception:
            return {"error": f"HTTP {e.code}"}


def fmt(n):
    return f"{round(float(n or 0)):,}"


TOOLS = [
    {"name": "list_models", "description": "List AI models available through the Hero Run gateway.",
     "inputSchema": {"type": "object", "properties": {"kind": {"type": "string", "enum": ["text", "image", "audio", "all"]}}}},
    {"name": "run_text", "description": "Run a text model (default: auto). Pays $HERO via your key.",
     "inputSchema": {"type": "object", "required": ["prompt"], "properties": {"prompt": {"type": "string"}, "model": {"type": "string"}, "consent": {"type": "boolean"}}}},
    {"name": "generate_image", "description": "Generate an image. Pays $HERO via your key.",
     "inputSchema": {"type": "object", "required": ["prompt"], "properties": {"prompt": {"type": "string"}, "model": {"type": "string"}, "consent": {"type": "boolean"}}}},
    {"name": "treasury_stats", "description": "Read the Hero Run treasury (live from Base).",
     "inputSchema": {"type": "object", "properties": {}}},
    {"name": "wallet_balance", "description": "Your prepaid API key credit balance.",
     "inputSchema": {"type": "object", "properties": {}}},
]


def run_model(mid, inp, kind, consent):
    if not KEY:
        raise Exception("Set HERO_RUN_KEY (mint at /keys) to run models.")
    d = http("/api/run", "POST", {"model": mid, "input": inp, "kind": kind, "consent": bool(consent)}, use_key=True)
    if d.get("error"):
        raise Exception(d["error"])
    return d


def t_list_models(a):
    kind = a.get("kind", "all")
    ms = [m for m in http("/api/models")["models"] if kind in ("all", m["kind"])]
    rows = "\n".join(f"  {fmt(m['hero']):>9} $HERO · {m['kind']}  {m['id']}" for m in ms[:60])
    return f"{len(ms)} models. Each costs $HERO per run.\n{rows}"


def t_run_text(a):
    d = run_model(a.get("model") or "auto", a.get("prompt", ""), "text", a.get("consent"))
    return f"{d.get('text', '')}\n\n— {d.get('autoModel') or d.get('model')} · spent {fmt(d.get('charged'))} $HERO"


def t_generate_image(a):
    d = run_model(a.get("model") or "google/gemini-2.5-flash-image", a.get("prompt", ""), "image", a.get("consent"))
    return f"Image: {d['image'][:80]}…\nspent {fmt(d.get('charged'))} $HERO" if d.get("image") else "No image returned."


def t_treasury_stats(a):
    t = http("/api/treasury")
    cl = t.get("claimable") or {}
    return f"Treasury {t.get('treasury')}\nClaimable: {cl.get('token0', '?')} WETH + {cl.get('token1', '?')} HERO"


def t_wallet_balance(a):
    if not KEY:
        return "Set HERO_RUN_KEY to see credits."
    d = http("/api/keys/info", use_key=True)
    if d.get("error"):
        return "API key error: " + d["error"]
    return f"Prepaid API key\n{fmt(d['balance'])} $HERO credits (deposited {fmt(d['deposited'])}, spent {fmt(d['spent'])})"


IMPL = {"list_models": t_list_models, "run_text": t_run_text, "generate_image": t_generate_image, "treasury_stats": t_treasury_stats, "wallet_balance": t_wallet_balance}


def send(o):
    sys.stdout.write(json.dumps(o) + "\n")
    sys.stdout.flush()


for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    try:
        m = json.loads(line)
    except Exception:
        continue
    mid, method, params = m.get("id"), m.get("method"), m.get("params") or {}
    if method == "initialize":
        send({"jsonrpc": "2.0", "id": mid, "result": {"protocolVersion": "2024-11-05", "capabilities": {"tools": {}}, "serverInfo": {"name": "hero-run", "version": "1.0.0"}}})
    elif method == "tools/list":
        send({"jsonrpc": "2.0", "id": mid, "result": {"tools": TOOLS}})
    elif method == "tools/call":
        try:
            text = IMPL[params["name"]](params.get("arguments") or {})
            send({"jsonrpc": "2.0", "id": mid, "result": {"content": [{"type": "text", "text": text}]}})
        except Exception as e:
            send({"jsonrpc": "2.0", "id": mid, "error": {"code": -32000, "message": str(e)}})
    elif mid is not None:
        send({"jsonrpc": "2.0", "id": mid, "error": {"code": -32601, "message": "Method not found"}})
