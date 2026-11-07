import { ExternalLinkIcon, MailIcon } from "lucide-react";
import { toast } from "sonner";
import { version } from "../../package.json";
import { AppMark } from "@/components/app-mark";
import { GitHubMark } from "@/components/github-mark";
import { UpdatesSettings } from "@/components/app-updates";
import { Button } from "@/components/ui/button";
import { t, useTranslation } from "@/i18n";
import { errorMessage, gitApi } from "@/lib/git";

const REPOSITORY_URL = "https://github.com/FlyAndNotDown/RebaseRaven";
const AUTHOR = "FlyAndNotDown";
const EMAIL = "johnkindem@qq.com";

export function AboutSettings() {
  useTranslation();
  return (
    <div className="grid gap-6">
      <section aria-label="RebaseRaven" className="grid gap-5">
        <div className="flex items-center gap-4">
          <AppMark className="size-14" />
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2.5">
              <h2 className="text-2xl leading-none font-medium tracking-tight">RebaseRaven</h2>
              <span className="rounded-md border bg-muted/40 px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground">v{version}</span>
            </div>
            <p className="mt-2 text-sm text-muted-foreground">{t("desktop.aboutSettings.a_unified_version_control_client")}</p>
          </div>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 text-sm">
          <p><span className="mr-2 text-muted-foreground">{t("desktop.aboutSettings.developer")}</span>{AUTHOR}</p>
          <Button variant="ghost" size="sm" className="min-w-0 text-muted-foreground" onClick={() => void sendMail()}>
            <MailIcon /><span className="truncate font-mono text-xs">{EMAIL}</span>
          </Button>
        </div>
        <Button
          variant="outline"
          className="h-auto w-full justify-start gap-3 px-3 py-3 text-left"
          aria-label={t("desktop.aboutSettings.open_github_repository")}
          onClick={() => void openRepository()}
        >
          <GitHubMark className="size-5 shrink-0 text-muted-foreground" />
          <span className="grid min-w-0 flex-1 gap-1 whitespace-normal">
            <span className="text-sm font-medium">{t("desktop.aboutSettings.github_repository")}</span>
            <span className="break-all font-mono text-[11px] leading-relaxed text-muted-foreground">{REPOSITORY_URL}</span>
          </span>
          <ExternalLinkIcon className="size-3.5 shrink-0 text-muted-foreground" />
        </Button>
      </section>
      <div className="border-t pt-6"><UpdatesSettings /></div>
    </div>
  );
}

async function openRepository() {
  try {
    await gitApi.openExternalUrl(REPOSITORY_URL);
  } catch (error) {
    toast.error(errorMessage(error));
  }
}

async function sendMail() {
  try {
    await gitApi.openMailto(EMAIL);
  } catch (error) {
    toast.error(errorMessage(error));
  }
}
