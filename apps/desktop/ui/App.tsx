import { useState, useEffect, useRef, useCallback } from "react";

const contextManager = window.contextManager;

type ProcessingStatus = {
  isProcessing: boolean;
  currentChunk: number;
  totalChunks: number;
  pendingChunks: number;
  visiblePendingChunks: number;
  activeRecordingChunk: boolean;
  trigger: "idle" | "manual" | "live" | null;
};

type AISettings = {
  provider: "fireworks" | "local";
  localBaseUrl: string;
  localTaggingModel: string;
  fireworksApiKey?: string;
};

type TabId = "controls" | "network" | "settings";

const fallbackAISettings: AISettings = {
  provider: "fireworks",
  localBaseUrl: "http://127.0.0.1:11434/v1",
  localTaggingModel: "llava:7b",
};

export default function App() {
  const [activeTab, setActiveTab] = useState<TabId>("controls");
  const [isRecording, setIsRecording] = useState(false);
  const [duration, setDuration] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [processingStatus, setProcessingStatus] = useState<ProcessingStatus>({
    isProcessing: false,
    currentChunk: 0,
    totalChunks: 0,
    pendingChunks: 0,
    visiblePendingChunks: 0,
    activeRecordingChunk: false,
    trigger: null,
  });
  const [aiSettings, setAISettings] = useState<AISettings>(fallbackAISettings);
  const [chunkDurationMinutes, setChunkDurationMinutes] = useState(5);
  const [settingsNotice, setSettingsNotice] = useState<string | null>(null);
  const [tailscaleStatus, setTailscaleStatus] = useState<TailscaleStatus | null>(null);

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
          setError(err instanceof Error ? err.message : "Failed to read recorded chunk");
        })
        .finally(() => {
          pendingChunkSendsRef.current.delete(sendPromise);
        });
      pendingChunkSendsRef.current.add(sendPromise);
    };

    recorder.onerror = (event) => {
      const maybeError = (event as unknown as { error?: Error }).error;
      setError(maybeError?.message ?? "MediaRecorder error");
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
      setError(null);
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
            setError(err instanceof Error ? err.message : "Failed rotating recorder");
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
      setError(err instanceof Error ? err.message : "Failed to start recording");
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
          setError(err instanceof Error ? err.message : "Failed to stop recording");
        }
      };
      mediaRecorderRef.current.stop();
    } else {
      try {
        await finalizeStop();
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to stop recording");
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
      setError(null);
      const result = await contextManager.processNow();
      if (!result.started) {
        await refreshProcessingStatus();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to process backlog");
    }
  }, [refreshProcessingStatus]);

  const saveAISettings = useCallback(async () => {
    try {
      setError(null);
      const updated = await contextManager.updateAISettings(aiSettings);
      setAISettings(updated);
      setSettingsNotice("AI settings saved.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save AI settings");
    }
  }, [aiSettings]);

  const saveChunkSettings = useCallback(async () => {
    try {
      setError(null);
      const updated = await contextManager.updateChunkSettings({
        chunkDurationMinutes: Math.max(1, Math.round(chunkDurationMinutes)),
      });
      setChunkDurationMinutes(updated.chunkDurationMinutes);
      setSettingsNotice("Capture settings saved.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save capture settings");
    }
  }, [chunkDurationMinutes]);

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

  const isLocalProvider = aiSettings.provider === "local";
  const statusToneClass = processingStatus.isProcessing
    ? "tone-processing"
    : isRecording
      ? "tone-live"
      : processingStatus.pendingChunks > 0
        ? "tone-pending"
        : "tone-ready";

  useEffect(() => {
    if (!contextManager) {
      return;
    }

    void refreshProcessingStatus();
    void contextManager.getChunkSettings().then((settings) => {
      setChunkDurationMinutes(settings.chunkDurationMinutes);
    });
    void contextManager.getAISettings().then((settings) => {
      setAISettings(settings);
    });

    const unsubscribeProcessing = contextManager.onProcessingStatus((status) => {
      setProcessingStatus(status);
    });

    void contextManager.getTailscaleStatus().then(setTailscaleStatus);
    const unsubscribeTailscale = contextManager.onTailscaleStatus(setTailscaleStatus);

    return () => {
      unsubscribeProcessing();
      unsubscribeTailscale();
      if (rotationTimerRef.current) clearInterval(rotationTimerRef.current);
      if (durationTimerRef.current) clearInterval(durationTimerRef.current);
    };
  }, [refreshProcessingStatus]);

  return (
    <div className="app-shell">
      <div className="app-frame content-area">
        <div className="tab-list" role="tablist" aria-label="Context manager sections">
          <button
            className={`tab-button ${activeTab === "controls" ? "is-active" : ""}`}
            onClick={() => setActiveTab("controls")}
            type="button"
          >
            Controls
          </button>
          <button
            className={`tab-button ${activeTab === "network" ? "is-active" : ""}`}
            onClick={() => setActiveTab("network")}
            type="button"
          >
            Network
          </button>
          <button
            className={`tab-button ${activeTab === "settings" ? "is-active" : ""}`}
            onClick={() => setActiveTab("settings")}
            type="button"
          >
            Settings
          </button>
        </div>

        {error && <p className="banner banner-error">{error}</p>}
        {settingsNotice && <p className="banner banner-info">{settingsNotice}</p>}

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

        {activeTab === "network" && (
          <section className="panel">
            <div className="section-heading">
              <h2 className="section-title">Network access</h2>
            </div>

            {!tailscaleStatus && (
              <p className="support-copy">Checking Tailscale status...</p>
            )}

            {tailscaleStatus && !tailscaleStatus.installed && (
              <div className="info-card">
                <p className="banner banner-warning">
                  Tailscale is not installed. Install it from tailscale.com to share your context
                  data with remote machines.
                </p>
              </div>
            )}

            {tailscaleStatus && tailscaleStatus.installed && !tailscaleStatus.running && (
              <div className="info-card">
                <div className="info-block">
                  <div className="info-label">Status</div>
                  <div className="info-value">Tailscale is off</div>
                </div>
                <p className="support-copy">
                  Start Tailscale from the menu bar to make your context accessible to remote machines.
                </p>
              </div>
            )}

            {tailscaleStatus && tailscaleStatus.running && (
              <>
                <div className="info-card">
                  <div className="info-block">
                    <div className="info-label">Hostname</div>
                    <div className="info-value">{tailscaleStatus.hostname || "unknown"}</div>
                  </div>
                  <div className="info-block">
                    <div className="info-label">Tailscale IP</div>
                    <div className="info-value">{tailscaleStatus.tailscaleIp || "unknown"}</div>
                  </div>
                </div>

                <div className="section-heading">
                  <h2 className="section-title">
                    Peers ({tailscaleStatus.peers.filter((p) => p.online).length} online)
                  </h2>
                </div>

                {tailscaleStatus.peers.length === 0 ? (
                  <p className="support-copy">No peers on your Tailscale network.</p>
                ) : (
                  <div className="peer-list">
                    {tailscaleStatus.peers.map((peer) => (
                      <div key={peer.tailscaleIp} className="peer-row">
                        <span
                          className={`peer-indicator ${peer.online ? "is-online" : "is-offline"}`}
                        />
                        <div className="peer-info">
                          <div className="peer-hostname">{peer.hostname}</div>
                          <div className="peer-detail">
                            {peer.tailscaleIp} &middot; {peer.os}
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}

                {tailscaleStatus.tailscaleIp && (
                  <>
                    <div className="section-heading">
                      <h2 className="section-title">Mount command</h2>
                    </div>
                    <p className="support-copy">
                      Run this on your EC2 instance to mount your context directory (read-only):
                    </p>
                    <div className="mount-command">
                      <code>
                        sshfs $USER@{tailscaleStatus.tailscaleIp}:~/.context /mnt/context -o
                        ro,reconnect
                      </code>
                      <button
                        className="button button-ghost copy-button"
                        onClick={() => {
                          void navigator.clipboard.writeText(
                            `sshfs $USER@${tailscaleStatus.tailscaleIp}:~/.context /mnt/context -o ro,reconnect`
                          );
                        }}
                        type="button"
                      >
                        Copy
                      </button>
                    </div>
                  </>
                )}
              </>
            )}
          </section>
        )}

        {activeTab === "settings" && (
          <section className="panel panel-form">
            <div className="settings-stack">
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
                  setChunkDurationMinutes(Number.isFinite(next) ? next : 5);
                }}
              />
              <p className="support-copy">
                New recordings rotate every {chunkDurationMinutes || 5} minute
                {Math.abs(chunkDurationMinutes || 5) === 1 ? "" : "s"}. Default is 5 minutes.
              </p>

              <div className="section-heading">
                <h2 className="section-title">AI settings</h2>
              </div>

              <label className="field-label" htmlFor="provider">
                Provider
              </label>
              <select
                id="provider"
                className="field-input"
                value={aiSettings.provider}
                onChange={(event) =>
                  setAISettings((current) => ({
                    ...current,
                    provider: event.target.value === "local" ? "local" : "fireworks",
                  }))
                }
              >
                <option value="fireworks">Fireworks</option>
                <option value="local">Local (Ollama)</option>
              </select>
              {!isLocalProvider && (
                <>
                  <label className="field-label" htmlFor="fireworks-api-key">
                    Fireworks API key
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
                    Tagging uses <code>FIREWORKS_API_KEY</code> when set; otherwise the key above
                    (saved in <code>ai-settings.json</code>). Optional env: <code>FIREWORKS_MODEL</code>,{" "}
                    <code>FIREWORKS_BASE_URL</code>.
                  </p>
                </>
              )}
              {isLocalProvider && (
                <>
                  <label className="field-label" htmlFor="ollama-base-url">
                    Ollama base URL
                  </label>
                  <input
                    id="ollama-base-url"
                    className="field-input"
                    type="text"
                    value={aiSettings.localBaseUrl}
                    onChange={(event) =>
                      setAISettings((current) => ({
                        ...current,
                        localBaseUrl: event.target.value,
                      }))
                    }
                  />
                  <label className="field-label" htmlFor="ollama-tagging-model">
                    Local tagging model
                  </label>
                  <input
                    id="ollama-tagging-model"
                    className="field-input"
                    type="text"
                    value={aiSettings.localTaggingModel}
                    onChange={(event) =>
                      setAISettings((current) => ({
                        ...current,
                        localTaggingModel: event.target.value,
                      }))
                    }
                  />
                  <p className="support-copy">
                    Use Ollama&apos;s OpenAI-compatible endpoint. If you enter{" "}
                    <code>http://127.0.0.1:11434</code>, the app will automatically normalize it to{" "}
                    <code>/v1</code>.
                  </p>
                </>
              )}

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
            {tailscaleStatus?.running && (
              <span
                className={`status-pill ${
                  tailscaleStatus.peers.some((p) => p.online) ? "tone-ready" : "tone-muted"
                }`}
              >
                TS: {tailscaleStatus.peers.filter((p) => p.online).length} peer
                {tailscaleStatus.peers.filter((p) => p.online).length === 1 ? "" : "s"}
              </span>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
