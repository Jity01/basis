#!/usr/bin/env node

/**
 * Basis Migration: ~/.context/ → ~/context/
 *
 * Brings old Basis data to the new system:
 *   1. Copy chunk data to ~/context/
 *   2. Copy settings to ~/.basis/
 *   3. Backfill per-chunk summary.txt from day-level index.txt
 *   4. Discover all chunks
 *   5. Run Pass 2 (structured metadata) on every chunk
 *   6. Build catalog.json per day
 *   7. Rebuild SQLite index (index.db)
 *   8. Compute sessions per day (model-synthesized)
 *   9. Build user profile
 *  10. Write rolling context (context.json)
 *  11. Delete old ~/.context/
 *
 * Usage:
 *   pnpm build && node scripts/migrate/migrate.mjs
 *   node scripts/migrate/migrate.mjs --dry-run
 */

import * as fs from "fs/promises";
import * as fss from "fs";
import * as path from "path";
import * as os from "os";

const DRY_RUN = process.argv.includes("--dry-run");
const OLD_DIR = path.join(os.homedir(), ".context");
const NEW_DIR = path.join(os.homedir(), "context");
const BASIS_DIR = path.join(os.homedir(), ".basis");

// Set env so core library functions write to the right place
process.env.CONTEXT_ROOT = NEW_DIR;

const {
  extractChunkMetadata,
  readAISettings,
  computeSessions,
  updateProfile,
  rebuildIndex,
  updateContext,
} = await import("../../packages/core/dist/index.js");

// ─── Helpers ─────────────────────────────────────────────────────────────────

function log(msg) {
  console.log(`  ${msg}`);
}

function warn(msg) {
  console.warn(`  ⚠ ${msg}`);
}

async function copyRecursive(src, dest) {
  await fs.mkdir(dest, { recursive: true });
  for (const entry of await fs.readdir(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      await copyRecursive(s, d);
    } else {
      await fs.copyFile(s, d);
    }
  }
}

async function readJson(filePath) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch {
    return null;
  }
}

async function readText(filePath) {
  try {
    return (await fs.readFile(filePath, "utf8")).trim();
  } catch {
    return "";
  }
}

// ─── Step 1: Copy chunk data ─────────────────────────────────────────────────

async function copyChunkData() {
  console.log("\n── Step 1: Copy chunk data ──\n");

  if (!fss.existsSync(OLD_DIR)) {
    console.error(`Source not found: ${OLD_DIR}`);
    process.exit(1);
  }

  if (DRY_RUN) {
    log(`Would copy ${OLD_DIR} → ${NEW_DIR}`);
    return;
  }

  const entries = await fs.readdir(OLD_DIR, { withFileTypes: true });
  await fs.mkdir(NEW_DIR, { recursive: true });

  // Settings files to migrate to ~/.basis/ instead
  const settingsFiles = ["ai-settings.json", "chunk-settings.json"];
  const skipFiles = ["mcp-auth.json", "mcp-oauth-clients.json"];

  for (const entry of entries) {
    const src = path.join(OLD_DIR, entry.name);

    if (entry.isFile() && settingsFiles.includes(entry.name)) {
      continue; // handled in Step 2
    }
    if (entry.isFile() && skipFiles.includes(entry.name)) {
      log(`Skipping ${entry.name} (regenerated on launch)`);
      continue;
    }

    const dest = path.join(NEW_DIR, entry.name);
    if (entry.isDirectory()) {
      await copyRecursive(src, dest);
      log(`Copied ${entry.name}/`);
    } else {
      await fs.copyFile(src, dest);
      log(`Copied ${entry.name}`);
    }
  }
}

// ─── Step 2: Copy settings to ~/.basis/ ──────────────────────────────────────

async function copySettings() {
  console.log("\n── Step 2: Copy settings to ~/.basis/ ──\n");

  await fs.mkdir(BASIS_DIR, { recursive: true });

  for (const name of ["ai-settings.json", "chunk-settings.json"]) {
    const src = path.join(OLD_DIR, name);
    const dest = path.join(BASIS_DIR, name);

    if (!fss.existsSync(src)) continue;

    if (fss.existsSync(dest)) {
      log(`${name} already exists in ~/.basis/, skipping`);
      continue;
    }

    if (DRY_RUN) {
      log(`Would copy ${name} → ~/.basis/`);
      continue;
    }

    await fs.copyFile(src, dest);
    log(`Copied ${name} → ~/.basis/`);
  }
}

