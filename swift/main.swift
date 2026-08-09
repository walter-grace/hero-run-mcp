// Hero Run MCP server: Swift implementation (stdio JSON-RPC).
// Any MCP agent can run 500+ AI models paying $HERO per call. Key mode only; the
// API key is read from HERO_RUN_KEY, never hardcoded. Foundation only (no deps).
import Foundation

let baseURL = ProcessInfo.processInfo.environment["HERO_RUN_URL"] ?? "https://herorunai.com"
let KEY = ProcessInfo.processInfo.environment["HERO_RUN_KEY"] ?? ""

// ---- helpers ----------------------------------------------------------------

func toDouble(_ v: Any?) -> Double {
    switch v {
    case let n as NSNumber: return n.doubleValue
    case let d as Double: return d
    case let i as Int: return Double(i)
    case let s as String: return Double(s) ?? 0
    default: return 0
    }
}

let commaFormatter: NumberFormatter = {
    let f = NumberFormatter()
    f.numberStyle = .decimal
    f.groupingSeparator = ","
    f.groupingSize = 3
    f.usesGroupingSeparator = true
    f.maximumFractionDigits = 0
    f.minimumFractionDigits = 0
    f.locale = Locale(identifier: "en_US")
    return f
}()

// round to integer with thousands commas
func fmt(_ v: Any?) -> String {
    let r = toDouble(v).rounded()
    return commaFormatter.string(from: NSNumber(value: r)) ?? "0"
}

// right-align (pad start) to a given width, like padStart / :>9
func padStart(_ s: String, _ width: Int) -> String {
    let n = s.count
    if n >= width { return s }
    return String(repeating: " ", count: width - n) + s
}

func str(_ v: Any?) -> String? {
    if let s = v as? String { return s }
    return nil
}

// A non-empty string, or nil: so "" falls back to the default like `||` does.
func nonEmpty(_ v: Any?) -> String? {
    if let s = v as? String, !s.isEmpty { return s }
    return nil
}

func isBool(_ n: NSNumber) -> Bool { CFGetTypeID(n) == CFBooleanGetTypeID() }

// Strict JSON boolean: only a real `true` counts. `as? Bool` alone would also
// accept the number 1, which must not stand in for consent on a paid run.
func boolArg(_ v: Any?) -> Bool {
    guard let n = v as? NSNumber, isBool(n) else { return false }
    return n.boolValue
}

// Render any JSON value plainly (string without quotes, number as-is).
func plain(_ v: Any?, _ fallback: String) -> String {
    guard let v = v, !(v is NSNull) else { return fallback }
    if let s = v as? String { return s }
    if let n = v as? NSNumber { return isBool(n) ? (n.boolValue ? "true" : "false") : n.stringValue }
    if let d = try? JSONSerialization.data(withJSONObject: v, options: [.fragmentsAllowed]),
       let s = String(data: d, encoding: .utf8) { return s }
    return "\(v)"
}

// Message of a truthy `error` field, if any. An error *object* (not just a
// string) counts as a failure, as does the `error` http() sets on a transport
// failure.
func apiError(_ d: [String: Any]) -> String? {
    guard let e = d["error"], !(e is NSNull) else { return nil }
    if let s = e as? String { return s.isEmpty ? nil : s }
    if let n = e as? NSNumber {
        if isBool(n) { return n.boolValue ? "true" : nil }
        return n.doubleValue == 0 ? nil : n.stringValue
    }
    return plain(e, "")
}

// ---- HTTP (synchronous via semaphore) --------------------------------------

// Long timeout: video generation can take 1-3 minutes (URLSession default is 60s).
let httpSession: URLSession = {
    let cfg = URLSessionConfiguration.default
    cfg.timeoutIntervalForRequest = 300
    cfg.timeoutIntervalForResource = 300
    return URLSession(configuration: cfg)
}()

func http(_ path: String, method: String = "GET", body: [String: Any]? = nil, useKey: Bool = false) -> [String: Any] {
    guard let url = URL(string: baseURL + path) else { return ["error": "bad url"] }
    var req = URLRequest(url: url)
    req.httpMethod = method
    req.timeoutInterval = 300
    req.setValue("application/json", forHTTPHeaderField: "Content-Type")
    if useKey && !KEY.isEmpty { req.setValue(KEY, forHTTPHeaderField: "x-api-key") }
    if let body = body {
        req.httpBody = try? JSONSerialization.data(withJSONObject: body)
    }
    let sem = DispatchSemaphore(value: 0)
    var out: [String: Any] = [:]
    let task = httpSession.dataTask(with: req) { data, resp, err in
        defer { sem.signal() }
        if let data = data,
           let obj = try? JSONSerialization.jsonObject(with: data),
           let dict = obj as? [String: Any] {
            out = dict
        } else if let err = err {
            out = ["error": err.localizedDescription]
        } else if let http = resp as? HTTPURLResponse {
            out = ["error": "HTTP \(http.statusCode)"]
        }
    }
    task.resume()
    sem.wait()
    return out
}

