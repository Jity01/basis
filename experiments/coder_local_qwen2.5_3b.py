"""
Search Agent Experiment
-----------------------
Spins up a shell, loops with a local coding model via Ollama,
runs terminal commands against the .context/ file structure,
and produces a final report.

Usage:
  1. Make sure Ollama is running with qwen2.5-coder:3b pulled
  2. Make sure you have some data in ~/.context/
  3. python search_agent.py

Change QUERY below to test different searches.
"""

import subprocess
import requests
import json
import re
import os

# ---- CONFIG ----
OLLAMA_URL = "http://localhost:11434/api/chat"
MODEL = os.environ.get("OLLAMA_MODEL", "qwen3:8b")
CONTEXT_ROOT = "~/.context"
MAX_ROUNDS = 10
MAX_OUTPUT_CHARS = 2000

QUERY = "claude context manager spec"

# ---- SYSTEM PROMPT ----
SYSTEM_PROMPT = f"""You are a search agent for a personal context manager.
Your goal is to generate 10 summaries you think matches the query.

The user's screen activity summaries are stored at {CONTEXT_ROOT}.

File structure:
  {CONTEXT_ROOT}/YYYY/MM/DD/HH-MM/summary.txt  — detailed summary of a 5-min chunk
  {CONTEXT_ROOT}/YYYY/MM/DD/HH-MM/meta.json    — tags, entities, activity_label, mode
  {CONTEXT_ROOT}/YYYY/MM/DD/index.txt           — all summaries for that day concatenated

Given a query, generate bash commands to search the data.

After each command result, either:
- Generate more commands if you need more info
- Output FINAL REPORT: followed by your list if you have enough info

Strict output format (must follow exactly):
1) Command mode:
```bash
<one or more shell commands>
```
IMPORTANT: DO NOT INCLUDE ANY other text before or after the code block. Your
job is to soley generate the code block.

2) Final mode:
FINAL REPORT:
<your list>
Do not include any code block in final mode. All you have to do here is generate
10 summaries you think matches the query.

Rules:
- Only use: find, grep, cat, ls, head, tail, jq, wc, sort, uniq, awk, sed
- Do NOT modify or delete any files
- Output exactly one code block with your command(s), nothing else (unless giving the final report)
- When giving the final report, do NOT include a code block — just write FINAL REPORT: followed by the report
"""


def call_ollama(conversation: list) -> str:
    """Send conversation to Ollama and return the response text."""
    resp = requests.post(
        OLLAMA_URL,
        json={
            "model": MODEL,
            "messages": conversation,
            "stream": False,
            "options": {
                "num_predict": 1000,
                "temperature": 0.1,
            },
        },
        timeout=60,
    )
    try:
        resp.raise_for_status()
    except requests.HTTPError as exc:
        details = ""
        try:
            details = f" | body: {resp.text}"
        except Exception:
            pass
        raise requests.HTTPError(f"{exc}{details}") from exc
    data = resp.json()
    return data["message"]["content"]


def parse_model_response(text: str) -> tuple[str, str | None, str | None]:
    """
    Parse model output according to the strict protocol.
    Returns: (kind, payload, error)
      - kind: "command" | "final" | "invalid"
      - payload: command text or final report text when valid
      - error: short reason when invalid
    """
    raw = text.strip()
    has_final = "FINAL REPORT:" in raw

    # Match all fenced code blocks
    code_blocks = re.findall(r"```(?:bash|sh)?\s*\n(.*?)```", raw, re.DOTALL)
    has_code = len(code_blocks) > 0

    if has_final and has_code:
        return ("invalid", None, "Response mixed FINAL REPORT and code block.")

    if has_final:
        if not raw.startswith("FINAL REPORT:"):
            return ("invalid", None, "FINAL REPORT must start the response.")
        report = raw.split("FINAL REPORT:", 1)[1].strip()
        if not report:
            return ("invalid", None, "FINAL REPORT is empty.")
        return ("final", report, None)

    if has_code:
        if len(code_blocks) != 1:
            return ("invalid", None, "Response must contain exactly one code block.")
        # Ensure there is no extra text outside the code block
        stripped_without_block = re.sub(r"```(?:bash|sh)?\s*\n.*?```", "", raw, flags=re.DOTALL).strip()
        if stripped_without_block:
            return ("invalid", None, "Code block mode cannot include extra text.")
        command = code_blocks[0].strip()
        if not command:
            return ("invalid", None, "Code block is empty.")
        return ("command", command, None)

    return ("invalid", None, "Response must be either one code block or FINAL REPORT.")


