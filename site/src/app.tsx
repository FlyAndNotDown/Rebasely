import { useEffect, useRef, useState, type MouseEvent, type RefObject } from "react";
import {
  ArrowDownToLineIcon,
  ArrowUpRightIcon,
  ChevronRightIcon,
  CodeXmlIcon,
  CommandIcon,
  FolderGit2Icon,
  GitBranchIcon,
  LaptopIcon,
  MonitorIcon,
  MoonIcon,
  RefreshCwIcon,
  SunIcon,
} from "lucide-react";
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
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Separator } from "@/components/ui/separator";
import { HoverTip } from "@/components/ui/tooltip";
import { WorkspacePreview } from "./workspace-preview";
import { fetchReleaseDownloads, LATEST_RELEASE_URL, REPOSITORY_URL, type ReleaseDownloads } from "./release-downloads";

const REPOSITORY = REPOSITORY_URL;
type DownloadState = { kind: "idle" | "pending" | "error" } | { kind: "ready"; downloads: ReleaseDownloads };

export function Site() {
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
      <a className="site-skip" href="#main">Skip to content</a>
      <header className="site-header site-container">
        <a className="site-brand" href="./" aria-label="Rebasely home">
          <AppMark className="size-8" iconClassName="size-4" />
          <span>Rebasely</span>
        </a>
        <nav className="site-navigation" aria-label="Main navigation">
          <Button variant="ghost" size="sm" asChild className="overview-link">
            <a href="#features">Features</a>
          </Button>
          <Button variant="ghost" size="sm" asChild><a href={LATEST_RELEASE_URL} onClick={openDownload}>Download</a></Button>
          <HoverTip label="Source on GitHub">
            <Button variant="ghost" size="icon-sm" asChild>
              <a href={REPOSITORY} aria-label="Source on GitHub"><CodeXmlIcon /></a>
            </Button>
          </HoverTip>
          <Separator orientation="vertical" className="mx-1 h-4" />
          <ThemeMenu />
        </nav>
      </header>

      <main id="main" className="site-container">
        <section className="site-hero" aria-labelledby="hero-title">
          <div>
            <p className="site-eyebrow">YOUR WORK, IN VIEW.</p>
            <h1 id="hero-title">A unified<br />version control client.</h1>
          </div>
          <div className="site-hero-actions">
            <p>Review changes. Prepare the next commit.<br />Move between projects without losing context.</p>
            <div className="site-actions">
              <Button size="lg" asChild>
                <a href={LATEST_RELEASE_URL} onClick={openDownload}>
                  <ArrowDownToLineIcon data-icon="inline-start" />
                  Download
                </a>
              </Button>
              <Button variant="outline" size="lg" asChild>
                <a href={REPOSITORY}>Source <ArrowUpRightIcon data-icon="inline-end" /></a>
              </Button>
            </div>
            <p className="site-platforms">macOS Apple Silicon · Windows x64</p>
          </div>
        </section>

        <section id="features" className="site-workspace" aria-labelledby="workspace-title">
          <div className="site-preview-label">
            <div><p className="site-eyebrow">FEATURES</p><h2 id="workspace-title">Try the next step.</h2></div>
            <span>Interactive demo · Sample data</span>
          </div>
          <noscript className="site-preview-caption">Enable JavaScript to try the interactive demo. Product details and download links remain available below.</noscript>
          <WorkspacePreview />
          <p className="site-preview-caption">Supports Git repositories and Perforce workspaces. Try either tab with sample data; changes stay in this demo.</p>
        </section>

        <section className="site-features" aria-label="Made for your workflow">
          <Feature icon={GitBranchIcon} title="Review the right scope.">
            Inspect unified or split diffs, compare images, and stage a file, hunk, or selected line.
          </Feature>
          <Feature icon={FolderGit2Icon} title="Follow the whole change.">
            Navigate Git graphs and file history. Review Perforce pending work, shelves, and submitted changelists.
          </Feature>
          <Feature icon={CommandIcon} title="Keep your context.">
            Switch projects in tabs. Reach actions from the command palette, with familiar shortcuts and light or dark themes.
          </Feature>
        </section>

        <section className="site-get-started" aria-labelledby="start-title">
          <div className="site-section-intro"><p className="site-eyebrow">GET STARTED</p><h2 id="start-title">Start with a repository.</h2></div>
          <ol>
            <li><span>01</span><div><h3>Install your tools.</h3><p>Get Rebasely and install Git, or the Perforce CLI for your workspace.</p></div></li>
            <li><span>02</span><div><h3>Bring your work.</h3><p>Open or clone a Git repository. Connect an existing Perforce workspace.</p></div></li>
            <li><span>03</span><div><h3>Make the next change.</h3><p>Choose a file, review its diff, and prepare your commit or changelist.</p></div></li>
          </ol>
        </section>
        <Separator />
        <section className="site-download" aria-labelledby="download-title">
          <div>
            <h2 id="download-title">Ready for your next change.</h2>
            <p>Open source under the MIT License. Diagnostics are local and are not uploaded automatically.</p>
          </div>
          <Button size="lg" asChild><a href={LATEST_RELEASE_URL} onClick={openDownload}>Get Rebasely <ArrowUpRightIcon data-icon="inline-end" /></a></Button>
        </section>
      </main>

      <footer className="site-footer site-container">
        <span>Rebasely <span className="site-footer-tagline">· A unified version control client.</span></span>
        <nav aria-label="Footer navigation">
          <a href={`${REPOSITORY}/issues`}>Feedback</a>
          <a href={`${REPOSITORY}/blob/dev/CONTRIBUTING.md`}>Contribute</a>
          <a href={`${REPOSITORY}/blob/dev/LICENSE`}>MIT License</a>
        </nav>
      </footer>
      <DownloadDialog open={downloadOpen} onOpenChange={changeDownloadOpen} returnFocusTo={downloadTrigger} state={downloads} onRefresh={() => loadDownloads(true)} />
    </>
  );
}

