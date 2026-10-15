import { useMemo, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { ClockIcon, DownloadIcon, FolderOpenIcon, InfoIcon, LogOutIcon, MenuIcon, SettingsIcon } from "lucide-react";
import { AboutDialog } from "@/components/about-dialog";
import { CloneRepositoryDialog } from "@/components/lazy-dialogs";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { disambiguateRepoLabels, displayPath } from "@/lib/format";
import { useGitPick } from "@/state/git-context";

export function AppMenu() {
  const { recents, openFolder, openPath, setOpenPanel } = useGitPick([
    "recents",
    "openFolder",
    "openPath",
    "setOpenPanel",
  ]);
  const [menuOpen, setMenuOpen] = useState(false);
  const [tooltipOpen, setTooltipOpen] = useState(false);
  const [cloneOpen, setCloneOpen] = useState(false);
  const [aboutOpen, setAboutOpen] = useState(false);
  const hovering = useRef(false);
  const menuOpenRef = useRef(false);
  const labels = useMemo(() => disambiguateRepoLabels(recents), [recents]);

  return (
    <div className="flex h-full shrink-0 items-center pl-1.5">
      <DropdownMenu
        open={menuOpen}
        onOpenChange={(next) => {
          menuOpenRef.current = next;
          setMenuOpen(next);
          if (next || !hovering.current) setTooltipOpen(false);
        }}
      >
        <Tooltip
          open={menuOpen ? false : tooltipOpen}
          onOpenChange={(next) => {
            if (next && (menuOpenRef.current || !hovering.current)) return;
            setTooltipOpen(next);
          }}
        >
          <TooltipTrigger
            asChild
            onPointerEnter={() => {
              hovering.current = true;
            }}
            onPointerLeave={() => {
              hovering.current = false;
            }}
          >
            <DropdownMenuTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                className="size-8 text-muted-foreground"
                aria-label="Options"
              >
                <MenuIcon />
              </Button>
            </DropdownMenuTrigger>
          </TooltipTrigger>
          <TooltipContent>Options</TooltipContent>
        </Tooltip>
        <DropdownMenuContent align="start" className="w-56">
          <DropdownMenuItem onSelect={() => void openFolder()}>
            <FolderOpenIcon />
            Open repository
          </DropdownMenuItem>
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>
              <ClockIcon />
              Recent repositories
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent className="w-72 p-0">
              <div className="max-h-80 overflow-y-auto p-1 [scrollbar-width:thin]">
                {recents.length === 0 ? (
                  <DropdownMenuItem disabled>No recent repositories</DropdownMenuItem>
                ) : (
                  recents.map((repo) => {
                    const label = labels.get(repo.path) ?? repo.name;
                    const path = displayPath(repo.path);
                    return (
                      <DropdownMenuItem
                        key={repo.path}
                        title={path}
                        onSelect={() => void openPath(repo.path)}
                      >
                            <span className="flex w-full min-w-0 flex-col">
                          <span className="truncate">{label}</span>
                          <span className="truncate font-mono text-[11px] text-muted-foreground">
                            {path}
                          </span>
                        </span>
                      </DropdownMenuItem>
                    );
                  })
                )}
              </div>
            </DropdownMenuSubContent>
          </DropdownMenuSub>
          <DropdownMenuItem onSelect={() => setCloneOpen(true)}>
            <DownloadIcon />
            Clone repository
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => setOpenPanel("settings")}>
            <SettingsIcon />
            Settings
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => setAboutOpen(true)}>
            <InfoIcon />
            About
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => void getCurrentWindow().close()}>
            <LogOutIcon />
            Exit
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <CloneRepositoryDialog open={cloneOpen} onOpenChange={setCloneOpen} />
      <AboutDialog open={aboutOpen} onOpenChange={setAboutOpen} />
    </div>
  );
}
