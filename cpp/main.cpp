// Hero Run MCP server — C++ implementation (stdio JSON-RPC).
// Any MCP agent can run 340+ AI models paying $HERO per call. Key mode (prepaid
// credits) only; the API key is read from HERO_RUN_KEY, never hardcoded.
//
// Build: clang++ -O2 -std=c++17 -Wall main.cpp -lcurl -o hero-run-mcp

#include "json.hpp"

#include <curl/curl.h>

#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <iostream>
#include <stdexcept>
#include <string>
#include <vector>

// Insertion-order-preserving JSON so key order matches the Node reference.
using json = nlohmann::ordered_json;

static std::string BASE_URL = "https://hero-run.vercel.app";
static std::string KEY;

// ---------------------------------------------------------------------------
// Static tools list as raw JSON so serialization is byte-identical to Node.
// ---------------------------------------------------------------------------
static const char* TOOLS_JSON =
    R"JSON([{"name":"list_models","description":"List AI models available through the Hero Run gateway. Tip: append @gateway to a model id (e.g. openai/gpt-oss-120b@cerebras) to pin a specific gateway.","inputSchema":{"type":"object","properties":{"kind":{"type":"string","enum":["text","image","video","audio","all"]}}}},{"name":"run_text","description":"Run a text model (default: auto). Pays $HERO via your key.","inputSchema":{"type":"object","required":["prompt"],"properties":{"prompt":{"type":"string"},"model":{"type":"string"},"consent":{"type":"boolean"}}}},{"name":"generate_image","description":"Generate an image. Pays $HERO via your key.","inputSchema":{"type":"object","required":["prompt"],"properties":{"prompt":{"type":"string"},"model":{"type":"string"},"consent":{"type":"boolean"}}}},{"name":"generate_video","description":"Generate a short video clip (~5s, default Wan 2.2 480p). Takes 1-3 minutes. Pays $HERO via your key.","inputSchema":{"type":"object","required":["prompt"],"properties":{"prompt":{"type":"string"},"model":{"type":"string"},"consent":{"type":"boolean"}}}},{"name":"generate_audio","description":"Generate speech or music (default: openai/gpt-audio-mini; music: google/lyria-3-clip-preview). Pays $HERO via your key.","inputSchema":{"type":"object","required":["prompt"],"properties":{"prompt":{"type":"string"},"model":{"type":"string"},"consent":{"type":"boolean"}}}},{"name":"treasury_stats","description":"Read the Hero Run treasury (live from Base).","inputSchema":{"type":"object","properties":{}}},{"name":"wallet_balance","description":"Your prepaid API key credit balance.","inputSchema":{"type":"object","properties":{}}}])JSON";

// ---------------------------------------------------------------------------
// Small JS-semantics helpers
// ---------------------------------------------------------------------------

// obj[key] with "undefined" semantics: nullptr when missing or obj not object.
static const json* get(const json& o, const char* k) {
    if (!o.is_object()) return nullptr;
    auto it = o.find(k);
    return it == o.end() ? nullptr : &it.value();
}

// JS truthiness for a (possibly missing) value.
static bool js_truthy(const json* v) {
    if (!v || v->is_null()) return false;
    if (v->is_boolean()) return v->get<bool>();
    if (v->is_number()) {
        double d = v->get<double>();
        return d != 0.0 && !std::isnan(d);
    }
    if (v->is_string()) return !v->get<std::string>().empty();
    return true; // objects and arrays are truthy
}

// Template-literal rendering: `${v}` (undefined -> "undefined", null -> "null").
static std::string js_display(const json* v) {
    if (!v) return "undefined";
    if (v->is_string()) return v->get<std::string>();
    if (v->is_null()) return "null";
    if (v->is_boolean()) return v->get<bool>() ? "true" : "false";
    if (v->is_number_integer()) return std::to_string(v->get<long long>());
    if (v->is_number_unsigned()) return std::to_string(v->get<unsigned long long>());
    if (v->is_number()) return v->dump();
    if (v->is_object()) return "[object Object]";
    return v->dump();
}