function Feature({ icon: Icon, title, children }: {
  icon: typeof GitBranchIcon;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="site-feature">
      <Icon className="size-4 text-muted-foreground" aria-hidden="true" />
      <h3>{title}</h3>
      <p>{children}</p>
    </div>
  );
}

function ThemeMenu() {
  const { theme, setTheme } = useSiteTheme();

  return (
    <DropdownMenu>
      <HoverTip label="Appearance">
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon-sm" aria-label="Appearance">
            <SunIcon className="hidden dark:block" />
            <MoonIcon className="dark:hidden" />
          </Button>
        </DropdownMenuTrigger>
      </HoverTip>
      <DropdownMenuContent align="end" className="w-36">
        <DropdownMenuRadioGroup value={theme} onValueChange={(value) => {
          if (value === "light" || value === "dark" || value === "system") setTheme(value);
        }}>
        {([
          { value: "light", label: "Light", icon: SunIcon },
          { value: "dark", label: "Dark", icon: MoonIcon },
          { value: "system", label: "System", icon: MonitorIcon },
        ] as const).map(({ value, label, icon: Icon }) => (
          <DropdownMenuRadioItem key={value} value={value}>
            <Icon /><span>{label}</span>
          </DropdownMenuRadioItem>
        ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function DownloadDialog({ open, onOpenChange, returnFocusTo, state, onRefresh }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  returnFocusTo: RefObject<HTMLAnchorElement | null>;
  state: DownloadState;
  onRefresh: () => void;
}) {
  const downloads = state.kind === "ready" ? state.downloads : null;
  const complete = downloads?.macos && downloads.windows;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="sm:max-w-md"
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          returnFocusTo.current?.focus();
        }}
      >
        <DialogHeader>
          <DialogTitle>Get Rebasely</DialogTitle>
          <DialogDescription>Get the latest build for your desktop.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-1">
          {[
            { label: "macOS", detail: "Apple Silicon", format: "DMG", icon: LaptopIcon, url: downloads?.macos },
            { label: "Windows", detail: "x64", format: "Installer", icon: MonitorIcon, url: downloads?.windows },
          ].map(({ label, detail, format, icon: Icon, url }) => (
            <Button key={label} variant="ghost" asChild className="h-auto justify-start gap-3 px-2 py-3">
              <a href={url ?? LATEST_RELEASE_URL}>
                <Icon className="size-5 text-muted-foreground" />
                <span className="grid min-w-0 flex-1 gap-1 text-left">
                  <span>{label} <span className="ml-1 text-xs font-normal text-muted-foreground">{detail}</span></span>
                  <span className="text-xs font-normal text-muted-foreground">{url ? format : "View latest release"}</span>
                </span>
                {url ? <ArrowDownToLineIcon className="text-muted-foreground" /> : <ChevronRightIcon className="text-muted-foreground" />}
              </a>
            </Button>
          ))}
        </div>
        <div className="flex items-center gap-3">
          <p role={state.kind === "error" ? "alert" : "status"} className="min-w-0 flex-1 text-xs leading-relaxed text-muted-foreground">
            {state.kind === "pending" ? "Finding the latest downloads…" : state.kind === "error" ? "Direct links unavailable. Open the latest release." : complete ? `Latest release · ${downloads.tag}` : "Choose a platform to view the latest release."}
          </p>
          <Button size="sm" variant="ghost" disabled={state.kind === "pending"} onClick={onRefresh}>
            <RefreshCwIcon />{state.kind === "error" ? "Retry" : "Refresh"}
          </Button>
        </div>
        <p className="text-xs leading-relaxed text-muted-foreground">Requires Git, or the Perforce CLI for Perforce workspaces.</p>
        <DialogFooter className="items-center sm:justify-between">
          <Button variant="ghost" size="sm" asChild>
            <a href={`${REPOSITORY}/blob/dev/docs/development.md`}>Build from source</a>
          </Button>
          <Button size="sm" asChild><a href={LATEST_RELEASE_URL}>Latest release <ArrowUpRightIcon data-icon="inline-end" /></a></Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
