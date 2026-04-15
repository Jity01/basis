import { useState, useEffect, useCallback } from "react";

const contextManager = window.contextManager;

type OnboardingProps = {
  onComplete: () => void;
};

type Step = "auth" | "apps" | "ready";
type AuthMode = "signup" | "login";

type AppInfo = {
  name: string;
  installed: boolean;
};

type AppResult = {
  name: string;
  success: boolean;
  error?: string;
};

function formatTunnelStatus(state: { enabled: boolean; status: string; error: string | null }): string {
  if (state.status === "connected") return "connected";
  if (state.status === "starting" || state.status === "reconnecting") return "starting...";
  if (state.error) return state.error;
  if (!state.enabled) return "not available";
  return state.status;
}

const AUTH_API_URL = import.meta.env.VITE_AUTH_API_URL?.trim() || "https://vizlog-auth.vizlog.workers.dev";

export default function Onboarding({ onComplete }: OnboardingProps) {
  const [step, setStep] = useState<Step>("auth");
  const [authMode, setAuthMode] = useState<AuthMode>("signup");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [authError, setAuthError] = useState<string | null>(null);
  const [authLoading, setAuthLoading] = useState(false);
  // Keep token input as fallback
  const [showTokenInput, setShowTokenInput] = useState(false);
  const [token, setToken] = useState("");
  const [tokenError, setTokenError] = useState<string | null>(null);
  const [savingToken, setSavingToken] = useState(false);

  const [apps, setApps] = useState<AppInfo[]>([]);
  const [detectingApps, setDetectingApps] = useState(false);
  const [connectingApps, setConnectingApps] = useState(false);
  const [appResults, setAppResults] = useState<AppResult[]>([]);

  const [tunnelStatus, setTunnelStatus] = useState<string>("starting...");
  const [startingRecording, setStartingRecording] = useState(false);

  // Step 1: Validate and save token
  const handleContinue = useCallback(async () => {
    const trimmed = token.trim();
    if (!trimmed) {
      setTokenError("Please paste your auth token.");
      return;
    }
    if (!trimmed.startsWith("jr_")) {
      setTokenError("Token must start with \"jr_\". Check your dashboard and try again.");
      return;
    }
    setTokenError(null);
    setSavingToken(true);
    try {
      const result = await contextManager.saveCredentials({ authToken: trimmed });
      if (!result.success) {
        setTokenError("Failed to save token. Please try again.");
        setSavingToken(false);
        return;
      }
      const provision = await contextManager.provisionTunnel();
      if (!provision.success && provision.error) {
        setTokenError(provision.error);
      }
      setStep("apps");
    } catch (err) {
      setTokenError(
        err instanceof Error ? err.message : "Failed to save token. Please try again."
      );
    } finally {
      setSavingToken(false);
    }
  }, [token]);

  // Step 1b: Sign up or log in via auth API
  const handleAuth = useCallback(async () => {
    if (!email.trim()) {
      setAuthError("Please enter your email.");
      return;
    }
    if (!email.includes("@")) {
      setAuthError("Please enter a valid email.");
      return;
    }
    if (password.length < 8) {
      setAuthError("Password must be at least 8 characters.");
      return;
    }
    setAuthError(null);
    setAuthLoading(true);

    const endpoint = authMode === "signup" ? "/auth/signup" : "/auth/login";

    try {
      const res = await fetch(`${AUTH_API_URL}${endpoint}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: email.trim(), password }),
      });

      let data: { error?: string; authToken?: string; email?: string; tunnelId?: string } = {};
      try {
        data = (await res.json()) as { error?: string; authToken?: string; email?: string; tunnelId?: string };
      } catch {
        // Keep default empty payload for non-JSON responses.
      }

      if (!res.ok) {
        setAuthError(data.error || `${authMode === "signup" ? "Sign up" : "Login"} failed.`);
        setAuthLoading(false);
        return;
      }
      if (!data.authToken) {
        setAuthError("Auth service response was missing an auth token.");
        setAuthLoading(false);
        return;
      }

      const authToken = data.authToken;

      // Save the token
      await contextManager.saveCredentials({
        authToken,
        accountEmail: data.email,
        tunnelId: data.tunnelId,
      });

      const provision = await contextManager.provisionTunnel();
      if (!provision.success && provision.error) {
        setAuthError(provision.error);
      }

      setStep("apps");
    } catch {
      setAuthError(`Could not reach auth service at ${AUTH_API_URL}.`);
    } finally {
      setAuthLoading(false);
    }
  }, [email, password, authMode]);

  // Step 2: Detect installed apps
  useEffect(() => {
    if (step !== "apps") return;
    let cancelled = false;
    setDetectingApps(true);

    const autoConfigureApps = async (): Promise<void> => {
      const knownApps = ["Claude Desktop", "Cursor", "Claude Code"];

      let appList: AppInfo[];
      try {
        const detected = await contextManager.detectMcpApps();
        appList = knownApps.map((name) => ({
          name,
          installed: detected.includes(name),
        }));
      } catch {
        appList = knownApps.map((name) => ({ name, installed: false }));
      }

      if (cancelled) return;
      setApps(appList);
      setDetectingApps(false);

      const selected = appList.filter((app) => app.installed).map((app) => app.name);
      if (selected.length === 0) {
        setAppResults([]);
        setStep("ready");
        return;
      }

      setConnectingApps(true);
      try {
        const results = await contextManager.registerMcpApps(selected);
        if (cancelled) return;
        const resultList: AppResult[] = selected.map((name) => ({
          name,
          success: results[name]?.success ?? false,
          error: results[name]?.error,
        }));
        setAppResults(resultList);
      } catch {
        if (cancelled) return;
        setAppResults(selected.map((name) => ({ name, success: false, error: "Automatic setup failed" })));
      } finally {
        if (!cancelled) {
          setConnectingApps(false);
          setStep("ready");
        }
      }
    };

    void autoConfigureApps();

    return () => {
      cancelled = true;
    };
  }, [step]);

  // Step 3: Start tunnel on mount
  useEffect(() => {
    if (step !== "ready") return;
    let cancelled = false;
    setTunnelStatus("starting...");

    const unsubscribe = contextManager.onTunnelState((state) => {
      if (cancelled) return;
      setTunnelStatus(formatTunnelStatus(state));
    });

    contextManager
      .startTunnel()
      .then((result) => {
        if (cancelled) return;
        setTunnelStatus(formatTunnelStatus(result));
      })
      .catch(() => {
        if (!cancelled) setTunnelStatus("not available");
      });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [step]);

  const handleStartRecording = useCallback(async () => {
    setStartingRecording(true);
    try {
      await contextManager.startRecording();
    } catch {
      // Recording will be handled by the main app
    }
    onComplete();
  }, [onComplete]);

  const connectedCount = appResults.filter((r) => r.success).length;

  return (
    <div className="onboarding-shell">
      <div className="onboarding-container">
        {/* Progress indicator */}
        <div className="onboarding-progress">
          <div className={`onboarding-dot ${step === "auth" ? "is-active" : "is-done"}`} />
          <div className="onboarding-progress-line" />
          <div className={`onboarding-dot ${step === "apps" ? "is-active" : step === "ready" ? "is-done" : ""}`} />
          <div className="onboarding-progress-line" />
          <div className={`onboarding-dot ${step === "ready" ? "is-active" : ""}`} />
        </div>

        {/* Step 1: Welcome + Auth */}
        {step === "auth" && (
          <div className="onboarding-step">
            <h1 className="onboarding-title">Welcome to Vizlog</h1>
            <p className="onboarding-subtitle">
              Your screen, your memory.<br />
              Data stays on your machine — we only process frames with zero-day retention.
            </p>

            {!showTokenInput ? (
              <>
                {/* Auth mode tabs */}
                <div className="onboarding-auth-tabs">
                  <button
                    className={`onboarding-auth-tab ${authMode === "signup" ? "is-active" : ""}`}
                    onClick={() => { setAuthMode("signup"); setAuthError(null); }}
                    type="button"
                  >
                    Sign Up
                  </button>
                  <button
                    className={`onboarding-auth-tab ${authMode === "login" ? "is-active" : ""}`}
                    onClick={() => { setAuthMode("login"); setAuthError(null); }}
                    type="button"
                  >
                    Log In
                  </button>
                </div>

                <label className="onboarding-label" htmlFor="onboarding-email">
                  Email
                </label>
                <input
                  id="onboarding-email"
                  className="field-input onboarding-token-input"
                  type="email"
                  autoComplete="email"
                  placeholder="you@example.com"
                  value={email}
                  onChange={(e) => { setEmail(e.target.value); if (authError) setAuthError(null); }}
                  onKeyDown={(e) => { if (e.key === "Enter") document.getElementById("onboarding-password")?.focus(); }}
                />

                <label className="onboarding-label" htmlFor="onboarding-password">
                  Password
                </label>
                <input
                  id="onboarding-password"
                  className="field-input onboarding-token-input"
                  type="password"
                  autoComplete={authMode === "signup" ? "new-password" : "current-password"}
                  placeholder="At least 8 characters"
                  value={password}
                  onChange={(e) => { setPassword(e.target.value); if (authError) setAuthError(null); }}
                  onKeyDown={(e) => { if (e.key === "Enter") void handleAuth(); }}
                />

                {authError && <p className="onboarding-error">{authError}</p>}

                <button
                  className="button button-primary onboarding-continue-button"
                  onClick={() => void handleAuth()}
                  disabled={authLoading}
                  type="button"
                >
                  {authLoading
                    ? authMode === "signup" ? "Creating account..." : "Logging in..."
                    : authMode === "signup" ? "Create Account" : "Log In"}
                </button>

                <button
                  className="button button-ghost onboarding-skip-button"
                  onClick={() => setShowTokenInput(true)}
                  type="button"
                >
                  Have a token? Paste it instead
                </button>
              </>
            ) : (
              <>
                <label className="onboarding-label" htmlFor="onboarding-token">
                  Paste your auth token
                </label>
                <input
                  id="onboarding-token"
                  className="field-input onboarding-token-input"
                  type="text"
                  autoComplete="off"
                  spellCheck={false}
                  placeholder="jr_..."
                  value={token}
                  onChange={(e) => {
                    setToken(e.target.value);
                    if (tokenError) setTokenError(null);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") void handleContinue();
                  }}
                />
                {tokenError && <p className="onboarding-error">{tokenError}</p>}

                <button
                  className="button button-primary onboarding-continue-button"
                  onClick={() => void handleContinue()}
                  disabled={savingToken}
                  type="button"
                >
                  {savingToken ? "Saving..." : "Continue"}
                </button>

                <button
                  className="button button-ghost onboarding-skip-button"
                  onClick={() => setShowTokenInput(false)}
                  type="button"
                >
                  Back to sign up
                </button>
              </>
            )}
          </div>
        )}

        {/* Step 2: Connect AI Apps */}
        {step === "apps" && (
          <div className="onboarding-step">
            <h1 className="onboarding-title">Configuring your AI apps</h1>
            <p className="onboarding-subtitle">
              Vizlog is auto-configuring supported desktop clients.
            </p>

            {detectingApps ? (
              <p className="onboarding-hint">Detecting installed apps...</p>
            ) : (
              <div className="onboarding-app-list">
                {apps.map((app) => (
                  <div
                    key={app.name}
                    className={`onboarding-app-row ${!app.installed ? "is-disabled" : ""}`}
                  >
                    <span className="onboarding-app-name">{app.name}</span>
                    <span className="onboarding-app-badge">
                      {!app.installed ? "not installed" : connectingApps ? "configuring" : "configured"}
                    </span>
                  </div>
                ))}
              </div>
            )}
            {(detectingApps || connectingApps) && <p className="onboarding-hint">Finalizing setup...</p>}
          </div>
        )}

        {/* Step 3: Ready */}
        {step === "ready" && (
          <div className="onboarding-step">
            <h1 className="onboarding-title">You're all set!</h1>

            <div className="onboarding-status-list">
              <div className="onboarding-status-row">
                <span className="onboarding-status-icon is-success" />
                <span>Token saved</span>
              </div>
              {connectedCount > 0 && (
                <div className="onboarding-status-row">
                  <span className="onboarding-status-icon is-success" />
                  <span>
                    {connectedCount} AI app{connectedCount === 1 ? "" : "s"} connected
                  </span>
                </div>
              )}
              {appResults.some((r) => !r.success) && (
                <div className="onboarding-status-row">
                  <span className="onboarding-status-icon is-error" />
                  <span>
                    {appResults.filter((r) => !r.success).length} app
                    {appResults.filter((r) => !r.success).length === 1 ? "" : "s"} failed to connect
                  </span>
                </div>
              )}
              <div className="onboarding-status-row">
                <span
                  className={`onboarding-status-icon ${
                    tunnelStatus === "connected"
                      ? "is-success"
                      : tunnelStatus === "starting..."
                        ? "is-pending"
                        : "is-error"
                  }`}
                />
                <span>
                  Tunnel{" "}
                  {tunnelStatus === "connected"
                    ? "connected"
                    : tunnelStatus === "starting..."
                      ? "starting..."
                      : tunnelStatus}
                </span>
              </div>
            </div>

            <button
              className="button button-primary onboarding-continue-button"
              onClick={() => void handleStartRecording()}
              disabled={startingRecording}
              type="button"
            >
              {startingRecording ? "Starting..." : "Start Recording"}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
