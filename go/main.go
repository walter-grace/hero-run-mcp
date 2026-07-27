// Hero Run MCP server — Go implementation (stdio JSON-RPC).
// Any MCP agent can run 340+ AI models paying $HERO per call. Key mode only; the API
// key is read from HERO_RUN_KEY, never hardcoded. Pure stdlib, compiles to one binary.
package main

import (
	"bufio"
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"
)

// rpcError carries a JSON-RPC error code alongside the message.
type rpcError struct {
	code int
	msg  string
}

func (e *rpcError) Error() string { return e.msg }

func invalidParams(format string, args ...any) error {
	return &rpcError{code: -32602, msg: fmt.Sprintf(format, args...)}
}

// codeOf returns the JSON-RPC code an error should be reported with.
func codeOf(err error) int {
	var re *rpcError
	if errors.As(err, &re) {
		return re.code
	}
	return -32000
}

func env(k, d string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return d
}

var baseURL = env("HERO_RUN_URL", "https://hero-run.vercel.app")
var apiKey = os.Getenv("HERO_RUN_KEY")

// Video runs can take 1-3 minutes; allow up to 5 minutes for any call.
var client = &http.Client{Timeout: 300 * time.Second}

func httpJSON(path, method string, body any, useKey bool) (map[string]any, error) {
	var rdr io.Reader
	if body != nil {
		b, _ := json.Marshal(body)
		rdr = bytes.NewReader(b)
	}
	req, err := http.NewRequest(method, baseURL+path, rdr)
	if err != nil {
		return nil, fmt.Errorf("bad url")
	}
	req.Header.Set("Content-Type", "application/json")
	if useKey && apiKey != "" {
		req.Header.Set("x-api-key", apiKey)
	}
	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	var out map[string]any
	// A non-JSON body (HTML error page, empty response) is a failure, not an
	// empty success — never let it read as "0 credits" / "0 models".
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return nil, fmt.Errorf("HTTP %d: invalid JSON response from %s", resp.StatusCode, path)
	}
	return out, nil
}

func num(v any) float64 {
	if f, ok := v.(float64); ok {
		return f
	}
	return 0
}
func str(v any) string {
	if s, ok := v.(string); ok {
		return s
	}
	return ""
}

// loose renders any JSON value as plain text (string without quotes, number
// as-is), so numeric fields don't disappear.
func loose(v any) string {
	switch t := v.(type) {
	case nil:
		return ""
	case string:
		return t
	case bool:
		return strconv.FormatBool(t)
	case float64:
		return strconv.FormatFloat(t, 'f', -1, 64)
	case json.Number:
		return t.String()
	default:
		b, err := json.Marshal(t)
		if err != nil {
			return fmt.Sprintf("%v", t)
		}
		return string(b)
	}
}

// plain is loose with a fallback for a missing/null value.
func plain(v any, fallback string) string {
	if v == nil {
		return fallback
	}
	return loose(v)
}

// apiError reports the message of a truthy `error` field, if any. An error
// object (not just a string) counts as a failure.
func apiError(d map[string]any) (string, bool) {
	v, ok := d["error"]
	if !ok || v == nil {
		return "", false
	}
	switch t := v.(type) {
	case string:
		if t == "" {
			return "", false
		}
	case bool:
		if !t {
			return "", false
		}
	case float64:
		if t == 0 {
			return "", false
		}
	}
	return loose(v), true
}

// promptArg requires a string `prompt` before any (billed) HTTP call.
func promptArg(a map[string]any) (string, error) {
	v, ok := a["prompt"]
	if !ok || v == nil {
		return "", invalidParams("Invalid params: prompt must be a string")
	}
	s, ok := v.(string)
	if !ok {
		return "", invalidParams("Invalid params: prompt must be a string")
	}
	return s, nil
}

// comma-format an integer amount
func fmtNum(f float64) string {
	s := fmt.Sprintf("%.0f", f)
	neg := strings.HasPrefix(s, "-")
	if neg {
		s = s[1:]
	}
	n := len(s)
	if n > 3 {
		var b strings.Builder
		pre := n % 3
		if pre > 0 {
			b.WriteString(s[:pre])
			b.WriteByte(',')
		}
		for i := pre; i < n; i += 3 {
			b.WriteString(s[i : i+3])
			if i+3 < n {
				b.WriteByte(',')
			}
		}
		s = b.String()
	}
	if neg {
		return "-" + s
	}
	return s
}

func runModel(id, input, kind string, consent bool) (map[string]any, error) {
	if apiKey == "" {
		return nil, fmt.Errorf("Set HERO_RUN_KEY (mint at /keys) to run models.")
	}
	d, err := httpJSON("/api/run", "POST", map[string]any{"model": id, "input": input, "kind": kind, "consent": consent}, true)
	if err != nil {
		return nil, err
	}
	if e, ok := apiError(d); ok {
		return nil, fmt.Errorf("%s", e)
	}
	return d, nil
}

