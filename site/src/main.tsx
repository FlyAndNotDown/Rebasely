import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { SiteThemeProvider } from "./theme";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Site } from "./app";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <SiteThemeProvider>
      <TooltipProvider>
        <Site />
      </TooltipProvider>
    </SiteThemeProvider>
  </StrictMode>,
);
