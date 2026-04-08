import * as fs from "fs/promises";
import * as path from "path";
import { BASIS_ROOT } from "@context-manager/config";
import type {
  UserProfile,
  ActiveProject,
  ActiveThread,
  DaySessions,
  Session,
} from "@context-manager/config";

const PROFILE_FILE_NAME = "profile.json";

function getProfilePath(): string {
  return path.join(BASIS_ROOT, PROFILE_FILE_NAME);
}

const DEFAULT_PROFILE: UserProfile = {
  updated_at: new Date().toISOString(),
  active_projects: [],
  active_threads: [],
  daily_pattern: {
    typical_start: "",
    typical_end: "",
    most_used_apps: [],
  },
  week_summary: "",
};

export async function readProfile(): Promise<UserProfile> {
  try {
    const raw = await fs.readFile(getProfilePath(), "utf8");
    const parsed = JSON.parse(raw) as Partial<UserProfile>;
    return {
      updated_at: parsed.updated_at || new Date().toISOString(),
      active_projects: Array.isArray(parsed.active_projects) ? parsed.active_projects : [],
      active_threads: Array.isArray(parsed.active_threads) ? parsed.active_threads : [],
      daily_pattern: parsed.daily_pattern || { typical_start: "", typical_end: "", most_used_apps: [] },
      week_summary: parsed.week_summary || "",
    };
  } catch {
    return { ...DEFAULT_PROFILE, updated_at: new Date().toISOString() };
  }
}

export async function writeProfile(profile: UserProfile): Promise<void> {
  const profilePath = getProfilePath();
  await fs.mkdir(path.dirname(profilePath), { recursive: true });
  await fs.writeFile(profilePath, `${JSON.stringify(profile, null, 2)}\n`, "utf8");
}

/** Extract project-like entities from session topics and entities. */
function inferProjectName(session: Session): string | null {
  // Look for repository-like or project-like patterns in topics/entities
  // This is a heuristic — entities that look like project names
  for (const entity of session.topics) {
    // Multi-word topics with hyphens often indicate projects
    if (entity.includes("-") && !["stack-overflow", "auth-flow"].includes(entity)) {
      return entity;
    }
  }
  // Fall back to the most specific topic
  if (session.topics.length > 0) {
    return session.topics[0]!;
  }
  return null;
}

function collectRecentFiles(sessions: Session[]): string[] {
  const files = new Set<string>();
  for (const s of sessions) {
    // Look for entities that look like files (contain . or /)
    for (const entity of (s as Session & { entities?: string[] }).entities || []) {
      if (entity.includes(".") && !entity.startsWith("http")) {
        files.add(entity);
      }
    }
  }
  return Array.from(files).slice(0, 10);
}

/** Update the profile with new session data. */
export async function updateProfile(daySessions: DaySessions): Promise<UserProfile> {
  const profile = await readProfile();
  const now = new Date().toISOString();
  profile.updated_at = now;

  // Update active projects
  for (const session of daySessions.sessions) {
    const projectName = inferProjectName(session);
    if (!projectName) continue;

    const existing = profile.active_projects.find((p) => p.name === projectName);
    if (existing) {
      existing.last_seen = now;
      existing.sessions_this_week += 1;
      // Merge topics
      for (const topic of session.topics) {
        if (!existing.topics.includes(topic)) {
          existing.topics.push(topic);
        }
      }
      // Keep topics manageable
      if (existing.topics.length > 20) {
        existing.topics = existing.topics.slice(-20);
      }
    } else {
      const newProject: ActiveProject = {
        name: projectName,
        last_seen: now,
        topics: session.topics.slice(0, 10),
        recent_files: [],
        sessions_this_week: 1,
      };
      profile.active_projects.push(newProject);
    }
  }

  // Update recent files from today's sessions
  const todayFiles = collectRecentFiles(daySessions.sessions);
  for (const project of profile.active_projects) {
    if (todayFiles.length > 0) {
      project.recent_files = todayFiles.slice(0, 10);
    }
  }

  // Prune stale projects (not seen in 7 days)
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  profile.active_projects = profile.active_projects.filter((p) => p.last_seen > sevenDaysAgo);

  // Keep only the 10 most recent projects
  profile.active_projects.sort((a, b) => b.last_seen.localeCompare(a.last_seen));
  profile.active_projects = profile.active_projects.slice(0, 10);

  // Update active threads
  for (const session of daySessions.sessions) {
    if (session.chunk_keys.length < 2) continue; // Single-chunk sessions aren't threads

    const matchingThread = profile.active_threads.find((t) => {
      // A thread matches if it shares topics with this session
      const threadTopics = t.description.toLowerCase().split(/\s+/);
      return session.topics.some((topic) =>
        threadTopics.some((word) => word.includes(topic) || topic.includes(word))
      );
    });

    if (matchingThread) {
      matchingThread.last_active = now;
      matchingThread.status = "in_progress";
      if (!matchingThread.related_sessions.includes(session.id)) {
        matchingThread.related_sessions.push(session.id);
      }
      // Keep manageable
      if (matchingThread.related_sessions.length > 20) {
        matchingThread.related_sessions = matchingThread.related_sessions.slice(-20);
      }
    } else {
      const newThread: ActiveThread = {
        description: session.primary_intent || session.summary.slice(0, 100),
        started: now,
        last_active: now,
        status: "in_progress",
        related_sessions: [session.id],
      };
      profile.active_threads.push(newThread);
    }
  }

  // Mark stale threads (not active in 3 days)
  const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
  for (const thread of profile.active_threads) {
    if (thread.last_active < threeDaysAgo && thread.status === "in_progress") {
      thread.status = "stale";
    }
  }

  // Prune old threads (stale for 7+ days)
  profile.active_threads = profile.active_threads.filter(
    (t) => t.status !== "stale" || t.last_active > sevenDaysAgo
  );

  // Keep only 15 most recent threads
  profile.active_threads.sort((a, b) => b.last_active.localeCompare(a.last_active));
  profile.active_threads = profile.active_threads.slice(0, 15);

  // Update daily pattern from today's sessions
  if (daySessions.sessions.length > 0) {
    const times = daySessions.sessions.map((s) => s.start_time).sort();
    const endTimes = daySessions.sessions.map((s) => s.end_time).sort();
    profile.daily_pattern.typical_start = times[0] || "";
    profile.daily_pattern.typical_end = endTimes[endTimes.length - 1] || "";

    const appCounts = new Map<string, number>();
    for (const s of daySessions.sessions) {
      for (const app of s.apps) {
        appCounts.set(app, (appCounts.get(app) || 0) + 1);
      }
    }
    profile.daily_pattern.most_used_apps = Array.from(appCounts.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([app]) => app);
  }

  // Generate week summary from active projects and threads
  const projectNames = profile.active_projects.map((p) => p.name);
  const activeThreadDescs = profile.active_threads
    .filter((t) => t.status === "in_progress")
    .map((t) => t.description);

  const summaryParts: string[] = [];
  if (projectNames.length > 0) {
    summaryParts.push(`Active projects: ${projectNames.join(", ")}.`);
  }
  if (activeThreadDescs.length > 0) {
    summaryParts.push(`Current threads: ${activeThreadDescs.join("; ")}.`);
  }
  profile.week_summary = summaryParts.join(" ");

  await writeProfile(profile);
  return profile;
}
