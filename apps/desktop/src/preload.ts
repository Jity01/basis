import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("contextManager", {
  startRecording: () => ipcRenderer.invoke("start-recording"),
  stopRecording: () => ipcRenderer.invoke("stop-recording"),
  rotateRecording: () => ipcRenderer.invoke("rotate-recording"),
  processNow: () => ipcRenderer.invoke("process-now"),
  sendRecordingChunk: (chunk: ArrayBuffer) =>
    ipcRenderer.send("recording-chunk", Buffer.from(chunk)),
  getCurrentFile: () => ipcRenderer.invoke("get-current-file"),
  getUnprocessedFiles: () => ipcRenderer.invoke("get-unprocessed-files"),
  getProcessingStatus: () => ipcRenderer.invoke("get-processing-status"),
  onProcessingStatus: (
    callback: (status: {
      isProcessing: boolean;
      currentChunk: number;
      totalChunks: number;
      pendingChunks: number;
      trigger: "idle" | "manual" | null;
    }) => void
  ) => {
    const listener = (_event: unknown, status: unknown) => {
      callback(
        status as {
          isProcessing: boolean;
          currentChunk: number;
          totalChunks: number;
          pendingChunks: number;
          trigger: "idle" | "manual" | null;
        }
      );
    };
    ipcRenderer.on("processing-status", listener);
    return () => {
      ipcRenderer.removeListener("processing-status", listener);
    };
  },
  getChunkDurationMs: () => ipcRenderer.invoke("get-chunk-duration-ms"),
  getDesktopSources: (opts: { types: ("screen" | "window")[] }) =>
    ipcRenderer.invoke("get-desktop-sources", opts),
});
