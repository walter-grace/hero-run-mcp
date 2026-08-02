// Hero Run MCP server — Rust implementation (stdio JSON-RPC).
// Any MCP agent can run 500+ AI models paying $HERO per call. Key mode (prepaid
// credits) only; the API key is read from HERO_RUN_KEY, never hardcoded.
use serde_json::{json, Value};
use std::io::{BufRead, Write};

fn base_url() -> String {
    std::env::var("HERO_RUN_URL").unwrap_or_else(|_| "https://herorunai.com".to_string())
}
fn key() -> String {
    std::env::var("HERO_RUN_KEY").unwrap_or_default()
}

// Round a JSON value to an integer with en-US thousands commas (matches JS/Python fmt).
fn fmt(v: &Value) -> String {
    let n = match v {
        Value::Number(x) => x.as_f64().unwrap_or(0.0),
        Value::String(s) => s.parse::<f64>().unwrap_or(0.0),
        _ => 0.0,
    };
    let rounded = n.round() as i64;
    let neg = rounded < 0;
    let digits = rounded.abs().to_string();
    let mut out = String::new();
    let bytes = digits.as_bytes();
    for (i, b) in bytes.iter().enumerate() {
        if i > 0 && (bytes.len() - i) % 3 == 0 {
            out.push(',');
        }
        out.push(*b as char);
    }
    if neg {
        format!("-{}", out)
    } else {
        out
    }
}

// Render a JSON value plainly (string without quotes, number as-is), else fallback.
fn plain(v: &Value, fallback: &str) -> String {
    match v {
        Value::String(s) => s.clone(),
        Value::Number(n) => n.to_string(),
        Value::Bool(b) => b.to_string(),
        Value::Null => fallback.to_string(),
        _ => fallback.to_string(),
    }
}

fn http(path: &str, method: &str, body: Option<Value>, use_key: bool) -> Value {
    let url = format!("{}{}", base_url(), path);
    let k = key();
    // Video runs can take 1-3 minutes; allow up to 5 minutes for any call.
    let mut req = ureq::request(method, &url)
        .timeout(std::time::Duration::from_secs(300))
        .set("Content-Type", "application/json");
    if use_key && !k.is_empty() {
        req = req.set("x-api-key", &k);
    }
    let resp = match body {
        Some(b) => req.send_json(b),
        None => req.call(),
    };
    match resp {
        Ok(r) => r
            .into_json::<Value>()
            .unwrap_or_else(|_| json!({"error": "invalid JSON"})),
        // On HTTP error status, read the JSON body like the reference impls do.
        Err(ureq::Error::Status(code, r)) => r
            .into_json::<Value>()
            .unwrap_or_else(|_| json!({"error": format!("HTTP {}", code)})),
        Err(e) => json!({ "error": e.to_string() }),
    }
}

// Static tools list as raw JSON so key order matches the Node reference exactly
// (serde_json's default Map is a BTreeMap, which would sort keys alphabetically).
const TOOLS_JSON: &str = r#"[{"name":"list_models","description":"List AI models available through the Hero Run gateway. Tip: append @gateway to a model id (e.g. openai/gpt-oss-120b@cerebras) to pin a specific gateway.","inputSchema":{"type":"object","properties":{"kind":{"type":"string","enum":["text","image","video","audio","all"]}}}},{"name":"run_text","description":"Run a text model (default: auto). Pays $HERO via your key.","inputSchema":{"type":"object","required":["prompt"],"properties":{"prompt":{"type":"string"},"model":{"type":"string"},"consent":{"type":"boolean"}}}},{"name":"generate_image","description":"Generate an image. Pays $HERO via your key.","inputSchema":{"type":"object","required":["prompt"],"properties":{"prompt":{"type":"string"},"model":{"type":"string"},"consent":{"type":"boolean"}}}},{"name":"generate_video","description":"Generate a short video clip (~5s, default Wan 2.2 480p). Takes 1-3 minutes. Pays $HERO via your key.","inputSchema":{"type":"object","required":["prompt"],"properties":{"prompt":{"type":"string"},"model":{"type":"string"},"consent":{"type":"boolean"}}}},{"name":"generate_audio","description":"Generate speech or music (default: openai/gpt-audio-mini; music: google/lyria-3-clip-preview). Pays $HERO via your key.","inputSchema":{"type":"object","required":["prompt"],"properties":{"prompt":{"type":"string"},"model":{"type":"string"},"consent":{"type":"boolean"}}}},{"name":"treasury_stats","description":"Read the Hero Run treasury (live from Base).","inputSchema":{"type":"object","properties":{}}},{"name":"wallet_balance","description":"Your prepaid API key credit balance.","inputSchema":{"type":"object","properties":{}}}]"#;

// A JSON-RPC error: code + message.
type RpcErr = (i64, String);
fn tool_err(msg: impl Into<String>) -> RpcErr {
    (-32000, msg.into())
}
fn invalid_params(msg: impl Into<String>) -> RpcErr {
    (-32602, msg.into())
}

