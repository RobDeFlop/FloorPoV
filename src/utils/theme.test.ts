import { describe, expect, test } from "bun:test";
import {
  APP_THEME_CLASS_NAMES,
  APP_THEME_STORAGE_KEY,
  applyAppTheme,
  DEFAULT_APP_THEME,
  getAppThemeClassName,
  isAppTheme,
  normalizeAppTheme,
  persistAppTheme,
  readPersistedAppTheme,
  type ThemeRoot,
  type ThemeStorage,
} from "./theme";

function createThemeStorage(initial: Record<string, string> = {}): ThemeStorage & {
  values: Record<string, string>;
} {
  const values = { ...initial };

  return {
    values,
    getItem(key: string) {
      return Object.prototype.hasOwnProperty.call(values, key) ? values[key] : null;
    },
    setItem(key: string, value: string) {
      values[key] = value;
    },
  };
}

function createThemeRoot(): ThemeRoot & { classNames: Set<string> } {
  const classNames = new Set<string>();

  return {
    classNames,
    classList: {
      add(...tokens: string[]) {
        for (const token of tokens) {
          classNames.add(token);
        }
      },
      remove(...tokens: string[]) {
        for (const token of tokens) {
          classNames.delete(token);
        }
      },
    },
    dataset: {},
    style: {
      colorScheme: "",
    },
  };
}

describe("isAppTheme", () => {
  test("accepts dark and light", () => {
    expect(isAppTheme("dark")).toBe(true);
    expect(isAppTheme("light")).toBe(true);
  });

  test("rejects unknown values", () => {
    expect(isAppTheme("system")).toBe(false);
    expect(isAppTheme("")).toBe(false);
    expect(isAppTheme(undefined)).toBe(false);
    expect(isAppTheme(null)).toBe(false);
  });
});

describe("normalizeAppTheme", () => {
  test("keeps valid themes", () => {
    expect(normalizeAppTheme("dark")).toBe("dark");
    expect(normalizeAppTheme("light")).toBe("light");
  });

  test("falls back to dark for unknown values", () => {
    expect(normalizeAppTheme(undefined)).toBe(DEFAULT_APP_THEME);
    expect(normalizeAppTheme("system")).toBe("dark");
    expect(normalizeAppTheme(1)).toBe("dark");
  });
});

describe("getAppThemeClassName", () => {
  test("returns the matching theme class", () => {
    expect(getAppThemeClassName("dark")).toBe(APP_THEME_CLASS_NAMES.dark);
    expect(getAppThemeClassName("light")).toBe(APP_THEME_CLASS_NAMES.light);
  });
});

describe("applyAppTheme", () => {
  test("sets the light theme class, data attribute, and color scheme", () => {
    const root = createThemeRoot();

    expect(applyAppTheme("light", root)).toBe("light");
    expect(root.classNames.has("theme-light")).toBe(true);
    expect(root.classNames.has("theme-dark")).toBe(false);
    expect(root.dataset.theme).toBe("light");
    expect(root.style.colorScheme).toBe("light");
  });

  test("replaces a previous theme class when switching", () => {
    const root = createThemeRoot();

    applyAppTheme("light", root);
    applyAppTheme("dark", root);

    expect(root.classNames.has("theme-dark")).toBe(true);
    expect(root.classNames.has("theme-light")).toBe(false);
    expect(root.dataset.theme).toBe("dark");
    expect(root.style.colorScheme).toBe("dark");
  });

  test("normalizes invalid values to the dark theme class", () => {
    const root = createThemeRoot();

    expect(applyAppTheme("contrast", root)).toBe("dark");
    expect(root.classNames.has("theme-dark")).toBe(true);
    expect(root.dataset.theme).toBe("dark");
  });
});

describe("readPersistedAppTheme", () => {
  test("returns the stored light theme", () => {
    const storage = createThemeStorage({ [APP_THEME_STORAGE_KEY]: "light" });

    expect(readPersistedAppTheme(storage)).toBe("light");
  });

  test("falls back to dark when storage is missing or invalid", () => {
    expect(readPersistedAppTheme(null)).toBe(DEFAULT_APP_THEME);
    expect(readPersistedAppTheme(createThemeStorage())).toBe("dark");
    expect(readPersistedAppTheme(createThemeStorage({ [APP_THEME_STORAGE_KEY]: "system" }))).toBe(
      "dark",
    );
  });
});

describe("persistAppTheme", () => {
  test("writes the normalized theme key", () => {
    const storage = createThemeStorage();

    persistAppTheme("light", storage);

    expect(storage.values[APP_THEME_STORAGE_KEY]).toBe("light");
  });

  test("ignores missing storage", () => {
    expect(() => persistAppTheme("dark", null)).not.toThrow();
  });
});
