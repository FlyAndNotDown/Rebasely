import { createContext, useContext, useSyncExternalStore, type ReactNode } from "react";

const STORAGE_KEY = "rebasely-site-theme";
const CHANGE_EVENT = "rebasely-site-theme-change";
type Theme = "light" | "dark" | "system";
const ThemeContext = createContext<{ theme: Theme; setTheme: (theme: Theme) => void } | null>(null);

function isTheme(value: string | null | undefined): value is Theme {
  return value === "light" || value === "dark" || value === "system";
}

function readTheme(): Theme {
  const value = document.documentElement.dataset.siteTheme;
  return isTheme(value) ? value : "dark";
}

function applyTheme(theme: Theme) {
  const dark = theme === "dark" || (theme === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.classList.toggle("dark", dark);
  document.documentElement.style.colorScheme = dark ? "dark" : "light";
  document.documentElement.dataset.siteTheme = theme;
}

function setTheme(theme: Theme) {
  applyTheme(theme);
  try {
    localStorage.setItem(STORAGE_KEY, theme);
  } catch {
    // The selected theme remains usable when browser storage is unavailable.
  }
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

function subscribe(onChange: () => void) {
  const systemTheme = window.matchMedia("(prefers-color-scheme: dark)");
  function onSystemTheme() {
    if (readTheme() === "system") applyTheme("system");
  }
  function onStorage(event: StorageEvent) {
    if (event.key !== STORAGE_KEY && event.key !== null) return;
    applyTheme(isTheme(event.newValue) ? event.newValue : "dark");
    onChange();
  }
  window.addEventListener(CHANGE_EVENT, onChange);
  window.addEventListener("storage", onStorage);
  systemTheme.addEventListener("change", onSystemTheme);
  return () => {
    window.removeEventListener(CHANGE_EVENT, onChange);
    window.removeEventListener("storage", onStorage);
    systemTheme.removeEventListener("change", onSystemTheme);
  };
}

const serverTheme = (): Theme => "dark";

export function SiteThemeProvider({ children }: { children: ReactNode }) {
  const theme = useSyncExternalStore(subscribe, readTheme, serverTheme);

  return <ThemeContext.Provider value={{ theme, setTheme }}>{children}</ThemeContext.Provider>;
}

export function useSiteTheme() {
  const context = useContext(ThemeContext);
  if (!context) throw new Error("SiteThemeProvider is required");
  return context;
}
