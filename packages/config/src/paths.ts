import * as os from "os";
import * as path from "path";

export const CONTEXT_ROOT = process.env.CONTEXT_ROOT || path.join(os.homedir(), "context");
export const BASIS_ROOT = process.env.BASIS_ROOT || path.join(os.homedir(), ".basis");
