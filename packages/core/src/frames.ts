import { execFile } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { promisify } from "util";
import { CONTEXT_ROOT } from "@context-manager/config";

const execFileAsync = promisify(execFile);

const DEFAULT_MAX_DIM = 1568;

function ffmpegBin(): string {
  return process.env.CONTEXT_MANAGER_FFMPEG_BIN?.trim() || "ffmpeg";
}

function ffprobeBin(): string {
  return process.env.CONTEXT_MANAGER_FFPROBE_BIN?.trim() || "ffprobe";
}

/** Latest `extractFrames` output: `~/.context/.tmp/extracted-frames/` (overwritten each run). */
export const EXTRACTED_FRAMES_DIR = path.join(
  CONTEXT_ROOT,
  ".tmp",
  "extracted-frames"
);

function parseFfprobeDurationSeconds(stdout: string): number | null {
  const t = String(stdout).trim();
  if (t === "" || /^N\/A$/i.test(t)) {
    return null;
  }
  const v = parseFloat(t);
  if (!Number.isFinite(v) || v <= 0) {
    return null;
  }
  return v;
}

/** Parses `Duration: HH:MM:SS.xx` from ffmpeg stderr (e.g. when format=duration is N/A for WebM). */
function parseDurationFromFfmpegStderr(stderr: string): number | null {
  const m = stderr.match(/Duration:\s*(\d+):(\d+):(\d+\.?\d*)/);
  if (!m) {
    return null;
  }
  const hours = parseInt(m[1]!, 10);
  const minutes = parseInt(m[2]!, 10);
  const seconds = parseFloat(m[3]!);
  const total = hours * 3600 + minutes * 60 + seconds;
  if (!Number.isFinite(total) || total <= 0) {
    return null;
  }
  return total;
}

/** Last `time=HH:MM:SS.xx` from ffmpeg progress lines (decode-to-null / stats). */
function parseLastTimeFromFfmpegProgress(stderr: string): number | null {
  const re = /time=(\d+):(\d+):(\d+\.?\d*)/g;
  let m: RegExpExecArray | null;
  let last: RegExpExecArray | null = null;
  while ((m = re.exec(stderr)) !== null) {
    last = m;
  }
  if (!last) {
    return null;
  }
  const hours = parseInt(last[1]!, 10);
  const minutes = parseInt(last[2]!, 10);
  const seconds = parseFloat(last[3]!);
  const total = hours * 3600 + minutes * 60 + seconds;
  if (!Number.isFinite(total) || total <= 0) {
    return null;
  }
  return total;
}

/**
 * Chrome MediaRecorder WebM often has no container duration; demuxing to null still emits
 * progress with a final `time=` (reads the whole file once).
 */
async function probeDurationViaFfmpegDecodeToNull(
  videoPath: string
): Promise<number | null> {
  try {
    const { stderr } = await execFileAsync(
      ffmpegBin(),
      ["-hide_banner", "-i", videoPath, "-f", "null", "-"],
      { maxBuffer: 50 * 1024 * 1024, encoding: "utf8" }
    );
    return parseLastTimeFromFfmpegProgress(String(stderr ?? ""));
  } catch (e: unknown) {
    if (e && typeof e === "object" && "code" in e) {
      const code = (e as { code?: string }).code;
      if (code === "ENOENT") {
        throw wrapFfmpegError(e);
      }
    }
    return parseLastTimeFromFfmpegProgress(getExecStderr(e));
  }
}

function getExecStderr(err: unknown): string {
  if (err && typeof err === "object" && "stderr" in err) {
    const s = (err as { stderr?: Buffer | string }).stderr;
    return Buffer.isBuffer(s) ? s.toString("utf8") : String(s ?? "");
  }
  return "";
}

function wrapFfmpegError(err: unknown): Error {
  if (err && typeof err === "object" && "code" in err) {
    const code = (err as { code?: string }).code;
    if (code === "ENOENT") {
      return new Error(
        "ffmpeg/ffprobe not found. Install ffmpeg (e.g. brew install ffmpeg), or use the packaged desktop app which bundles them."
      );
    }
  }
  return err instanceof Error ? err : new Error(String(err));
}

