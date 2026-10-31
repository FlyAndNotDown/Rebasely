import { useRef, useState, type MouseEvent, type RefObject } from "react";
import {
  ArrowDownToLineIcon,
  ArrowUpRightIcon,
  CheckIcon,
  ChevronRightIcon,
  CodeXmlIcon,
  CommandIcon,
  FolderGit2Icon,
  GitBranchIcon,
  LaptopIcon,
  MonitorIcon,
  MoonIcon,
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
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Separator } from "@/components/ui/separator";
import { HoverTip } from "@/components/ui/tooltip";
import { WorkspacePreview } from "./workspace-preview";

const REPOSITORY = "https://github.com/FlyAndNotDown/Rebasely";
const RELEASES = `${REPOSITORY}/releases`;

export function Site() {
  const [downloadOpen, setDownloadOpen] = useState(false);
  const downloadTrigger = useRef<HTMLButtonElement | null>(null);

  function openDownload(event: MouseEvent<HTMLButtonElement>) {
    downloadTrigger.current = event.currentTarget;
    setDownloadOpen(true);
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
            <a href="#workspace">Overview</a>
          </Button>
          <Button variant="ghost" size="sm" onClick={openDownload}>Download</Button>
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
            <p>Review changes. Follow history.<br />Move between projects without losing context.</p>
            <div className="site-actions">
              <Button size="lg" onClick={openDownload}>
                <ArrowDownToLineIcon data-icon="inline-start" />
                Download
              </Button>
              <Button variant="outline" size="lg" asChild>
                <a href={REPOSITORY}>Source <ArrowUpRightIcon data-icon="inline-end" /></a>
              </Button>
            </div>
            <p className="site-platforms">macOS Apple Silicon · Windows · Linux</p>
          </div>
        </section>

        <section id="workspace" className="site-workspace" aria-labelledby="workspace-title">
          <div className="site-preview-label">
            <h2 id="workspace-title">One workspace. A clear next step.</h2>
            <span>Interactive illustration</span>
          </div>
          <WorkspacePreview />
          <p className="site-preview-caption">Explore the views in the sidebar. All repository data shown is illustrative.</p>
        </section>

        <section className="site-features" aria-label="Made for your workflow">
          <Feature icon={GitBranchIcon} title="Understand the change.">
            Compare revisions, follow the graph, and review a file, hunk, or line.
          </Feature>
          <Feature icon={FolderGit2Icon} title="Keep projects together.">
            Git repositories and Perforce workspaces. Tabs that stay with you.
          </Feature>
          <Feature icon={CommandIcon} title="Stay in flow.">
            Familiar shortcuts, a command palette, and light or dark themes.
          </Feature>
        </section>

        <Separator />
        <section className="site-download" aria-labelledby="download-title">
          <div>
            <h2 id="download-title">Ready for your next change.</h2>
            <p>Open a repository. Pick up where you left off.</p>
          </div>
          <Button size="lg" onClick={openDownload}>Get Rebasely <ArrowUpRightIcon data-icon="inline-end" /></Button>
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
      <DownloadDialog open={downloadOpen} onOpenChange={setDownloadOpen} returnFocusTo={downloadTrigger} />
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
        {([
          { value: "light", label: "Light", icon: SunIcon },
          { value: "dark", label: "Dark", icon: MoonIcon },
          { value: "system", label: "System", icon: MonitorIcon },
        ] as const).map(({ value, label, icon: Icon }) => (
          <DropdownMenuItem key={value} onSelect={() => setTheme(value)}>
            <Icon /><span className="flex-1">{label}</span>{theme === value ? <CheckIcon className="size-3.5" /> : null}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function DownloadDialog({ open, onOpenChange, returnFocusTo }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  returnFocusTo: RefObject<HTMLButtonElement | null>;
}) {
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
          <DialogDescription>Browse release builds for your desktop.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-1">
          {[
            { label: "macOS", detail: "Apple Silicon", format: "DMG", icon: LaptopIcon },
            { label: "Windows", detail: "x64", format: "Installer", icon: MonitorIcon },
            { label: "Linux", detail: "x64", format: "AppImage / DEB", icon: CodeXmlIcon },
          ].map(({ label, detail, format, icon: Icon }) => (
            <Button key={label} variant="ghost" asChild className="h-auto justify-start gap-3 px-2 py-3">
              <a href={RELEASES}>
                <Icon className="size-5 text-muted-foreground" />
                <span className="grid min-w-0 flex-1 gap-1 text-left">
                  <span>{label} <span className="ml-1 text-xs font-normal text-muted-foreground">{detail}</span></span>
                  <span className="text-xs font-normal text-muted-foreground">{format}</span>
                </span>
                <ChevronRightIcon className="text-muted-foreground" />
              </a>
            </Button>
          ))}
        </div>
        <p className="text-xs leading-relaxed text-muted-foreground">Requires Git, or the Perforce CLI for Perforce workspaces.</p>
        <DialogFooter className="items-center sm:justify-between">
          <Button variant="ghost" size="sm" asChild>
            <a href={`${REPOSITORY}/blob/dev/docs/development.md`}>Build from source</a>
          </Button>
          <Button size="sm" asChild><a href={RELEASES}>Browse releases <ArrowUpRightIcon data-icon="inline-end" /></a></Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
