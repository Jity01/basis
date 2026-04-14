/**
 * Search agent evaluation script.
 *
 * Runs test queries against the search agent using a pre-populated context root.
 * Prints the full agent trace and data package for each query.
 *
 * Usage:
 *   pnpm --filter @context-manager/mcp-server search-eval -- --context-root /tmp/basis-eval-XXXX
 *   pnpm --filter @context-manager/mcp-server search-eval -- --context-root ~/context
 *   pnpm --filter @context-manager/mcp-server search-eval -- --context-root /tmp/basis-eval-XXXX --query "what was I doing?"
 *
 * Environment:
 *   ANTHROPIC_API_KEY — required for the search agent
 */

import fs from "fs";
import path from "path";
import os from "os";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── CLI args ────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = { contextRoot: null, query: null };
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--context-root" && argv[i + 1]) args.contextRoot = argv[++i];
    else if (arg === "--query" && argv[i + 1]) args.query = argv[++i];
  }
  return args;
}

const args = parseArgs(process.argv);

if (!args.contextRoot) {
  console.error("Usage: search-eval --context-root <path> [--query <single query>]");
  process.exit(1);
}

if (!fs.existsSync(args.contextRoot)) {
  console.error(`Context root not found: ${args.contextRoot}`);
  process.exit(1);
}

// ── Load .env ───────────────────────────────────────────────────────────────

const dotenvPath = path.join(__dirname, "../../../.env");
if (fs.existsSync(dotenvPath)) {
  const envContent = fs.readFileSync(dotenvPath, "utf8");
  for (const line of envContent.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    let value = trimmed.slice(eqIdx + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!process.env[key]) process.env[key] = value;
  }
}

if (!process.env.ANTHROPIC_API_KEY) {
  console.error("Missing ANTHROPIC_API_KEY. Set it in .env or environment.");
  process.exit(1);
}

// ── Import handler ──────────────────────────────────────────────────────────

const { handleSearch } = await import("../dist/handlers/search.js");

// ── Define test queries ─────────────────────────────────────────────────────

function buildTestQueries(contextRoot) {
  const queries = [
    {
      name: "Recall: broad",
      input: { query: "What was I working on?" },
    },
    {
      name: "Recall: specific time",
      input: {
        query: "What happened at 10:02?",
        hints: { time_range: "2026-04-14" },
      },
    },
    {
      name: "Hot buffer: live",
      input: { query: "What am I doing right now?" },
    },
  ];

  // Try to find a topic from the wiki to test keyword search
  const wikiDir = path.join(contextRoot, ".wiki");
  if (fs.existsSync(wikiDir)) {
    const wikiFiles = fs.readdirSync(wikiDir)
      .filter(f => f.endsWith(".md") && f !== "index.md" && f !== "sub_agent.md");
    if (wikiFiles.length > 0) {
      const topicName = wikiFiles[0].replace(".md", "").replace(/-/g, " ");
      queries.push({
        name: `Wiki keyword: "${topicName}"`,
        input: { query: `What do you know about ${topicName}?` },
      });
    }
  }

  // Try to find an app or entity from temporal descriptions
  const dateDir = path.join(contextRoot, "2026", "04", "14");
  if (fs.existsSync(dateDir)) {
    const chunks = fs.readdirSync(dateDir).filter(d => /^\d{2}-\d{2}$/.test(d));
    if (chunks.length > 0) {
      const tdPath = path.join(dateDir, chunks[0], "temporal_description.txt");
      if (fs.existsSync(tdPath)) {
        const td = fs.readFileSync(tdPath, "utf8");
        // Extract a likely keyword from the temporal description
        const words = td.split(/\s+/).filter(w => w.length > 5 && /^[A-Z]/.test(w));
        if (words.length > 0) {
          queries.push({
            name: `OCR grep: "${words[0]}"`,
            input: { query: `Find mentions of ${words[0]}` },
          });
        }
      }
    }
  }

  return queries;
}

// ── Run queries ─────────────────────────────────────────────────────────────

const contextRoot = args.contextRoot;

console.log(`\n${"=".repeat(72)}`);
console.log("Search Agent Evaluation");
console.log(`${"=".repeat(72)}`);
console.log(`Context root: ${contextRoot}`);
console.log(`Model: ${process.env.SEARCH_AGENT_MODEL || "claude-sonnet-4-20250514 (default)"}`);
console.log();

const queries = args.query
  ? [{ name: "Custom query", input: { query: args.query } }]
  : buildTestQueries(contextRoot);

console.log(`Running ${queries.length} test queries...\n`);

for (let i = 0; i < queries.length; i++) {
  const q = queries[i];
  console.log(`${"─".repeat(72)}`);
  console.log(`[${i + 1}/${queries.length}] ${q.name}`);
  console.log(`Query: "${q.input.query}"`);
  if (q.input.hints) console.log(`Hints: ${JSON.stringify(q.input.hints)}`);
  console.log();

  const t0 = Date.now();

  try {
    const result = await handleSearch(q.input, contextRoot);
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

    if (result.isError) {
      console.log(`ERROR (${elapsed}s): ${result.content[0]?.text}`);
    } else {
      const text = result.content[0]?.text || "(empty)";
      console.log(`Response (${elapsed}s):`);
      console.log(text);
    }
  } catch (err) {
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(`EXCEPTION (${elapsed}s): ${err.message}`);
  }

  console.log();
}

console.log(`${"=".repeat(72)}`);
console.log("Evaluation complete. Review the data packages above.");
console.log(`${"=".repeat(72)}\n`);
