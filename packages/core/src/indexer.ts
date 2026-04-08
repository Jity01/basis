import * as fs from "fs/promises";
import * as path from "path";
import Database from "better-sqlite3";
import { CONTEXT_ROOT } from "@context-manager/config";
import type { CatalogEntry, DayCatalog } from "@context-manager/config";

const INDEX_FILE_NAME = "index.db";

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS chunks (
    chunk_key        TEXT PRIMARY KEY,
    date             TEXT NOT NULL,
    time             TEXT NOT NULL,
    primary_intent   TEXT,
    context_switches INTEGER DEFAULT 0,
    summary_preview  TEXT
  );

  CREATE TABLE IF NOT EXISTS chunk_topics (
    chunk_key TEXT NOT NULL,
    topic     TEXT NOT NULL,
    PRIMARY KEY (chunk_key, topic)
  );

  CREATE TABLE IF NOT EXISTS chunk_apps (
    chunk_key TEXT NOT NULL,
    app       TEXT NOT NULL,
    PRIMARY KEY (chunk_key, app)
  );

  CREATE TABLE IF NOT EXISTS chunk_entities (
    chunk_key TEXT NOT NULL,
    entity    TEXT NOT NULL,
    PRIMARY KEY (chunk_key, entity)
  );

  CREATE TABLE IF NOT EXISTS chunk_activity_types (
    chunk_key     TEXT NOT NULL,
    activity_type TEXT NOT NULL,
    PRIMARY KEY (chunk_key, activity_type)
  );

  CREATE INDEX IF NOT EXISTS idx_topics ON chunk_topics(topic);
  CREATE INDEX IF NOT EXISTS idx_apps ON chunk_apps(app);
  CREATE INDEX IF NOT EXISTS idx_entities ON chunk_entities(entity);
  CREATE INDEX IF NOT EXISTS idx_activity_types ON chunk_activity_types(activity_type);
  CREATE INDEX IF NOT EXISTS idx_chunks_date ON chunks(date);
`;

/** Open (or create) the SQLite index at CONTEXT_ROOT/index.db. */
export function openIndex(contextRoot: string = CONTEXT_ROOT): Database.Database {
  const dbPath = path.join(contextRoot, INDEX_FILE_NAME);
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.exec(SCHEMA);
  return db;
}

/** Index a single chunk entry. Safe to call multiple times (upserts). */
export function indexChunk(db: Database.Database, entry: CatalogEntry): void {
  const tx = db.transaction(() => {
    // Upsert the chunk row
    db.prepare(`
      INSERT OR REPLACE INTO chunks (chunk_key, date, time, primary_intent, context_switches, summary_preview)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      entry.chunk_key,
      entry.chunk_key.split("/")[0], // date from chunk_key "YYYY-MM-DD/HH-MM"
      entry.time,
      entry.primary_intent,
      entry.context_switches,
      entry.summary_preview
    );

    // Clear old relations for this chunk (in case of reprocessing)
    db.prepare("DELETE FROM chunk_topics WHERE chunk_key = ?").run(entry.chunk_key);
    db.prepare("DELETE FROM chunk_apps WHERE chunk_key = ?").run(entry.chunk_key);
    db.prepare("DELETE FROM chunk_entities WHERE chunk_key = ?").run(entry.chunk_key);
    db.prepare("DELETE FROM chunk_activity_types WHERE chunk_key = ?").run(entry.chunk_key);

    // Insert topics
    const insertTopic = db.prepare("INSERT INTO chunk_topics (chunk_key, topic) VALUES (?, ?)");
    for (const topic of entry.topics) {
      insertTopic.run(entry.chunk_key, topic);
    }

    // Insert apps
    const insertApp = db.prepare("INSERT INTO chunk_apps (chunk_key, app) VALUES (?, ?)");
    for (const app of entry.apps) {
      insertApp.run(entry.chunk_key, app);
    }

    // Insert entities
    const insertEntity = db.prepare("INSERT INTO chunk_entities (chunk_key, entity) VALUES (?, ?)");
    for (const entity of entry.entities) {
      insertEntity.run(entry.chunk_key, entity);
    }

    // Insert activity types (parsed from "type:topic:topic" format)
    const seenTypes = new Set<string>();
    const insertType = db.prepare("INSERT INTO chunk_activity_types (chunk_key, activity_type) VALUES (?, ?)");
    for (const activity of entry.activities) {
      const type = activity.split(":")[0];
      if (type && !seenTypes.has(type)) {
        seenTypes.add(type);
        insertType.run(entry.chunk_key, type);
      }
    }
  });

  tx();
}

