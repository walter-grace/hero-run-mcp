# Go agent on Hero Run

A working tool-using agent with the Go standard library only: zero dependencies. The agent is one POST endpoint away: `/v1/chat/completions` with a Bearer `hr_live_` key and model `"auto"`, and Hero Run's router right-sizes the model for every step, billed in $HERO.

```bash
export HERO_RUN_KEY=hr_live_...   # mint at https://herorunai.com/keys
go run . "what is 127 * 419, and is it prime?"
```

Sample run:

```
[mid -> openai/gpt-oss-120b]
  tool: 127 * 419 = 53213
[mid -> openai/gpt-oss-120b]
The result of 127 multiplied by 419 is 53,213.
```

The loop is the whole trick: send the conversation, and if the model replies `CALC: a op b`, run the tool and feed `RESULT: <value>` back; otherwise print the answer. Each `[tier -> model]` line is the router's live decision (`x_hero` metadata in the response).

Prefer a typed client with streaming? See [`hero-run-go`](https://github.com/walter-grace/hero-run-go): `Chat`, `ChatStream`, `ListModels`.