async function probeDurationSeconds(videoPath: string): Promise<number> {
  const { stdout } = await execFileAsync(
    ffprobeBin(),
    [
      "-v",
      "error",
      "-show_entries",
      "format=duration",
      "-of",
      "default=noprint_wrappers=1:nokey=1",
      videoPath,
    ],
    { maxBuffer: 1024 * 1024 }
  );
  const fromProbe = parseFfprobeDurationSeconds(String(stdout));
  if (fromProbe !== null) {
    return fromProbe;
  }

  // WebM from MediaRecorder often has format duration N/A; ffmpeg -i still reports Duration on stderr.
  try {
    await execFileAsync(
      ffmpegBin(),
      ["-hide_banner", "-i", videoPath],
      { maxBuffer: 1024 * 1024 }
    );
  } catch (e: unknown) {
    if (e && typeof e === "object" && "code" in e) {
      const code = (e as { code?: string }).code;
      if (code === "ENOENT") {
        throw wrapFfmpegError(e);
      }
    }
    const fromFfmpeg = parseDurationFromFfmpegStderr(getExecStderr(e));
    if (fromFfmpeg !== null) {
      return fromFfmpeg;
    }
  }

  const fromDecode = await probeDurationViaFfmpegDecodeToNull(videoPath);
  if (fromDecode !== null) {
    return fromDecode;
  }

  return NaN;
}

function scaleFilterLongestEdge(maxDim: number): string {
  return `scale='if(gt(iw,ih),${maxDim},-2)':'if(gt(iw,ih),-2,${maxDim})'`;
}

async function runFfmpegFrameAt(
  videoPath: string,
  ssSeconds: number,
  outPath: string,
  maxDim: number
): Promise<void> {
  const vf = scaleFilterLongestEdge(maxDim);
  await execFileAsync(
    ffmpegBin(),
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
      "-ss",
      String(ssSeconds),
      "-i",
      videoPath,
      "-vframes",
      "1",
      "-vf",
      vf,
      "-q:v",
      "2",
      outPath,
    ],
    { maxBuffer: 1024 * 1024 }
  );
}

/**
 * Extract evenly spaced JPEG frames from a video using ffmpeg.
 * Frames are centered in `numFrames` equal time slices across the duration.
 * Downscales so the longest edge is at most `maxDim` (default 1568).
 * Writes JPEGs to {@link EXTRACTED_FRAMES_DIR} (replaces previous run); returns absolute paths in time order.
 */
export async function extractFrames(
  videoPath: string,
  numFrames: number,
  maxDim: number = DEFAULT_MAX_DIM
): Promise<string[]> {
  if (numFrames <= 0) {
    return [];
  }
  if (!fs.existsSync(videoPath)) {
    throw new Error(`Video not found: ${videoPath}`);
  }

  let duration: number;
  try {
    duration = await probeDurationSeconds(videoPath);
  } catch (e) {
    throw wrapFfmpegError(e);
  }
  if (!Number.isFinite(duration) || duration <= 0) {
    throw new Error(`Invalid or zero duration for: ${videoPath}`);
  }

  const outDir = EXTRACTED_FRAMES_DIR;
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });
  const paths: string[] = [];

  for (let i = 0; i < numFrames; i++) {
    const t = ((i + 0.5) / numFrames) * duration;
    const name = `frame_${String(i).padStart(3, "0")}.jpg`;
    const outPath = path.join(outDir, name);
    try {
      await runFfmpegFrameAt(videoPath, t, outPath, maxDim);
    } catch (e) {
      throw wrapFfmpegError(e);
    }
    paths.push(outPath);
  }

  return paths;
}

/**
 * From ordered extracted frames, pick `keep` paths that are most distinct
 * from their neighbors, using consecutive file-size deltas as a cheap proxy.
 * Always includes the first and last frame when keep >= 2.
 */
export function selectRepresentativeFrames(
  framePaths: string[],
  keep: number
): string[] {
  const n = framePaths.length;
  if (n === 0 || keep <= 0) {
    return [];
  }
  if (keep >= n) {
    return [...framePaths];
  }
  if (keep === 1) {
    return [framePaths[0]];
  }
  if (keep === 2) {
    return [framePaths[0], framePaths[n - 1]];
  }

  const sizes = framePaths.map((p) => fs.statSync(p).size);
  const deltas: number[] = [];
  for (let i = 0; i < n - 1; i++) {
    deltas.push(Math.abs(sizes[i + 1] - sizes[i]));
  }

  const scored: { index: number; score: number }[] = [];
  for (let j = 1; j <= n - 2; j++) {
    const score = Math.max(deltas[j - 1]!, deltas[j]!);
    scored.push({ index: j, score });
  }

  scored.sort((a, b) => b.score - a.score || a.index - b.index);

  const needMiddle = keep - 2;
  const chosen = new Set<number>([0, n - 1]);
  for (let k = 0; k < needMiddle && k < scored.length; k++) {
    chosen.add(scored[k]!.index);
  }

  const sortedIdx = Array.from(chosen).sort((a, b) => a - b);
  return sortedIdx.map((i) => framePaths[i]!);
}