// ─── Step 3: Backfill summary.txt from index.txt ────────────────────────────

const INDEX_SECTION_RE = /\[(\d{2}):(\d{2})\]\n([\s\S]*?)(?=\n\n\[\d{2}:\d{2}\]\n|$)/g;

async function backfillSummaries() {
  console.log("\n── Step 3: Backfill summaries from index.txt ──\n");

  const dataDir = DRY_RUN && !fss.existsSync(NEW_DIR) ? OLD_DIR : NEW_DIR;
  let totalWritten = 0;

  for (const year of await safeReaddir(dataDir)) {
    if (!/^\d{4}$/.test(year)) continue;
    for (const month of await safeReaddir(path.join(dataDir, year))) {
      if (!/^\d{2}$/.test(month)) continue;
      for (const day of await safeReaddir(path.join(dataDir, year, month))) {
        if (!/^\d{2}$/.test(day)) continue;

        const dayDir = path.join(dataDir, year, month, day);
        const indexPath = path.join(dayDir, "index.txt");
        const indexText = await readText(indexPath);
        if (!indexText) continue;

        // Parse [HH:MM] sections from index.txt
        INDEX_SECTION_RE.lastIndex = 0;
        let match;
        while ((match = INDEX_SECTION_RE.exec(indexText)) !== null) {
          const hh = match[1];
          const mm = match[2];
          const body = (match[3] || "").trim();
          if (!body) continue;

          const chunkDir = path.join(dayDir, `${hh}-${mm}`);
          const summaryPath = path.join(chunkDir, "summary.txt");

          // Skip if chunk dir doesn't exist or summary already written
          if (!fss.existsSync(chunkDir)) continue;
          if (fss.existsSync(summaryPath)) continue;

          if (DRY_RUN) {
            log(`Would write ${year}/${month}/${day}/${hh}-${mm}/summary.txt`);
          } else {
            await fs.writeFile(summaryPath, body + "\n", "utf8");
          }
          totalWritten++;
        }
      }
    }
  }

  log(`Wrote ${totalWritten} summary.txt files from index.txt`);
}

// ─── Step 4: Discover chunks ─────────────────────────────────────────────────

async function discoverChunks() {
  console.log("\n── Step 4: Discover chunks ──\n");

  const chunks = [];
  const dataDir = DRY_RUN && !fss.existsSync(NEW_DIR) ? OLD_DIR : NEW_DIR;

  for (const year of await safeReaddir(dataDir)) {
    if (!/^\d{4}$/.test(year)) continue;
    for (const month of await safeReaddir(path.join(dataDir, year))) {
      if (!/^\d{2}$/.test(month)) continue;
      for (const day of await safeReaddir(path.join(dataDir, year, month))) {
        if (!/^\d{2}$/.test(day)) continue;
        const dayDir = path.join(dataDir, year, month, day);
        const date = `${year}-${month}-${day}`;

        for (const chunk of await safeReaddir(dayDir)) {
          if (!/^\d{2}-\d{2}$/.test(chunk)) continue;
          const chunkDir = path.join(dayDir, chunk);
          if (!fss.existsSync(path.join(chunkDir, "summary.txt"))) continue;

          const [hh, mm] = chunk.split("-");
          chunks.push({
            date,
            time: `${hh}:${mm}`,
            chunkKey: `${date}/${chunk}`,
            dir: chunkDir,
          });
        }
      }
    }
  }

  chunks.sort((a, b) => a.chunkKey.localeCompare(b.chunkKey));
  const days = new Set(chunks.map((c) => c.date)).size;
  log(`Found ${chunks.length} chunks across ${days} days`);
  return chunks;
}

async function safeReaddir(dir) {
  try {
    return (await fs.readdir(dir)).filter((n) => !n.startsWith("."));
  } catch {
    return [];
  }
}

// ─── Step 5: Extract metadata (Pass 2) ──────────────────────────────────────