func callTool(name string, a map[string]any) (string, error) {
	switch name {
	case "list_models":
		d, err := httpJSON("/api/models", "GET", nil, false)
		if err != nil {
			return "", err
		}
		if e, ok := apiError(d); ok {
			return "", fmt.Errorf("%s", e)
		}
		// An explicit string (including "") is a supplied filter; a missing or
		// null kind means no filter.
		kind := "all"
		if s, ok := a["kind"].(string); ok {
			kind = s
		}
		models, _ := d["models"].([]any)
		var lines []string
		count := 0
		for _, mm := range models {
			m, _ := mm.(map[string]any)
			if m == nil || (kind != "all" && str(m["kind"]) != kind) {
				continue
			}
			count++
			if len(lines) < 60 {
				lines = append(lines, fmt.Sprintf("  %9s $HERO · %s  %s", fmtNum(num(m["hero"])), str(m["kind"]), str(m["id"])))
			}
		}
		return fmt.Sprintf("%d models. Each costs $HERO per run.\n%s", count, strings.Join(lines, "\n")), nil
	case "run_text":
		prompt, err := promptArg(a)
		if err != nil {
			return "", err
		}
		model := str(a["model"])
		if model == "" {
			model = "auto"
		}
		d, err := runModel(model, prompt, "text", a["consent"] == true)
		if err != nil {
			return "", err
		}
		am := str(d["autoModel"])
		if am == "" {
			am = str(d["model"])
		}
		return fmt.Sprintf("%s\n\n— %s · spent %s $HERO", str(d["text"]), am, fmtNum(num(d["charged"]))), nil
	case "generate_image":
		prompt, err := promptArg(a)
		if err != nil {
			return "", err
		}
		model := str(a["model"])
		if model == "" {
			model = "google/gemini-2.5-flash-image"
		}
		d, err := runModel(model, prompt, "image", a["consent"] == true)
		if err != nil {
			return "", err
		}
		img := str(d["image"])
		if img == "" {
			return "No image returned.", nil
		}
		if len(img) > 80 {
			img = img[:80]
		}
		return fmt.Sprintf("Image: %s…\nspent %s $HERO", img, fmtNum(num(d["charged"]))), nil
	case "generate_video":
		prompt, err := promptArg(a)
		if err != nil {
			return "", err
		}
		model := str(a["model"])
		if model == "" {
			model = "wavespeed-ai/wan-2.2/t2v-480p-ultra-fast"
		}
		d, err := runModel(model, prompt, "video", a["consent"] == true)
		if err != nil {
			return "", err
		}
		video := str(d["video"])
		if video == "" {
			return "No video returned.", nil
		}
		return fmt.Sprintf("Video ready: %s\nspent %s $HERO", video, fmtNum(num(d["charged"]))), nil
	case "generate_audio":
		prompt, err := promptArg(a)
		if err != nil {
			return "", err
		}
		model := str(a["model"])
		if model == "" {
			model = "openai/gpt-audio-mini"
		}
		d, err := runModel(model, prompt, "audio", a["consent"] == true)
		if err != nil {
			return "", err
		}
		audio := str(d["audio"])
		if audio == "" {
			return "No audio returned.", nil
		}
		if len(audio) > 80 {
			audio = audio[:80]
		}
		return fmt.Sprintf("Audio: %s…\n%s\nspent %s $HERO", audio, str(d["text"]), fmtNum(num(d["charged"]))), nil
	case "treasury_stats":
		d, err := httpJSON("/api/treasury", "GET", nil, false)
		if err != nil {
			return "", err
		}
		if e, ok := apiError(d); ok {
			return "", fmt.Errorf("%s", e)
		}
		cl, _ := d["claimable"].(map[string]any)
		t0, t1 := "?", "?"
		if cl != nil {
			t0, t1 = plain(cl["token0"], "?"), plain(cl["token1"], "?")
		}
		return fmt.Sprintf("Treasury %s\nClaimable: %s WETH + %s HERO", plain(d["treasury"], "null"), t0, t1), nil
	case "wallet_balance":
		if apiKey == "" {
			return "Set HERO_RUN_KEY to see credits.", nil
		}
		d, err := httpJSON("/api/keys/info", "GET", nil, true)
		if err != nil {
			return "", err
		}
		// A real API failure is an error, not a balance of zero. Only the
		// "no key configured" case above stays advisory text.
		if e, ok := apiError(d); ok {
			return "", fmt.Errorf("%s", e)
		}
		return fmt.Sprintf("Prepaid API key\n%s $HERO credits (deposited %s, spent %s)", fmtNum(num(d["balance"])), fmtNum(num(d["deposited"])), fmtNum(num(d["spent"]))), nil
	}
	return "", fmt.Errorf("Unknown tool: %s", name)
}

