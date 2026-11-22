export type AppTheme = "dark" | "light";

export const DEFAULT_APP_THEME: AppTheme = "dark";
export const APP_THEME_STORAGE_KEY = "floorpov-app-theme";
export const APP_THEME_CLASS_NAMES = {
  dark: "theme-dark",
  light: "theme-light",
} as const;

export interface ThemeRoot {
  classList: {
    add(...tokens: string[]): void;
    remove(...tokens: string[]): void;
  };
  dataset: {
    theme?: string;
  };
  style: {
    colorScheme: string;
  };
}

export interface ThemeStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export function isAppTheme(value: unknown): value is AppTheme {
  return value === "dark" || value === "light";
}

export function normalizeAppTheme(value: unknown): AppTheme {
  return isAppTheme(value) ? value : DEFAULT_APP_THEME;
}

export function getAppThemeClassName(theme: AppTheme): string {
  return APP_THEME_CLASS_NAMES[theme];
}

export function applyAppTheme(theme: unknown, root: ThemeRoot): AppTheme {
  const normalizedTheme = normalizeAppTheme(theme);

  root.classList.remove(APP_THEME_CLASS_NAMES.dark, APP_THEME_CLASS_NAMES.light);
  root.classList.add(getAppThemeClassName(normalizedTheme));
  root.dataset.theme = normalizedTheme;
  root.style.colorScheme = normalizedTheme;

  return normalizedTheme;
}

function getLocalThemeStorage(): ThemeStorage | null {
  try {
    if (typeof window === "undefined" || !window.localStorage) {
      return null;
    }

    return window.localStorage;
  } catch {
    return null;
  }
}

export function readPersistedAppTheme(
  storage: ThemeStorage | null = getLocalThemeStorage(),
): AppTheme {
  if (!storage) {
    return DEFAULT_APP_THEME;
  }

  try {
    return normalizeAppTheme(storage.getItem(APP_THEME_STORAGE_KEY));
  } catch {
    return DEFAULT_APP_THEME;
  }
}

export function persistAppTheme(
  theme: AppTheme,
  storage: ThemeStorage | null = getLocalThemeStorage(),
): void {
  if (!storage) {
    return;
  }

  try {
    storage.setItem(APP_THEME_STORAGE_KEY, theme);
  } catch {
    // Private mode and quota errors should not block applying the in-memory theme.
  }
}
