import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import {
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Copy,
  FileText,
  LoaderCircle,
  ShieldCheck,
  Terminal,
  UploadCloud,
  XCircle,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import {
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

interface WclGuild {
  id: number;
  name: string;
}

interface FetchWclGuildsResponse {
  email: string;
  guilds: WclGuild[];
}

interface WclLoginState {
  savedEmail: string | null;
  hasSavedCredentials: boolean;
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
    errorMessage,
    reportUrl,
    setWclError,
    clearProgress,
    startUpload,
    cancelUpload,
    startLiveUpload,
    stopLiveUpload,
  } = useWclUpload();

  const [logFilePath, setLogFilePath] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [useSavedLogin, setUseSavedLogin] = useState(false);
  const [rememberLogin, setRememberLogin] = useState(false);
  const [hasSavedCredentials, setHasSavedCredentials] = useState(false);
  const [description, setDescription] = useState("");
  const [region, setRegion] = useState("2");
  const [visibility, setVisibility] = useState("0");
  const [guildOptions, setGuildOptions] = useState<WclGuild[]>([]);
  const [selectedGuildId, setSelectedGuildId] = useState("none");
  const [isLoadingGuilds, setIsLoadingGuilds] = useState(false);
  const [isResolvingLatestLog, setIsResolvingLatestLog] = useState(false);
  const [isConsoleExpanded, setIsConsoleExpanded] = useState(true);

  const hasCredentialInput =
    email.trim().length > 0 &&
    (password.trim().length > 0 || (useSavedLogin && hasSavedCredentials));

  useEffect(() => {
    let mounted = true;

    const loadLoginState = async () => {
      try {
        const loginState = await invoke<WclLoginState>("get_wcl_login_state");
        if (!mounted) {
          return;
        }
        setHasSavedCredentials(loginState.hasSavedCredentials);
        if (loginState.savedEmail) {
          setEmail(loginState.savedEmail);
          setUseSavedLogin(loginState.hasSavedCredentials);
        }
      } catch (error) {
        if (!mounted) {
          return;
        }
        setWclError(getErrorMessage(error));
      }
    };

    void loadLoginState();

    return () => {
      mounted = false;
    };
  }, [setWclError]);

  const canStartUpload = useMemo(() => {
    return !isUploading && !isLiveUploading && logFilePath.trim().length > 0 && hasCredentialInput;
  }, [hasCredentialInput, isLiveUploading, isUploading, logFilePath]);

  const canLoadGuilds = useMemo(() => {
    return !isUploading && !isLiveUploading && !isLoadingGuilds && hasCredentialInput;
  }, [hasCredentialInput, isLiveUploading, isLoadingGuilds, isUploading]);

  const canStartLiveUpload = useMemo(() => {
    return !isUploading && !isLiveUploading && hasCredentialInput;
  }, [hasCredentialInput, isLiveUploading, isUploading]);

  const progressBarTheme = errorMessage ? "bg-rose-400/90" : "bg-emerald-400/85";

  const handleLoadGuilds = async () => {
    if (!canLoadGuilds) {
      return;
    }

    setIsLoadingGuilds(true);
    setWclError(null);

    try {
      const response = await invoke<FetchWclGuildsResponse>("fetch_wcl_guilds", {
        request: {
          email: email.trim(),
          password: password.trim() ? password : null,
          useSavedLogin,
          rememberLogin,
        },
      });

      setEmail(response.email);
      setGuildOptions(response.guilds);
      if (rememberLogin) {
        setHasSavedCredentials(true);
      }
    } catch (error) {
      setWclError(getErrorMessage(error));
    } finally {
      setPassword("");
      setIsLoadingGuilds(false);
    }
  };

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
      await invoke("clear_wcl_saved_login");
      setUseSavedLogin(false);
      setHasSavedCredentials(false);
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

    const payload: StartWclUploadPayload = {
      logFilePath: logFilePath.trim(),
      email: email.trim(),
      password: password.trim() ? password : null,
      useSavedLogin,
      rememberLogin,
      description,
      region: Number(region),
      visibility: Number(visibility),
      guildId: selectedGuildId === "none" ? null : Number(selectedGuildId),
    };

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
      email: email.trim(),
      password: password.trim() ? password : null,
      useSavedLogin,
      rememberLogin,
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
            Upload logs and manage live logging from FloorPoV
          </p>
        </div>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto px-4 py-6 pb-10 md:px-6">
        <div className="mx-auto w-full max-w-5xl space-y-4">
          <SettingsSection title="Account" icon={<ShieldCheck className="h-4 w-4" />}>
            <div className="grid gap-4 lg:grid-cols-2">
              <FormField id={FIELD_IDS.email} label="WarcraftLogs Email">
                <Input
                  id={FIELD_IDS.email}
                  type="email"
                  placeholder="you@example.com"
                  value={email}
                  disabled={isUploading || isLiveUploading}
                  onChange={(event) => setEmail(event.target.value)}
                />
              </FormField>

              <FormField
                id={FIELD_IDS.password}
                label="WarcraftLogs Password"
                description="Used only for login and upload steps."
              >
                <Input
                  id={FIELD_IDS.password}
                  type="password"
                  value={password}
                  disabled={isUploading || isLiveUploading}
                  onChange={(event) => setPassword(event.target.value)}
                />
              </FormField>
            </div>

            <div className="mt-3 grid gap-2 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-center">
              <label className="inline-flex items-center gap-2 text-xs text-neutral-300">
                <input
                  id={FIELD_IDS.rememberLogin}
                  type="checkbox"
                  className="h-3.5 w-3.5 rounded border-white/20 bg-black/20"
                  checked={rememberLogin}
                  disabled={isUploading || isLiveUploading}
                  onChange={(event) => setRememberLogin(event.target.checked)}
                />
                Remember login in secure OS keychain
              </label>

              {hasSavedCredentials && (
                <div className="flex flex-wrap items-center gap-2 lg:justify-end">
                  <label className="inline-flex items-center gap-2 text-xs text-neutral-300">
                    <input
                      type="checkbox"
                      className="h-3.5 w-3.5 rounded border-white/20 bg-black/20"
                      checked={useSavedLogin}
                      disabled={isUploading || isLiveUploading}
                      onChange={(event) => setUseSavedLogin(event.target.checked)}
                    />
                    Use saved login
                  </label>
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={handleClearSavedLogin}
                    disabled={isUploading || isLiveUploading}
                  >
                    Forget saved login
                  </Button>
                </div>
              )}
            </div>
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
                    disabled={isUploading || isLiveUploading || isLoadingGuilds}
                    onChange={setSelectedGuildId}
                  />
                  <Button variant="secondary" onClick={handleLoadGuilds} disabled={!canLoadGuilds}>
                    {isLoadingGuilds ? "Loading guilds..." : "Load Guilds"}
                  </Button>
                </div>
                <p className="mt-2 text-xs text-neutral-500">
                  Load guilds after entering credentials. You can keep "No guild" for personal
                  uploads.
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
                      <p className="mb-2 inline-flex items-center gap-1.5 font-medium">
                        <CheckCircle2 className="h-3.5 w-3.5 text-emerald-300" />
                        Report URL
                      </p>
                      <p>
                        <a
                          href={reportUrl}
                          target="_blank"
                          rel="noreferrer noopener"
                          className="break-all font-mono text-[11px] text-emerald-200 underline underline-offset-2 hover:text-emerald-100"
                        >
                          {reportUrl}
                        </a>
                      </p>
                      <div className="mt-3">
                        <Button variant="secondary" size="sm" onClick={handleCopyReportUrl}>
                          Copy URL
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
    </div>
  );
}
