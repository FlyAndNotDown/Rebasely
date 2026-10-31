import { StrictMode } from "react";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Site } from "./app";
import { SiteThemeProvider } from "./theme";

export const IDENTIFIER_PREFIX = "rebasely-";

export function SiteRoot() {
  return (
    <StrictMode>
      <SiteThemeProvider>
        <TooltipProvider>
          <Site />
        </TooltipProvider>
      </SiteThemeProvider>
    </StrictMode>
  );
}
