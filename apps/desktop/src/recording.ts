import { app } from "electron";
import * as fs from "fs";
import * as path from "path";
import {
  ensureTmpDir,
  getNextRecordingPath,
  setCurrentFile,
  writeChunkDurationMsForFile,
} from "@context-manager/core";
import { sendToRenderer } from "./mainWindowRef";
import { emitProcessingStatus } from "./processing";

let writeStream: fs.WriteStream | null = null;
let pendingWriteChain: Promise<void> = Promise.resolve();
let activeRecordingChunkDurationMs: number | null = null;

export function setActiveRecordingChunkDurationMs(ms: number | null): void {
  activeRecordingChunkDurationMs = ms;
}

export function getActiveRecordingChunkDurationMs(): number | null {
  return activeRecordingChunkDurationMs;
}

export function resolveOcrBinaryPath(): string | undefined {
  if (process.platform !== "darwin") {
    return undefined;
  }
  if (app.isPackaged) {
    return path.join(process.resourcesPath, "ocr-bin", "ocr-helper");
  }
  return path.join(__dirname, "..", "resources", "ocr-bin", "ocr-helper");
}

function waitForStreamFinish(stream: fs.WriteStream): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;

    const cleanup = () => {
      stream.removeListener("finish", onFinish);
      stream.removeListener("close", onClose);
      stream.removeListener("error", onError);
    };

    const settle = (callback: () => void) => {
      if (settled) return;
      settled = true;
      cleanup();
      callback();
    };

    const onFinish = () => {
      settle(resolve);
    };

    const onClose = () => {
      settle(resolve);
    };

    const onError = (err: Error) => {
      settle(() => reject(err));
    };

    stream.once("finish", onFinish);
    stream.once("close", onClose);
    stream.once("error", onError);
  });
}

function writeChunkToStream(stream: fs.WriteStream, chunk: Buffer): Promise<void> {
  if (stream.destroyed || stream.writableEnded) {
    return Promise.reject(new Error("Recording file is already closing"));
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    let callbackDone = false;
    let drainDone = false;
    let needsDrain = false;

    const cleanup = () => {
      stream.removeListener("error", onError);
      stream.removeListener("drain", onDrain);
    };

    const settle = (callback: () => void) => {
      if (settled) return;
      settled = true;
      cleanup();
      callback();
    };

    const maybeResolve = () => {
      if (!callbackDone) return;
      if (!needsDrain || drainDone) {
        settle(resolve);
      }
    };

    const onError = (err: Error) => {
      settle(() => reject(err));
    };

    const onDrain = () => {
      drainDone = true;
      maybeResolve();
    };

    stream.once("error", onError);
    needsDrain = !stream.write(chunk, (err?: Error | null) => {
      if (err) {
        settle(() => reject(err));
        return;
      }
      callbackDone = true;
      maybeResolve();
    });

    if (needsDrain) {
      stream.once("drain", onDrain);
      return;
    }

    drainDone = true;
  });
}

export function enqueueChunkWrite(chunk: Buffer): Promise<void> {
  const priorWrites = pendingWriteChain.catch(() => {});
  const nextWrite = priorWrites.then(() => {
    if (!writeStream) {
      throw new Error("No active recording file");
    }
    return writeChunkToStream(writeStream, chunk);
  });
  pendingWriteChain = nextWrite;
  return nextWrite;
}

export async function closeCurrentFile(): Promise<void> {
  const stream = writeStream;
  await pendingWriteChain.catch(() => {});
  if (!stream) {
    setCurrentFile(null);
    emitProcessingStatus();
    return;
  }

  writeStream = null;
  stream.end();
  await waitForStreamFinish(stream);
  setCurrentFile(null);
  emitProcessingStatus();
}

export async function openNewFile(chunkDurationMs: number): Promise<string> {
  await closeCurrentFile();
  ensureTmpDir();
  const filePath = getNextRecordingPath();
  writeChunkDurationMsForFile(filePath, chunkDurationMs);
  writeStream = fs.createWriteStream(filePath);
  pendingWriteChain = Promise.resolve();
  setCurrentFile(filePath);
  emitProcessingStatus();
  return filePath;
}

export function coerceChunkToBuffer(input: unknown): Buffer | null {
  if (Buffer.isBuffer(input)) {
    return input;
  }
  if (input instanceof Uint8Array) {
    return Buffer.from(input);
  }
  if (input instanceof ArrayBuffer) {
    return Buffer.from(new Uint8Array(input));
  }
  return null;
}
