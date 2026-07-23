# Python agent on Hero Run

A working tool-using agent in ~40 lines of logic, one dependency. Hero Run speaks the OpenAI API, so the standard `openai` client is all you need: point `base_url` at `/v1`, use model `"auto"`, and the router right-sizes the model for every step, billed in $HERO.

```bash
pip install openai
export HERO_RUN_KEY=hr_live_...   # mint at https://hero-run.vercel.app/keys
python agent.py "what is 127 * 419, and is it prime?"
```

Sample run:

```
[mid -> openai/gpt-oss-120b]
  tool: 88*61 = 5368
[mid -> openai/gpt-oss-120b]
88 multiplied by 61 equals 5368.
```

The loop is the whole trick: send the conversation, and if the model replies `CALC: <expr>`, run the tool and feed `RESULT: <value>` back; otherwise print the answer. Each `[tier -> model]` line is the router's live decision (`x_hero` metadata in the response).
