import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("contextManager", {
  startRecording: () => ipcRenderer.invoke("start-recording"),
  stopRecording: () => ipcRenderer.invoke("stop-recording"),
  rotateRecording: () => ipcRenderer.invoke("rotate-recording"),
  sendRecordingChunk: (chunk: ArrayBuffer) =>
    ipcRenderer.send("recording-chunk", Buffer.from(chunk)),
  getCurrentFile: () => ipcRenderer.invoke("get-current-file"),
  getUnprocessedFiles: () => ipcRenderer.invoke("get-unprocessed-files"),
  getChunkDurationMs: () => ipcRenderer.invoke("get-chunk-duration-ms"),
  getDesktopSources: (opts: { types: ("screen" | "window")[] }) =>
    ipcRenderer.invoke("get-desktop-sources", opts),
});
