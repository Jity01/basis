import * as fs from "fs/promises";
import * as path from "path";
import { CONTEXT_ROOT } from "@context-manager/config";
import type {
  AISettings,
  DayCatalog,
  CatalogEntry,
  Session,
  DaySessions,
  ActivityType,
} from "@context-manager/config";
import { SUMMARY_FILE_NAME } from "./storage";

const SESSIONS_FILE_NAME = "sessions.json";
export { SESSIONS_FILE_NAME };

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

function dayDirFromDate(date: string, contextRoot: string): string {
  const [yyyy, mm, dd] = date.split("-");
  return path.join(contextRoot, yyyy!, mm!, dd!);
}

function generateSessionId(date: string, index: number): string {
  return `${date}/s-${index + 1}`;
}

/**
 * Two adjacent chunks share a session if they have >=1 overlapping topic
 * AND at least one overlapping app.
 */
function shouldMerge(a: CatalogEntry, b: CatalogEntry): boolean {
  const sharedTopics = a.topics.some((t) => b.topics.includes(t));
  const sharedApps = a.apps.some((app) => b.apps.includes(app));
  return sharedTopics && sharedApps;
}

function parseTimeMinutes(time: string): number {
  const [h, m] = time.split(":").map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

/** Group catalog entries into sessions based on topic/app overlap. */
function groupIntoSessions(catalog: DayCatalog): CatalogEntry[][] {
  if (catalog.chunks.length === 0) {
    return [];
  }

  const groups: CatalogEntry[][] = [[catalog.chunks[0]!]];

  for (let i = 1; i < catalog.chunks.length; i++) {
    const current = catalog.chunks[i]!;
    const lastGroup = groups[groups.length - 1]!;
    const lastEntry = lastGroup[lastGroup.length - 1]!;

    if (shouldMerge(lastEntry, current)) {
      lastGroup.push(current);
    } else {
      groups.push([current]);
    }
  }

  return groups;
}

function collectTopics(entries: CatalogEntry[]): string[] {
  const set = new Set<string>();
  for (const e of entries) {
    for (const t of e.topics) {
      set.add(t);
    }
  }
  return Array.from(set);
}

function collectApps(entries: CatalogEntry[]): string[] {
  const set = new Set<string>();
  for (const e of entries) {
    for (const a of e.apps) {
      set.add(a);
    }
  }
  return Array.from(set);
}

function collectActivityTypes(entries: CatalogEntry[]): ActivityType[] {
  const set = new Set<ActivityType>();
  for (const e of entries) {
    for (const a of e.activities) {
      const type = a.split(":")[0] as ActivityType;
      if (type) {
        set.add(type);
      }
    }
  }
  return Array.from(set);
}

function chunkDurationMinutes(catalog: DayCatalog): number {
  // Infer from first two chunks, or default to 5
  if (catalog.chunks.length < 2) {
    return 5;
  }
  const t0 = parseTimeMinutes(catalog.chunks[0]!.time);
  const t1 = parseTimeMinutes(catalog.chunks[1]!.time);
  const diff = t1 - t0;
  return diff > 0 ? diff : 5;
}

/** Read chunk summaries for a session's chunks. */
async function readChunkSummaries(
  chunkKeys: string[],
  contextRoot: string
): Promise<string> {
  const parts: string[] = [];
  for (const key of chunkKeys) {
    const [datePart, timePart] = key.split("/");
    if (!datePart || !timePart) continue;
    const [yyyy, mm, dd] = datePart.split("-");
    const chunkDir = path.join(contextRoot, yyyy!, mm!, dd!, timePart);
    try {
      const text = (await fs.readFile(path.join(chunkDir, SUMMARY_FILE_NAME), "utf8")).trim();
      if (text) {
        parts.push(`[${timePart.replace("-", ":")}] ${text}`);
      }
    } catch {
      // Skip missing summaries
    }
  }
  return parts.join("\n\n");
}

/** Synthesize a session summary using the AI model. */
async function synthesizeSessionSummary(
  chunkSummaries: string,
  topics: string[],
  apps: string[],
  durationMinutes: number,
  settings?: AISettings
): Promise<string> {
  if (!settings || settings.provider !== "fireworks") {
    // For local models or no settings, use concatenated summaries
    return chunkSummaries;
  }

  const apiKey = process.env.FIREWORKS_API_KEY?.trim() || settings.fireworksApiKey?.trim();
  if (!apiKey) {
    return chunkSummaries;
  }

  const baseUrl = process.env.FIREWORKS_BASE_URL?.trim() || "https://api.fireworks.ai/inference/v1";
  const model = process.env.FIREWORKS_MODEL?.trim() || "accounts/fireworks/models/qwen3-vl-30b-a3b-instruct";

  const prompt = `You are summarizing a user's activity session (${durationMinutes} minutes).

The session involved these apps: ${apps.join(", ")}
Topics: ${topics.join(", ")}

Here are the individual chunk summaries from this session:

${chunkSummaries}

Write a single coherent paragraph summarizing this entire session. Focus on:
- What the user was trying to accomplish overall
- The progression of their work (what they started with, what they moved to, where they ended)
- Key outcomes or status (e.g. "ended with a failing test", "committed the changes")

Keep it concise (2-4 sentences). Do not repeat yourself.`;

  try {
    const response = await fetch(`${baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        max_tokens: 512,
        messages: [{ role: "user", content: prompt }],
      }),
    });

    if (!response.ok) {
      return chunkSummaries;
    }

    const json = (await response.json()) as {
      choices?: Array<{ message?: { content?: string | null } }>;
    };
    const result = json.choices?.[0]?.message?.content?.trim();
    return result || chunkSummaries;
  } catch {
    return chunkSummaries;
  }
}

/** Compute sessions from a day's catalog. Writes sessions.json. */
export async function computeSessions(
  catalog: DayCatalog,
  contextRoot: string = CONTEXT_ROOT,
  aiSettings?: AISettings
): Promise<DaySessions> {
  const groups = groupIntoSessions(catalog);
  const chunkDur = chunkDurationMinutes(catalog);
  const sessions: Session[] = [];

  for (let i = 0; i < groups.length; i++) {
    const entries = groups[i]!;
    const firstEntry = entries[0]!;
    const lastEntry = entries[entries.length - 1]!;
    const chunkKeys = entries.map((e) => e.chunk_key);
    const topics = collectTopics(entries);
    const apps = collectApps(entries);
    const activityTypes = collectActivityTypes(entries);
    const durationMinutes = entries.length * chunkDur;

    const chunkSummaries = await readChunkSummaries(chunkKeys, contextRoot);
    const summary = await synthesizeSessionSummary(
      chunkSummaries,
      topics,
      apps,
      durationMinutes,
      aiSettings
    );

    // Use the most common primary_intent, or the first one
    const intentCounts = new Map<string, number>();
    for (const e of entries) {
      if (e.primary_intent) {
        intentCounts.set(e.primary_intent, (intentCounts.get(e.primary_intent) || 0) + 1);
      }
    }
    let primaryIntent = firstEntry.primary_intent;
    let maxCount = 0;
    for (const [intent, count] of Array.from(intentCounts.entries())) {
      if (count > maxCount) {
        maxCount = count;
        primaryIntent = intent;
      }
    }

    sessions.push({
      id: generateSessionId(catalog.date, i),
      date: catalog.date,
      start_time: firstEntry.time,
      end_time: lastEntry.time,
      chunk_keys: chunkKeys,
      duration_minutes: durationMinutes,
      primary_intent: primaryIntent,
      topics,
      apps,
      activity_types: activityTypes,
      summary,
    });
  }

  const daySessions: DaySessions = { date: catalog.date, sessions };
  const dayDir = dayDirFromDate(catalog.date, contextRoot);
  await fs.mkdir(dayDir, { recursive: true });
  await fs.writeFile(
    path.join(dayDir, SESSIONS_FILE_NAME),
    `${JSON.stringify(daySessions, null, 2)}\n`,
    "utf8"
  );

  return daySessions;
}

/** Read sessions for a day, or null if not available. */
export async function readDaySessions(
  date: string,
  contextRoot: string = CONTEXT_ROOT
): Promise<DaySessions | null> {
  const [yyyy, mm, dd] = date.split("-");
  if (!yyyy || !mm || !dd) return null;
  const sessionsPath = path.join(contextRoot, yyyy, mm, dd, SESSIONS_FILE_NAME);
  try {
    const raw = await fs.readFile(sessionsPath, "utf8");
    const sessions = JSON.parse(raw) as DaySessions;
    if (Array.isArray(sessions.sessions)) {
      return sessions;
    }
    return null;
  } catch {
    return null;
  }
}
