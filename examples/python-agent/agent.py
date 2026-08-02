"""A tiny agent on Hero Run — one dependency, ~40 lines of logic.

Hero Run speaks the OpenAI API, so any OpenAI client is already a Hero Run
client: point base_url at /v1, use model "auto", and the router picks a
right-sized model for every step, billed in $HERO from your prepaid key.

    pip install openai
    export HERO_RUN_KEY=hr_live_...   # mint at https://herorunai.com/keys
    python agent.py "what is 127 * 419, and is it prime?"
"""

import os
import re
import sys

from openai import OpenAI

client = OpenAI(
    base_url="https://herorunai.com/v1",
    api_key=os.environ["HERO_RUN_KEY"],
)

SYSTEM = (
    "You are a precise agent with one tool: a calculator. "
    "To use it, reply with ONLY a line like `CALC: 127*419` and nothing else. "
    "When you receive a line like `RESULT: 53213`, use it to answer. "
    "When you can answer, reply with the final answer directly."
)


def calc(expr: str) -> str:
    """The tool: evaluate basic arithmetic, nothing else."""
    if not re.fullmatch(r"[0-9+\-*/().% ]+", expr):
        return "error: only arithmetic allowed"
    return str(eval(expr))  # safe: input is whitelisted above


def run_agent(task: str) -> None:
    messages = [{"role": "system", "content": SYSTEM}, {"role": "user", "content": task}]
    for _ in range(5):  # agent loop: think -> maybe use tool -> answer
        r = client.chat.completions.create(model="auto", messages=messages)
        reply = r.choices[0].message.content.strip()
        hero = r.model_dump().get("x_hero") or {}
        print(f"[{hero.get('routed_tier', '?')} -> {hero.get('resolved_model', r.model)}]")

        # grab just the arithmetic after CALC:, ignoring any trailing prose
        m = re.match(r"^CALC:\s*([0-9+\-*/().% ]+)", reply)
        if not m:  # no tool call -> final answer
            print(reply)
            return
        result = calc(m.group(1).strip())
        print(f"  tool: {m.group(1).strip()} = {result}")
        messages += [
            {"role": "assistant", "content": reply},
            {"role": "user", "content": f"RESULT: {result}"},
        ]
    print("(agent hit its step limit)")


if __name__ == "__main__":
    run_agent(" ".join(sys.argv[1:]) or "What is 127 * 419? Use the calculator.")
