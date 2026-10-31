import { useEffect, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { ThemeProvider as NextThemesProvider, useTheme } from "next-themes";

export function ThemeProvider({ children }: { children: ReactNode }) {
  return (
    <NextThemesProvider
      attribute="class"
      defaultTheme="dark"
      enableSystem
      disableTransitionOnChange
    >
      <NativeTitleBar />
      {children}
    </NextThemesProvider>
  );
}

function NativeTitleBar() {
  const { resolvedTheme } = useTheme();

  useEffect(() => {
    if (resolvedTheme !== "light" && resolvedTheme !== "dark") return;
    void invoke("sync_window_chrome", { theme: resolvedTheme });
  }, [resolvedTheme]);

  return null;
}
