import { StrictMode, useState } from "react";
import { I18nextProvider } from "react-i18next";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Site } from "./app";
import { SiteThemeProvider } from "./theme";
import { createSiteI18n, type SiteLocale } from "./i18n";

export const IDENTIFIER_PREFIX = "rebasely-";

export function SiteRoot({ locale = "en", rootPage = true }: { locale?: SiteLocale; rootPage?: boolean }) {
  const [i18n] = useState(() => createSiteI18n(locale));
  return (
    <StrictMode>
      <I18nextProvider i18n={i18n}>
        <SiteThemeProvider>
          <TooltipProvider>
            <Site rootPage={rootPage} />
          </TooltipProvider>
        </SiteThemeProvider>
      </I18nextProvider>
    </StrictMode>
  );
}
