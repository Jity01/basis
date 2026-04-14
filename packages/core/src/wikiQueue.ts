import * as fs from "fs/promises";
import * as path from "path";
import { wikiRootPath } from "@context-manager/config";
import type { WikiOperation } from "./segmentWiki";
import { applyWikiDiffs } from "./wikiApply";

export type WikiQueueEntry = {
  chunkStartMs: number;
  chunkKey: string;
  operations: WikiOperation[];
  enqueuedAt: string;
};

function queueDir(contextRoot: string): string {
  return path.join(wikiRootPath(contextRoot), "_queue");
}

function pendingPath(contextRoot: string): string {
  return path.join(queueDir(contextRoot), "pending.jsonl");
}

function deadLetterPath(contextRoot: string): string {
  return path.join(queueDir(contextRoot), "dead.jsonl");
}

export async function enqueueWikiOps(contextRoot: string, entry: WikiQueueEntry): Promise<void> {
  const dir = queueDir(contextRoot);
  await fs.mkdir(dir, { recursive: true });
  const line = `${JSON.stringify(entry)}\n`;
  await fs.appendFile(pendingPath(contextRoot), line, "utf8");
}

/**
 * Apply queued wiki ops in chronological chunk order (by `chunkStartMs`).
 * Successful entries are removed from the queue; failures are appended to `dead.jsonl` and re-queued.
 */
export async function drainWikiQueue(contextRoot: string): Promise<void> {
  const pend = pendingPath(contextRoot);
  let raw: string;
  try {
    raw = await fs.readFile(pend, "utf8");
  } catch {
    return;
  }

  const lines = raw.split("\n").map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0) {
    await fs.writeFile(pend, "", "utf8");
    return;
  }

  const entries: WikiQueueEntry[] = [];
  for (const line of lines) {
    try {
      entries.push(JSON.parse(line) as WikiQueueEntry);
    } catch {
      /* malformed line — skip */
    }
  }

  entries.sort((a, b) => a.chunkStartMs - b.chunkStartMs);

  const wikiDir = wikiRootPath(contextRoot);
  const failed: WikiQueueEntry[] = [];

  for (const e of entries) {
    try {
      await applyWikiDiffs(wikiDir, e.operations, contextRoot, false);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[wiki-queue] apply failed for ${e.chunkKey}: ${message}`);
      failed.push(e);
      try {
        await fs.appendFile(
          deadLetterPath(contextRoot),
          `${JSON.stringify({ ...e, error: message, failedAt: new Date().toISOString() })}\n`,
          "utf8"
        );
      } catch {
        /* ignore dead-letter write errors */
      }
    }
  }

  if (failed.length === 0) {
    await fs.writeFile(pend, "", "utf8");
  } else {
    await fs.writeFile(
      pend,
      failed.map((e) => JSON.stringify(e)).join("\n") + "\n",
      "utf8"
    );
  }
}
