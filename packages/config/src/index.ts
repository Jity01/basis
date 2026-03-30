import * as path from "path";
import * as os from "os";

export const CONTEXT_ROOT =
  process.env.CONTEXT_ROOT || path.join(os.homedir(), ".context");
export const CHUNK_DURATION_MS = 300_000; // 5 minutes
export const FRAMES_PER_CHUNK = 15;
export const FRAMES_TO_KEEP = 5;
