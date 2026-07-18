import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { Store } from "@tauri-apps/plugin-store";
import {
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Copy,
  ExternalLink,
  FileText,
  LoaderCircle,
  ShieldCheck,
  Terminal,
  UploadCloud,
  XCircle,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  WclActivityGroup,
  StartWclLiveUploadPayload,
  StartWclUploadPayload,
  useWclUpload,
} from "../../contexts/WclUploadContext";
import { useSettings } from "../../contexts/SettingsContext";
import { getErrorMessage } from "../../services/tauri";
import { SettingsSection } from "../settings/SettingsSection";
import { SettingsSelect, type SettingsSelectOption } from "../settings/SettingsSelect";
import { Button } from "../ui/Button";
import { FormField } from "../ui/FormField";
import { Input } from "../ui/Input";
import { WclActivitySelectionModal } from "./WclActivitySelectionModal";

interface WclGuild {
  id: number;
  name: string;
}

interface FetchWclGuildsResponse {
  email: string;
  guilds: WclGuild[];
}

interface WclAuthStatus {
  status: "signedOut" | "authenticated";
  authenticatedEmail: string | null;
  userName: string | null;
  savedEmail: string | null;
  hasAnySavedCredentials: boolean;
  hasSavedCredentialsForEmail: boolean;
}

interface LoginFeedback {
  tone: "success" | "error";
  message: string;
}

const REGION_OPTIONS: SettingsSelectOption[] = [
  { value: "1", label: "US" },
  { value: "2", label: "EU" },
  { value: "3", label: "KR" },
  { value: "4", label: "TW" },
  { value: "5", label: "CN" },
];

const VISIBILITY_OPTIONS: SettingsSelectOption[] = [
  { value: "0", label: "Public" },
  { value: "1", label: "Private" },
  { value: "2", label: "Unlisted" },
];

const GUILD_NONE_OPTION: SettingsSelectOption = {
  value: "none",
  label: "No guild (personal upload)",
};

const WCL_UI_STORE_FILE = "settings.json";
const WCL_REMEMBER_LOGIN_KEY = "wcl-remember-login-preference";
const WCL_INCLUDE_EXISTING_KEY = "wcl-live-include-existing-preference";

const FIELD_IDS = {
  email: "wcl-email",
  password: "wcl-password",
  description: "wcl-description",
  region: "wcl-region",
  visibility: "wcl-visibility",
  guildSelection: "wcl-guild-selection",
  rememberLogin: "wcl-remember-login",
  logFilePath: "wcl-log-file-path",
} as const;

