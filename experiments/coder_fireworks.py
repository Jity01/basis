"""
Index Matcher Experiment (Fireworks)
------------------------------------
Reads context day index files in non-overlapping batches, sends each batch to a
Fireworks model in parallel, and returns matching index file paths for a query.

Usage:
  1. Put FIREWORKS_API_KEY in repo .env (or export it)
  2. (Optional) set FIREWORKS_MODEL
  3. python coder_fireworks.py --query "claude context manager spec"
"""

import argparse
import os
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

import requests


def _load_repo_dotenv() -> None:
    """Load environment variables from repo .env if available."""
    repo_env = Path(__file__).resolve().parent.parent / ".env"
    if not repo_env.exists():
        return

    try:
        from dotenv import load_dotenv

        load_dotenv(dotenv_path=repo_env)
        return
    except Exception:
        pass

    # Fallback parser for simple KEY=VALUE lines.
    try:
        for line in repo_env.read_text(encoding="utf-8").splitlines():
            raw = line.strip()
            if not raw or raw.startswith("#") or "=" not in raw:
                continue
            key, value = raw.split("=", 1)
            key = key.strip()
            value = value.strip().strip("'").strip('"')
            if key and key not in os.environ:
                os.environ[key] = value
    except Exception:
        pass


_load_repo_dotenv()

# ---- CONFIG ----
FIREWORKS_API_KEY = os.environ.get("FIREWORKS_API_KEY", "")
FIREWORKS_BASE_URL = os.environ.get(
    "FIREWORKS_BASE_URL", "https://api.fireworks.ai/inference/v1"
)
FIREWORKS_MODEL = os.environ.get(
    "FIREWORKS_MODEL", "accounts/fireworks/models/gpt-oss-120b"
)

DEFAULT_QUERY = "context manager development"
CONTEXT_ROOT = os.path.expanduser(os.environ.get("CONTEXT_ROOT", "~/.context"))

# batching strategy: up to 10 parallel batches, each with 5 index files
BATCH_SIZE = 5
MAX_PARALLEL_BATCHES = 10
MAX_INDEX_CHARS = 120_000
MAX_RESPONSE_TOKENS = 800


def call_fireworks(messages: list[dict], max_tokens: int = MAX_RESPONSE_TOKENS) -> str:
    """Send chat messages to Fireworks and return assistant text."""
    if not FIREWORKS_API_KEY:
        raise RuntimeError("FIREWORKS_API_KEY is not set")

    url = f"{FIREWORKS_BASE_URL.rstrip('/')}/chat/completions"
    headers = {
        "Authorization": f"Bearer {FIREWORKS_API_KEY}",
        "Content-Type": "application/json",
    }
    payload = {
        "model": FIREWORKS_MODEL,
        "messages": messages,
        "max_tokens": max_tokens,
        "temperature": 0.0,
    }

    resp = requests.post(url, headers=headers, json=payload, timeout=90)
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
    content = data["choices"][0]["message"]["content"]
    if not content:
        raise RuntimeError("Empty response from Fireworks model")
    return content.strip()


def discover_index_files(context_root: str) -> list[Path]:
    """Return all index.txt files sorted by recency (newest first)."""
    root = Path(context_root)
    index_paths = [p for p in root.rglob("index.txt") if p.is_file()]
    return sorted(index_paths, reverse=True)


def build_batches(paths: list[Path], batch_size: int, max_batches: int) -> list[list[Path]]:
    """Build non-overlapping batches from the newest files first."""
    selected = paths[: batch_size * max_batches]
    return [selected[i : i + batch_size] for i in range(0, len(selected), batch_size)]


def read_index_text(path: Path) -> str:
    """Read and truncate a single index file."""
    text = path.read_text(encoding="utf-8", errors="replace")
    if len(text) <= MAX_INDEX_CHARS:
        return text
    return text[:MAX_INDEX_CHARS] + "\n\n[TRUNCATED]"