// ---- tool schema (parsed from JSON to match reference exactly) --------------

let toolsJSON = """
[
  { "name": "list_models", "description": "List AI models available through the Hero Run gateway. Tip: append @gateway to a model id (e.g. openai/gpt-oss-120b@cerebras) to pin a specific gateway.",
    "inputSchema": { "type": "object", "properties": { "kind": { "type": "string", "enum": ["text", "image", "video", "audio", "all"] } } } },
  { "name": "run_text", "description": "Run a text model (default: auto). Pays $HERO via your key.",
    "inputSchema": { "type": "object", "required": ["prompt"], "properties": { "prompt": { "type": "string" }, "model": { "type": "string" }, "consent": { "type": "boolean" } } } },
  { "name": "generate_image", "description": "Generate an image. Pays $HERO via your key.",
    "inputSchema": { "type": "object", "required": ["prompt"], "properties": { "prompt": { "type": "string" }, "model": { "type": "string" }, "consent": { "type": "boolean" } } } },
  { "name": "generate_video", "description": "Generate a short video clip (~5s, default Wan 2.2 480p). Takes 1-3 minutes. Pays $HERO via your key.",
    "inputSchema": { "type": "object", "required": ["prompt"], "properties": { "prompt": { "type": "string" }, "model": { "type": "string" }, "consent": { "type": "boolean" } } } },
  { "name": "generate_audio", "description": "Generate speech or music (default: openai/gpt-audio-mini; music: google/lyria-3-clip-preview). Pays $HERO via your key.",
    "inputSchema": { "type": "object", "required": ["prompt"], "properties": { "prompt": { "type": "string" }, "model": { "type": "string" }, "consent": { "type": "boolean" } } } },
  { "name": "treasury_stats", "description": "Read the Hero Run treasury (live from Base).",
    "inputSchema": { "type": "object", "properties": {} } },
  { "name": "wallet_balance", "description": "Your prepaid API key credit balance.",
    "inputSchema": { "type": "object", "properties": {} } }
]
"""
let TOOLS = (try? JSONSerialization.jsonObject(with: toolsJSON.data(using: .utf8)!)) as? [[String: Any]] ?? []

// ---- tool implementations ---------------------------------------------------

struct ToolError: Error {
    let code: Int
    let message: String
    init(code: Int = -32000, message: String) {
        self.code = code
        self.message = message
    }
}

// A string `prompt` is required: validate before any (billed) HTTP call.
func promptArg(_ a: [String: Any]) throws -> String {
    guard let v = a["prompt"], !(v is NSNull) else {
        throw ToolError(code: -32602, message: "Invalid params: prompt must be a string")
    }
    guard let s = v as? String else {
        throw ToolError(code: -32602, message: "Invalid params: prompt must be a string")
    }
    return s
}

func runModel(_ id: String, _ input: String, _ kind: String, _ consent: Bool) throws -> [String: Any] {
    if KEY.isEmpty { throw ToolError(message: "Set HERO_RUN_KEY (mint at /keys) to run models.") }
    let d = http("/api/run", method: "POST",
                 body: ["model": id, "input": input, "kind": kind, "consent": consent],
                 useKey: true)
    if let e = apiError(d) { throw ToolError(message: e) }
    return d
}

func t_list_models(_ a: [String: Any]) throws -> String {
    let kind = str(a["kind"]) ?? "all"
    let d = http("/api/models")
    if let e = apiError(d) { throw ToolError(message: e) }
    let all = (d["models"] as? [[String: Any]]) ?? []
    let ms = all.filter { kind == "all" || (str($0["kind"]) == kind) }
    let rows = ms.prefix(60).map { m -> String in
        let hero = padStart(fmt(m["hero"]), 9)
        let k = str(m["kind"]) ?? ""
        let id = str(m["id"]) ?? ""
        return "  \(hero) $HERO · \(k)  \(id)"
    }.joined(separator: "\n")
    return "\(ms.count) models. Each costs $HERO per run.\n\(rows)"
}

func t_run_text(_ a: [String: Any]) throws -> String {
    let prompt = try promptArg(a)
    let d = try runModel(nonEmpty(a["model"]) ?? "auto", prompt, "text", boolArg(a["consent"]))
    let model = nonEmpty(d["autoModel"]) ?? nonEmpty(d["model"]) ?? ""
    return "\(str(d["text"]) ?? "")\n\n\(model) · spent \(fmt(d["charged"])) $HERO"
}

func t_generate_image(_ a: [String: Any]) throws -> String {
    let prompt = try promptArg(a)
    let d = try runModel(nonEmpty(a["model"]) ?? "google/gemini-2.5-flash-image", prompt, "image", boolArg(a["consent"]))
    if let img = str(d["image"]) {
        let clip = String(img.prefix(80))
        return "Image: \(clip)…\nspent \(fmt(d["charged"])) $HERO"
    }
    return "No image returned."
}

