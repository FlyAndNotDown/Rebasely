import { useRef, useState, type MouseEvent, type RefObject } from "react";
import {
  ArrowDownToLineIcon,
  ArrowUpRightIcon,
  ChevronRightIcon,
  ChevronDownIcon,
  CodeXmlIcon,
  CommandIcon,
  FileDiffIcon,
  FolderOpenIcon,
  GitForkIcon,
  GitPullRequestIcon,
  HistoryIcon,
  MessageSquareIcon,
  MousePointer2Icon,
  ScaleIcon,
  LanguagesIcon,
  LayersIcon,
  ShieldCheckIcon,
  TerminalIcon,
  LaptopIcon,
  MonitorIcon,
  MoonIcon,
  SunIcon,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { localeHref, rememberSiteLanguage, SITE_LOCALES, type SiteLocale } from "./i18n";
import { useSiteTheme } from "./theme";
import { BrandMark } from "@/components/brand-mark";
import { GitHubMark } from "@/components/github-mark";
import { VcsIcon } from "@/components/vcs-icon";
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
import { LATEST_RELEASE_URL, readBundledReleaseDownloads, REPOSITORY_URL } from "./release-downloads";
import { trackDemoStart, trackDownloadDialog, trackInstallerDownload } from "./website-analytics";

const REPOSITORY = REPOSITORY_URL;
const capabilityIcons = { review: FileDiffIcon, organize: LayersIcon, history: HistoryIcon, advanced: GitForkIcon, tools: TerminalIcon };
const gettingStartedSteps = [{ step: 1, Icon: ArrowDownToLineIcon }, { step: 2, Icon: TerminalIcon }, { step: 3, Icon: FolderOpenIcon }] as const;
const downloads = readBundledReleaseDownloads(import.meta.env.VITE_RELEASE_DOWNLOADS);

export function Site({ rootPage = false }: { rootPage?: boolean }) {
  const { t } = useTranslation();
  const [downloadOpen, setDownloadOpen] = useState(false);
  const downloadTrigger = useRef<HTMLAnchorElement | null>(null);
  const demoStarted = useRef(false);

  function startDemo() {
    if (demoStarted.current) return;
    demoStarted.current = true;
    trackDemoStart();
  }

  function openDownload(event: MouseEvent<HTMLAnchorElement>) {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    downloadTrigger.current = event.currentTarget;
    const source = event.currentTarget.dataset.downloadSource;
    if (source === "header" || source === "hero" || source === "footer") trackDownloadDialog(source);
    setDownloadOpen(true);
  }

  return (
    <>
      <a className="site-skip" href="#main">{t("nav.skip")}</a>
      <div className="site-header-shell">
        <header className="site-header site-container">
          <a className="site-brand" href={rootPage ? "./" : "../"} aria-label={t("nav.home")}>
            <BrandMark className="site-brand-mark size-8" src={`${rootPage ? "./" : "../"}assets/raven.svg`} /><span translate="no">RebaseRaven</span>
          </a>
          <nav className="site-navigation" aria-label={t("nav.main")}>
            <Button variant="ghost" size="sm" asChild className="overview-link"><a href="#features">{t("nav.features")}</a></Button>
            <Button variant="ghost" size="sm" asChild className="overview-link"><a href="#workflows">{t("nav.workflow")}</a></Button>
            <Button variant="ghost" size="sm" asChild className="overview-link overview-link-start"><a href="#start">{t("nav.start")}</a></Button>
            <HoverTip label={t("nav.source")}><Button variant="ghost" size="icon-sm" asChild className="site-source-link"><a href={REPOSITORY} aria-label={t("nav.source")}><GitHubMark /></a></Button></HoverTip>
            <LanguageMenu rootPage={rootPage} />
            <ThemeMenu />
            <Button size="sm" asChild className="site-nav-download"><a href={LATEST_RELEASE_URL} aria-label={t("nav.download")} data-download-source="header" onClick={openDownload}><span className="site-nav-download-label">{t("nav.download")}</span><ArrowDownToLineIcon /></a></Button>
          </nav>
        </header>
      </div>

      <main id="main" className="site-container">
        <section className="site-hero" aria-labelledby="hero-title">
          <p className="site-eyebrow">{t("hero.eyebrow")}</p>
          <h1 id="hero-title">{t("hero.title").split("\n").map((line, index) => <span key={line} className={index ? "site-hero-title-secondary" : undefined}>{index ? ` ${line}` : line}</span>)}</h1>
          <p className="site-hero-description">{t("hero.description")}</p>
          <div className="site-actions">
            <Button size="lg" asChild><a href={LATEST_RELEASE_URL} data-download-source="hero" onClick={openDownload}><ArrowDownToLineIcon />{t("hero.download")}</a></Button>
            <Button variant="outline" size="lg" asChild><a href="#features"><MousePointer2Icon />{t("hero.explore")}</a></Button>
          </div>
          <p className="site-platforms"><span className="site-supported-platforms">{t("hero.platforms")}</span><span className="site-platform-separator" aria-hidden="true">·</span><span className="site-license-note">{t("hero.note")}</span></p>
        </section>

        <section id="features" className="site-workspace" aria-labelledby="workspace-title">
          <div className="site-preview-label">
            <div><p className="site-eyebrow">{t("preview.eyebrow")}</p><h2 id="workspace-title">{t("preview.title")}</h2></div>
            <p>{t("preview.label")}</p>
          </div>
          <div className="site-preview-frame" onPointerDownCapture={startDemo} onKeyDownCapture={startDemo}>
            <noscript className="site-preview-caption">{t("preview.noscript")}</noscript>
            <WorkspacePreview />
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
          <details className="site-capability-details">
            <summary>{t("capabilities.toggle")}<ChevronDownIcon aria-hidden="true" /></summary>
            <div className="site-capability-content">
              <table className="site-capability-table">
                <caption className="sr-only">{t("capabilities.caption")}</caption>
                <thead><tr><th scope="col">{t("capabilities.category")}</th><th scope="col"><VcsIcon vcs="git" />Git</th><th scope="col"><VcsIcon vcs="perforce" />Perforce</th></tr></thead>
                <tbody>{(["review", "organize", "history", "advanced", "tools"] as const).map((kind) => { const Icon = capabilityIcons[kind]; return <tr key={kind}>
                  <th scope="row"><span className="site-capability-label"><Icon aria-hidden="true" /><span>{t(`capabilities.${kind}.title`)}</span></span></th>
                  <td data-label="Git">{t(`capabilities.${kind}.git`)}</td>
                  <td data-label="Perforce">{t(`capabilities.${kind}.p4`)}</td>
                </tr>; })}</tbody>
              </table>
            </div>
          </details>
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
          <ol>{gettingStartedSteps.map(({ step, Icon }) => <li key={step}><span>0{step}</span><h3><Icon aria-hidden="true" />{t(`start.step${step}.title`)}</h3><p>{t(`start.step${step}.body`)}</p>{step === 2 ? <div className="site-tool-links"><a href="https://git-scm.com/downloads/">Git<ArrowUpRightIcon aria-hidden="true" /></a><a href="https://www.perforce.com/downloads/helix-command-line-client-p4">Perforce CLI<ArrowUpRightIcon aria-hidden="true" /></a></div> : null}</li>)}</ol>
        </section>

        <section className="site-faq site-section" aria-labelledby="faq-title">
          <div className="site-section-intro"><p className="site-eyebrow">{t("faq.eyebrow")}</p><h2 id="faq-title">{t("faq.title")}</h2></div>
          <div>{["systems", "tools", "accounts", "demo"].map((key) => <details key={key}><summary>{t(`faq.${key}.question`)}<ChevronRightIcon aria-hidden="true" /></summary><p>{t(`faq.${key}.answer`)}</p></details>)}</div>
        </section>

        <section className="site-download" aria-labelledby="download-title">
          <div className="site-download-content"><BrandMark className="size-12" src={`${rootPage ? "./" : "../"}assets/raven.svg`} /><div><p className="site-eyebrow" translate="no">RebaseRaven</p><h2 id="download-title">{t("download.title")}</h2><p>{t("download.body")}</p></div></div>
          <Button size="lg" asChild><a href={LATEST_RELEASE_URL} data-download-source="footer" onClick={openDownload}>{t("download.action")}<ArrowDownToLineIcon /></a></Button>
        </section>
      </main>

      <footer className="site-footer site-container">
        <div className="site-footer-brand"><a href={rootPage ? "./" : "../"} translate="no">RebaseRaven</a><p>{t("footer.tagline")}</p></div>
        <nav aria-label={t("nav.footer")}><a href={`${REPOSITORY}/issues`}><MessageSquareIcon aria-hidden="true" />{t("nav.feedback")}</a><a href={`${REPOSITORY}/blob/dev/CONTRIBUTING.md`}><GitPullRequestIcon aria-hidden="true" />{t("nav.contribute")}</a><a href={`${REPOSITORY}/blob/dev/LICENSE`}><ScaleIcon aria-hidden="true" />{t("nav.license")}</a></nav>
      </footer>
      <DownloadDialog open={downloadOpen} onOpenChange={setDownloadOpen} returnFocusTo={downloadTrigger} />
    </>
  );
}

function WorkflowPath({ kind }: { kind: "git" | "p4" }) {
  const { t } = useTranslation();
  return <article className="site-workflow-path">
    <div className="site-workflow-heading"><VcsIcon vcs={kind === "git" ? "git" : "perforce"} /><span>{kind === "git" ? "Git" : "Perforce"}</span><p>{t(`workflow.${kind}.tag`)}</p></div>
    <h3>{t(`workflow.${kind}.title`)}</h3>
    <p>{t(`workflow.${kind}.body`)}</p>
    <ol>{[1, 2, 3].map((step) => <li key={step}><span>{step}</span><div><h4>{t(`workflow.${kind}.step${step}.title`)}</h4><p>{t(`workflow.${kind}.step${step}.body`)}</p></div></li>)}</ol>
  </article>;
}

function LanguageMenu({ rootPage }: { rootPage: boolean }) {
  const { t, i18n } = useTranslation();
  const links = SITE_LOCALES.map((locale: SiteLocale) => ({
    locale,
    href: localeHref(locale, rootPage),
    label: t(`language.${locale}`),
    current: i18n.language === locale ? "page" as const : undefined,
  }));
  return (
    <>
      <DropdownMenu>
        <HoverTip label={t("language.label")}>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon-sm" className="site-language-trigger" aria-label={t("language.label")}>
              <LanguagesIcon />
            </Button>
          </DropdownMenuTrigger>
        </HoverTip>
        <DropdownMenuContent align="end">
          {links.map(({ locale, href, label, current }) => (
            <DropdownMenuItem key={locale} asChild>
              <a href={href} hrefLang={locale} aria-current={current} onClick={() => rememberSiteLanguage(locale)}>{label}</a>
            </DropdownMenuItem>
          ))}
          <DropdownMenuSeparator />
          <DropdownMenuItem asChild>
            <a href={rootPage ? "./" : "../"} onClick={() => rememberSiteLanguage(null)}>{t("language.automatic")}</a>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <noscript>
        <style>{".site-language-trigger { display: none; }"}</style>
        <details className="relative">
          <Button asChild variant="ghost" size="icon-sm">
            <summary aria-label={t("language.label")} className="list-none [&::-webkit-details-marker]:hidden"><LanguagesIcon /></summary>
          </Button>
          <div className="absolute right-0 z-50 grid min-w-max gap-1 rounded-md border bg-popover p-1 text-sm text-popover-foreground">
            {links.map(({ locale, href, label, current }) => (
              <a key={locale} href={href} hrefLang={locale} aria-current={current} className="rounded-sm px-2 py-1 hover:bg-accent">{label}</a>
            ))}
          </div>
        </details>
      </noscript>
    </>
  );
}

function ThemeMenu() {
  const { theme, setTheme } = useSiteTheme();
  const { t } = useTranslation();
  return <DropdownMenu><HoverTip label={t("theme.label")}><DropdownMenuTrigger asChild><Button variant="ghost" size="icon-sm" aria-label={t("theme.label")}><SunIcon className="hidden dark:block" /><MoonIcon className="dark:hidden" /></Button></DropdownMenuTrigger></HoverTip><DropdownMenuContent align="end" className="w-36"><DropdownMenuRadioGroup value={theme} onValueChange={(value) => { if (value === "light" || value === "dark" || value === "system") setTheme(value); }}>{([{ value: "light", icon: SunIcon }, { value: "dark", icon: MoonIcon }, { value: "system", icon: MonitorIcon }] as const).map(({ value, icon: Icon }) => <DropdownMenuRadioItem key={value} value={value}><Icon /><span>{t(`theme.${value}`)}</span></DropdownMenuRadioItem>)}</DropdownMenuRadioGroup></DropdownMenuContent></DropdownMenu>;
}

function DownloadDialog({ open, onOpenChange, returnFocusTo }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  returnFocusTo: RefObject<HTMLAnchorElement | null>;
}) {
  const { t } = useTranslation();
  const platforms = [
    { platform: "macos" as const, label: "macOS", detail: "Apple Silicon", format: "DMG", icon: LaptopIcon, url: downloads?.macos },
    { platform: "windows" as const, label: "Windows", detail: "x64", format: t("download.installer"), icon: MonitorIcon, url: downloads?.windows },
  ];
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="site-download-dialog max-h-[calc(100dvh-2rem)] overflow-y-auto overscroll-contain sm:max-w-md"
        onCloseAutoFocus={(event) => { event.preventDefault(); returnFocusTo.current?.focus(); }}
      >
        <DialogHeader>
          <DialogTitle>{t("download.dialog.title")}</DialogTitle>
          <DialogDescription>{t("download.dialog.body")}</DialogDescription>
        </DialogHeader>
        <div className="grid gap-1">
          {platforms.map(({ platform, label, detail, format, icon: Icon, url }) => (
            <Button key={label} variant="ghost" asChild className="h-auto justify-start gap-3 px-2 py-3">
              <a href={url ?? LATEST_RELEASE_URL} onClick={() => { if (url && downloads) trackInstallerDownload(platform, url, downloads.tag); }}>
                <Icon className="size-5 text-muted-foreground" />
                <span className="grid min-w-0 flex-1 gap-1 text-left">
                  <span>{label}<span className="ml-1 text-xs text-muted-foreground">{detail}</span></span>
                  <span className="text-xs font-normal text-muted-foreground">{url ? format : t("download.viewLatest")}</span>
                </span>
                {url ? <ArrowDownToLineIcon className="text-muted-foreground" /> : <ChevronRightIcon className="text-muted-foreground" />}
              </a>
            </Button>
          ))}
        </div>
        {downloads ? <p className="text-xs text-muted-foreground">{t("download.version", { version: downloads.tag })}</p> : null}
        <DialogFooter className="items-center sm:justify-between">
          <Button variant="ghost" size="sm" asChild><a href={`${REPOSITORY}/blob/dev/docs/development.md`}>{t("download.build")}</a></Button>
          <Button size="sm" asChild><a href={LATEST_RELEASE_URL}>{t("download.latest")}<ArrowUpRightIcon /></a></Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
