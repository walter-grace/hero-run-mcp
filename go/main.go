// Hero Run MCP server — Go implementation (stdio JSON-RPC).
// Any MCP agent can run 340+ AI models paying $HERO per call. Key mode only; the API
// key is read from HERO_RUN_KEY, never hardcoded. Pure stdlib, compiles to one binary.
package main

import (
	"bufio"
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
)

func env(k, d string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return d
}

var baseURL = env("HERO_RUN_URL", "https://hero-run.vercel.app")
var apiKey = os.Getenv("HERO_RUN_KEY")

func httpJSON(path, method string, body any, useKey bool) (map[string]any, error) {
	var rdr io.Reader
	if body != nil {
		b, _ := json.Marshal(body)
		rdr = bytes.NewReader(b)
	}
	req, _ := http.NewRequest(method, baseURL+path, rdr)
	req.Header.Set("Content-Type", "application/json")
	if useKey && apiKey != "" {
		req.Header.Set("x-api-key", apiKey)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	var out map[string]any
	json.NewDecoder(resp.Body).Decode(&out)
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
	if e, ok := d["error"].(string); ok {
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
		kind := str(a["kind"])
		if kind == "" {
			kind = "all"
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
		model := str(a["model"])
		if model == "" {
			model = "auto"
		}
		d, err := runModel(model, str(a["prompt"]), "text", a["consent"] == true)
		if err != nil {
			return "", err
		}
		am := str(d["autoModel"])
		if am == "" {
			am = str(d["model"])
		}
		return fmt.Sprintf("%s\n\n— %s · spent %s $HERO", str(d["text"]), am, fmtNum(num(d["charged"]))), nil
	case "generate_image":
		model := str(a["model"])
		if model == "" {
			model = "google/gemini-2.5-flash-image"
		}
		d, err := runModel(model, str(a["prompt"]), "image", a["consent"] == true)
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
	case "treasury_stats":
		d, err := httpJSON("/api/treasury", "GET", nil, false)
		if err != nil {
			return "", err
		}
		cl, _ := d["claimable"].(map[string]any)
		t0, t1 := "?", "?"
		if cl != nil {
			t0, t1 = str(cl["token0"]), str(cl["token1"])
		}
		return fmt.Sprintf("Treasury %s\nClaimable: %s WETH + %s HERO", str(d["treasury"]), t0, t1), nil
	case "wallet_balance":
		if apiKey == "" {
			return "Set HERO_RUN_KEY to see credits.", nil
		}
		d, err := httpJSON("/api/keys/info", "GET", nil, true)
		if err != nil {
			return "", err
		}
		if e, ok := d["error"].(string); ok {
			return "API key error: " + e, nil
		}
		return fmt.Sprintf("Prepaid API key\n%s $HERO credits (deposited %s, spent %s)", fmtNum(num(d["balance"])), fmtNum(num(d["deposited"])), fmtNum(num(d["spent"]))), nil
	}
	return "", fmt.Errorf("unknown tool: %s", name)
}

var toolsJSON = json.RawMessage(`[
{"name":"list_models","description":"List AI models available through the Hero Run gateway.","inputSchema":{"type":"object","properties":{"kind":{"type":"string","enum":["text","image","audio","all"]}}}},
{"name":"run_text","description":"Run a text model (default: auto). Pays $HERO via your key.","inputSchema":{"type":"object","required":["prompt"],"properties":{"prompt":{"type":"string"},"model":{"type":"string"},"consent":{"type":"boolean"}}}},
{"name":"generate_image","description":"Generate an image. Pays $HERO via your key.","inputSchema":{"type":"object","required":["prompt"],"properties":{"prompt":{"type":"string"},"model":{"type":"string"},"consent":{"type":"boolean"}}}},
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

func send(id json.RawMessage, result any, errObj any) {
	m := map[string]any{"jsonrpc": "2.0"}
	if id != nil {
		m["id"] = id
	}
	if errObj != nil {
		m["error"] = errObj
	} else {
		m["result"] = result
	}
	b, _ := json.Marshal(m)
	os.Stdout.Write(append(b, '\n'))
}

func main() {
	sc := bufio.NewScanner(os.Stdin)
	sc.Buffer(make([]byte, 1024*1024), 1024*1024)
	for sc.Scan() {
		line := sc.Bytes()
		if len(bytes.TrimSpace(line)) == 0 {
			continue
		}
		var r request
		if json.Unmarshal(line, &r) != nil {
			continue
		}
		switch r.Method {
		case "initialize":
			send(r.ID, map[string]any{"protocolVersion": "2024-11-05", "capabilities": map[string]any{"tools": map[string]any{}}, "serverInfo": map[string]any{"name": "hero-run", "version": "1.0.0"}}, nil)
		case "tools/list":
			send(r.ID, map[string]any{"tools": toolsJSON}, nil)
		case "tools/call":
			text, err := callTool(r.Params.Name, r.Params.Arguments)
			if err != nil {
				send(r.ID, nil, map[string]any{"code": -32000, "message": err.Error()})
			} else {
				send(r.ID, map[string]any{"content": []map[string]any{{"type": "text", "text": text}}}, nil)
			}
		default:
			if r.ID != nil {
				send(r.ID, nil, map[string]any{"code": -32601, "message": "Method not found"})
			}
		}
	}
}
