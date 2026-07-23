// Hero Run — Telegram bot that drives the Hero Run MCP server.
//
// The bot spawns an MCP server (any of the repo's language impls) as a
// subprocess and speaks JSON-RPC 2.0 over stdio, so every Telegram command
// becomes a real MCP tools/call. Zero external dependencies: net/http for the
// Telegram Bot API, os/exec + encoding/json for the MCP transport.
//
//	TELEGRAM_BOT_TOKEN=123:abc \   # from @BotFather
//	HERO_RUN_KEY=hr_live_...    \   # optional; needed for paid tools (ask/image)
//	MCP_CMD="../../go/hero-run-mcp" \  # optional; the MCP server to drive
//	go run .
package main

import (
	"bufio"
	"bytes"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"mime/multipart"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"sync"
	"time"
)

// ---------- MCP client: spawn a server, speak JSON-RPC 2.0 over stdio ----------

type contentItem struct {
	Type     string `json:"type"`
	Text     string `json:"text"`
	Data     string `json:"data"` // base64 (image)
	MimeType string `json:"mimeType"`
}

type mcp struct {
	mu  sync.Mutex // serialize requests over the single stdio pipe
	in  io.WriteCloser
	out *bufio.Reader
	id  int
}

func startMCP(cmdline string) (*mcp, error) {
	parts := strings.Fields(cmdline)
	if len(parts) == 0 {
		return nil, errors.New("empty MCP_CMD")
	}
	cmd := exec.Command(parts[0], parts[1:]...)
	cmd.Stderr = os.Stderr // the server prints a one-line startup banner here
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return nil, err
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, err
	}
	if err := cmd.Start(); err != nil {
		return nil, err
	}
	m := &mcp{in: stdin, out: bufio.NewReader(stdout)}
	if _, err := m.rpc("initialize", map[string]any{}); err != nil {
		return nil, fmt.Errorf("initialize: %w", err)
	}
	return m, nil
}

func (m *mcp) rpc(method string, params any) (json.RawMessage, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.id++
	id := m.id
	req, _ := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": id, "method": method, "params": params})
	if _, err := m.in.Write(append(req, '\n')); err != nil {
		return nil, err
	}
	for { // read until we get the response with our id (skip any others)
		line, err := m.out.ReadBytes('\n')
		if err != nil {
			return nil, err
		}
		var r struct {
			ID     *int            `json:"id"`
			Result json.RawMessage `json:"result"`
			Error  *struct {
				Message string `json:"message"`
			} `json:"error"`
		}
		if json.Unmarshal(line, &r) != nil || r.ID == nil || *r.ID != id {
			continue
		}
		if r.Error != nil {
			return nil, errors.New(r.Error.Message)
		}
		return r.Result, nil
	}
}

func (m *mcp) callTool(name string, args map[string]any) (contentItem, error) {
	res, err := m.rpc("tools/call", map[string]any{"name": name, "arguments": args})
	if err != nil {
		return contentItem{}, err
	}
	var out struct {
		Content []contentItem `json:"content"`
	}
	if err := json.Unmarshal(res, &out); err != nil {
		return contentItem{}, err
	}
	if len(out.Content) == 0 {
		return contentItem{}, errors.New("empty response from tool")
	}
	return out.Content[0], nil
}

// ---------- Telegram Bot API (long polling, stdlib http) ----------

type tg struct{ api string }

type update struct {
	UpdateID int `json:"update_id"`
	Message  *struct {
		Chat struct {
			ID int64 `json:"id"`
		} `json:"chat"`
		Text string `json:"text"`
	} `json:"message"`
}

