import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { app } from "electron";

// ── Known MCP config paths (macOS) ──────────────────────────────────────────

const MCP_CONFIGS: Record<string, string> = {
  "Claude Desktop": path.join(
    os.homedir(),
    "Library",
    "Application Support",
    "Claude",
    "claude_desktop_config.json",
  ),
  "Cursor": path.join(os.homedir(), ".cursor", "mcp.json"),
  "Claude Code": path.join(os.homedir(), ".claude.json"),
};

// ── Server command ──────────────────────────────────────────────────────────

function getMcpServerCommand(): { command: string; args: string[] } {
  if (app.isPackaged) {
    const serverPath = path.join(process.resourcesPath, "mcp-server", "dist", "server.js");
    return { command: "node", args: [serverPath] };
  }
  const serverPath = path.join(__dirname, "..", "..", "mcp_server", "dist", "server.js");
  return { command: "node", args: [serverPath] };
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function readJsonFile(filePath: string): Record<string, unknown> | null {
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return null;
  } catch (err: unknown) {
    if (err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "ENOENT") {
      return {};
    }
    return null;
  }
}

function writeJsonFile(filePath: string, data: Record<string, unknown>): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + "\n", "utf8");
}

// ── Public API ──────────────────────────────────────────────────────────────

/** Return app names whose MCP config files exist on disk (i.e. the app is installed). */
export function detectInstalledMcpApps(): string[] {
  return Object.entries(MCP_CONFIGS)
    .filter(([, configPath]) => {
      try {
        // Check the config file itself, or at minimum the parent directory.
        return fs.existsSync(configPath) || fs.existsSync(path.dirname(configPath));
      } catch {
        return false;
      }
    })
    .map(([name]) => name);
}

/** Register the vizlog MCP server with a specific AI app. */
export function registerMcpWithApp(appName: string): { success: boolean; error?: string } {
  const configPath = MCP_CONFIGS[appName];
  if (!configPath) {
    return { success: false, error: `Unknown app: ${appName}` };
  }

  const config = readJsonFile(configPath);
  if (config === null) {
    return { success: false, error: `Malformed config file: ${configPath}` };
  }

  const { command, args } = getMcpServerCommand();

  // Ensure mcpServers key exists as an object.
  if (typeof config.mcpServers !== "object" || config.mcpServers === null || Array.isArray(config.mcpServers)) {
    config.mcpServers = {};
  }

  const servers = config.mcpServers as Record<string, unknown>;
  servers.vizlog = { command, args };

  try {
    writeJsonFile(configPath, config);
    return { success: true };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return { success: false, error: message };
  }
}

/** Register vizlog MCP server with multiple apps at once. */
export function registerMcpWithApps(
  appNames: string[],
): Record<string, { success: boolean; error?: string }> {
  const results: Record<string, { success: boolean; error?: string }> = {};
  for (const name of appNames) {
    results[name] = registerMcpWithApp(name);
  }
  return results;
}

/** Check if vizlog is already registered with a given app. */
export function isMcpRegistered(appName: string): boolean {
  const configPath = MCP_CONFIGS[appName];
  if (!configPath) return false;

  const config = readJsonFile(configPath);
  if (!config) return false;

  const servers = config.mcpServers;
  if (typeof servers !== "object" || servers === null || Array.isArray(servers)) return false;

  return "vizlog" in (servers as Record<string, unknown>);
}

/** Unregister vizlog from an app's MCP config. Returns `true` if it was present and removed. */
export function unregisterMcpFromApp(appName: string): boolean {
  const configPath = MCP_CONFIGS[appName];
  if (!configPath) return false;

  const config = readJsonFile(configPath);
  if (!config) return false;

  const servers = config.mcpServers;
  if (typeof servers !== "object" || servers === null || Array.isArray(servers)) return false;

  const serversObj = servers as Record<string, unknown>;
  if (!("vizlog" in serversObj)) return false;

  delete serversObj.vizlog;

  try {
    writeJsonFile(configPath, config);
    return true;
  } catch {
    return false;
  }
}