// Number(v): NaN when unconvertible (missing -> NaN, null -> 0, "" -> 0).
static double js_number(const json* v) {
    if (!v) return std::nan("");
    if (v->is_number()) return v->get<double>();
    if (v->is_boolean()) return v->get<bool>() ? 1.0 : 0.0;
    if (v->is_null()) return 0.0;
    if (v->is_string()) {
        std::string s = v->get<std::string>();
        size_t a = s.find_first_not_of(" \t\n\r\f\v");
        if (a == std::string::npos) return 0.0; // Number("") === 0
        size_t b = s.find_last_not_of(" \t\n\r\f\v");
        s = s.substr(a, b - a + 1);
        const char* c = s.c_str();
        char* end = nullptr;
        double d = std::strtod(c, &end);
        if (end != c + s.size()) return std::nan(""); // partial parse -> NaN
        return d;
    }
    return std::nan("");
}

// fmt = Math.round(Number(n) || 0).toLocaleString("en-US")
static std::string fmt(const json* v) {
    double n = js_number(v);
    if (std::isnan(n)) n = 0.0;                       // NaN || 0
    double r = std::floor(n + 0.5);                   // JS Math.round (half up)
    long long ll = static_cast<long long>(r);
    bool neg = ll < 0;
    std::string digits = std::to_string(neg ? -ll : ll);
    std::string out;
    for (size_t i = 0; i < digits.size(); i++) {
        if (i > 0 && (digits.size() - i) % 3 == 0) out.push_back(',');
        out.push_back(digits[i]);
    }
    return neg ? "-" + out : out;
}

// String.prototype.padStart(9) on the formatted string.
static std::string pad_start9(const std::string& s) {
    return s.size() >= 9 ? s : std::string(9 - s.size(), ' ') + s;
}

// String.prototype.slice(0, 80). Data URIs are ASCII so a byte cut matches JS
// code-unit semantics; back off any trailing UTF-8 continuation bytes so the
// output always serializes cleanly.
static std::string slice80(const std::string& s) {
    if (s.size() <= 80) return s;
    size_t n = 80;
    while (n > 0 && (static_cast<unsigned char>(s[n]) & 0xC0) == 0x80) n--;
    return s.substr(0, n);
}

// ---------------------------------------------------------------------------
// HTTP via libcurl (easy interface)
// ---------------------------------------------------------------------------

static size_t write_cb(char* ptr, size_t size, size_t nmemb, void* userdata) {
    static_cast<std::string*>(userdata)->append(ptr, size * nmemb);
    return size * nmemb;
}

// GET/POST BASE_URL+path, parse JSON. Throws std::runtime_error on transport
// or parse failure (mirrors fetch()/res.json() throwing in Node).
static json http_json(const std::string& path, bool post, const std::string* body, bool use_key) {
    std::string url = BASE_URL + path;
    CURL* h = curl_easy_init();
    if (!h) throw std::runtime_error("fetch failed: curl init");
    std::string resp;
    struct curl_slist* hdrs = nullptr;
    if (post) hdrs = curl_slist_append(hdrs, "Content-Type: application/json");
    if (use_key && !KEY.empty()) {
        std::string kh = "x-api-key: " + KEY;
        hdrs = curl_slist_append(hdrs, kh.c_str());
    }
    if (hdrs) curl_easy_setopt(h, CURLOPT_HTTPHEADER, hdrs);
    curl_easy_setopt(h, CURLOPT_URL, url.c_str());
    curl_easy_setopt(h, CURLOPT_TIMEOUT, 300L); // video runs take 1-3 minutes
    curl_easy_setopt(h, CURLOPT_FOLLOWLOCATION, 0L);
    curl_easy_setopt(h, CURLOPT_WRITEFUNCTION, write_cb);
    curl_easy_setopt(h, CURLOPT_WRITEDATA, &resp);
    if (post && body) {
        curl_easy_setopt(h, CURLOPT_POSTFIELDS, body->c_str());
        curl_easy_setopt(h, CURLOPT_POSTFIELDSIZE, static_cast<long>(body->size()));
    }
    CURLcode rc = curl_easy_perform(h);
    if (hdrs) curl_slist_free_all(hdrs);
    curl_easy_cleanup(h);
    if (rc != CURLE_OK)
        throw std::runtime_error(std::string("fetch failed: ") + curl_easy_strerror(rc));
    json d = json::parse(resp, nullptr, false);
    if (d.is_discarded()) throw std::runtime_error("invalid JSON response");
    return d;
}

// ---------------------------------------------------------------------------
// Tool implementations (mirror node/index.mjs IMPL)
// ---------------------------------------------------------------------------