func (t *tg) getUpdates(offset int) ([]update, error) {
	resp, err := http.Get(fmt.Sprintf("%s/getUpdates?timeout=30&offset=%d", t.api, offset))
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	var r struct {
		OK     bool     `json:"ok"`
		Result []update `json:"result"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&r); err != nil {
		return nil, err
	}
	return r.Result, nil
}

func (t *tg) send(chat int64, text string) {
	if len([]rune(text)) > 4000 { // Telegram caps messages at 4096 chars
		text = string([]rune(text)[:4000]) + "…"
	}
	http.PostForm(t.api+"/sendMessage", url.Values{"chat_id": {fmt.Sprint(chat)}, "text": {text}})
}

func (t *tg) sendPhoto(chat int64, data []byte, caption string) error {
	var buf bytes.Buffer
	w := multipart.NewWriter(&buf)
	w.WriteField("chat_id", fmt.Sprint(chat))
	if caption != "" {
		w.WriteField("caption", caption)
	}
	fw, _ := w.CreateFormFile("photo", "image.png")
	fw.Write(data)
	w.Close()
	resp, err := http.Post(t.api+"/sendPhoto", w.FormDataContentType(), &buf)
	if err != nil {
		return err
	}
	resp.Body.Close()
	return nil
}

// ---------- bot ----------

const help = `Hero Run — run 340+ AI models, paid in $HERO.

/models [text|image|audio]  list available models
/ask [model] <prompt>       run a text model
/image [model] <prompt>     generate an image
/treasury                   fees funding open-source AI
/balance                    your $HERO credit balance

Plain text is treated as /ask.
Add an optional model id first, e.g.
  /ask openai/gpt-5 explain quantum tunneling
  /image google/gemini-3-pro-image a red fox`

const selfHost = "This is a public demo, so paid tools are limited to protect a shared balance. Run your own Hero Run bot with your own token and $HERO key (no limits): https://hero-run.vercel.app/keys"

// demo mode caps paid usage on a public bot so its shared prepaid key can't be
// drained. Counters are in-memory (reset on restart) — fine for a demo.
type demo struct {
	on         bool
	userLimit  int
	totalLimit int
	mu         sync.Mutex
	perUser    map[int64]int
	total      int
}

// allowAsk reports whether this chat may run one more paid /ask under the demo caps.
func (d *demo) allowAsk(chat int64) bool {
	if !d.on {
		return true
	}
	d.mu.Lock()
	defer d.mu.Unlock()
	if d.total >= d.totalLimit || d.perUser[chat] >= d.userLimit {
		return false
	}
	d.total++
	d.perUser[chat]++
	return true
}

var dm = &demo{perUser: map[int64]int{}}

func envInt(name string, def int) int {
	if v := os.Getenv(name); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			return n
		}
	}
	return def
}

func main() {
	token := os.Getenv("TELEGRAM_BOT_TOKEN")
	if token == "" {
		log.Fatal("set TELEGRAM_BOT_TOKEN (get one from @BotFather)")
	}
	cmdline := os.Getenv("MCP_CMD")
	if cmdline == "" {
		cmdline = "../../go/hero-run-mcp" // build with: (cd ../../go && go build -o hero-run-mcp .)
	}
	dm.on = os.Getenv("DEMO_MODE") == "1"
	dm.userLimit = envInt("DEMO_USER_LIMIT", 3)
	dm.totalLimit = envInt("DEMO_TOTAL_LIMIT", 20)
	if dm.on {
		log.Printf("DEMO_MODE on: /image disabled, /ask capped at %d/user, %d total (in-memory)", dm.userLimit, dm.totalLimit)
	}
	server, err := startMCP(cmdline)
	if err != nil {
		log.Fatalf("start MCP server (%s): %v", cmdline, err)
	}
	log.Printf("MCP server up via: %s", cmdline)

	bot := &tg{api: "https://api.telegram.org/bot" + token}
	log.Println("bot polling for updates…")

	offset := 0
	for {
		ups, err := bot.getUpdates(offset)
		if err != nil {
			log.Printf("getUpdates: %v", err)
			time.Sleep(2 * time.Second)
			continue
		}
		for _, u := range ups {
			offset = u.UpdateID + 1
			if u.Message == nil || u.Message.Text == "" {
				continue
			}
			go handle(bot, server, u.Message.Chat.ID, strings.TrimSpace(u.Message.Text))
		}
	}
}

func handle(bot *tg, server *mcp, chat int64, text string) {
	cmd, arg := "/ask", text
	if strings.HasPrefix(text, "/") {
		cmd = text
		if i := strings.IndexByte(text, ' '); i > 0 {
			cmd, arg = text[:i], strings.TrimSpace(text[i+1:])
		} else {
			arg = ""
		}
		cmd = strings.SplitN(cmd, "@", 2)[0] // strip @botname in group chats
	}

	switch cmd {
	case "/start", "/help":
		msg := help
		if dm.on {
			msg += "\n\n" + selfHost
		}
		bot.send(chat, msg)
	case "/models":
		kind := arg
		if kind == "" {
			kind = "all"
		}
		out, err := server.callTool("list_models", map[string]any{"kind": kind})
		reply(bot, chat, out, err)
	case "/ask":
		if arg == "" {
			bot.send(chat, "Usage: /ask [model] <prompt>")
			return
		}
		if !dm.allowAsk(chat) {
			bot.send(chat, selfHost)
			return
		}
		bot.send(chat, "Thinking…")
		model, prompt := splitModel(arg)
		args := map[string]any{"prompt": prompt}
		if model != "" {
			args["model"] = model
		}
		out, err := server.callTool("run_text", args)
		reply(bot, chat, out, err)
	case "/image":
		if arg == "" {
			bot.send(chat, "Usage: /image [model] <prompt>")
			return
		}
		if dm.on {
			bot.send(chat, "Image generation is disabled on the public demo (it costs a lot of $HERO). "+selfHost)
			return
		}
		bot.send(chat, "Generating…")
		model, prompt := splitModel(arg)
		if model == "" {
			model = "google/gemini-2.5-flash-image" // affordable default; override with /image <model> <prompt>
		}
		out, err := server.callTool("generate_image", map[string]any{"prompt": prompt, "model": model})
		if err != nil {
			bot.send(chat, "Error: "+err.Error())
			return
		}
		img, derr := base64.StdEncoding.DecodeString(out.Data)
		if derr != nil {
			bot.send(chat, "bad image data from model")
			return
		}
		if err := bot.sendPhoto(chat, img, arg); err != nil {
			bot.send(chat, "send failed: "+err.Error())
		}
	case "/treasury":
		out, err := server.callTool("treasury_stats", map[string]any{})
		reply(bot, chat, out, err)
	case "/balance":
		out, err := server.callTool("wallet_balance", map[string]any{})
		reply(bot, chat, out, err)
	default:
		bot.send(chat, "Unknown command. Send /help for options.")
	}
}

// splitModel pulls an optional leading model id (contains "/") off the argument,
// e.g. "google/gemini-3-pro-image a red fox" -> ("google/gemini-3-pro-image", "a red fox").
func splitModel(arg string) (model, prompt string) {
	f := strings.Fields(arg)
	if len(f) >= 2 && strings.Contains(f[0], "/") {
		return f[0], strings.TrimSpace(arg[strings.Index(arg, f[0])+len(f[0]):])
	}
	return "", arg
}

func reply(bot *tg, chat int64, out contentItem, err error) {
	if err != nil {
		bot.send(chat, "Error: "+err.Error())
		return
	}
	bot.send(chat, out.Text)
}