def build_batch_prompt(query: str, batch_paths: list[Path]) -> str:
    """Build path-tagged prompt payload for one batch."""
    chunks: list[str] = []
    for p in batch_paths:
        chunks.append(f"### FILE: {p}\n{read_index_text(p)}")

    joined = "\n\n".join(chunks)
    return f"""You are a relevance filter.

Task:
Given a query and a set of index files, return the index file paths that match
the query semantically.

Rules:
- IMPORTANT: Make sure to read and carefully consider EVERY index file.
- Return only file paths, one per line.
- Do not return explanations or markdown.
- Do not invent paths; only return file paths present in this input.

Query:
{query}

Index files:
{joined}
"""


def parse_paths(raw: str, valid_paths: set[str]) -> list[str]:
    """Keep only valid, known index paths from model output."""
    out: list[str] = []
    seen: set[str] = set()
    for line in raw.splitlines():
        candidate = line.strip()
        if not candidate:
            continue
        if candidate in valid_paths and candidate not in seen:
            out.append(candidate)
            seen.add(candidate)
    return out


def run_batch(query: str, batch_paths: list[Path], batch_id: int) -> tuple[int, list[str]]:
    """Run one batch request and parse its path output."""
    prompt = build_batch_prompt(query=query, batch_paths=batch_paths)
    messages = [{"role": "user", "content": prompt}]
    raw = call_fireworks(messages)
    valid = {str(p) for p in batch_paths}
    parsed = parse_paths(raw, valid_paths=valid)
    return batch_id, parsed


def aggregate_results(batch_results: list[tuple[int, list[str]]]) -> list[str]:
    """Concatenate in batch order and dedupe while preserving order."""
    ordered = sorted(batch_results, key=lambda x: x[0])
    merged: list[str] = []
    seen: set[str] = set()
    for _, paths in ordered:
        for p in paths:
            if p not in seen:
                merged.append(p)
                seen.add(p)
    return merged


def main() -> None:
    parser = argparse.ArgumentParser(description="Match context index files with Fireworks")
    parser.add_argument("--query", default=DEFAULT_QUERY, help="Search query")
    parser.add_argument("--context-root", default=CONTEXT_ROOT, help="Path to ~/.context")
    parser.add_argument("--batch-size", type=int, default=BATCH_SIZE)
    parser.add_argument("--parallel-batches", type=int, default=MAX_PARALLEL_BATCHES)
    args = parser.parse_args()

    index_files = discover_index_files(args.context_root)
    batches = build_batches(
        index_files,
        batch_size=max(1, args.batch_size),
        max_batches=max(1, args.parallel_batches),
    )

    print("Index Matcher Experiment")
    print(f"Model: {FIREWORKS_MODEL}")
    print(f"Context root: {args.context_root}")
    print(f"Query: {args.query}")
    print(f"Discovered index files: {len(index_files)}")
    print(f"Batches: {len(batches)} x up to {max(1, args.batch_size)} files")
    print("=" * 60)

    if not batches:
        print("FINAL INDEX PATHS:")
        return

    results: list[tuple[int, list[str]]] = []
    workers = min(len(batches), max(1, args.parallel_batches))
    with ThreadPoolExecutor(max_workers=workers) as executor:
        futures = {
            executor.submit(run_batch, args.query, batch, i): i
            for i, batch in enumerate(batches)
        }
        for fut in as_completed(futures):
            batch_id = futures[fut]
            try:
                _, paths = fut.result()
                print(f"Batch {batch_id + 1}/{len(batches)} -> {len(paths)} matches")
                results.append((batch_id, paths))
            except Exception as exc:
                print(f"Batch {batch_id + 1}/{len(batches)} failed: {exc}")
                results.append((batch_id, []))

    final_paths = aggregate_results(results)

    print("\n" + "=" * 60)
    print("FINAL INDEX PATHS:")
    print("=" * 60)
    for p in final_paths:
        print(p)


if __name__ == "__main__":
    main()
