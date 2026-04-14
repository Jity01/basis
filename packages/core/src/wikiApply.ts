import * as fs from "fs/promises";
import * as fsSync from "fs";
import * as path from "path";
import type { WikiOperation } from "./segmentWiki";

const WIKI_KNOWN_OPS = new Set(["create", "append", "cite", "skip", "update_index"]);

/**
 * Read flat wiki: `index.md` first, then other `*.md` in `wikiDir` (no recursion).
 */
export async function readWikiStateFlat(wikiDir: string): Promise<string> {
  try {
    await fs.access(wikiDir);
  } catch {
    return "(empty)";
  }

  const entries = await fs.readdir(wikiDir, { withFileTypes: true });
  const mdFiles = entries
    .filter((e) => e.isFile() && e.name.endsWith(".md") && !e.name.startsWith("_"))
    .map((e) => e.name)
    .sort();

  if (mdFiles.length === 0) {
    return "(empty)";
  }

  const parts: string[] = [];
  const ordered = mdFiles.includes("index.md")
    ? ["index.md", ...mdFiles.filter((n) => n !== "index.md")]
    : mdFiles;

  for (const name of ordered) {
    const fp = path.join(wikiDir, name);
    const content = (await fs.readFile(fp, "utf8")).trim();
    if (!content) {
      continue;
    }
    if (name === "index.md") {
      parts.push(`## index.md\n\n${content}`);
    } else {
      parts.push(`## ${name}\n\n${content}`);
    }
  }

  if (parts.length === 0) {
    return "(empty)";
  }

  return parts.join("\n\n---\n\n");
}

function sanitizeFilename(name: unknown): string {
  if (typeof name !== "string") {
    return String(name ?? "");
  }
  let n = name.replace(/\//g, "-").replace(/\\/g, "-");
  n = n.replace(/^[-.]+/, "");
  return n;
}

/** Replace `[frame:YYYY-MM-DD HH:MM:N]` with image or OCR link. */
export function resolveFrameLinks(content: string, contextRoot: string): string {
  const pattern = /\[frame:(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}):(\d+)\]/g;
  return content.replace(pattern, (_match, dateStr, timeStr, frameNum) => {
    const [year, month, day] = String(dateStr).split("-");
    const hhMm = String(timeStr).replace(":", "-");
    const frameFile = `${Number.parseInt(String(frameNum), 10)}`.padStart(3, "0");
    const base = path.join(contextRoot, year, month, day, hhMm);
    const jpg = path.join(base, "frames", `${frameFile}.jpg`);
    const png = path.join(base, "frames", `${frameFile}.png`);
    const ocrTxt = path.join(base, "ocr", `${frameFile}.txt`);

    let framePath: string | null = null;
    if (fsSync.existsSync(jpg)) {
      framePath = jpg;
    } else if (fsSync.existsSync(png)) {
      framePath = png;
    } else if (fsSync.existsSync(ocrTxt)) {
      const alt = `${dateStr} ${timeStr} #${frameNum} (OCR)`;
      return `[${alt}](${ocrTxt})`;
    }

    if (!framePath) {
      return `[screenshot ${dateStr} ${timeStr} #${frameNum}]`;
    }

    const absPath = path.resolve(framePath);
    const alt = `${dateStr} ${timeStr} #${frameNum}`;
    return `[![${alt}](${absPath})](${absPath})`;
  });
}

export function resolveWikilinks(content: string): string {
  return content.replace(/\[\[([^\]]+)\]\]/g, "[$1]($1.md)");
}

const INLINE_FRAME_TOKEN_RE = /^(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2})(?:#(\d+))?$/;

/**
 * Replace inline `(frames: …)` citations with embedded image links (or OCR file links).
 * Matches `experiments/daywiki.resolve_inline_frame_citations`, with OCR fallback when
 * `frames/00N.{jpg,png}` is missing but `ocr/00N.txt` exists.
 */
export function resolveInlineFrameCitations(content: string, contextRoot: string): string {
  const pattern = /\(frames?:\s*([^)]+)\)/g;

  return content.replace(pattern, (_match, inner: string) => {
    const rawTokens = inner
      .split(",")
      .map((t: string) => t.trim())
      .filter(Boolean);
    const imageLinks: string[] = [];

    for (const ts of rawTokens) {
      const m = INLINE_FRAME_TOKEN_RE.exec(ts);
      if (!m) {
        imageLinks.push("`" + ts + "`");
        continue;
      }
      const dateStr = m[1]!;
      const timeStr = m[2]!;
      const idxS = m[3];
      const frameIndex = idxS ? Number.parseInt(idxS, 10) : null;

      const resolved = frameFileForCitation(contextRoot, dateStr, timeStr, frameIndex);
      if (!resolved.path) {
        const label =
          `${dateStr} ${timeStr}` + (frameIndex != null ? `#${frameIndex}` : "");
        imageLinks.push("`" + label + "`");
        continue;
      }

      if (resolved.kind === "ocr") {
        imageLinks.push(`[${resolved.alt}](${resolved.path})`);
      } else {
        imageLinks.push(`[![${resolved.alt}](${resolved.path})](${resolved.path})`);
      }
    }

    return "(" + imageLinks.join(" ") + ")";
  });
}

