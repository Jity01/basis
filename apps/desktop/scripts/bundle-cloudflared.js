#!/usr/bin/env node
/**
 * Downloads cloudflared for the current platform/arch from GitHub releases into
 * resources/cloudflared-bin/ for electron-builder extraResources.
 *
 * Pin VERSION when upgrading; see https://github.com/cloudflare/cloudflared/releases
 */
const fs = require("fs");
const path = require("path");
const tar = require("tar");

const VERSION = "2024.12.2";
const BASE = `https://github.com/cloudflare/cloudflared/releases/download/${VERSION}/`;

const root = path.join(__dirname, "..");
const outDir = path.join(root, "resources", "cloudflared-bin");
fs.mkdirSync(outDir, { recursive: true });

const isWin = process.platform === "win32";
const outName = isWin ? "cloudflared.exe" : "cloudflared";
const dest = path.join(outDir, outName);

/** @type {Record<string, { asset: string; kind: 'tgz' | 'bin' }>} */
const matrix = {
  "darwin-arm64": { asset: "cloudflared-darwin-arm64.tgz", kind: "tgz" },
  "darwin-x64": { asset: "cloudflared-darwin-amd64.tgz", kind: "tgz" },
  "linux-x64": { asset: "cloudflared-linux-amd64", kind: "bin" },
  "linux-arm64": { asset: "cloudflared-linux-arm64", kind: "bin" },
  "win32-x64": { asset: "cloudflared-windows-amd64.exe", kind: "bin" },
  "win32-arm64": { asset: "cloudflared-windows-amd64.exe", kind: "bin" },
};

const key = `${process.platform}-${process.arch}`;
const spec = matrix[key];
if (!spec) {
  console.error(`[bundle-cloudflared] Unsupported platform ${key}. Supported: ${Object.keys(matrix).join(", ")}`);
  process.exit(1);
}

async function download(url) {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`GET ${url} -> ${res.status}`);
  }
  return Buffer.from(await res.arrayBuffer());
}

async function main() {
  const url = BASE + spec.asset;
  console.log("[bundle-cloudflared] Downloading", url);
  const buf = await download(url);

  if (spec.kind === "bin") {
    fs.writeFileSync(dest, buf);
    if (!isWin) {
      fs.chmodSync(dest, 0o755);
    }
    console.log("[bundle-cloudflared] Wrote", dest);
    return;
  }

  const tmpTgz = path.join(outDir, "_cloudflared.tgz");
  const tmpExtract = path.join(outDir, "_extract");
  fs.writeFileSync(tmpTgz, buf);
  fs.rmSync(tmpExtract, { recursive: true, force: true });
  fs.mkdirSync(tmpExtract, { recursive: true });
  try {
    await tar.x({ file: tmpTgz, cwd: tmpExtract });
  } finally {
    fs.rmSync(tmpTgz, { force: true });
  }

  const extracted = path.join(tmpExtract, "cloudflared");
  if (!fs.existsSync(extracted)) {
    const found = fs.readdirSync(tmpExtract, { withFileTypes: true });
    console.error("[bundle-cloudflared] Expected cloudflared in archive, got:", found.map((d) => d.name));
    process.exit(1);
  }
  fs.copyFileSync(extracted, dest);
  fs.chmodSync(dest, 0o755);
  fs.rmSync(tmpExtract, { recursive: true, force: true });
  console.log("[bundle-cloudflared] Wrote", dest);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
