import { useState, useEffect, useRef, useCallback } from "react";
import type {
  ProcessingStatus,
  AISettings,
  ExclusionEntry,
  ExclusionsConfig,
  SckitExclusionsInitState,
} from "@context-manager/config";

const contextManager = window.contextManager;
const INDEX_SECTION_PATTERN = /\[(\d{2}):(\d{2})\]\n([\s\S]*?)(?=\n\n\[\d{2}:\d{2}\]\n|$)/g;

type TabId = "controls" | "settings";

type BannerState = { variant: "error" | "success"; message: string } | null;

const fallbackAISettings: AISettings = {};

const initialExclusionsConfig: ExclusionsConfig = {
  requires_restart: false,
  bundle_ids: [],
};

const initialSckitExclusionsState: SckitExclusionsInitState = {
  initialized: false,
  bundleIds: [],
  error: null,
};

function formatFriendlyDate(dateText: string): string {
  const date = new Date(`${dateText}T00:00:00`);
  if (Number.isNaN(date.getTime())) {
    return dateText;
  }
  return date.toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function formatFriendlyTime(timeText: string): string {
  const [hourText = "00", minuteText = "00"] = timeText.split(":");
  const date = new Date(2000, 0, 1, Number(hourText), Number(minuteText));
  if (Number.isNaN(date.getTime())) {
    return timeText;
  }
  return date.toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });
}

function formatCreatedAt(createdAt: string): string {
  const date = new Date(createdAt);
  if (Number.isNaN(date.getTime())) {
    return createdAt;
  }
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function parseIndexSections(indexText: string): Array<{ time: string; summaryText: string }> {
  const sections: Array<{ time: string; summaryText: string }> = [];
  INDEX_SECTION_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = INDEX_SECTION_PATTERN.exec(indexText)) !== null) {
    sections.push({
      time: `${match[1]}:${match[2]}`,
      summaryText: (match[3] || "").trim(),
    });
  }
  return sections;
}

