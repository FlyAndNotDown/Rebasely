import { createContext, useContext, useEffect, useState, type ReactNode } from "react";

const STORAGE_KEY = "rebasely-site-theme";
type Theme = "light" | "dark" | "system";
const ThemeContext = createContext<{ theme: Theme; setTheme: (theme: Theme) => void } | null>(null);

function isTheme(value: string | null | undefined): value is Theme {
  return value === "light" || value === "dark" || value === "system";
}

export function SiteThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setTheme] = useState<Theme>(() => {
    const initial = document.documentElement.dataset.siteTheme;
    return isTheme(initial) ? initial : "dark";
  });

  useEffect(() => {
    const systemTheme = window.matchMedia("(prefers-color-scheme: dark)");
    function applyTheme() {
      const dark = theme === "dark" || (theme === "system" && systemTheme.matches);
      document.documentElement.classList.toggle("dark", dark);
      document.documentElement.style.colorScheme = dark ? "dark" : "light";
      document.documentElement.dataset.siteTheme = theme;
    }
    applyTheme();
    try {
      localStorage.setItem(STORAGE_KEY, theme);
    } catch {
      // The selected theme remains usable when browser storage is unavailable.
    }
    if (theme !== "system") return;
    systemTheme.addEventListener("change", applyTheme);
    return () => systemTheme.removeEventListener("change", applyTheme);
  }, [theme]);

  useEffect(() => {
    function onStorage(event: StorageEvent) {
      if (event.key === STORAGE_KEY) setTheme(isTheme(event.newValue) ? event.newValue : "dark");
    }
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  return <ThemeContext.Provider value={{ theme, setTheme }}>{children}</ThemeContext.Provider>;
}

export function useSiteTheme() {
  const context = useContext(ThemeContext);
  if (!context) throw new Error("SiteThemeProvider is required");
  return context;
}