def run_command(cmd: str) -> str:
    """Run a bash command and return stdout + stderr."""
    expanded_cmd = cmd.replace("~/.context", CONTEXT_ROOT)
    try:
        result = subprocess.run(
            ["bash", "-c", expanded_cmd],
            capture_output=True,
            text=True,
            timeout=10,
        )
        output = result.stdout + result.stderr
        if len(output) > MAX_OUTPUT_CHARS:
            output = output[:MAX_OUTPUT_CHARS] + f"\n... (truncated, {len(output)} total chars)"
        if not output.strip():
            output = "(no output)"
        return output
    except subprocess.TimeoutExpired:
        return "(command timed out after 10 seconds)"
    except Exception as e:
        return f"(error running command: {e})"


def main():
    # Expand ~ in context root
    global CONTEXT_ROOT
    CONTEXT_ROOT = os.path.expanduser(CONTEXT_ROOT)

    print(f"Search Agent Experiment")
    print(f"Model: {MODEL}")
    print(f"Context root: {CONTEXT_ROOT}")
    print(f"Query: {QUERY}")
    print(f"Max rounds: {MAX_ROUNDS}")
    print("=" * 60)

    conversation = [
        {"role": "system", "content": SYSTEM_PROMPT},
        {"role": "user", "content": QUERY},
    ]

    for round_num in range(1, MAX_ROUNDS + 1):
        print(f"\n--- Round {round_num}/{MAX_ROUNDS} ---")
        print("Thinking...")

        response = call_ollama(conversation)
        print(f"Model: {response[:200]}{'...' if len(response) > 200 else ''}")

        kind, payload, err = parse_model_response(response)

        if kind == "final" and payload is not None:
            print("\n" + "=" * 60)
            print("FINAL REPORT:")
            print("=" * 60)
            print(payload)
            return

        if kind == "invalid":
            print(f"Invalid response format: {err}")
            conversation.append({"role": "assistant", "content": response})
            conversation.append({
                "role": "user",
                "content": (
                    f"Invalid format: {err}\n"
                    "Respond in exactly one of these forms:\n"
                    "1) One ```bash code block with commands and no extra text.\n"
                    "2) FINAL REPORT: followed by your report (no code block)."
                ),
            })
            continue

        cmd = payload or ""

        print(f"Command: {cmd}")
        output = run_command(cmd)
        print(f"Output: {output[:300]}{'...' if len(output) > 300 else ''}")

        remaining = MAX_ROUNDS - round_num
        conversation.append({"role": "assistant", "content": response})
        conversation.append({
            "role": "user",
            "content": f"Command output:\n{output}\n\n({remaining} rounds left)",
        })

    # Hit max rounds — force a final report
    print(f"\n--- Max rounds reached, forcing final report ---")
    conversation.append({
        "role": "user",
        "content": "No more rounds. Give your FINAL REPORT: now based on everything you've gathered.",
    })
    response = call_ollama(conversation)

    if "FINAL REPORT:" in response:
        report = response.split("FINAL REPORT:", 1)[1].strip()
    else:
        report = response

    print("\n" + "=" * 60)
    print("FINAL REPORT:")
    print("=" * 60)
    print(report)


if __name__ == "__main__":
    main()