/** Rebuild the entire index from all catalog.json files on disk. */
export async function rebuildIndex(contextRoot: string = CONTEXT_ROOT): Promise<{ chunks: number; days: number }> {
  const db = openIndex(contextRoot);
  let totalChunks = 0;
  let totalDays = 0;

  try {
    // Clear existing data
    db.exec("DELETE FROM chunks; DELETE FROM chunk_topics; DELETE FROM chunk_apps; DELETE FROM chunk_entities; DELETE FROM chunk_activity_types;");

    // Walk year/month/day directories looking for catalog.json
    const years = await safeReaddir(contextRoot);
    for (const year of years) {
      if (!/^\d{4}$/.test(year)) continue;
      const months = await safeReaddir(path.join(contextRoot, year));
      for (const month of months) {
        if (!/^\d{2}$/.test(month)) continue;
        const days = await safeReaddir(path.join(contextRoot, year, month));
        for (const day of days) {
          if (!/^\d{2}$/.test(day)) continue;

          const catalogPath = path.join(contextRoot, year, month, day, "catalog.json");
          try {
            const raw = await fs.readFile(catalogPath, "utf8");
            const catalog = JSON.parse(raw) as DayCatalog;
            if (!Array.isArray(catalog.chunks)) continue;

            for (const entry of catalog.chunks) {
              indexChunk(db, entry);
              totalChunks++;
            }
            totalDays++;
          } catch {
            // No catalog for this day, skip
          }
        }
      }
    }
  } finally {
    db.close();
  }

  return { chunks: totalChunks, days: totalDays };
}

async function safeReaddir(dir: string): Promise<string[]> {
  try {
    return (await fs.readdir(dir)).filter((n) => !n.startsWith("."));
  } catch {
    return [];
  }
}

// ── Query functions (for MCP tools and other consumers) ──────────────────────

export function queryByTopic(
  db: Database.Database,
  topic: string,
  dateFrom?: string,
  dateTo?: string
): string[] {
  let sql = `
    SELECT DISTINCT c.chunk_key FROM chunks c
    JOIN chunk_topics t ON c.chunk_key = t.chunk_key
    WHERE t.topic = ?
  `;
  const params: string[] = [topic];

  if (dateFrom) { sql += " AND c.date >= ?"; params.push(dateFrom); }
  if (dateTo) { sql += " AND c.date <= ?"; params.push(dateTo); }

  sql += " ORDER BY c.chunk_key";
  return db.prepare(sql).pluck().all(...params) as string[];
}

export function queryByApp(
  db: Database.Database,
  app: string,
  dateFrom?: string,
  dateTo?: string
): string[] {
  let sql = `
    SELECT DISTINCT c.chunk_key FROM chunks c
    JOIN chunk_apps a ON c.chunk_key = a.chunk_key
    WHERE a.app = ?
  `;
  const params: string[] = [app];

  if (dateFrom) { sql += " AND c.date >= ?"; params.push(dateFrom); }
  if (dateTo) { sql += " AND c.date <= ?"; params.push(dateTo); }

  sql += " ORDER BY c.chunk_key";
  return db.prepare(sql).pluck().all(...params) as string[];
}

export function queryByEntity(db: Database.Database, entity: string): string[] {
  return db.prepare(`
    SELECT DISTINCT chunk_key FROM chunk_entities
    WHERE entity LIKE ?
    ORDER BY chunk_key
  `).pluck().all(`%${entity}%`) as string[];
}
