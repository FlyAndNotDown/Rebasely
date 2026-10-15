import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { ThemeProvider } from "@/components/theme-provider";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { GitProvider } from "@/state/git-context";
import { P4Provider } from "@/state/p4-context";
import "./index.css";

// Runs on the way back up, after the app's own menus have opened. Preventing
// the default earlier makes those menus treat the event as already handled.
// Editable fields keep the native cut, copy, and paste menu.
document.addEventListener("contextmenu", (event) => {
  const node = event.target instanceof Node ? event.target : null;
  const element = node instanceof Element ? node : (node?.parentElement ?? null);
  if (element?.closest("input, textarea, select, [contenteditable='true']")) return;
  event.preventDefault();
});

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <ThemeProvider>
      <TooltipProvider>
        <GitProvider>
          <P4Provider>
            <App />
            <Toaster position="bottom-right" />
          </P4Provider>
        </GitProvider>
      </TooltipProvider>
    </ThemeProvider>
  </React.StrictMode>,
);
