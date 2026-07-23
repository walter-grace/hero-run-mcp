// A tiny agent on Hero Run — Go stdlib only, zero dependencies.
//
// Hero Run speaks the OpenAI API, so an agent is one POST endpoint away:
// point at /v1/chat/completions, use model "auto", and the router picks a
// right-sized model for every step, billed in $HERO from your prepaid key.
//
//	export HERO_RUN_KEY=hr_live_...   # mint at https://hero-run.vercel.app/keys
//	go run . "what is 127 * 419, and is it prime?"
package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"os"
	"strings"
)

const baseURL = "https://hero-run.vercel.app/v1"

const system = "You are a precise agent with one tool: a calculator. " +
	"To use it, reply with ONLY a line like `CALC: 127 * 419` (two numbers, one of + - * /). " +
	"When you receive a line like `RESULT: 53213`, use it to answer. " +
	"When you can answer, reply with the final answer directly."

type msg struct {
	Role    string `json:"role"`
	Content string `json:"content"`
}

// chat sends the conversation to Hero Run and returns the reply plus routing info.
func chat(messages []msg) (reply, routed string, err error) {
	body, _ := json.Marshal(map[string]any{"model": "auto", "messages": messages})
	req, _ := http.NewRequest("POST", baseURL+"/chat/completions", bytes.NewReader(body))
	req.Header.Set("Authorization", "Bearer "+os.Getenv("HERO_RUN_KEY"))
	req.Header.Set("Content-Type", "application/json")
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		return "", "", err
	}
	defer res.Body.Close()
	var out struct {
		Choices []struct {
			Message msg `json:"message"`
		} `json:"choices"`
		XHero struct {
			Tier  string `json:"routed_tier"`
			Model string `json:"resolved_model"`
		} `json:"x_hero"`
		Error *struct {
			Message string `json:"message"`
		} `json:"error"`
	}
	if err := json.NewDecoder(res.Body).Decode(&out); err != nil {
		return "", "", err
	}
	if out.Error != nil {
		return "", "", fmt.Errorf("%s", out.Error.Message)
	}
	return strings.TrimSpace(out.Choices[0].Message.Content),
		fmt.Sprintf("%s -> %s", out.XHero.Tier, out.XHero.Model), nil
}

// calc is the tool: "a op b" with one of + - * /.
func calc(expr string) string {
	var a, b float64
	var op string
	if _, err := fmt.Sscanf(expr, "%f %s %f", &a, &op, &b); err != nil {
		return "error: use `a op b`, e.g. 127 * 419"
	}
	switch op {
	case "+":
		return fmt.Sprintf("%g", a+b)
	case "-":
		return fmt.Sprintf("%g", a-b)
	case "*":
		return fmt.Sprintf("%g", a*b)
	case "/":
		if b == 0 {
			return "error: divide by zero"
		}
		return fmt.Sprintf("%g", a/b)
	}
	return "error: unknown operator"
}

func main() {
	task := strings.Join(os.Args[1:], " ")
	if task == "" {
		task = "What is 127 * 419? Use the calculator."
	}
	messages := []msg{{Role: "system", Content: system}, {Role: "user", Content: task}}

	for range 5 { // agent loop: think -> maybe use tool -> answer
		reply, routed, err := chat(messages)
		if err != nil {
			log.Fatal(err)
		}
		fmt.Printf("[%s]\n", routed)

		expr, isTool := strings.CutPrefix(reply, "CALC:")
		if !isTool { // no tool call -> final answer
			fmt.Println(reply)
			return
		}
		result := calc(strings.TrimSpace(expr))
		fmt.Printf("  tool: %s = %s\n", strings.TrimSpace(expr), result)
		messages = append(messages,
			msg{Role: "assistant", Content: reply},
			msg{Role: "user", Content: "RESULT: " + result},
		)
	}
	fmt.Println("(agent hit its step limit)")
}