var toolsJSON = json.RawMessage(`[
{"name":"list_models","description":"List AI models available through the Hero Run gateway. Tip: append @gateway to a model id (e.g. openai/gpt-oss-120b@cerebras) to pin a specific gateway.","inputSchema":{"type":"object","properties":{"kind":{"type":"string","enum":["text","image","video","audio","all"]}}}},
{"name":"run_text","description":"Run a text model (default: auto). Pays $HERO via your key.","inputSchema":{"type":"object","required":["prompt"],"properties":{"prompt":{"type":"string"},"model":{"type":"string"},"consent":{"type":"boolean"}}}},
{"name":"generate_image","description":"Generate an image. Pays $HERO via your key.","inputSchema":{"type":"object","required":["prompt"],"properties":{"prompt":{"type":"string"},"model":{"type":"string"},"consent":{"type":"boolean"}}}},
{"name":"generate_video","description":"Generate a short video clip (~5s, default Wan 2.2 480p). Takes 1-3 minutes. Pays $HERO via your key.","inputSchema":{"type":"object","required":["prompt"],"properties":{"prompt":{"type":"string"},"model":{"type":"string"},"consent":{"type":"boolean"}}}},
{"name":"generate_audio","description":"Generate speech or music (default: openai/gpt-audio-mini; music: google/lyria-3-clip-preview). Pays $HERO via your key.","inputSchema":{"type":"object","required":["prompt"],"properties":{"prompt":{"type":"string"},"model":{"type":"string"},"consent":{"type":"boolean"}}}},
{"name":"treasury_stats","description":"Read the Hero Run treasury (live from Base).","inputSchema":{"type":"object","properties":{}}},
{"name":"wallet_balance","description":"Your prepaid API key credit balance.","inputSchema":{"type":"object","properties":{}}}
]`)

type request struct {
	ID     json.RawMessage `json:"id"`
	Method string          `json:"method"`
	Params struct {
		Name      string         `json:"name"`
		Arguments map[string]any `json:"arguments"`
	} `json:"params"`
}

// send writes a response. A request with no `id` member is a notification and
// gets no response at all.
func send(id json.RawMessage, result any, errObj any) {
	if id == nil {
		return
	}
	m := map[string]any{"jsonrpc": "2.0", "id": id}
	if errObj != nil {
		m["error"] = errObj
	} else {
		m["result"] = result
	}
	b, _ := json.Marshal(m)
	os.Stdout.Write(append(b, '\n'))
}

func sendParseError(msg string) {
	b, _ := json.Marshal(map[string]any{
		"jsonrpc": "2.0",
		"id":      nil,
		"error":   map[string]any{"code": -32700, "message": msg},
	})
	os.Stdout.Write(append(b, '\n'))
}

// Guard rail only: a line this long is not a real request. Anything under it is
// served normally (bufio.Scanner used to die at 1 MB and answer nothing again).
const maxLine = 32 * 1024 * 1024

func main() {
	rd := bufio.NewReaderSize(os.Stdin, 64*1024)
	for {
		line, err := rd.ReadString('\n')
		if len(line) > maxLine {
			sendParseError("Parse error: request line exceeds size limit")
			if err != nil {
				return
			}
			continue
		}
		if len(bytes.TrimSpace([]byte(line))) > 0 {
			handle([]byte(line))
		}
		if err != nil {
			if err != io.EOF {
				sendParseError("Parse error: " + err.Error())
			}
			return
		}
	}
}

func handle(line []byte) {
	var r request
	if json.Unmarshal(line, &r) != nil {
		return
	}
	switch r.Method {
	case "initialize":
		send(r.ID, map[string]any{"protocolVersion": "2024-11-05", "capabilities": map[string]any{"tools": map[string]any{}}, "serverInfo": map[string]any{"name": "hero-run", "version": "1.0.0"}}, nil)
	case "tools/list":
		send(r.ID, map[string]any{"tools": toolsJSON}, nil)
	case "tools/call":
		text, err := callTool(r.Params.Name, r.Params.Arguments)
		if err != nil {
			send(r.ID, nil, map[string]any{"code": codeOf(err), "message": err.Error()})
		} else {
			send(r.ID, map[string]any{"content": []map[string]any{{"type": "text", "text": text}}}, nil)
		}
	default:
		if r.ID != nil {
			send(r.ID, nil, map[string]any{"code": -32601, "message": "Method not found"})
		}
	}
}
