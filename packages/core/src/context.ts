import * as fs from "fs/promises";
import * as path from "path";
import { CONTEXT_ROOT } from "@context-manager/config";
import type { RollingContext, DaySessions, Session } from "@context-manager/config";

const CONTEXT_FILE_NAME = "context.json";

const EMPTY_CONTEXT: RollingContext = {
  updated_at: "",
  active_projects: [],
  recent_threads: [],
  last_session: null,
  daily_pattern: { typical_start: "", typical_end: "", most_used_apps: [] },
  week_summary: "",
};

/** Read the rolling context, or return empty defaults. */
export async function readContext(contextRoot: string = CONTEXT_ROOT): Promise<RollingContext> {
  try {
    const raw = await fs.readFile(path.join(contextRoot, CONTEXT_FILE_NAME), "utf8");
    return JSON.parse(raw) as RollingContext;
  } catch {
    return { ...EMPTY_CONTEXT, updated_at: new Date().toISOString() };
  }
}

/** Update the rolling context with a day's session data. */
export async function updateContext(
  daySessions: DaySessions,
  contextRoot: string = CONTEXT_ROOT
): Promise<RollingContext> {
  const ctx = await readContext(contextRoot);
  const now = new Date().toISOString();
  ctx.updated_at = now;

  // Update last_session from the most recent session today
  if (daySessions.sessions.length > 0) {
    const last = daySessions.sessions[daySessions.sessions.length - 1]!;
    ctx.last_session = {
      date: last.date,
      time: last.end_time,
      primary_intent: last.primary_intent,
      topics: last.topics,
      apps: last.apps,
    };
  }

  // Update active projects from session topics
  for (const session of daySessions.sessions) {
    const projectName = inferProject(session);
    if (!projectName) continue;

    const existing = ctx.active_projects.find((p) => p.name === projectName);
    if (existing) {
      existing.last_seen = now;
      existing.sessions_this_week++;
      for (const t of session.topics) {
        if (!existing.topics.includes(t)) existing.topics.push(t);
      }
      if (existing.topics.length > 15) existing.topics = existing.topics.slice(-15);
    } else {
      ctx.active_projects.push({
        name: projectName,
        last_seen: now,
        topics: session.topics.slice(0, 10),
        sessions_this_week: 1,
      });
    }
  }

  // Prune stale projects (not seen in 7 days)
  const cutoff7d = new Date(Date.now() - 7 * 86400000).toISOString();
  ctx.active_projects = ctx.active_projects
    .filter((p) => p.last_seen > cutoff7d)
    .sort((a, b) => b.last_seen.localeCompare(a.last_seen))
    .slice(0, 10);

  // Update recent threads from multi-chunk sessions
  for (const session of daySessions.sessions) {
    if (session.chunk_keys.length < 2) continue;

    const desc = session.primary_intent || session.summary.slice(0, 100);
    const existing = ctx.recent_threads.find((t) =>
      session.topics.some((topic) => t.description.toLowerCase().includes(topic))
    );

    if (existing) {
      existing.last_active = now;
      existing.status = "active";
    } else {
      ctx.recent_threads.push({ description: desc, last_active: now, status: "active" });
    }
  }

  // Mark stale threads, prune old ones
  const cutoff3d = new Date(Date.now() - 3 * 86400000).toISOString();
  for (const t of ctx.recent_threads) {
    if (t.last_active < cutoff3d && t.status === "active") t.status = "stale";
  }
  ctx.recent_threads = ctx.recent_threads
    .filter((t) => t.last_active > cutoff7d)
    .sort((a, b) => b.last_active.localeCompare(a.last_active))
    .slice(0, 15);

  // Update daily pattern
  if (daySessions.sessions.length > 0) {
    const starts = daySessions.sessions.map((s) => s.start_time).sort();
    const ends = daySessions.sessions.map((s) => s.end_time).sort();
    ctx.daily_pattern.typical_start = starts[0] || "";
    ctx.daily_pattern.typical_end = ends[ends.length - 1] || "";

    const appCounts = new Map<string, number>();
    for (const s of daySessions.sessions) {
      for (const app of s.apps) appCounts.set(app, (appCounts.get(app) || 0) + 1);
    }
    ctx.daily_pattern.most_used_apps = Array.from(appCounts.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([app]) => app);
  }

  // Build week summary
  const projects = ctx.active_projects.map((p) => p.name);
  const threads = ctx.recent_threads.filter((t) => t.status === "active").map((t) => t.description);
  const parts: string[] = [];
  if (projects.length > 0) parts.push(`Active projects: ${projects.join(", ")}.`);
  if (threads.length > 0) parts.push(`Current threads: ${threads.join("; ")}.`);
  ctx.week_summary = parts.join(" ");

  // Write to disk
  const contextPath = path.join(contextRoot, CONTEXT_FILE_NAME);
  await fs.mkdir(contextRoot, { recursive: true });
  await fs.writeFile(contextPath, JSON.stringify(ctx, null, 2) + "\n", "utf8");

  return ctx;
}

function inferProject(session: Session): string | null {
  for (const topic of session.topics) {
    if (topic.includes("-") && !["stack-overflow", "auth-flow"].includes(topic)) return topic;
  }
  return session.topics[0] || null;
}