// Message of a truthy `error` field, if any. An error *object* (not just a
// string) counts as a failure, as does the `error` our http() helper synthesises
// on a transport failure.
fn api_error(d: &Value) -> Option<String> {
    match d.get("error") {
        None | Some(Value::Null) => None,
        Some(Value::Bool(false)) => None,
        Some(Value::String(s)) if s.is_empty() => None,
        Some(Value::Number(n)) if n.as_f64() == Some(0.0) => None,
        Some(Value::String(s)) => Some(s.clone()),
        Some(v) => Some(v.to_string()),
    }
}

fn run_model(mid: &str, input: &str, kind: &str, consent: bool) -> Result<Value, RpcErr> {
    if key().is_empty() {
        return Err(tool_err("Set HERO_RUN_KEY (mint at /keys) to run models."));
    }
    let d = http(
        "/api/run",
        "POST",
        Some(json!({ "model": mid, "input": input, "kind": kind, "consent": consent })),
        true,
    );
    if let Some(e) = api_error(&d) {
        return Err(tool_err(e));
    }
    Ok(d)
}

fn str_arg<'a>(a: &'a Value, k: &str) -> &'a str {
    a.get(k).and_then(|v| v.as_str()).unwrap_or("")
}

// A string `prompt` is required — validate before any (billed) HTTP call.
fn prompt_arg(a: &Value) -> Result<&str, RpcErr> {
    match a.get("prompt") {
        None | Some(Value::Null) => Err(invalid_params("Invalid params: prompt must be a string")),
        Some(Value::String(s)) => Ok(s),
        Some(_) => Err(invalid_params("Invalid params: prompt must be a string")),
    }
}
// model || default: empty/missing string falls back to default.
fn model_or(a: &Value, default: &str) -> String {
    let m = str_arg(a, "model");
    if m.is_empty() {
        default.to_string()
    } else {
        m.to_string()
    }
}

fn call_tool(name: &str, a: &Value) -> Result<String, RpcErr> {
    match name {
        "list_models" => {
            // An explicit string (including "") is a supplied filter; a missing
            // or null kind means no filter.
            let kind = match a.get("kind") {
                Some(Value::String(s)) => s.clone(),
                _ => "all".to_string(),
            };
            let d = http("/api/models", "GET", None, false);
            if let Some(e) = api_error(&d) {
                return Err(tool_err(e));
            }
            let empty: Vec<Value> = vec![];
            let models = d.get("models").and_then(|m| m.as_array()).unwrap_or(&empty);
            let filtered: Vec<&Value> = models
                .iter()
                .filter(|m| {
                    kind == "all"
                        || m.get("kind").and_then(|x| x.as_str()) == Some(kind.as_str())
                })
                .collect();
            let mut rows = String::new();
            for m in filtered.iter().take(60) {
                let hero = fmt(m.get("hero").unwrap_or(&Value::Null));
                let mkind = m.get("kind").and_then(|x| x.as_str()).unwrap_or("");
                let mid = m.get("id").and_then(|x| x.as_str()).unwrap_or("");
                rows.push_str(&format!("\n  {:>9} $HERO · {}  {}", hero, mkind, mid));
            }
            Ok(format!(
                "{} models. Each costs $HERO per run.{}",
                filtered.len(),
                rows
            ))
        }
        "run_text" => {
            let consent = a.get("consent").and_then(|v| v.as_bool()).unwrap_or(false);
            let prompt = prompt_arg(a)?;
            let d = run_model(&model_or(a, "auto"), prompt, "text", consent)?;
            let text = d.get("text").and_then(|v| v.as_str()).unwrap_or("");
            let model = match d.get("autoModel").and_then(|v| v.as_str()) {
                Some(m) if !m.is_empty() => m,
                _ => d.get("model").and_then(|v| v.as_str()).unwrap_or(""),
            };
            Ok(format!(
                "{}\n\n— {} · spent {} $HERO",
                text,
                model,
                fmt(d.get("charged").unwrap_or(&Value::Null))
            ))
        }
        "generate_image" => {
            let consent = a.get("consent").and_then(|v| v.as_bool()).unwrap_or(false);
            let prompt = prompt_arg(a)?;
            let d = run_model(
                &model_or(a, "google/gemini-2.5-flash-image"),
                prompt,
                "image",
                consent,
            )?;
            match d.get("image").and_then(|v| v.as_str()) {
                Some(img) if !img.is_empty() => {
                    let short: String = img.chars().take(80).collect();
                    Ok(format!(
                        "Image: {}…\nspent {} $HERO",
                        short,
                        fmt(d.get("charged").unwrap_or(&Value::Null))
                    ))
                }
                _ => Ok("No image returned.".to_string()),
            }
        }
        "generate_video" => {
            let consent = a.get("consent").and_then(|v| v.as_bool()).unwrap_or(false);
            let prompt = prompt_arg(a)?;
            let d = run_model(
                &model_or(a, "wavespeed-ai/wan-2.2/t2v-480p-ultra-fast"),
                prompt,
                "video",
                consent,
            )?;
            match d.get("video").and_then(|v| v.as_str()) {
                Some(video) if !video.is_empty() => Ok(format!(
                    "Video ready: {}\nspent {} $HERO",
                    video,
                    fmt(d.get("charged").unwrap_or(&Value::Null))
                )),
                _ => Ok("No video returned.".to_string()),
            }
        }
        "generate_audio" => {
            let consent = a.get("consent").and_then(|v| v.as_bool()).unwrap_or(false);
            let prompt = prompt_arg(a)?;
            let d = run_model(
                &model_or(a, "openai/gpt-audio-mini"),
                prompt,
                "audio",
                consent,
            )?;
            match d.get("audio").and_then(|v| v.as_str()) {
                Some(audio) if !audio.is_empty() => {
                    let short: String = audio.chars().take(80).collect();
                    let text = d.get("text").and_then(|v| v.as_str()).unwrap_or("");
                    Ok(format!(
                        "Audio: {}…\n{}\nspent {} $HERO",
                        short,
                        text,
                        fmt(d.get("charged").unwrap_or(&Value::Null))
                    ))
                }
                _ => Ok("No audio returned.".to_string()),
            }
        }
        "treasury_stats" => {
            let t = http("/api/treasury", "GET", None, false);
            if let Some(e) = api_error(&t) {
                return Err(tool_err(e));
            }
            let cl = t.get("claimable").cloned().unwrap_or(Value::Null);
            let token0 = plain(cl.get("token0").unwrap_or(&Value::Null), "?");
            let token1 = plain(cl.get("token1").unwrap_or(&Value::Null), "?");
            let treasury = plain(t.get("treasury").unwrap_or(&Value::Null), "null");
            Ok(format!(
                "Treasury {}\nClaimable: {} WETH + {} HERO",
                treasury, token0, token1
            ))
        }
        "wallet_balance" => {
            if key().is_empty() {
                return Ok("Set HERO_RUN_KEY to see credits.".to_string());
            }
            let d = http("/api/keys/info", "GET", None, true);
            // A transport/decode failure and an API error envelope both land in
            // `error`; both are real failures, so both become an MCP error
            // rather than a fabricated zero balance. Only the "no key
            // configured" case above stays advisory text.
            if let Some(e) = api_error(&d) {
                return Err(tool_err(e));
            }
            Ok(format!(
                "Prepaid API key\n{} $HERO credits (deposited {}, spent {})",
                fmt(d.get("balance").unwrap_or(&Value::Null)),
                fmt(d.get("deposited").unwrap_or(&Value::Null)),
                fmt(d.get("spent").unwrap_or(&Value::Null))
            ))
        }
        _ => Err(tool_err(format!("Unknown tool: {}", name))),
    }
}