async function extractMetadata(chunks, aiSettings) {
  console.log("\n── Step 5: Extract structured metadata ──\n");

  let done = 0;
  let failed = 0;
  let skipped = 0;

  for (let i = 0; i < chunks.length; i += 5) {
    const batch = chunks.slice(i, i + 5);

    await Promise.all(batch.map(async (chunk) => {
      const metaPath = path.join(chunk.dir, "meta.json");
      const meta = await readJson(metaPath);

      // Already migrated?
      if (meta && Array.isArray(meta.activities) && meta.activities.length > 0) {
        skipped++;
        return;
      }

      const summary = await readText(path.join(chunk.dir, "summary.txt"));
      if (!summary) { skipped++; return; }

      // Get frame paths
      const framesDir = path.join(chunk.dir, "frames");
      let framePaths = [];
      try {
        const names = (await fs.readdir(framesDir)).filter((n) => /\.jpe?g$/i.test(n)).sort();
        framePaths = names.map((n) => path.join(framesDir, n));
      } catch { /* no frames dir */ }

      if (framePaths.length === 0) {
        warn(`No frames for ${chunk.chunkKey}, skipping metadata extraction`);
        skipped++;
        return;
      }

      // Parse times from existing meta
      let startTime = `${chunk.time.replace(":", ":")}:00`;
      let endTime = startTime;
      if (meta?.chunk_start_iso) {
        try { const d = new Date(meta.chunk_start_iso); startTime = timeStr(d); } catch {}
      }
      if (meta?.chunk_end_iso) {
        try { const d = new Date(meta.chunk_end_iso); endTime = timeStr(d); } catch {}
      }

      if (DRY_RUN) {
        done++;
        return;
      }

      try {
        const metadata = await extractChunkMetadata(summary, framePaths, startTime, endTime, aiSettings);
        const updated = { ...(meta || {}), ...metadata };
        await fs.writeFile(metaPath, JSON.stringify(updated, null, 2) + "\n", "utf8");
        done++;
      } catch (err) {
        warn(`Failed: ${chunk.chunkKey} — ${err.message}`);
        failed++;
      }
    }));

    // Progress every 20 chunks
    const total = Math.min(i + 5, chunks.length);
    if (total % 20 === 0 || total === chunks.length) {
      log(`${total}/${chunks.length} (done: ${done}, skipped: ${skipped}, failed: ${failed})`);
    }
  }

  log(`\nMetadata extraction: ${done} done, ${skipped} skipped, ${failed} failed`);
}

