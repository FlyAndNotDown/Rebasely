import { useEffect, useRef, useState, type MouseEvent, type RefObject } from "react";
import {
  ArrowDownToLineIcon,
  ArrowUpRightIcon,
  ChevronRightIcon,
  CodeXmlIcon,
  CommandIcon,
  GitBranchIcon,
  LanguagesIcon,
  LayersIcon,
  ShieldCheckIcon,
  TerminalIcon,
  LaptopIcon,
  MonitorIcon,
  MoonIcon,
  RefreshCwIcon,
  SunIcon,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { localeHref, rememberSiteLanguage, SITE_LOCALES, type SiteLocale } from "./i18n";
import { useSiteTheme } from "./theme";
import { AppMark } from "@/components/app-mark";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { HoverTip } from "@/components/ui/tooltip";
import { WorkspacePreview } from "./workspace-preview";
import { fetchReleaseDownloads, LATEST_RELEASE_URL, REPOSITORY_URL, type ReleaseDownloads } from "./release-downloads";

const REPOSITORY = REPOSITORY_URL;
type DownloadState = { kind: "idle" | "pending" | "error" } | { kind: "ready"; downloads: ReleaseDownloads };

export function Site({ rootPage = false }: { rootPage?: boolean }) {
  const { t } = useTranslation();
  const [downloadOpen, setDownloadOpen] = useState(false);
  const [downloads, setDownloads] = useState<DownloadState>({ kind: "idle" });
  const downloadTrigger = useRef<HTMLAnchorElement | null>(null);
  const downloadRequest = useRef<AbortController | null>(null);
  const downloadCache = useRef<{ state: DownloadState; until: number } | null>(null);

  useEffect(() => () => {
    const request = downloadRequest.current;
    downloadRequest.current = null;
    request?.abort();
  }, []);

  function loadDownloads(force = false) {
    if (downloadRequest.current) return;
    const cached = downloadCache.current;
    if (!force && cached && cached.until > Date.now()) {
      setDownloads(cached.state);
      return;
    }
    const request = new AbortController();
    downloadRequest.current = request;
    setDownloads({ kind: "pending" });
    const timeout = window.setTimeout(() => request.abort(), 10_000);
    void fetchReleaseDownloads(request.signal).then((value) => {
      if (downloadRequest.current !== request) return;
      const state: DownloadState = { kind: "ready", downloads: value };
      downloadCache.current = { state, until: Date.now() + 5 * 60_000 };
      setDownloads(state);
    }).catch(() => {
      if (downloadRequest.current !== request) return;
      const state: DownloadState = { kind: "error" };
      downloadCache.current = { state, until: Date.now() + 30_000 };
      setDownloads(state);
    }).finally(() => {
      window.clearTimeout(timeout);
      if (downloadRequest.current === request) downloadRequest.current = null;
    });
  }

  function changeDownloadOpen(open: boolean) {
    if (!open) {
      const request = downloadRequest.current;
      downloadRequest.current = null;
      request?.abort();
    }
    setDownloadOpen(open);
  }

  function openDownload(event: MouseEvent<HTMLAnchorElement>) {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    downloadTrigger.current = event.currentTarget;
    setDownloadOpen(true);
    loadDownloads();
  }

  return (
    <>
      <a className="site-skip" href="#main">{t("nav.skip")}</a>
      <header className="site-header site-container">
        <a className="site-brand" href={rootPage ? "./" : "../"} aria-label={t("nav.home")}>
          <AppMark className="size-8" iconClassName="size-4" /><span>Rebasely</span>
        </a>
        <nav className="site-navigation" aria-label={t("nav.main")}>
          <Button variant="ghost" size="sm" asChild className="overview-link"><a href="#features">{t("nav.features")}</a></Button>
          <Button variant="ghost" size="sm" asChild className="overview-link"><a href="#workflows">{t("nav.workflow")}</a></Button>
          <Button variant="ghost" size="sm" asChild className="overview-link"><a href="#start">{t("nav.start")}</a></Button>
          <HoverTip label={t("nav.source")}><Button variant="ghost" size="icon-sm" asChild className="site-source-link"><a href={REPOSITORY} aria-label={t("nav.source")}><CodeXmlIcon /></a></Button></HoverTip>
          <LanguageMenu rootPage={rootPage} />
          <ThemeMenu />
          <Button size="sm" asChild className="site-nav-download"><a href={LATEST_RELEASE_URL} onClick={openDownload}>{t("nav.download")}<ArrowDownToLineIcon /></a></Button>
        </nav>
      </header>

      <main id="main" className="site-container">
        <section className="site-hero" aria-labelledby="hero-title">
          <p className="site-eyebrow">{t("hero.eyebrow")}</p>
          <h1 id="hero-title">{t("hero.title").split("\n").map((line, index) => <span key={line} className={index ? "site-hero-title-secondary" : undefined}>{line}</span>)}</h1>
          <p className="site-hero-description">{t("hero.description")}</p>
          <div className="site-actions">
            <Button size="lg" asChild><a href={LATEST_RELEASE_URL} onClick={openDownload}><ArrowDownToLineIcon />{t("hero.download")}</a></Button>
            <Button variant="outline" size="lg" asChild><a href="#features">{t("hero.explore")}<ChevronRightIcon /></a></Button>
          </div>
          <p className="site-platforms"><span className="site-supported-platforms">{t("hero.platforms")}</span><span className="site-platform-separator" aria-hidden="true">·</span><span className="site-license-note">{t("hero.note")}</span></p>
        </section>

        <section id="features" className="site-workspace" aria-labelledby="workspace-title">
          <div className="site-preview-label">
            <div><p className="site-eyebrow">{t("preview.eyebrow")}</p><h2 id="workspace-title">{t("preview.title")}</h2></div>
            <p>{t("preview.intro")}</p>
          </div>
          <div className="site-preview-frame">
            <noscript className="site-preview-caption">{t("preview.noscript")}</noscript>
            <WorkspacePreview />
          </div>
          <div className="site-preview-guides">
            <div><GitBranchIcon aria-hidden="true" /><p><strong>Git</strong>{t("preview.gitGuide")}</p></div>
            <div><LayersIcon aria-hidden="true" /><p><strong>Perforce</strong>{t("preview.p4Guide")}</p></div>
          </div>
          <p className="site-preview-caption">{t("preview.caption")}</p>
        </section>

        <section id="workflows" className="site-workflows site-section" aria-labelledby="workflows-title">
          <div className="site-section-intro">
            <p className="site-eyebrow">{t("workflow.eyebrow")}</p>
            <h2 id="workflows-title">{t("workflow.title")}</h2>
            <p>{t("workflow.intro")}</p>
          </div>
          <div className="site-workflow-pair">
            <WorkflowPath kind="git" />
            <WorkflowPath kind="p4" />
          </div>
        </section>

        <section className="site-capabilities site-section" aria-labelledby="capabilities-title">
          <div className="site-section-intro">
            <p className="site-eyebrow">{t("capabilities.eyebrow")}</p>
            <h2 id="capabilities-title">{t("capabilities.title")}</h2>
            <p>{t("capabilities.intro")}</p>
          </div>
          <table className="site-capability-table">
            <caption className="sr-only">{t("capabilities.caption")}</caption>
            <thead><tr><th scope="col">{t("capabilities.category")}</th><th scope="col"><GitBranchIcon aria-hidden="true" />Git</th><th scope="col"><LayersIcon aria-hidden="true" />Perforce</th></tr></thead>
            <tbody>{["review", "organize", "history", "advanced", "tools"].map((kind) => <tr key={kind}>
              <th scope="row">{t(`capabilities.${kind}.title`)}</th>
              <td data-label="Git">{t(`capabilities.${kind}.git`)}</td>
              <td data-label="Perforce">{t(`capabilities.${kind}.p4`)}</td>
            </tr>)}</tbody>
          </table>
        </section>

        <section className="site-tooling site-section" aria-labelledby="tooling-title">
          <div className="site-section-intro"><p className="site-eyebrow">{t("tooling.eyebrow")}</p><h2 id="tooling-title">{t("tooling.title")}</h2><p>{t("tooling.intro")}</p></div>
          <div className="site-tool-list">
            {([{ kind: "cli", Icon: TerminalIcon }, { kind: "editor", Icon: CodeXmlIcon }, { kind: "access", Icon: ShieldCheckIcon }, { kind: "comfort", Icon: CommandIcon }] as const).map(({ kind, Icon }) => <article key={kind}><Icon aria-hidden="true" /><div><h3>{t(`tooling.${kind}.title`)}</h3><p>{t(`tooling.${kind}.body`)}</p></div></article>)}
          </div>
          <p className="site-local-note">{t("principles.local.body")} {t("principles.open.body")}</p>
        </section>

        <section id="start" className="site-get-started site-section" aria-labelledby="start-title">
          <div className="site-section-intro"><p className="site-eyebrow">{t("start.eyebrow")}</p><h2 id="start-title">{t("start.title")}</h2></div>
          <ol>{[1, 2, 3].map((step) => <li key={step}><span>0{step}</span><h3>{t(`start.step${step}.title`)}</h3><p>{t(`start.step${step}.body`)}</p>{step === 2 ? <div className="site-tool-links"><a href="https://git-scm.com/downloads/">Git<ArrowUpRightIcon aria-hidden="true" /></a><a href="https://www.perforce.com/downloads/helix-command-line-client-p4">Perforce CLI<ArrowUpRightIcon aria-hidden="true" /></a></div> : null}</li>)}</ol>
        </section>

        <section className="site-faq site-section" aria-labelledby="faq-title">
          <div className="site-section-intro"><p className="site-eyebrow">{t("faq.eyebrow")}</p><h2 id="faq-title">{t("faq.title")}</h2></div>
          <div>{["systems", "tools", "accounts", "demo"].map((key) => <details key={key}><summary>{t(`faq.${key}.question`)}<ChevronRightIcon aria-hidden="true" /></summary><p>{t(`faq.${key}.answer`)}</p></details>)}</div>
        </section>

        <section className="site-download" aria-labelledby="download-title">
          <div><p className="site-eyebrow">Rebasely</p><h2 id="download-title">{t("download.title")}</h2><p>{t("download.body")}</p></div>
          <Button size="lg" asChild><a href={LATEST_RELEASE_URL} onClick={openDownload}>{t("download.action")}<ArrowDownToLineIcon /></a></Button>
        </section>
      </main>

      <footer className="site-footer site-container">
        <div className="site-footer-brand"><a href={rootPage ? "./" : "../"}>Rebasely</a><p>{t("footer.tagline")}</p></div>
        <nav aria-label={t("nav.footer")}><a href={`${REPOSITORY}/issues`}>{t("nav.feedback")}</a><a href={`${REPOSITORY}/blob/dev/CONTRIBUTING.md`}>{t("nav.contribute")}</a><a href={`${REPOSITORY}/blob/dev/LICENSE`}>{t("nav.license")}</a></nav>
        <div className="site-footer-languages">{SITE_LOCALES.map((locale) => <a key={locale} href={localeHref(locale, rootPage)} hrefLang={locale} onClick={() => rememberSiteLanguage(locale)}>{t(`language.${locale}`)}</a>)}</div>
      </footer>
      <DownloadDialog open={downloadOpen} onOpenChange={changeDownloadOpen} returnFocusTo={downloadTrigger} state={downloads} onRefresh={() => loadDownloads(true)} />
    </>
  );
}

function WorkflowPath({ kind }: { kind: "git" | "p4" }) {
  const { t } = useTranslation();
  const Icon = kind === "git" ? GitBranchIcon : LayersIcon;
  return <article className="site-workflow-path">
    <div className="site-workflow-heading"><Icon aria-hidden="true" /><span>{kind === "git" ? "Git" : "Perforce"}</span><p>{t(`workflow.${kind}.tag`)}</p></div>
    <h3>{t(`workflow.${kind}.title`)}</h3>
    <p>{t(`workflow.${kind}.body`)}</p>
    <ol>{[1, 2, 3].map((step) => <li key={step}><span>{step}</span><div><h4>{t(`workflow.${kind}.step${step}.title`)}</h4><p>{t(`workflow.${kind}.step${step}.body`)}</p></div></li>)}</ol>
  </article>;
}

function LanguageMenu({ rootPage }: { rootPage: boolean }) {
  const { t, i18n } = useTranslation();
  return <DropdownMenu><DropdownMenuTrigger asChild><Button variant="ghost" size="sm" className="site-language-control" aria-label={t("language.label")}><LanguagesIcon /><span>{t("language.short")}</span></Button></DropdownMenuTrigger><DropdownMenuContent align="end">{SITE_LOCALES.map((locale: SiteLocale) => <DropdownMenuItem key={locale} asChild><a href={localeHref(locale, rootPage)} hrefLang={locale} lang={locale} aria-current={i18n.language === locale ? "page" : undefined} onClick={() => rememberSiteLanguage(locale)}>{t(`language.${locale}`)}</a></DropdownMenuItem>)}<DropdownMenuSeparator /><DropdownMenuItem asChild><a href={rootPage ? "./" : "../"} onClick={() => rememberSiteLanguage(null)}>{t("language.automatic")}</a></DropdownMenuItem></DropdownMenuContent></DropdownMenu>;
}

function ThemeMenu() {
  const { theme, setTheme } = useSiteTheme();
  const { t } = useTranslation();
  return <DropdownMenu><HoverTip label={t("theme.label")}><DropdownMenuTrigger asChild><Button variant="ghost" size="icon-sm" aria-label={t("theme.label")}><SunIcon className="hidden dark:block" /><MoonIcon className="dark:hidden" /></Button></DropdownMenuTrigger></HoverTip><DropdownMenuContent align="end" className="w-36"><DropdownMenuRadioGroup value={theme} onValueChange={(value) => { if (value === "light" || value === "dark" || value === "system") setTheme(value); }}>{([{ value: "light", icon: SunIcon }, { value: "dark", icon: MoonIcon }, { value: "system", icon: MonitorIcon }] as const).map(({ value, icon: Icon }) => <DropdownMenuRadioItem key={value} value={value}><Icon /><span>{t(`theme.${value}`)}</span></DropdownMenuRadioItem>)}</DropdownMenuRadioGroup></DropdownMenuContent></DropdownMenu>;
}

function DownloadDialog({ open, onOpenChange, returnFocusTo, state, onRefresh }: { open: boolean; onOpenChange: (open: boolean) => void; returnFocusTo: RefObject<HTMLAnchorElement | null>; state: DownloadState; onRefresh: () => void }) {
  const { t } = useTranslation();
  const downloads = state.kind === "ready" ? state.downloads : null;
  const complete = downloads?.macos && downloads.windows;
  return <Dialog open={open} onOpenChange={onOpenChange}><DialogContent className="sm:max-w-md" onCloseAutoFocus={(event) => { event.preventDefault(); returnFocusTo.current?.focus(); }}><DialogHeader><DialogTitle>{t("download.dialog.title")}</DialogTitle><DialogDescription>{t("download.dialog.body")}</DialogDescription></DialogHeader><div className="grid gap-1">{[{ label: "macOS", detail: "Apple Silicon", format: "DMG", icon: LaptopIcon, url: downloads?.macos }, { label: "Windows", detail: "x64", format: t("download.installer"), icon: MonitorIcon, url: downloads?.windows }].map(({ label, detail, format, icon: Icon, url }) => <Button key={label} variant="ghost" asChild className="h-auto justify-start gap-3 px-2 py-3"><a href={url ?? LATEST_RELEASE_URL}><Icon className="size-5 text-muted-foreground" /><span className="grid min-w-0 flex-1 gap-1 text-left"><span>{label}<span className="ml-1 text-xs font-normal text-muted-foreground">{detail}</span></span><span className="text-xs font-normal text-muted-foreground">{url ? format : t("download.viewLatest")}</span></span>{url ? <ArrowDownToLineIcon className="text-muted-foreground" /> : <ChevronRightIcon className="text-muted-foreground" />}</a></Button>)}</div><div className="flex items-center gap-3"><p role={state.kind === "error" ? "alert" : "status"} className="min-w-0 flex-1 text-xs leading-relaxed text-muted-foreground">{state.kind === "pending" ? t("download.finding") : state.kind === "error" ? t("download.error") : complete ? t("download.version", { version: downloads.tag }) : t("download.choose")}</p><Button size="sm" variant="ghost" disabled={state.kind === "pending"} onClick={onRefresh}><RefreshCwIcon />{t(state.kind === "error" ? "download.retry" : "download.refresh")}</Button></div><p className="text-xs leading-relaxed text-muted-foreground">{t("download.requires")}</p><DialogFooter className="items-center sm:justify-between"><Button variant="ghost" size="sm" asChild><a href={`${REPOSITORY}/blob/dev/docs/development.md`}>{t("download.build")}</a></Button><Button size="sm" asChild><a href={LATEST_RELEASE_URL}>{t("download.latest")}<ArrowUpRightIcon /></a></Button></DialogFooter></DialogContent></Dialog>;
}