static json run_model(const std::string& model, const json* prompt, const char* kind, bool consent) {
    if (KEY.empty()) throw std::runtime_error("Set HERO_RUN_KEY (mint at /keys) to run models.");
    json b = json::object();
    b["model"] = model;
    if (prompt) b["input"] = *prompt; // JSON.stringify drops undefined keys
    b["kind"] = kind;
    b["consent"] = consent;
    std::string bs = b.dump();
    json d = http_json("/api/run", true, &bs, true);
    const json* err = get(d, "error");
    if (js_truthy(err)) throw std::runtime_error(js_display(err));
    return d;
}

// model || default (falsy model string falls back)
static std::string model_or(const json& a, const char* dflt) {
    const json* m = get(a, "model");
    return js_truthy(m) ? js_display(m) : dflt;
}

static std::string tool_list_models(const json& a) {
    const json* kindv = get(a, "kind"); // default "all" only when undefined
    bool all = kindv == nullptr || (kindv->is_string() && kindv->get<std::string>() == "all");
    json d = http_json("/api/models", false, nullptr, false);
    const json* models = get(d, "models");
    if (!models || !models->is_array())
        throw std::runtime_error("Cannot read properties of undefined (reading 'filter')");
    std::vector<const json*> ms;
    for (const auto& m : *models) {
        const json* mk = get(m, "kind");
        if (all || (kindv != nullptr && mk != nullptr && *mk == *kindv)) ms.push_back(&m);
    }
    std::string out = std::to_string(ms.size()) + " models. Each costs $HERO per run.\n";
    for (size_t i = 0; i < ms.size() && i < 60; i++) {
        if (i > 0) out += "\n";
        out += "  " + pad_start9(fmt(get(*ms[i], "hero"))) + " $HERO · " +
               js_display(get(*ms[i], "kind")) + "  " + js_display(get(*ms[i], "id"));
    }
    return out;
}

static std::string tool_run_text(const json& a) {
    json d = run_model(model_or(a, "auto"), get(a, "prompt"), "text", js_truthy(get(a, "consent")));
    const json* am = get(d, "autoModel");
    std::string model = js_truthy(am) ? js_display(am) : js_display(get(d, "model"));
    return js_display(get(d, "text")) + "\n\n— " + model + " · spent " +
           fmt(get(d, "charged")) + " $HERO";
}

static std::string tool_generate_image(const json& a) {
    json d = run_model(model_or(a, "google/gemini-2.5-flash-image"), get(a, "prompt"), "image",
                       js_truthy(get(a, "consent")));
    const json* img = get(d, "image");
    if (!js_truthy(img)) return "No image returned.";
    return "Image: " + slice80(js_display(img)) + "…\nspent " + fmt(get(d, "charged")) +
           " $HERO";
}

static std::string tool_generate_video(const json& a) {
    json d = run_model(model_or(a, "wavespeed-ai/wan-2.2/t2v-480p-ultra-fast"), get(a, "prompt"),
                       "video", js_truthy(get(a, "consent")));
    const json* vid = get(d, "video");
    if (!js_truthy(vid)) return "No video returned.";
    return "Video ready: " + js_display(vid) + "\nspent " + fmt(get(d, "charged")) + " $HERO";
}

static std::string tool_generate_audio(const json& a) {
    json d = run_model(model_or(a, "openai/gpt-audio-mini"), get(a, "prompt"), "audio",
                       js_truthy(get(a, "consent")));
    const json* aud = get(d, "audio");
    if (!js_truthy(aud)) return "No audio returned.";
    const json* txt = get(d, "text");
    return "Audio: " + slice80(js_display(aud)) + "…\n" +
           (js_truthy(txt) ? js_display(txt) : "") + "\nspent " + fmt(get(d, "charged")) +
           " $HERO";
}

static std::string tool_treasury_stats(const json&) {
    json t = http_json("/api/treasury", false, nullptr, false);
    const json* cl = get(t, "claimable");
    const json* t0 = cl ? get(*cl, "token0") : nullptr;
    const json* t1 = cl ? get(*cl, "token1") : nullptr;
    std::string tok0 = (t0 && !t0->is_null()) ? js_display(t0) : "?"; // ?? "?"
    std::string tok1 = (t1 && !t1->is_null()) ? js_display(t1) : "?";
    return "Treasury " + js_display(get(t, "treasury")) + "\nClaimable: " + tok0 + " WETH + " +
           tok1 + " HERO";
}