fn send_raw(s: &str) {
    let stdout = std::io::stdout();
    let mut h = stdout.lock();
    let _ = h.write_all(s.as_bytes());
    let _ = h.write_all(b"\n");
    let _ = h.flush();
}

fn send(o: &Value) {
    send_raw(&o.to_string());
}

fn main() {
    let stdin = std::io::stdin();
    for line in stdin.lock().lines() {
        let line = match line {
            Ok(l) => l,
            Err(_) => break,
        };
        if line.trim().is_empty() {
            continue;
        }
        let m: Value = match serde_json::from_str(&line) {
            Ok(v) => v,
            Err(_) => continue,
        };
        // No `id` member at all = notification: process it, answer nothing.
        let has_id = m.get("id").is_some();
        let id = m.get("id").cloned().unwrap_or(Value::Null);
        let method = m.get("method").and_then(|v| v.as_str()).unwrap_or("");
        let params = m.get("params").cloned().unwrap_or(Value::Null);

        match method {
            "initialize" => {
                if has_id {
                    send(&json!({
                        "jsonrpc": "2.0",
                        "id": id,
                        "result": {
                            "protocolVersion": "2024-11-05",
                            "capabilities": { "tools": {} },
                            "serverInfo": { "name": "hero-run", "version": "1.0.0" }
                        }
                    }))
                }
            }
            "tools/list" => {
                if has_id {
                    send_raw(&format!(
                        r#"{{"jsonrpc":"2.0","id":{},"result":{{"tools":{}}}}}"#,
                        id, TOOLS_JSON
                    ))
                }
            }
            "tools/call" => {
                let name = params
                    .get("name")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                let args = params.get("arguments").cloned().unwrap_or(json!({}));
                let out = call_tool(&name, &args);
                if has_id {
                    match out {
                        Ok(text) => send(&json!({
                            "jsonrpc": "2.0",
                            "id": id,
                            "result": { "content": [{ "type": "text", "text": text }] }
                        })),
                        Err((code, msg)) => send(&json!({
                            "jsonrpc": "2.0",
                            "id": id,
                            "error": { "code": code, "message": msg }
                        })),
                    }
                }
            }
            _ => {
                if has_id && !id.is_null() {
                    send(&json!({
                        "jsonrpc": "2.0",
                        "id": id,
                        "error": { "code": -32601, "message": "Method not found" }
                    }));
                }
            }
        }
    }
}
