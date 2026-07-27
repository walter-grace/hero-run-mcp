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
TIMEOUT = 300  # seconds; same budget for a request as every other port


class RpcError(Exception):
    """A tool error carrying a JSON-RPC error code (-32602 = invalid params)."""

    def __init__(self, code, message):
        super().__init__(message)
        self.code = code


def api_error(d):
    """Message of a truthy `error` key, if any. An error *object* (not just a
    string) counts as a failure, so an API error never renders as data."""
    e = d.get("error") if isinstance(d, dict) else None
    if e is None or e is False or e == "" or e == 0:
        return None
    return e if isinstance(e, str) else json.dumps(e, separators=(",", ":"))


def ok(d):
    """Raises on an error envelope; otherwise passes the decoded body through."""
    e = api_error(d)
    if e is not None:
        raise Exception(e)
    return d


def need_prompt(a):
    """prompt is required and must be a string — reject before spending anything."""
    p = a.get("prompt")
    if not isinstance(p, str):
        raise RpcError(-32602, "Invalid params: prompt must be a string")
    return p


def http(path, method="GET", body=None, use_key=False):
    headers = {"Content-Type": "application/json"}
    if use_key and KEY:
        headers["x-api-key"] = KEY
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(URL + path, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
            return json.load(r)
    except urllib.error.HTTPError as e:
        try:
            return json.load(e)
        except Exception:
            return {"error": f"HTTP {e.code}"}


def fmt(n):
    return f"{round(float(n or 0)):,}"


TOOLS = [
    {"name": "list_models", "description": "List AI models available through the Hero Run gateway. Tip: append @gateway to a model id (e.g. openai/gpt-oss-120b@cerebras) to pin a specific gateway.",
     "inputSchema": {"type": "object", "properties": {"kind": {"type": "string", "enum": ["text", "image", "video", "audio", "all"]}}}},
    {"name": "run_text", "description": "Run a text model (default: auto). Pays $HERO via your key.",
     "inputSchema": {"type": "object", "required": ["prompt"], "properties": {"prompt": {"type": "string"}, "model": {"type": "string"}, "consent": {"type": "boolean"}}}},
    {"name": "generate_image", "description": "Generate an image. Pays $HERO via your key.",
     "inputSchema": {"type": "object", "required": ["prompt"], "properties": {"prompt": {"type": "string"}, "model": {"type": "string"}, "consent": {"type": "boolean"}}}},
    {"name": "generate_video", "description": "Generate a short video clip (~5s, default Wan 2.2 480p). Takes 1-3 minutes. Pays $HERO via your key.",
     "inputSchema": {"type": "object", "required": ["prompt"], "properties": {"prompt": {"type": "string"}, "model": {"type": "string"}, "consent": {"type": "boolean"}}}},
    {"name": "generate_audio", "description": "Generate speech or music (default: openai/gpt-audio-mini; music: google/lyria-3-clip-preview). Pays $HERO via your key.",
     "inputSchema": {"type": "object", "required": ["prompt"], "properties": {"prompt": {"type": "string"}, "model": {"type": "string"}, "consent": {"type": "boolean"}}}},
    {"name": "treasury_stats", "description": "Read the Hero Run treasury (live from Base).",
     "inputSchema": {"type": "object", "properties": {}}},
    {"name": "wallet_balance", "description": "Your prepaid API key credit balance.",
     "inputSchema": {"type": "object", "properties": {}}},
]


def run_model(mid, inp, kind, consent):
    if not KEY:
        raise Exception("Set HERO_RUN_KEY (mint at /keys) to run models.")
    # consent gates public-dataset retention: only a real JSON true counts.
    return ok(http("/api/run", "POST", {"model": mid, "input": inp, "kind": kind, "consent": consent is True}, use_key=True))


def t_list_models(a):
    kind = a.get("kind")
    if not isinstance(kind, str):  # null or absent kind means "no filter"
        kind = "all"
    ms = [m for m in ok(http("/api/models"))["models"] if kind in ("all", m["kind"])]
    rows = "\n".join(f"  {fmt(m['hero']):>9} $HERO · {m['kind']}  {m['id']}" for m in ms[:60])
    return f"{len(ms)} models. Each costs $HERO per run.\n{rows}"


def t_run_text(a):
    d = run_model(a.get("model") or "auto", need_prompt(a), "text", a.get("consent"))
    return f"{d.get('text', '')}\n\n— {d.get('autoModel') or d.get('model')} · spent {fmt(d.get('charged'))} $HERO"


def t_generate_image(a):
    d = run_model(a.get("model") or "google/gemini-2.5-flash-image", need_prompt(a), "image", a.get("consent"))
    return f"Image: {d['image'][:80]}…\nspent {fmt(d.get('charged'))} $HERO" if d.get("image") else "No image returned."


def t_generate_video(a):
    d = run_model(a.get("model") or "wavespeed-ai/wan-2.2/t2v-480p-ultra-fast", need_prompt(a), "video", a.get("consent"))
    return f"Video ready: {d['video']}\nspent {fmt(d.get('charged'))} $HERO" if d.get("video") else "No video returned."


def t_generate_audio(a):
    d = run_model(a.get("model") or "openai/gpt-audio-mini", need_prompt(a), "audio", a.get("consent"))
    return f"Audio: {d['audio'][:80]}…\n{d.get('text') or ''}\nspent {fmt(d.get('charged'))} $HERO" if d.get("audio") else "No audio returned."


def t_treasury_stats(a):
    t = ok(http("/api/treasury"))
    cl = t.get("claimable") or {}
    return f"Treasury {t.get('treasury')}\nClaimable: {cl.get('token0', '?')} WETH + {cl.get('token1', '?')} HERO"


def t_wallet_balance(a):
    if not KEY:
        return "Set HERO_RUN_KEY to see credits."
    # A transport/decode failure and an API error envelope are both real
    # failures, so both become an MCP error rather than a fabricated zero
    # balance. Only the "no key configured" case above stays advisory text.
    d = ok(http("/api/keys/info", use_key=True))
    return f"Prepaid API key\n{fmt(d['balance'])} $HERO credits (deposited {fmt(d['deposited'])}, spent {fmt(d['spent'])})"


IMPL = {"list_models": t_list_models, "run_text": t_run_text, "generate_image": t_generate_image, "generate_video": t_generate_video, "generate_audio": t_generate_audio, "treasury_stats": t_treasury_stats, "wallet_balance": t_wallet_balance}


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
    if not isinstance(m, dict):
        continue
    has_id = "id" in m  # no id member at all = a notification: handle, never answer
    mid, method, params = m.get("id"), m.get("method"), m.get("params")
    if not isinstance(params, dict):
        params = {}
    resp = None
    if method == "initialize":
        resp = {"jsonrpc": "2.0", "id": mid, "result": {"protocolVersion": "2024-11-05", "capabilities": {"tools": {}}, "serverInfo": {"name": "hero-run", "version": "1.0.0"}}}
    elif method == "tools/list":
        resp = {"jsonrpc": "2.0", "id": mid, "result": {"tools": TOOLS}}
    elif method == "tools/call":
        name = params.get("name")
        fn = IMPL.get(name) if isinstance(name, str) else None
        if fn is None:
            resp = {"jsonrpc": "2.0", "id": mid, "error": {"code": -32000, "message": f"Unknown tool: {name if isinstance(name, str) else ''}"}}
        else:
            args = params.get("arguments")
            try:
                text = fn(args if isinstance(args, dict) else {})
                resp = {"jsonrpc": "2.0", "id": mid, "result": {"content": [{"type": "text", "text": text}]}}
            except RpcError as e:
                resp = {"jsonrpc": "2.0", "id": mid, "error": {"code": e.code, "message": str(e)}}
            except Exception as e:
                resp = {"jsonrpc": "2.0", "id": mid, "error": {"code": -32000, "message": str(e)}}
    elif has_id and mid is not None:
        resp = {"jsonrpc": "2.0", "id": mid, "error": {"code": -32601, "message": "Method not found"}}
    if resp is not None and has_id:
        send(resp)