static std::string tool_wallet_balance(const json&) {
    if (KEY.empty()) return "Set HERO_RUN_KEY to see credits.";
    json d = http_json("/api/keys/info", false, nullptr, true);
    const json* err = get(d, "error");
    if (js_truthy(err)) return "API key error: " + js_display(err);
    return "Prepaid API key\n" + fmt(get(d, "balance")) + " $HERO credits (deposited " +
           fmt(get(d, "deposited")) + ", spent " + fmt(get(d, "spent")) + ")";
}

static std::string call_tool(const std::string& name, const json& args) {
    if (name == "list_models") return tool_list_models(args);
    if (name == "run_text") return tool_run_text(args);
    if (name == "generate_image") return tool_generate_image(args);
    if (name == "generate_video") return tool_generate_video(args);
    if (name == "generate_audio") return tool_generate_audio(args);
    if (name == "treasury_stats") return tool_treasury_stats(args);
    if (name == "wallet_balance") return tool_wallet_balance(args);
    // Same message V8 produces for IMPL[params.name](...) on an unknown name.
    throw std::runtime_error("IMPL[params.name] is not a function");
}

// ---------------------------------------------------------------------------
// stdio JSON-RPC loop
// ---------------------------------------------------------------------------

static void send_raw(const std::string& s) {
    std::fwrite(s.data(), 1, s.size(), stdout);
    std::fputc('\n', stdout);
    std::fflush(stdout);
}

int main() {
    curl_global_init(CURL_GLOBAL_DEFAULT);
    if (const char* u = std::getenv("HERO_RUN_URL")) {
        if (*u) BASE_URL = u;
    }
    if (const char* k = std::getenv("HERO_RUN_KEY")) KEY = k;

    std::string line;
    while (std::getline(std::cin, line)) {
        if (line.find_first_not_of(" \t\r\n\f\v") == std::string::npos) continue;
        json m = json::parse(line, nullptr, false);
        if (m.is_discarded()) continue;
        const json* idp = get(m, "id");
        bool has_id = idp != nullptr; // JSON.stringify drops an undefined id
        json id = has_id ? *idp : json(nullptr);
        const json* methodp = get(m, "method");
        std::string method = (methodp && methodp->is_string()) ? methodp->get<std::string>() : "";

        if (method == "initialize") {
            json r;
            r["jsonrpc"] = "2.0";
            if (has_id) r["id"] = id;
            r["result"]["protocolVersion"] = "2024-11-05";
            r["result"]["capabilities"]["tools"] = json::object();
            r["result"]["serverInfo"]["name"] = "hero-run";
            r["result"]["serverInfo"]["version"] = "1.0.0";
            send_raw(r.dump());
        } else if (method == "tools/list") {
            // Raw splice for byte-identical output vs the Node reference.
            std::string r = "{\"jsonrpc\":\"2.0\",";
            if (has_id) r += "\"id\":" + id.dump() + ",";
            r += "\"result\":{\"tools\":";
            r += TOOLS_JSON;
            r += "}}";
            send_raw(r);
        } else if (method == "tools/call") {
            const json* params = get(m, "params");
            try {
                if (!params)
                    throw std::runtime_error(
                        "Cannot read properties of undefined (reading 'name')");
                const json* namep = get(*params, "name");
                std::string name =
                    (namep && namep->is_string()) ? namep->get<std::string>() : "";
                const json* argsp = get(*params, "arguments");
                json args = (argsp && !argsp->is_null()) ? *argsp : json::object();
                std::string text = call_tool(name, args);
                json r;
                r["jsonrpc"] = "2.0";
                if (has_id) r["id"] = id;
                r["result"]["content"] = json::array();
                json item;
                item["type"] = "text";
                item["text"] = text;
                r["result"]["content"].push_back(item);
                send_raw(r.dump());
            } catch (const std::exception& e) {
                json r;
                r["jsonrpc"] = "2.0";
                if (has_id) r["id"] = id;
                r["error"]["code"] = -32000;
                r["error"]["message"] = e.what();
                send_raw(r.dump());
            }
        } else if (has_id && !id.is_null()) {
            json r;
            r["jsonrpc"] = "2.0";
            r["id"] = id;
            r["error"]["code"] = -32601;
            r["error"]["message"] = "Method not found";
            send_raw(r.dump());
        }
    }
    curl_global_cleanup();
    return 0;
}