func t_generate_video(_ a: [String: Any]) throws -> String {
    let prompt = try promptArg(a)
    let d = try runModel(nonEmpty(a["model"]) ?? "wavespeed-ai/wan-2.2/t2v-480p-ultra-fast", prompt, "video", boolArg(a["consent"]))
    if let video = str(d["video"]) {
        return "Video ready: \(video)\nspent \(fmt(d["charged"])) $HERO"
    }
    return "No video returned."
}

func t_generate_audio(_ a: [String: Any]) throws -> String {
    let prompt = try promptArg(a)
    let d = try runModel(nonEmpty(a["model"]) ?? "openai/gpt-audio-mini", prompt, "audio", boolArg(a["consent"]))
    if let audio = str(d["audio"]) {
        let clip = String(audio.prefix(80))
        return "Audio: \(clip)…\n\(str(d["text"]) ?? "")\nspent \(fmt(d["charged"])) $HERO"
    }
    return "No audio returned."
}

func t_treasury_stats(_ a: [String: Any]) throws -> String {
    let t = http("/api/treasury")
    if let e = apiError(t) { throw ToolError(message: e) }
    let cl = (t["claimable"] as? [String: Any]) ?? [:]
    let tok0 = plain(cl["token0"], "?")
    let tok1 = plain(cl["token1"], "?")
    let treasury = plain(t["treasury"], "?")
    return "Treasury \(treasury)\nClaimable: \(tok0) WETH + \(tok1) HERO"
}

func t_wallet_balance(_ a: [String: Any]) throws -> String {
    if KEY.isEmpty { return "Set HERO_RUN_KEY to see credits." }
    let d = http("/api/keys/info", useKey: true)
    // A transport/decode failure and an API error envelope both land in
    // `error`; both are real failures, so both become an MCP error rather than
    // a fabricated zero balance. Only the "no key configured" case above stays
    // advisory text.
    if let e = apiError(d) { throw ToolError(message: e) }
    return "Prepaid API key\n\(fmt(d["balance"])) $HERO credits (deposited \(fmt(d["deposited"])), spent \(fmt(d["spent"])))"
}

let IMPL: [String: ([String: Any]) throws -> String] = [
    "list_models": t_list_models,
    "run_text": t_run_text,
    "generate_image": t_generate_image,
    "generate_video": t_generate_video,
    "generate_audio": t_generate_audio,
    "treasury_stats": t_treasury_stats,
    "wallet_balance": t_wallet_balance,
]

// ---- JSON-RPC loop ----------------------------------------------------------

func send(_ o: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: o),
          let s = String(data: data, encoding: .utf8) else { return }
    print(s)
    fflush(stdout)
}

// non-null id, or nil for a missing / null id
func rpcId(_ m: [String: Any]) -> Any? {
    guard let v = m["id"], !(v is NSNull) else { return nil }
    return v
}

while let line = readLine(strippingNewline: true) {
    let trimmed = line.trimmingCharacters(in: .whitespacesAndNewlines)
    if trimmed.isEmpty { continue }
    guard let data = trimmed.data(using: .utf8),
          let m = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else { continue }

    let method = str(m["method"])
    // No `id` member at all = notification: process it, answer nothing.
    let hasId = m["id"] != nil
    let rid: Any = m["id"] ?? NSNull()
    let id = rpcId(m)
    let params = (m["params"] as? [String: Any]) ?? [:]

    if method == "initialize" {
        if hasId {
            send(["jsonrpc": "2.0", "id": rid,
                  "result": ["protocolVersion": "2024-11-05", "capabilities": ["tools": [:]],
                             "serverInfo": ["name": "hero-run", "version": "1.0.0"]]])
        }
    } else if method == "tools/list" {
        if hasId { send(["jsonrpc": "2.0", "id": rid, "result": ["tools": TOOLS]]) }
    } else if method == "tools/call" {
        let name = str(params["name"]) ?? ""
        let args = (params["arguments"] as? [String: Any]) ?? [:]
        if let fn = IMPL[name] {
            do {
                let text = try fn(args)
                if hasId {
                    send(["jsonrpc": "2.0", "id": rid,
                          "result": ["content": [["type": "text", "text": text]]]])
                }
            } catch let e as ToolError {
                if hasId {
                    send(["jsonrpc": "2.0", "id": rid, "error": ["code": e.code, "message": e.message]])
                }
            } catch {
                if hasId {
                    send(["jsonrpc": "2.0", "id": rid, "error": ["code": -32000, "message": error.localizedDescription]])
                }
            }
        } else if let id = id {
            send(["jsonrpc": "2.0", "id": id, "error": ["code": -32000, "message": "Unknown tool: \(name)"]])
        }
    } else if let id = id {
        send(["jsonrpc": "2.0", "id": id, "error": ["code": -32601, "message": "Method not found"]])
    }
}