function frameFileForCitation(
  contextRoot: string,
  dateStr: string,
  timeStr: string,
  frameIndex1Based: number | null
): { path: string | null; alt: string; kind: "image" | "ocr" } | { path: null; alt: string; kind: null } {
  let year: string;
  let month: string;
  let day: string;
  try {
    const parts = dateStr.split("-");
    year = parts[0]!;
    month = parts[1]!;
    day = parts[2]!;
  } catch {
    return { path: null, alt: "", kind: null };
  }

  const hhMm = timeStr.replace(":", "-");
  const base = path.join(contextRoot, year, month, day, hhMm);
  const framesDir = path.join(base, "frames");

  if (frameIndex1Based != null && frameIndex1Based >= 1) {
    const stem = String(frameIndex1Based).padStart(3, "0");
    for (const ext of [".jpg", ".png"] as const) {
      const p = path.join(framesDir, `${stem}${ext}`);
      if (fsSync.existsSync(p)) {
        const alt = `${dateStr} ${timeStr} #${frameIndex1Based}`;
        return { path: path.resolve(p), alt, kind: "image" };
      }
    }
    const ocrPath = path.join(base, "ocr", `${stem}.txt`);
    if (fsSync.existsSync(ocrPath)) {
      const alt = `${dateStr} ${timeStr} #${frameIndex1Based} (OCR)`;
      return { path: path.resolve(ocrPath), alt, kind: "ocr" };
    }
    return { path: null, alt: "", kind: null };
  }

  if (!fsSync.existsSync(framesDir)) {
    return { path: null, alt: "", kind: null };
  }
  const names = fsSync.readdirSync(framesDir).sort();
  const first = names.find((f) => f.endsWith(".jpg")) ?? names.find((f) => f.endsWith(".png"));
  if (!first) {
    return { path: null, alt: "", kind: null };
  }
  const p = path.join(framesDir, first);
  const alt = `${dateStr} ${timeStr}`;
  return { path: path.resolve(p), alt, kind: "image" };
}

function normalizeCiteContent(raw: unknown): string {
  if (typeof raw !== "string") {
    return String(raw ?? "");
  }
  let s = raw.replace(/\\n/g, "\n").trim();
  if (!s) {
    return raw;
  }
  const headerM = /^(\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}\])\s*/.exec(s);
  if (!headerM) {
    return raw;
  }
  const tsLine = headerM[1]!;
  const re = /\(frames?:\s*([^)]+)\)/g;
  let m: RegExpExecArray | null;
  let last: RegExpExecArray | null = null;
  while ((m = re.exec(s)) !== null) {
    last = m;
  }
  if (!last) {
    return raw;
  }
  const inner = last[1]!.trim();
  return `${tsLine}\n(frames: ${inner})`;
}

function processContent(s: unknown, contextRoot: string): string {
  if (typeof s !== "string") {
    return String(s ?? "");
  }
  let out = s.replace(/\\n/g, "\n");
  out = resolveFrameLinks(out, contextRoot);
  out = resolveWikilinks(out);
  out = resolveInlineFrameCitations(out, contextRoot);
  return out;
}

export async function applyWikiDiffs(
  wikiDir: string,
  diffs: WikiOperation[],
  contextRoot: string,
  dryRun = false
): Promise<void> {
  await fs.mkdir(wikiDir, { recursive: true });

  for (const diff of diffs) {
    if (!diff || typeof diff !== "object") {
      continue;
    }
    const op = diff["op"];
    if (typeof op !== "string" || !WIKI_KNOWN_OPS.has(op)) {
      continue;
    }

    const frames = diff["frames"];

    if (op === "create") {
      const file = sanitizeFilename(diff["file"]);
      if (!file) {
        continue;
      }
      const filepath = path.join(wikiDir, file);
      const content = processContent(diff["content"], contextRoot);
      if (dryRun) {
        console.log(`[wiki] [CREATE] ${file} (frames: ${JSON.stringify(frames)})`);
      } else {
        await fs.writeFile(filepath, content, "utf8");
      }
      continue;
    }

    if (op === "append" || op === "cite") {
      const file = sanitizeFilename(diff["file"]);
      if (!file) {
        continue;
      }
      const filepath = path.join(wikiDir, file);
      let rawContent = diff["content"];
      if (op === "cite") {
        rawContent = normalizeCiteContent(rawContent);
      }
      const content = processContent(rawContent, contextRoot);
      try {
        await fs.access(filepath);
        if (dryRun) {
          console.log(`[wiki] [${op.toUpperCase()}] ${file}`);
        } else {
          const existing = await fs.readFile(filepath, "utf8");
          await fs.writeFile(filepath, `${existing.replace(/\s*$/, "")}\n\n${content}`, "utf8");
        }
      } catch {
        if (dryRun) {
          console.log(`[wiki] [${op.toUpperCase()}+CREATE] ${file}`);
        } else {
          await fs.writeFile(filepath, content, "utf8");
        }
      }
      continue;
    }

    if (op === "update_index") {
      const filepath = path.join(wikiDir, "index.md");
      const content = processContent(diff["content"], contextRoot);
      if (dryRun) {
        console.log("[wiki] [UPDATE_INDEX]");
      } else {
        await fs.writeFile(filepath, content, "utf8");
      }
      continue;
    }

    if (op === "skip") {
      /* no-op */
    }
  }
}