function timeStr(d) {
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}:${String(d.getSeconds()).padStart(2, "0")}`;
}

// ─── Step 6: Build catalogs ──────────────────────────────────────────────────

async function buildCatalogs(chunks) {
  console.log("\n── Step 6: Build day catalogs ──\n");

  // Group by date
  const byDate = new Map();
  for (const chunk of chunks) {
    if (!byDate.has(chunk.date)) byDate.set(chunk.date, []);
    byDate.get(chunk.date).push(chunk);
  }

  const catalogs = new Map();

  for (const [date, dayChunks] of byDate) {
    const entries = [];

    for (const chunk of dayChunks) {
      const summary = await readText(path.join(chunk.dir, "summary.txt"));
      const meta = await readJson(path.join(chunk.dir, "meta.json"));
      if (!summary) continue;

      const activities = Array.isArray(meta?.activities) ? meta.activities : [];
      const entities = Array.isArray(meta?.entities) ? meta.entities : [];
      const apps = Array.isArray(meta?.apps) ? meta.apps : [];

      entries.push({
        time: chunk.time,
        chunk_key: chunk.chunkKey,
        primary_intent: meta?.primary_intent || summary.slice(0, 100),
        activities: activities.map((a) => `${a.type}:${(a.topics || []).join(":")}`),
        apps: apps.map((a) => a.name || a),
        topics: Array.from(new Set(activities.flatMap((a) => a.topics || []))),
        entities,
        context_switches: meta?.context_switches || 0,
        summary_preview: summary.length > 200 ? summary.slice(0, 200) + "..." : summary,
      });
    }

    entries.sort((a, b) => a.time.localeCompare(b.time));
    const catalog = { date, chunks: entries };

    if (entries.length > 0) {
      const [yyyy, mm, dd] = date.split("-");
      const catalogPath = path.join(NEW_DIR, yyyy, mm, dd, "catalog.json");

      if (!DRY_RUN) {
        await fs.writeFile(catalogPath, JSON.stringify(catalog, null, 2) + "\n", "utf8");
      }

      catalogs.set(date, catalog);
      log(`${date}: ${entries.length} chunks`);
    }
  }

  return catalogs;
}

// ─── Step 7: Compute sessions ────────────────────────────────────────────────

async function buildSessions(catalogs, aiSettings) {
  console.log("\n── Step 7: Compute sessions ──\n");

  const allSessions = [];

  for (const [date, catalog] of catalogs) {
    if (DRY_RUN) {
      log(`Would compute sessions for ${date}`);
      continue;
    }

    try {
      const result = await computeSessions(catalog, NEW_DIR, aiSettings);
      allSessions.push(result);
      log(`${date}: ${result.sessions.length} sessions`);
    } catch (err) {
      warn(`Sessions failed for ${date}: ${err.message}`);
    }
  }

  return allSessions;
}

// ─── Step 8: Build profile ───────────────────────────────────────────────────

async function buildProfile(allSessions) {
  console.log("\n── Step 8: Build user profile ──\n");

  if (DRY_RUN) {
    log("Would build profile from session data");
    return;
  }

  // Process in chronological order
  const sorted = allSessions
    .filter((s) => s?.sessions?.length > 0)
    .sort((a, b) => a.date.localeCompare(b.date));

  for (const sessions of sorted) {
    await updateProfile(sessions);
  }

  log(`Profile built from ${sorted.length} days of data`);
}

// ─── Step 9: Rebuild SQLite index ────────────────────────────────────────────

async function buildSearchIndex() {
  console.log("\n── Step 9: Rebuild SQLite index ──\n");

  if (DRY_RUN) {
    log("Would rebuild index.db from all catalogs");
    return;
  }

  const result = await rebuildIndex(NEW_DIR);
  log(`Indexed ${result.chunks} chunks across ${result.days} days → ~/context/index.db`);
}

// ─── Step 10: Write rolling context ──────────────────────────────────────────

async function buildContext(allSessions) {
  console.log("\n── Step 10: Write rolling context ──\n");

  if (DRY_RUN) {
    log("Would write context.json");
    return;
  }

  const sorted = allSessions
    .filter((s) => s?.sessions?.length > 0)
    .sort((a, b) => a.date.localeCompare(b.date));

  for (const sessions of sorted) {
    await updateContext(sessions, NEW_DIR);
  }

  log(`Context built from ${sorted.length} days → ~/context/context.json`);
}

// ─── Step 11: Delete old directory ───────────────────────────────────────────

async function deleteOldDir() {
  console.log("\n── Step 11: Clean up ──\n");

  if (DRY_RUN) {
    log(`Would delete ${OLD_DIR}`);
    return;
  }

  await fs.rm(OLD_DIR, { recursive: true, force: true });
  log(`Deleted ${OLD_DIR}`);
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  console.log("\n  Basis Migration: ~/.context/ → ~/context/\n");

  if (DRY_RUN) log("DRY RUN — no changes will be made\n");

  const aiSettings = readAISettings();
  log(`AI provider: ${aiSettings.provider}`);

  await copyChunkData();
  await copySettings();
  await backfillSummaries();
  const chunks = await discoverChunks();

  if (chunks.length === 0) {
    log("\nNo chunks to migrate.");
    return;
  }

  await extractMetadata(chunks, aiSettings);
  const catalogs = await buildCatalogs(chunks);
  await buildSearchIndex();
  const allSessions = await buildSessions(catalogs, aiSettings);
  await buildProfile(allSessions);
  await buildContext(allSessions);
  await deleteOldDir();

  console.log("\n  Migration complete.\n");
  log(`Chunks processed: ${chunks.length}`);
  log(`Days cataloged: ${catalogs.size}`);
  log(`Sessions: ${allSessions.reduce((n, s) => n + (s?.sessions?.length || 0), 0)}`);
  log(`Index: ~/context/index.db`);
  log(`Context: ~/context/context.json`);
  log(`Profile: ~/.basis/profile.json`);
  console.log("");
}

main().catch((err) => {
  console.error("\nMigration failed:", err.message);
  process.exit(1);
});
