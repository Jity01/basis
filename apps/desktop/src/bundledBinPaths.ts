import { app } from "electron";
import * as path from "path";

/**
 * When packaged, point ffmpeg/ffprobe/cloudflared at extraResources before any module
 * imports `@context-manager/core` (which uses ffmpeg in frames.ts).
 */
if (app.isPackaged) {
  const r = process.resourcesPath;
  const isWin = process.platform === "win32";
  const ffmpegName = isWin ? "ffmpeg.exe" : "ffmpeg";
  const ffprobeName = isWin ? "ffprobe.exe" : "ffprobe";
  const cloudflaredName = isWin ? "cloudflared.exe" : "cloudflared";
  process.env.CONTEXT_MANAGER_FFMPEG_BIN = path.join(r, "ffmpeg-bin", ffmpegName);
  process.env.CONTEXT_MANAGER_FFPROBE_BIN = path.join(r, "ffmpeg-bin", ffprobeName);
  process.env.CONTEXT_MANAGER_CLOUDFLARED_BIN = path.join(r, "cloudflared-bin", cloudflaredName);
}