function normalizeClockTime(timeText: string): string {
  const [hRaw = "0", mRaw = "0"] = timeText.trim().split(":");
  const hour = Math.min(23, Math.max(0, Number.parseInt(hRaw, 10) || 0));
  const minute = Math.min(59, Math.max(0, Number.parseInt(mRaw, 10) || 0));
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

function serializeIndexSections(sections: Array<{ time: string; summaryText: string }>): string {
  return sections
    .map((section) => {
      const t = normalizeClockTime(section.time);
      const body = section.summaryText.replace(/\r\n/g, "\n").trimEnd();
      return `[${t}]\n${body}`;
    })
    .join("\n\n")
    .trimEnd();
}

export default function App() {
  const [activeTab, setActiveTab] = useState<TabId>("controls");
  const [isRecording, setIsRecording] = useState(false);
  const [duration, setDuration] = useState(0);
  const [banner, setBanner] = useState<BannerState>(null);
  const [processingStatus, setProcessingStatus] = useState<ProcessingStatus>({
    isProcessing: false,
    currentChunk: 0,
    totalChunks: 0,
    pendingChunks: 0,
    visiblePendingChunks: 0,
    activeRecordingChunk: false,
    trigger: null,
  });
  const [mcpServerPath, setMcpServerPath] = useState<string>("");
  const [aiSettings, setAISettings] = useState<AISettings>(fallbackAISettings);
  const [chunkDurationMinutes, setChunkDurationMinutes] = useState(1);
  const [exclusions, setExclusions] = useState<ExclusionsConfig>(initialExclusionsConfig);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [manualBundleId, setManualBundleId] = useState("");
  const [sckitExclusionsState, setSckitExclusionsState] = useState<SckitExclusionsInitState>(
    initialSckitExclusionsState
  );
  const [frameLightbox, setFrameLightbox] = useState<{ src: string; title: string } | null>(null);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const rotationTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const durationTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const isRotatingRef = useRef(false);
  const stoppingRef = useRef(false);
  const pendingChunkSendsRef = useRef(new Set<Promise<void>>());

  async function createScreenStream(): Promise<MediaStream> {
    const sources = await contextManager.getDesktopSources({ types: ["screen"] });
    if (sources.length === 0) {
      throw new Error("No screen source available");
    }

    const sourceId = sources[0].id;
    return navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        mandatory: {
          chromeMediaSource: "desktop",
          chromeMediaSourceId: sourceId,
        },
      } as unknown as MediaTrackConstraints,
    });
  }

  async function flushPendingChunkSends(): Promise<void> {
    if (pendingChunkSendsRef.current.size === 0) {
      return;
    }
    await Promise.allSettled(Array.from(pendingChunkSendsRef.current));
  }

  function wireRecorder(recorder: MediaRecorder) {
    recorder.ondataavailable = (e) => {
      if (e.data.size === 0) return;
      const sendPromise = e.data
        .arrayBuffer()
        .then((buf) => contextManager.sendRecordingChunk(buf))
        .catch((err) => {
          setBanner({
            variant: "error",
            message: err instanceof Error ? err.message : "Failed to read recorded chunk",
          });
        })
        .finally(() => {
          pendingChunkSendsRef.current.delete(sendPromise);
        });
      pendingChunkSendsRef.current.add(sendPromise);
    };

    recorder.onerror = (event) => {
      const maybeError = (event as unknown as { error?: Error }).error;
      setBanner({ variant: "error", message: maybeError?.message ?? "MediaRecorder error" });
    };
  }

  const startRecorderForCurrentFile = useCallback(async () => {
    const stream = await createScreenStream();
    streamRef.current = stream;
    const mimeType = MediaRecorder.isTypeSupported("video/webm;codecs=vp9")
      ? "video/webm;codecs=vp9"
      : "video/webm";
    const recorder = new MediaRecorder(stream, {
      mimeType,
      videoBitsPerSecond: 2500000,
    });
    wireRecorder(recorder);
    recorder.start(1000);
    mediaRecorderRef.current = recorder;
  }, []);

  const startCapture = useCallback(async () => {
    try {
      setBanner(null);
      if (!contextManager) {
        throw new Error(
          "contextManager is not available. Run the app with Electron (pnpm dev), not in a browser."
        );
      }

      stoppingRef.current = false;
      isRotatingRef.current = false;

      await contextManager.startRecording();
      await startRecorderForCurrentFile();

      const rotateOnce = async (): Promise<void> => {
        if (isRotatingRef.current || stoppingRef.current) return;
        const current = mediaRecorderRef.current;
        if (!current || current.state !== "recording") return;

        isRotatingRef.current = true;
        current.onstop = async () => {
          try {
            if (stoppingRef.current) return;
            await flushPendingChunkSends();
            streamRef.current?.getTracks().forEach((t) => t.stop());
            streamRef.current = null;

            await contextManager.rotateRecording();
            await startRecorderForCurrentFile();
          } catch (err) {
            setBanner({
              variant: "error",
              message: err instanceof Error ? err.message : "Failed rotating recorder",
            });
            setIsRecording(false);
            stoppingRef.current = true;
          } finally {
            isRotatingRef.current = false;
          }
        };

        current.stop();
      };

      const chunkDurationMs = await contextManager.getChunkDurationMs();
      rotationTimerRef.current = setInterval(() => {
        void rotateOnce();
      }, chunkDurationMs);

      durationTimerRef.current = setInterval(() => {
        setDuration((d) => d + 1);
      }, 1000);

      setIsRecording(true);
    } catch (err) {
      setBanner({
        variant: "error",
        message: err instanceof Error ? err.message : "Failed to start recording",
      });
    }
  }, [startRecorderForCurrentFile]);

  const stopCapture = useCallback(async () => {
    stoppingRef.current = true;

    if (rotationTimerRef.current) {
      clearInterval(rotationTimerRef.current);
      rotationTimerRef.current = null;
    }
    if (durationTimerRef.current) {
      clearInterval(durationTimerRef.current);
      durationTimerRef.current = null;
    }
    setDuration(0);

    const finalizeStop = async () => {
      await flushPendingChunkSends();
      await contextManager.stopRecording();
      streamRef.current?.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
      mediaRecorderRef.current = null;
      isRotatingRef.current = false;
      stoppingRef.current = false;
      setIsRecording(false);
    };

    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== "inactive") {
      mediaRecorderRef.current.onstop = async () => {
        try {
          await finalizeStop();
        } catch (err) {
          setBanner({
            variant: "error",
            message: err instanceof Error ? err.message : "Failed to stop recording",
          });
        }
      };
      mediaRecorderRef.current.stop();
    } else {
      try {
        await finalizeStop();
      } catch (err) {
        setBanner({
          variant: "error",
          message: err instanceof Error ? err.message : "Failed to stop recording",
        });
      }
    }
  }, []);

  const refreshProcessingStatus = useCallback(async () => {
    if (!contextManager) {
      return;
    }
    const status = await contextManager.getProcessingStatus();
    setProcessingStatus(status);
  }, []);

  const processNow = useCallback(async () => {
    try {
      setBanner(null);
      const result = await contextManager.processNow();
      if (!result.started) {
        await refreshProcessingStatus();
      }
    } catch (err) {
      setBanner({
        variant: "error",
        message: err instanceof Error ? err.message : "Failed to process backlog",
      });
    }
  }, [refreshProcessingStatus]);

  const copyToClipboard = useCallback(async (value: string | null) => {
    if (!value) {
      return;
    }
    try {
      await navigator.clipboard.writeText(value);
    } catch (err) {
      setBanner({
        variant: "error",
        message: err instanceof Error ? err.message : "Failed copying to clipboard",
      });
    }
  }, []);

  const saveAISettings = useCallback(async () => {
    try {
      setBanner(null);
      const updated = await contextManager.updateAISettings(aiSettings);
      setAISettings(updated);
      setBanner({ variant: "success", message: "Settings saved." });
    } catch (err) {
      setBanner({
        variant: "error",
        message: err instanceof Error ? err.message : "Failed to save Fireworks API key",
      });
    }
  }, [aiSettings]);

  const saveChunkSettings = useCallback(async () => {
    try {
      setBanner(null);
      const updated = await contextManager.updateChunkSettings({
        chunkDurationMinutes: Math.max(1, Math.round(chunkDurationMinutes)),
      });
      setChunkDurationMinutes(updated.chunkDurationMinutes);
      setBanner({ variant: "success", message: "Capture settings saved." });
    } catch (err) {
      setBanner({
        variant: "error",
        message: err instanceof Error ? err.message : "Failed to save capture settings",
      });
    }
  }, [chunkDurationMinutes]);

  const setExclusionsAndNotify = useCallback((next: ExclusionsConfig, notice: string) => {
    setExclusions(next);
    setBanner({ variant: "success", message: notice });
  }, []);

  const updateExclusionEntries = useCallback(
    async (entries: ExclusionEntry[], notice: string) => {
      const updated = await contextManager.updateExclusions({ bundle_ids: entries });
      setExclusionsAndNotify(updated, notice);
    },
    [setExclusionsAndNotify]
  );

  const toggleExclusion = useCallback(
    async (bundleId: string, enabled: boolean) => {
      const nextEntries = exclusions.bundle_ids.map((entry) =>
        entry.bundle_id === bundleId ? { ...entry, enabled } : entry
      );
      await updateExclusionEntries(nextEntries, "Excluded windows updated. Restart required.");
    },
    [exclusions.bundle_ids, updateExclusionEntries]
  );

  const addExclusion = useCallback(
    async (entry: { bundleId: string; name: string }) => {
      const normalized = entry.bundleId.trim();
      if (!normalized) {
        return;
      }
      const existing = exclusions.bundle_ids.find((candidate) => candidate.bundle_id === normalized);
      const nextEntries = existing
        ? exclusions.bundle_ids.map((candidate) =>
            candidate.bundle_id === normalized ? { ...candidate, name: entry.name, enabled: true } : candidate
          )
        : [
            ...exclusions.bundle_ids,
            {
              bundle_id: normalized,
              name: entry.name || normalized,
              is_default: false,
              enabled: true,
            },
          ];
      await updateExclusionEntries(nextEntries, "Excluded windows updated. Restart required.");
    },
    [exclusions.bundle_ids, updateExclusionEntries]
  );

  const saveAllSettings = useCallback(async () => {
    await saveChunkSettings();
    await saveAISettings();
  }, [saveChunkSettings, saveAISettings]);

  const formatDuration = (seconds: number) => {
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return `${m}:${s.toString().padStart(2, "0")}`;
  };

  const formatChunkCount = (count: number) => `${count} chunk${count === 1 ? "" : "s"}`;

  const processingCurrent = Math.max(processingStatus.currentChunk, 1);
  const processingTotal = Math.max(processingStatus.totalChunks, processingCurrent);
  const visiblePendingChunks = processingStatus.visiblePendingChunks;

  const statusLine = (() => {
    if (processingStatus.isProcessing) {
      if (processingStatus.trigger === "live" && processingStatus.activeRecordingChunk) {
        return `Processed ${processingCurrent}/${processingTotal} chunks - next chunk recording`;
      }
      return `Processed ${processingCurrent}/${processingTotal} chunks`;
    }
    if (isRecording && processingStatus.activeRecordingChunk) {
      if (processingStatus.pendingChunks > 0) {
        return `Recording - ${formatChunkCount(visiblePendingChunks)} pending`;
      }
      return "Recording - 1 chunk in progress";
    }
    if (isRecording) {
      return "Recording";
    }
    if (visiblePendingChunks > 0) {
      return `Idle - ${formatChunkCount(visiblePendingChunks)} pending`;
    }
    return "All caught up";
  })();

  const processNowLabel = (() => {
    if (processingStatus.isProcessing) {
      return `Processed ${processingCurrent}/${processingTotal} chunks...`;
    }
    if (processingStatus.pendingChunks > 0) {
      return `Process ${formatChunkCount(processingStatus.pendingChunks)}`;
    }
    if (processingStatus.activeRecordingChunk) {
      return "Waiting for current chunk";
    }
    return "Process Now";
  })();

  useEffect(() => {
    if (!contextManager) {
      return;
    }

    void refreshProcessingStatus();
    void contextManager.getMcpServerPath().then((p) => {
      setMcpServerPath(p);
    });
    void contextManager.getChunkSettings().then((settings) => {
      setChunkDurationMinutes(settings.chunkDurationMinutes);
    });
    void contextManager.getAISettings().then((settings) => {
      setAISettings(settings);
    });
    void contextManager.getExclusions().then((settings) => {
      setExclusions(settings);
    });
    void contextManager.getSckitExclusionsInitState().then((state) => {
      setSckitExclusionsState(state);
    });

    const unsubscribeProcessing = contextManager.onProcessingStatus((status) => {
      setProcessingStatus(status);
    });

    return () => {
      unsubscribeProcessing();
      if (rotationTimerRef.current) clearInterval(rotationTimerRef.current);
      if (durationTimerRef.current) clearInterval(durationTimerRef.current);
    };
  }, [refreshProcessingStatus]);

  useEffect(() => {
    if (!frameLightbox) {
      return;
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setFrameLightbox(null);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [frameLightbox]);

  const statusToneClass = processingStatus.isProcessing
    ? "tone-processing"
    : isRecording
      ? "tone-live"
      : processingStatus.pendingChunks > 0
        ? "tone-pending"
        : "tone-ready";
  const claudeConfigSnippet = mcpServerPath
    ? JSON.stringify({ mcpServers: { basis: { command: "node", args: [mcpServerPath] } } }, null, 2)
    : "";

  return (
    <div className="app-shell">
      <div className="app-frame content-area">
        <div className="tab-list" role="tablist" aria-label="JustReheat sections">
          <button
            className={`tab-button ${activeTab === "controls" ? "is-active" : ""}`}
            onClick={() => setActiveTab("controls")}
            type="button"
          >
            Controls
          </button>
          <button
            className={`tab-button ${activeTab === "settings" ? "is-active" : ""}`}
            onClick={() => setActiveTab("settings")}
            type="button"
          >
            Settings
          </button>
        </div>

        {banner && (
          <p
            className={`banner ${banner.variant === "success" ? "banner-success" : "banner-error"}`}
          >
            {banner.message}
          </p>
        )}
        {!sckitExclusionsState.initialized && sckitExclusionsState.error && (
          <p className="banner banner-error">
            OS-level exclusions failed to initialize: {sckitExclusionsState.error}
          </p>
        )}
        {activeTab === "controls" && (
          <section className="panel">
            <div className="section-heading">
              <h2 className="section-title">Capture your desktop context</h2>
            </div>

            <div className="control-row">
              <button
                className={`button button-primary ${isRecording ? "button-danger" : ""}`}
                onClick={isRecording ? stopCapture : startCapture}
                type="button"
              >
                {isRecording ? "Stop Recording" : "Start Recording"}
              </button>
              <button
                className="button button-secondary"
                onClick={processNow}
                disabled={processingStatus.pendingChunks === 0 || processingStatus.isProcessing}
                type="button"
              >
                {processNowLabel}
              </button>

              {isRecording && <span className="duration-pill">{formatDuration(duration)}</span>}
            </div>

            <p className="support-copy">
              Capture runs quietly in the background, rotating files automatically so your backlog
              stays searchable and easy to process.
            </p>
          </section>
        )}


        {activeTab === "settings" && (
          <section className="panel panel-form">
            <div className="settings-stack">
              <div className="section-heading">
                <h2 className="section-title">
                  Fireworks API key{" "}
                  <span className="tone-muted">(Important)</span>
                </h2>
              </div>

              <label className="field-label" htmlFor="fireworks-api-key">
                API key
              </label>
              <input
                id="fireworks-api-key"
                className="field-input"
                type="password"
                autoComplete="off"
                spellCheck={false}
                placeholder="Paste key if not using FIREWORKS_API_KEY in the environment"
                value={aiSettings.fireworksApiKey ?? ""}
                onChange={(event) =>
                  setAISettings((current) => ({
                    ...current,
                    fireworksApiKey: event.target.value,
                  }))
                }
              />
              <p className="support-copy">
                Image processing uses Fireworks, which respects a Zero Data Retention policy. Without your
                API key here, JustReheat won't be able to run.
              </p>

              <div className="section-heading">
                <h2 className="section-title">Capture settings</h2>
              </div>

              <label className="field-label" htmlFor="chunk-duration-minutes">
                Chunk duration (minutes)
              </label>
              <input
                id="chunk-duration-minutes"
                className="field-input field-input-small"
                type="number"
                min={1}
                step={1}
                value={chunkDurationMinutes}
                onChange={(event) => {
                  const next = Number(event.target.value);
                  setChunkDurationMinutes(Number.isFinite(next) ? next : 1);
                }}
              />
              <p className="support-copy">
                New recordings rotate every {chunkDurationMinutes || 1} minute
                {Math.abs(chunkDurationMinutes || 1) === 1 ? "" : "s"}. Default is 1 minute.
              </p>

              <div className="section-heading">
                <h2 className="section-title">Privacy &mdash; Excluded Windows</h2>
              </div>
              <p className="support-copy">
                Apps in this list are blocked at the OS level. Their pixels never enter JustReheat.
              </p>
              {exclusions.requires_restart && (
                <div className="banner banner-warning restart-banner">
                  <span>Restart Basis to apply exclusion changes.</span>
                  <button className="button button-secondary" type="button" onClick={() => void contextManager.restartApp()}>
                    Restart Now
                  </button>
                </div>
              )}
              <div className="exclusion-list">
                {exclusions.bundle_ids.map((entry) => (
                  <article key={entry.bundle_id} className="exclusion-row">
                    <div className="exclusion-meta">
                      <div className="exclusion-name">{entry.name}</div>
                      <div className="exclusion-bundle">{entry.bundle_id}</div>
                    </div>
                    <label className="checkbox-row exclusion-toggle">
                      <input
                        type="checkbox"
                        checked={entry.enabled}
                        onChange={(event) => {
                          void toggleExclusion(entry.bundle_id, event.target.checked);
                        }}
                      />
                      <span>{entry.enabled ? "Enabled" : "Disabled"}</span>
                    </label>
                  </article>
                ))}
              </div>
              <div className="button-row">
                <button
                  className="button button-secondary"
                  type="button"
                  onClick={() => setPickerOpen((current) => !current)}
                >
                  {pickerOpen ? "Close App Picker" : "Add App"}
                </button>
              </div>
              {pickerOpen && (
                <div className="exclusion-picker">
                  <div className="exclusion-manual-add">
                    <label className="field-label" htmlFor="manual-bundle-id">
                      Enter bundle ID manually
                    </label>
                    <div className="button-row">
                      <input
                        id="manual-bundle-id"
                        className="field-input"
                        placeholder="com.example.desktop"
                        value={manualBundleId}
                        onChange={(event) => setManualBundleId(event.target.value)}
                      />
                      <button
                        className="button button-secondary"
                        type="button"
                        onClick={() => {
                          const bundleId = manualBundleId.trim();
                          if (!bundleId) {
                            return;
                          }
                          void addExclusion({ bundleId, name: bundleId });
                          setManualBundleId("");
                        }}
                      >
                        Add
                      </button>
                    </div>
                  </div>
                </div>
              )}

              <div className="section-heading">
                <h2 className="section-title">MCP Access (Local stdio)</h2>
              </div>

              <p className="support-copy">
                JustReheat runs as a local stdio MCP server. Connect Claude Desktop (or any MCP client
                on your desktop) directly.
              </p>

              <div className="info-card">
                <div className="info-block">
                  <div className="info-label">MCP Server Path</div>
                  <div className="info-value">{mcpServerPath || "(loading...)"}</div>
                  <button
                    className="button button-ghost"
                    disabled={!mcpServerPath}
                    onClick={() => void copyToClipboard(mcpServerPath)}
                    type="button"
                  >
                    Copy Path
                  </button>
                </div>
                <div className="info-block">
                  <div className="info-label">Claude Desktop Config Snippet</div>
                  <pre className="info-value" style={{ whiteSpace: "pre", fontSize: 11 }}>{claudeConfigSnippet}</pre>
                  <button
                    className="button button-ghost"
                    disabled={!claudeConfigSnippet}
                    onClick={() => void copyToClipboard(claudeConfigSnippet)}
                    type="button"
                  >
                    Copy Config
                  </button>
                </div>
              </div>

              <div>
                <button className="button button-primary" onClick={() => void saveAllSettings()} type="button">
                  Save Settings
                </button>
              </div>
            </div>
          </section>
        )}
      </div>

      <div className="app-status-bar">
        <div className="app-frame">
          <div className="hero-meta">
            <span className={`status-pill ${statusToneClass}`}>{statusLine}</span>
          </div>
        </div>
      </div>

      {frameLightbox ? (
        <div
          className="frame-lightbox-overlay"
          role="presentation"
          onClick={() => setFrameLightbox(null)}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="frame-lightbox-title"
            className="frame-lightbox-dialog"
            onClick={(event) => event.stopPropagation()}
          >
            <button
              type="button"
              className="frame-lightbox-close"
              onClick={() => setFrameLightbox(null)}
              aria-label="Close"
            >
              Close
            </button>
            <img
              className="frame-lightbox-image"
              src={frameLightbox.src}
              alt={frameLightbox.title}
            />
            <p id="frame-lightbox-title" className="frame-lightbox-caption">
              {frameLightbox.title}
            </p>
          </div>
        </div>
      ) : null}
    </div>
  );
}