export function WarcraftLogsUploadPage() {
  const { settings } = useSettings();
  const {
    isUploading,
    isLiveUploading,
    progressPercent,
    progressStatus,
    progressLines,
    scanPercent,
    scanStatus,
    errorMessage,
    reportUrl,
    setWclError,
    clearProgress,
    startUpload,
    scanLog,
    cancelScan,
    validateUploadScan,
    cancelUpload,
    startLiveUpload,
    stopLiveUpload,
  } = useWclUpload();

  const [logFilePath, setLogFilePath] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [useSavedLogin, setUseSavedLogin] = useState(false);
  const [rememberLogin, setRememberLogin] = useState(false);
  const [savedLoginEmail, setSavedLoginEmail] = useState<string | null>(null);
  const [hasAnySavedCredentials, setHasAnySavedCredentials] = useState(false);
  const [hasSavedCredentialsForCurrentEmail, setHasSavedCredentialsForCurrentEmail] =
    useState(false);
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [authenticatedUserName, setAuthenticatedUserName] = useState<string | null>(null);
  const [description, setDescription] = useState("");
  const [region, setRegion] = useState("2");
  const [visibility, setVisibility] = useState("0");
  const [guildOptions, setGuildOptions] = useState<WclGuild[]>([]);
  const [selectedGuildId, setSelectedGuildId] = useState("none");
  const [isLoggingIn, setIsLoggingIn] = useState(false);
  const [isLoadingGuilds, setIsLoadingGuilds] = useState(false);
  const [hasAutoLoadedGuilds, setHasAutoLoadedGuilds] = useState(false);
  const [isAuthStatusLoaded, setIsAuthStatusLoaded] = useState(false);
  const [loginFeedback, setLoginFeedback] = useState<LoginFeedback | null>(null);
  const [isResolvingLatestLog, setIsResolvingLatestLog] = useState(false);
  const [isConsoleExpanded, setIsConsoleExpanded] = useState(true);
  const [preferencesStore, setPreferencesStore] = useState<Store | null>(null);
  const [isRememberLoginPreferenceLoaded, setIsRememberLoginPreferenceLoaded] = useState(false);
  const [includeExistingContents, setIncludeExistingContents] = useState(false);
  const [isLivePreferenceLoaded, setIsLivePreferenceLoaded] = useState(false);
  const [isActivityModalOpen, setIsActivityModalOpen] = useState(false);
  const [isScanningActivities, setIsScanningActivities] = useState(false);
  const [scanError, setScanError] = useState<string | null>(null);
  const [scanResult, setScanResult] = useState<{
    scanId: string;
    groups: WclActivityGroup[];
  } | null>(null);
  const [selectedActivityIds, setSelectedActivityIds] = useState<Set<string>>(new Set());
  const lastAuthStatusEmailRef = useRef("");

  const isAuthBusy = isLoggingIn || isLoadingGuilds;

  const hasLoginInput =
    email.trim().length > 0 &&
    (password.trim().length > 0 || (useSavedLogin && hasSavedCredentialsForCurrentEmail));
  const hasAuthenticatedSession = isAuthenticated && email.trim().length > 0;

  useEffect(() => {
    let mounted = true;

    const loadPreferencesStore = async () => {
      try {
        const store = await Store.load(WCL_UI_STORE_FILE);
        if (!mounted) {
          return;
        }

        setPreferencesStore(store);
      } catch (error) {
        if (mounted) {
          setIsRememberLoginPreferenceLoaded(true);
        }
        console.error("Failed to load WarcraftLogs UI preferences store:", error);
      }
    };

    void loadPreferencesStore();

    return () => {
      mounted = false;
    };
  }, []);

  useEffect(() => {
    if (!preferencesStore) {
      return;
    }

    let mounted = true;

    const loadRememberLoginPreference = async () => {
      try {
        const savedPreference = await preferencesStore.get<boolean>(WCL_REMEMBER_LOGIN_KEY);
        if (mounted && typeof savedPreference === "boolean") {
          setRememberLogin(savedPreference);
        }
        const savedLivePreference = await preferencesStore.get<boolean>(WCL_INCLUDE_EXISTING_KEY);
        if (mounted && typeof savedLivePreference === "boolean") {
          setIncludeExistingContents(savedLivePreference);
        }
      } catch (error) {
        console.error("Failed to load WarcraftLogs remember-login preference:", error);
      } finally {
        if (mounted) {
          setIsRememberLoginPreferenceLoaded(true);
          setIsLivePreferenceLoaded(true);
        }
      }
    };

    void loadRememberLoginPreference();

    return () => {
      mounted = false;
    };
  }, [preferencesStore]);

  useEffect(() => {
    if (!preferencesStore || !isRememberLoginPreferenceLoaded) {
      return;
    }

    const persistRememberLoginPreference = async () => {
      try {
        await preferencesStore.set(WCL_REMEMBER_LOGIN_KEY, rememberLogin);
        await preferencesStore.save();
      } catch (error) {
        console.error("Failed to persist WarcraftLogs remember-login preference:", error);
      }
    };

    void persistRememberLoginPreference();
  }, [isRememberLoginPreferenceLoaded, preferencesStore, rememberLogin]);

  useEffect(() => {
    if (!preferencesStore || !isLivePreferenceLoaded) {
      return;
    }

    const persistLivePreference = async () => {
      try {
        await preferencesStore.set(WCL_INCLUDE_EXISTING_KEY, includeExistingContents);
        await preferencesStore.save();
      } catch (error) {
        console.error("Failed to persist WarcraftLogs live backfill preference:", error);
      }
    };

    void persistLivePreference();
  }, [includeExistingContents, isLivePreferenceLoaded, preferencesStore]);

  const refreshAuthStatus = useCallback(
    async (emailToCheck?: string): Promise<WclAuthStatus> => {
      const trimmedEmail = (emailToCheck ?? email).trim();

      if (!trimmedEmail) {
        return invoke<WclAuthStatus>("get_wcl_auth_status");
      }

      return invoke<WclAuthStatus>("get_wcl_auth_status", {
        request: { email: trimmedEmail },
      });
    },
    [email],
  );

  const applyAuthStatus = useCallback((status: WclAuthStatus) => {
    setIsAuthenticated(status.status === "authenticated");
    setAuthenticatedUserName(status.userName);
    setSavedLoginEmail(status.savedEmail);
    setHasAnySavedCredentials(status.hasAnySavedCredentials);
    setHasSavedCredentialsForCurrentEmail(status.hasSavedCredentialsForEmail);
  }, []);

  useEffect(() => {
    let mounted = true;

    const loadAuthState = async () => {
      try {
        let authStatus = await invoke<WclAuthStatus>("get_wcl_auth_status");
        if (authStatus.status === "signedOut" && authStatus.hasAnySavedCredentials) {
          authStatus = await invoke<WclAuthStatus>("restore_wcl_session");
        }
        if (!mounted) {
          return;
        }

        applyAuthStatus(authStatus);
        const accountEmail = authStatus.authenticatedEmail ?? authStatus.savedEmail;
        if (accountEmail) {
          lastAuthStatusEmailRef.current = accountEmail;
          setEmail((current) => (current.trim().length > 0 ? current : accountEmail));
          setUseSavedLogin(authStatus.hasSavedCredentialsForEmail);
        } else {
          setUseSavedLogin(false);
        }
      } catch (error) {
        if (mounted) {
          setWclError(getErrorMessage(error));
        }
      } finally {
        if (mounted) {
          setIsAuthStatusLoaded(true);
        }
      }
    };

    void loadAuthState();

    return () => {
      mounted = false;
    };
  }, [applyAuthStatus, setWclError]);

  useEffect(() => {
    if (!isAuthStatusLoaded) {
      return;
    }

    const trimmedEmail = email.trim();
    if (!trimmedEmail) {
      setHasSavedCredentialsForCurrentEmail(false);
      if (useSavedLogin) {
        setUseSavedLogin(false);
      }
      return;
    }

    if (lastAuthStatusEmailRef.current === trimmedEmail) {
      return;
    }

    let mounted = true;
    const syncAuthStatus = async () => {
      try {
        const status = await refreshAuthStatus(trimmedEmail);
        if (!mounted) {
          return;
        }

        lastAuthStatusEmailRef.current = trimmedEmail;
        applyAuthStatus(status);
        if (useSavedLogin && !status.hasSavedCredentialsForEmail) {
          setUseSavedLogin(false);
        }
      } catch {
        // keep current auth status on refresh failure
      }
    };

    void syncAuthStatus();

    return () => {
      mounted = false;
    };
  }, [applyAuthStatus, email, isAuthStatusLoaded, refreshAuthStatus, useSavedLogin]);

  const canStartUpload = useMemo(() => {
    return (
      !isUploading &&
      !isLiveUploading &&
      !isScanningActivities &&
      !isAuthBusy &&
      logFilePath.trim().length > 0 &&
      hasAuthenticatedSession
    );
  }, [hasAuthenticatedSession, isAuthBusy, isLiveUploading, isScanningActivities, isUploading, logFilePath]);

  const canLogin = useMemo(() => {
    return !isUploading && !isLiveUploading && !isAuthBusy && hasLoginInput;
  }, [hasLoginInput, isAuthBusy, isLiveUploading, isUploading]);

  const canLoadGuilds = useMemo(() => {
    return !isUploading && !isLiveUploading && !isAuthBusy && hasAuthenticatedSession;
  }, [hasAuthenticatedSession, isAuthBusy, isLiveUploading, isUploading]);

  const canStartLiveUpload = useMemo(() => {
    return !isUploading && !isLiveUploading && !isAuthBusy && hasAuthenticatedSession;
  }, [hasAuthenticatedSession, isAuthBusy, isLiveUploading, isUploading]);

  const progressBarTheme = errorMessage ? "bg-rose-400/90" : "bg-emerald-400/85";

  const resolveGuildRequest = useCallback(() => {
    const trimmedEmail = email.trim();
    const trimmedPassword = password.trim();
    return {
      email: trimmedEmail,
      password: trimmedPassword ? trimmedPassword : null,
      useSavedLogin,
      rememberLogin,
    };
  }, [email, password, rememberLogin, useSavedLogin]);

  const ensureSavedLoginAvailable = useCallback(
    async (emailToCheck: string) => {
      const status = await refreshAuthStatus(emailToCheck);
      lastAuthStatusEmailRef.current = emailToCheck;
      applyAuthStatus(status);
      if (status.hasSavedCredentialsForEmail) {
        return { canUseSavedLogin: true as const, message: null };
      }

      setUseSavedLogin(false);
      let message: string;
      if (status.savedEmail) {
        message = `Saved login is available for ${status.savedEmail}. Enter your password for ${emailToCheck}.`;
      } else {
        message = "No saved WarcraftLogs login is available. Enter your password to continue.";
      }

      setWclError(message);

      return { canUseSavedLogin: false as const, message };
    },
    [applyAuthStatus, refreshAuthStatus, setWclError],
  );

  const loadGuilds = useCallback(
    async () => {
      const response = await invoke<FetchWclGuildsResponse>("fetch_wcl_guilds");
      setEmail(response.email);
      setGuildOptions(response.guilds);

      const authStatus = await refreshAuthStatus(response.email);
      lastAuthStatusEmailRef.current = response.email;
      applyAuthStatus(authStatus);

      if (authStatus.hasSavedCredentialsForEmail) {
        setUseSavedLogin(true);
      }

      return response.guilds.length;
    },
    [applyAuthStatus, refreshAuthStatus],
  );

  const handleRefreshGuilds = useCallback(async () => {
    if (!canLoadGuilds) {
      return;
    }

    setWclError(null);

    try {
      setIsLoadingGuilds(true);
      await loadGuilds();
      setHasAutoLoadedGuilds(true);
    } catch (error) {
      setWclError(getErrorMessage(error));
    } finally {
      setIsLoadingGuilds(false);
    }
  }, [canLoadGuilds, loadGuilds, setWclError]);

  const handleLogin = useCallback(async () => {
    if (!canLogin) {
      return;
    }

    const request = resolveGuildRequest();
    setWclError(null);
    setLoginFeedback(null);
    setIsLoggingIn(true);
    let didLoginSucceed = false;

    try {
      if (!request.password && request.useSavedLogin) {
        const { canUseSavedLogin, message } = await ensureSavedLoginAvailable(request.email);
        if (!canUseSavedLogin) {
          if (message) {
            setLoginFeedback({ tone: "error", message });
          }
          return;
        }
      }

      const authStatus = await invoke<WclAuthStatus>("login_wcl", { request });
      didLoginSucceed = true;
      setPassword("");
      applyAuthStatus(authStatus);
      const authenticatedEmail = authStatus.authenticatedEmail ?? request.email;
      setEmail(authenticatedEmail);
      lastAuthStatusEmailRef.current = authenticatedEmail;
      if (authStatus.hasSavedCredentialsForEmail && (request.useSavedLogin || request.rememberLogin)) {
        setUseSavedLogin(true);
      }

      setIsLoadingGuilds(true);
      const guildCount = await loadGuilds();
      setHasAutoLoadedGuilds(true);
      setLoginFeedback({
        tone: "success",
        message:
          guildCount > 0
            ? `Login successful. Loaded ${guildCount} guild${guildCount === 1 ? "" : "s"}.`
            : "Login successful. No guilds found for this account.",
      });
    } catch (error) {
      const message = getErrorMessage(error);
      setWclError(message);
      setLoginFeedback({
        tone: "error",
        message: didLoginSucceed
          ? `Login succeeded, but loading guilds failed: ${message}`
          : `Login failed: ${message}`,
      });
    } finally {
      setIsLoadingGuilds(false);
      setIsLoggingIn(false);
    }
  }, [
    applyAuthStatus,
    canLogin,
    ensureSavedLoginAvailable,
    loadGuilds,
    resolveGuildRequest,
    setWclError,
  ]);

  useEffect(() => {
    if (!isAuthStatusLoaded || hasAutoLoadedGuilds) {
      return;
    }

    if (!isAuthenticated || email.trim().length === 0) {
      return;
    }

    if (isUploading || isLiveUploading || isAuthBusy) {
      return;
    }

    setHasAutoLoadedGuilds(true);
    void handleRefreshGuilds();
  }, [
    email,
    hasAutoLoadedGuilds,
    handleRefreshGuilds,
    isAuthBusy,
    isAuthStatusLoaded,
    isAuthenticated,
    isLiveUploading,
    isUploading,
  ]);

  useEffect(() => {
    if (selectedGuildId === "none") {
      return;
    }

    const selectedStillExists = guildOptions.some((guild) => String(guild.id) === selectedGuildId);
    if (!selectedStillExists) {
      setSelectedGuildId("none");
    }
  }, [guildOptions, selectedGuildId]);

  const handleClearSavedLogin = async () => {
    try {
      const authStatus = await invoke<WclAuthStatus>("clear_wcl_saved_login");
      applyAuthStatus(authStatus);
      setUseSavedLogin(false);
      setSavedLoginEmail(null);
      setHasAnySavedCredentials(false);
      setHasSavedCredentialsForCurrentEmail(false);
      setGuildOptions([]);
      setHasAutoLoadedGuilds(false);
      setLoginFeedback(null);
      lastAuthStatusEmailRef.current = "";
      setPassword("");
    } catch (error) {
      setWclError(getErrorMessage(error));
    }
  };

  const handleSignOut = async () => {
    try {
      const authStatus = await invoke<WclAuthStatus>("sign_out_wcl");
      applyAuthStatus(authStatus);
      setGuildOptions([]);
      setSelectedGuildId("none");
      setHasAutoLoadedGuilds(false);
      setLoginFeedback(null);
      setPassword("");
    } catch (error) {
      setWclError(getErrorMessage(error));
    }
  };

  const handleBrowseLogFile = async () => {
    try {
      const selected = await open({
        directory: false,
        multiple: false,
        defaultPath: settings.wowFolder || undefined,
        filters: [{ name: "Combat Logs", extensions: ["txt"] }],
      });

      if (selected && typeof selected === "string") {
        setLogFilePath(selected);
      }
    } catch (error) {
      setWclError(getErrorMessage(error));
    }
  };

  const handleResolveLatestLog = async () => {
    if (isResolvingLatestLog) {
      return;
    }

    setIsResolvingLatestLog(true);
    setWclError(null);

    try {
      const latestLogPath = await invoke<string | null>("get_latest_combat_log_path", {
        wowFolder: settings.wowFolder.trim() ? settings.wowFolder : null,
      });

      if (!latestLogPath) {
        setWclError("Could not find a WoWCombatLog*.txt file. Check your WoW Folder in Settings.");
        return;
      }

      setLogFilePath(latestLogPath);
    } catch (error) {
      setWclError(getErrorMessage(error));
    } finally {
      setIsResolvingLatestLog(false);
    }
  };

  const handleStartUpload = async () => {
    if (!canStartUpload) {
      return;
    }

    setIsActivityModalOpen(true);
    setIsScanningActivities(true);
    setScanError(null);
    setScanResult(null);
    setSelectedActivityIds(new Set());
    try {
      const result = await scanLog(logFilePath.trim(), Number(region));
      setScanResult({ scanId: result.scanId, groups: result.groups });
    } catch (error) {
      setScanError(getErrorMessage(error));
    } finally {
      setIsScanningActivities(false);
    }
  };

  const handleCancelActivityModal = async () => {
    try {
      await cancelScan();
    } catch {
      // error already handled in context
    } finally {
      setIsScanningActivities(false);
      setIsActivityModalOpen(false);
      setScanResult(null);
      setScanError(null);
      setSelectedActivityIds(new Set());
    }
  };

  const handleUploadSelected = async () => {
    if (!scanResult || selectedActivityIds.size === 0) {
      return;
    }

    const payload: StartWclUploadPayload = {
      logFilePath: logFilePath.trim(),
      scanId: scanResult.scanId,
      selectedActivityIds: [...selectedActivityIds],
      description,
      region: Number(region),
      visibility: Number(visibility),
      guildId: selectedGuildId === "none" ? null : Number(selectedGuildId),
    };

    try {
      await validateUploadScan(payload);
    } catch (error) {
      const message = getErrorMessage(error);
      setScanError(message);
      setIsActivityModalOpen(true);
      return;
    }

    setIsActivityModalOpen(false);
    setScanResult(null);
    try {
      await startUpload(payload);
    } catch {
      // error already handled in context
    } finally {
      setPassword("");
    }
  };

  const handleCancelUpload = async () => {
    try {
      await cancelUpload();
    } catch {
      // error already handled in context
    }
  };

  const handleStartLiveUpload = async () => {
    if (!canStartLiveUpload) {
      return;
    }

    const wowFolder = settings.wowFolder.trim();
    if (!wowFolder) {
      setWclError("Set your WoW folder in Settings before starting live upload.");
      return;
    }

    const payload: StartWclLiveUploadPayload = {
      wowFolder,
      includeExistingContents,
      description,
      region: Number(region),
      visibility: Number(visibility),
      guildId: selectedGuildId === "none" ? null : Number(selectedGuildId),
    };

    try {
      await startLiveUpload(payload);
    } catch {
      // error already handled in context
    } finally {
      setPassword("");
    }
  };

  const handleStopLiveUpload = async () => {
    try {
      await stopLiveUpload();
    } catch {
      // error already handled in context
    }
  };

  const handleCopyReportUrl = async () => {
    if (!reportUrl) {
      return;
    }

    try {
      await navigator.clipboard.writeText(reportUrl);
    } catch (error) {
      setWclError(getErrorMessage(error));
    }
  };

  const handleCopyConsole = async () => {
    if (progressLines.length === 0) {
      return;
    }

    try {
      await navigator.clipboard.writeText(progressLines.join("\n"));
    } catch (error) {
      setWclError(getErrorMessage(error));
    }
  };

  return (
    <div className="relative flex flex-1 min-h-0 flex-col overflow-hidden bg-(--surface-0)">
      <div className="flex shrink-0 items-center gap-4 border-b border-white/10 bg-(--surface-1) px-4 py-4 md:px-6">
        <div>
          <h1 className="inline-flex items-center gap-2 text-lg font-semibold text-neutral-100">
            <UploadCloud className="h-4 w-4 text-neutral-300" />
            WarcraftLogs Upload
          </h1>
          <p className="text-xs uppercase tracking-[0.12em] text-neutral-500">
            Set up credentials, upload logs, and run live logging
          </p>
        </div>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto px-4 py-6 pb-10 [scrollbar-gutter:stable] md:px-6">
        <div className="w-full space-y-4">
          <SettingsSection title="Account" icon={<ShieldCheck className="h-4 w-4" />}>
            <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] lg:items-end">
              <FormField id={FIELD_IDS.email} label="WarcraftLogs Email">
                <Input
                  id={FIELD_IDS.email}
                  type="email"
                  placeholder="you@example.com"
                  value={email}
                  disabled={isUploading || isLiveUploading || isAuthBusy}
                  onChange={(event) => {
                    setEmail(event.target.value);
                    setLoginFeedback(null);
                  }}
                />
              </FormField>

              <FormField
                id={FIELD_IDS.password}
                label="WarcraftLogs Password"
              >
                <Input
                  id={FIELD_IDS.password}
                  type="password"
                  value={password}
                  disabled={isUploading || isLiveUploading || isAuthBusy}
                  onChange={(event) => {
                    setPassword(event.target.value);
                    setLoginFeedback(null);
                  }}
                />
              </FormField>

              <div className="flex lg:justify-end">
                <Button
                  variant="primary"
                  onClick={handleLogin}
                  disabled={!canLogin}
                  className="w-full lg:w-auto"
                >
                  {isLoggingIn ? "Logging in..." : "Login"}
                </Button>
              </div>
            </div>

            <p className="mt-2 text-xs text-neutral-400">
              Credentials are used only to create the WarcraftLogs session.
            </p>

            {(isAuthenticated || loginFeedback) && (
              <p
                className={`mt-2 inline-flex items-start gap-1.5 rounded-sm border px-2 py-1 text-xs ${
                  loginFeedback?.tone === "error"
                    ? "border-rose-300/30 bg-rose-500/12 text-rose-100"
                    : "border-emerald-300/30 bg-emerald-500/12 text-emerald-100"
                }`}
              >
                {loginFeedback?.tone === "error" ? (
                  <XCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-rose-300" />
                ) : (
                  <CheckCircle2 className="h-3.5 w-3.5 text-emerald-300" />
                )}
                <span>
                  {isAuthenticated && (
                    <span className="block font-medium">
                      Connected as {authenticatedUserName ?? email}
                    </span>
                  )}
                  {loginFeedback && (
                    <span className={isAuthenticated ? "mt-0.5 block text-[11px] opacity-90" : ""}>
                      {loginFeedback.message}
                    </span>
                  )}
                </span>
              </p>
            )}

            <div className="mt-3 grid gap-2 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-center">
              <label className="inline-flex items-center gap-2 text-xs text-neutral-300">
                <input
                  id={FIELD_IDS.rememberLogin}
                  type="checkbox"
                  className="h-3.5 w-3.5 rounded border-white/20 bg-black/20"
                  checked={rememberLogin}
                  disabled={isUploading || isLiveUploading || isAuthBusy}
                  onChange={(event) => setRememberLogin(event.target.checked)}
                />
                Remember login in secure OS keychain
              </label>

              {hasAnySavedCredentials && (savedLoginEmail || hasSavedCredentialsForCurrentEmail) && (
                <div className="flex flex-wrap items-center gap-2 lg:justify-end">
                  <label className="inline-flex items-center gap-2 text-xs text-neutral-300">
                    <input
                      type="checkbox"
                      className="h-3.5 w-3.5 rounded border-white/20 bg-black/20"
                      checked={useSavedLogin}
                      disabled={
                        isUploading ||
                        isLiveUploading ||
                        isAuthBusy ||
                        !hasSavedCredentialsForCurrentEmail
                      }
                      onChange={(event) => setUseSavedLogin(event.target.checked)}
                    />
                    Use saved login
                  </label>
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={handleClearSavedLogin}
                    disabled={isUploading || isLiveUploading || isAuthBusy}
                  >
                    Forget saved login
                  </Button>
                </div>
              )}

              {isAuthenticated && (
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={handleSignOut}
                  disabled={isUploading || isLiveUploading || isAuthBusy}
                >
                  Sign out
                </Button>
              )}
            </div>

            {hasAnySavedCredentials &&
              savedLoginEmail &&
              email.trim().length > 0 &&
              !hasSavedCredentialsForCurrentEmail && (
                <p className="mt-2 text-xs text-neutral-500">
                  Saved login is for {savedLoginEmail}. Enter password for this account or switch
                  back to use saved login.
                </p>
              )}
          </SettingsSection>

          <SettingsSection title="Upload Setup" icon={<FileText className="h-4 w-4" />}>
            <div className="grid gap-4 lg:grid-cols-3">
              <div>
                <label htmlFor={FIELD_IDS.region} className="mb-2 block text-sm text-neutral-300">
                  Region
                </label>
                <SettingsSelect
                  id={FIELD_IDS.region}
                  value={region}
                  options={REGION_OPTIONS}
                  disabled={isUploading || isLiveUploading}
                  onChange={setRegion}
                />
              </div>

              <div>
                <label htmlFor={FIELD_IDS.visibility} className="mb-2 block text-sm text-neutral-300">
                  Visibility
                </label>
                <SettingsSelect
                  id={FIELD_IDS.visibility}
                  value={visibility}
                  options={VISIBILITY_OPTIONS}
                  disabled={isUploading || isLiveUploading}
                  onChange={setVisibility}
                />
              </div>

              <FormField
                id={FIELD_IDS.description}
                label="Description"
                description="Optional report description shown on WarcraftLogs."
                className="lg:col-span-3"
              >
                <Input
                  id={FIELD_IDS.description}
                  type="text"
                  value={description}
                  disabled={isUploading || isLiveUploading}
                  onChange={(event) => setDescription(event.target.value)}
                  placeholder="Optional description"
                />
              </FormField>

              <div className="lg:col-span-3">
                <label htmlFor={FIELD_IDS.guildSelection} className="mb-2 block text-sm text-neutral-300">
                  Guild
                </label>
                <div className="grid gap-2 lg:grid-cols-[minmax(0,1fr)_auto]">
                  <SettingsSelect
                    id={FIELD_IDS.guildSelection}
                    value={selectedGuildId}
                    options={[
                      GUILD_NONE_OPTION,
                      ...guildOptions.map((guild) => ({
                        value: String(guild.id),
                        label: guild.name,
                      })),
                    ]}
                    disabled={isUploading || isLiveUploading || isAuthBusy}
                    onChange={setSelectedGuildId}
                  />
                  <Button variant="secondary" onClick={handleRefreshGuilds} disabled={!canLoadGuilds}>
                    {isLoadingGuilds ? "Loading guilds..." : "Refresh Guilds"}
                  </Button>
                </div>
                <p className="mt-2 text-xs text-neutral-500">
                  Guilds load automatically when saved login matches the current email. Use refresh
                  after changing credentials. You can keep "No guild" for personal uploads.
                </p>
              </div>
            </div>
          </SettingsSection>

          <SettingsSection title="Combat Log" icon={<UploadCloud className="h-4 w-4" />}>
            <div className="space-y-3">
              <FormField
                id={FIELD_IDS.logFilePath}
                label="Log File"
                description="Choose a WoWCombatLog*.txt file, or resolve the latest one from your WoW folder."
              >
                <Input
                  id={FIELD_IDS.logFilePath}
                  type="text"
                  value={logFilePath}
                  readOnly
                  disabled={isUploading || isLiveUploading}
                  placeholder="No file selected"
                />
              </FormField>

              <div className="flex flex-wrap gap-2">
                <Button
                  variant="secondary"
                  onClick={handleBrowseLogFile}
                  disabled={isUploading || isLiveUploading}
                >
                  Browse File
                </Button>
                <Button
                  variant="secondary"
                  onClick={handleResolveLatestLog}
                  disabled={isUploading || isLiveUploading || isResolvingLatestLog}
                >
                  {isResolvingLatestLog ? "Finding latest log..." : "Use Latest WoW Log"}
                </Button>
              </div>
            </div>
          </SettingsSection>

          <SettingsSection title="Upload Control" icon={<LoaderCircle className="h-4 w-4" />}>
            <div className="space-y-4">
              <div className="space-y-3">
                <p className="text-xs text-neutral-400">
                  One-shot upload sends the selected file once. Live upload tails your active combat
                  log until stopped.
                </p>
                <label className="flex items-start gap-2 text-xs text-neutral-300">
                  <input
                    type="checkbox"
                    checked={includeExistingContents}
                    onChange={(event) => setIncludeExistingContents(event.target.checked)}
                    disabled={isUploading || isLiveUploading || isAuthBusy}
                    className="mt-0.5 accent-emerald-400"
                  />
                  <span>
                    <span className="block font-medium text-neutral-200">Include existing contents in live upload</span>
                    <span className="block text-neutral-500">Backfill the latest WoW log before waiting for new lines.</span>
                  </span>
                </label>
                <div className="flex flex-wrap gap-2">
                  <Button variant="primary" onClick={handleStartUpload} disabled={!canStartUpload}>
                    {isUploading ? "Uploading..." : "Start Upload"}
                  </Button>
                  <Button variant="danger" onClick={handleCancelUpload} disabled={!isUploading}>
                    Cancel Upload
                  </Button>
                  <Button
                    variant="secondary"
                    onClick={handleStartLiveUpload}
                    disabled={!canStartLiveUpload}
                  >
                    {isLiveUploading ? "Live Upload Active" : "Start Live Upload"}
                  </Button>
                  <Button variant="danger" onClick={handleStopLiveUpload} disabled={!isLiveUploading}>
                    Stop Live Upload
                  </Button>
                </div>
              </div>

              <div className="rounded-sm border border-white/10 bg-black/20 p-3">
                <div className="space-y-3">
                  <p className="text-xs font-semibold uppercase tracking-[0.12em] text-neutral-400">
                    Upload Status
                  </p>
                  <div className="h-2 overflow-hidden rounded-full bg-neutral-800">
                    <div
                      className={`h-full rounded-full transition-all duration-300 ${progressBarTheme}`}
                      style={{ width: `${Math.min(100, Math.max(progressPercent, 0))}%` }}
                    />
                  </div>

                  <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                    <span className="text-neutral-300">{progressStatus ?? "Idle"}</span>
                    <span className="font-mono text-neutral-400">{progressPercent}%</span>
                  </div>

                  {errorMessage && (
                    <p className="inline-flex items-center gap-1.5 rounded-sm border border-rose-300/30 bg-rose-500/12 px-2 py-1 text-xs text-rose-200">
                      <XCircle className="h-3.5 w-3.5 text-rose-300" />
                      {errorMessage}
                    </p>
                  )}

                  {reportUrl && (
                    <div className="rounded-sm border border-emerald-300/30 bg-emerald-500/12 p-3 text-xs text-emerald-100">
                      <p className="mb-3 inline-flex items-center gap-1.5 font-medium">
                        <CheckCircle2 className="h-3.5 w-3.5 text-emerald-300" />
                        WarcraftLogs Report
                      </p>
                      <div className="flex flex-wrap items-center gap-2">
                        <a
                          href={reportUrl}
                          target="_blank"
                          rel="noreferrer noopener"
                          title={reportUrl}
                          className="inline-flex items-center gap-1.5 rounded-sm border border-emerald-300/35 bg-emerald-500/20 px-3 py-1.5 font-medium text-emerald-100 transition-colors hover:bg-emerald-500/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-300/60"
                        >
                          Open Report
                          <ExternalLink className="h-3.5 w-3.5" />
                        </a>
                        <Button variant="secondary" size="sm" onClick={handleCopyReportUrl}>
                          <span className="inline-flex items-center gap-1.5">
                            <Copy className="h-3.5 w-3.5" />
                            Copy URL
                          </span>
                        </Button>
                      </div>
                    </div>
                  )}
                </div>
              </div>
            </div>
          </SettingsSection>

          <SettingsSection title="Activity Console" icon={<Terminal className="h-4 w-4" />}>
            <div className="space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <button
                  type="button"
                  className="inline-flex items-center gap-1.5 text-xs text-neutral-300 hover:text-neutral-100"
                  onClick={() => setIsConsoleExpanded((current) => !current)}
                >
                  {isConsoleExpanded ? (
                    <ChevronUp className="h-3.5 w-3.5" />
                  ) : (
                    <ChevronDown className="h-3.5 w-3.5" />
                  )}
                  {isConsoleExpanded ? "Hide Console" : "Show Console"}
                </button>

                <div className="flex flex-wrap gap-2">
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={handleCopyConsole}
                    disabled={progressLines.length === 0}
                  >
                    <span className="inline-flex items-center gap-1.5">
                      <Copy className="h-3.5 w-3.5" />
                      Copy Logs
                    </span>
                  </Button>
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={clearProgress}
                    disabled={progressLines.length === 0 || isUploading || isLiveUploading}
                  >
                    Clear Console
                  </Button>
                </div>
              </div>

              {isConsoleExpanded && (
                <div className="max-h-72 overflow-y-auto rounded-sm border border-white/10 bg-black/20 p-3 font-mono text-xs text-neutral-300">
                  {progressLines.length === 0 ? (
                    <p className="text-neutral-500">Upload activity logs will appear here.</p>
                  ) : (
                    progressLines.map((line, index) => (
                      <p key={`${line}-${index}`} className="leading-relaxed">
                        {line}
                      </p>
                    ))
                  )}
                </div>
              )}
            </div>
          </SettingsSection>
        </div>
      </div>
      {isActivityModalOpen && (
        <WclActivitySelectionModal
          isScanning={isScanningActivities}
          scanPercent={scanPercent}
          scanStatus={scanStatus}
          scanError={scanError}
          groups={scanResult?.groups ?? []}
          selectedActivityIds={selectedActivityIds}
          onSelectionChange={setSelectedActivityIds}
          onUpload={handleUploadSelected}
          onCancel={handleCancelActivityModal}
          onRetry={handleStartUpload}
        />
      )}
    </div>
  );
}
