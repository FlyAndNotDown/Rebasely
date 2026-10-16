import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { ThemeProvider } from "@/components/theme-provider";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { GitProvider } from "@/state/git-context";
import { P4Provider } from "@/state/p4-context";
import "./index.css";

// WebView find, print, reload, zoom, and history. Shifted forms belong to the
// app (fetch, pull, reflog), so only the plain browser chord is swallowed.
document.addEventListener(
  "keydown",
  (event) => {
    if (isWebViewShortcut(event)) event.preventDefault();
  },
  true,
);

function isWebViewShortcut(event: KeyboardEvent) {
  if (event.key === "F3" || event.key === "F5" || event.key === "F7") return true;
  if (event.altKey && (event.key === "ArrowLeft" || event.key === "ArrowRight")) return true;
  if (!(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey) return false;
  switch (event.key.toLowerCase()) {
    case "f":
    case "p":
    case "g":
    case "r":
    case "s":
    case "u":
    case "n":
    case "t":
    case "h":
    case "j":
    case "d":
    case "l":
    case "+":
    case "-":
    case "=":
    case "_":
    case "0":
      return true;
    default:
      return false;
  }
}

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
