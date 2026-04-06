#!/usr/bin/env node
/**
 * One-time migration: parse legacy day-level index.txt into per-chunk summary.txt.
 *
 * Usage:
 *   CONTEXT_ROOT=~/.context node packages/core/scripts/backfill-summary-from-index.mjs [--dry-run] [--force] [--delete-index]
 *
 * Options:
 *   --dry-run       Print actions only
 *   --force         Overwrite existing summary.txt
 *   --delete-index  Remove index.txt after successful writes for that day
 */

import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

const INDEX_SECTION_PATTERN =
  /\[(\d{2}):(\d{2})\]\n([\s\S]*?)(?=\n\n\[\d{2}:\d{2}\]\n|$)/g;

const SUMMARY_FILE_NAME = "summary.txt";
const INDEX_FILE_NAME = "index.txt";

const contextRoot =
  process.env.CONTEXT_ROOT?.trim() || path.join(os.homedir(), ".context");

const args = new Set(process.argv.slice(2));
const dryRun = args.has("--dry-run");
const force = args.has("--force");
const deleteIndex = args.has("--delete-index");

async function walkDays(root) {
  const out = [];
  let years;
  try {
    years = await fs.readdir(root, { withFileTypes: true });
  } catch (e) {
    if (e?.code === "ENOENT") return out;
    throw e;
  }
  for (const y of years) {
    if (!y.isDirectory() || !/^\d{4}$/.test(y.name)) continue;
    const yearDir = path.join(root, y.name);
    const months = await fs.readdir(yearDir, { withFileTypes: true });
    for (const m of months) {
      if (!m.isDirectory() || !/^\d{2}$/.test(m.name)) continue;
      const monthDir = path.join(yearDir, m.name);
      const days = await fs.readdir(monthDir, { withFileTypes: true });
      for (const d of days) {
        if (!d.isDirectory() || !/^\d{2}$/.test(d.name)) continue;
        out.push(path.join(monthDir, d.name));
      }
    }
  }
  return out;
}

async function backfillDay(dayDir) {
  const indexPath = path.join(dayDir, INDEX_FILE_NAME);
  let raw;
  try {
    raw = await fs.readFile(indexPath, "utf8");
  } catch (e) {
    if (e?.code === "ENOENT") return { wrote: 0, skipped: 0 };
    throw e;
  }

  let match;
  const sections = [];
  INDEX_SECTION_PATTERN.lastIndex = 0;
  while ((match = INDEX_SECTION_PATTERN.exec(raw)) != null) {
    const hh = match[1];
    const mm = match[2];
    const body = (match[3] || "").trim();
    if (!body) continue;
    sections.push({ dir: `${hh}-${mm}`, text: body });
  }

  let wrote = 0;
  let skipped = 0;

  for (const { dir, text } of sections) {
    const chunkDir = path.join(dayDir, dir);
    const summaryPath = path.join(chunkDir, SUMMARY_FILE_NAME);
    try {
      await fs.access(chunkDir);
    } catch {
      console.warn(`[skip] no chunk dir ${chunkDir}`);
      skipped += 1;
      continue;
    }

    if (!force) {
      try {
        await fs.access(summaryPath);
        console.warn(`[skip] exists ${summaryPath} (use --force)`);
        skipped += 1;
        continue;
      } catch {
        /* write */
      }
    }

    if (dryRun) {
      console.log(`[dry-run] would write ${summaryPath}`);
      wrote += 1;
      continue;
    }

    await fs.mkdir(chunkDir, { recursive: true });
    await fs.writeFile(summaryPath, `${text}\n`, "utf8");
    console.log(`[write] ${summaryPath}`);
    wrote += 1;
  }

  if (deleteIndex && wrote > 0 && !dryRun) {
    await fs.unlink(indexPath);
    console.log(`[delete-index] ${indexPath}`);
  }

  return { wrote, skipped };
}

const dayDirs = await walkDays(contextRoot);
let totalWrote = 0;
for (const dayDir of dayDirs.sort()) {
  const indexPath = path.join(dayDir, INDEX_FILE_NAME);
  try {
    await fs.access(indexPath);
  } catch {
    continue;
  }
  const rel = path.relative(contextRoot, dayDir);
  console.log(`\n--- ${rel} ---`);
  const { wrote } = await backfillDay(dayDir);
  totalWrote += wrote;
}

console.log(`\nDone. summary.txt files written: ${totalWrote}${dryRun ? " (dry-run)" : ""}`);
