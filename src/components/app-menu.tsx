import { useMemo, useState, type ReactNode } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  ChevronDownIcon,
  ChevronRightIcon,
  ClockIcon,
  DownloadIcon,
  FolderOpenIcon,
  LogOutIcon,
  MenuIcon,
  SettingsIcon,
} from "lucide-react";
import { Popover as PopoverPrimitive } from "radix-ui";
import { CloneRepositoryDialog } from "@/components/lazy-dialogs";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { disambiguateRepoLabels, displayPath } from "@/lib/format";
import { cn } from "@/lib/utils";
import { useGitPick } from "@/state/git-context";

type AppMenuSection = "file" | "settings";

export function AppMenu() {
  const { recents, openFolder, openPath, setOpenPanel } = useGitPick([
    "recents",
    "openFolder",
    "openPath",
    "setOpenPanel",
  ]);
  const [open, setOpen] = useState(false);
  const [section, setSection] = useState<AppMenuSection>("file");
  const [recentsOpen, setRecentsOpen] = useState(false);
  const [cloneOpen, setCloneOpen] = useState(false);
  const labels = useMemo(() => disambiguateRepoLabels(recents), [recents]);

  function handleOpenChange(next: boolean) {
    if (next) {
      setSection("file");
      setRecentsOpen(false);
    }
    setOpen(next);
  }

  function choose(action: () => void) {
    setOpen(false);
    action();
  }

  return (
    <div className="flex h-full shrink-0 items-center pl-1.5">
      <PopoverPrimitive.Root open={open} onOpenChange={handleOpenChange}>
        <Tooltip open={open ? false : undefined}>
          <TooltipTrigger asChild>
            <PopoverPrimitive.Trigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                className="size-8 text-muted-foreground"
                aria-label="Options"
              >
                <MenuIcon />
              </Button>
            </PopoverPrimitive.Trigger>
          </TooltipTrigger>
          <TooltipContent>Options</TooltipContent>
        </Tooltip>
        <PopoverPrimitive.Portal>
          <PopoverPrimitive.Content
            align="start"
            sideOffset={4}
            collisionPadding={8}
            className="z-50 w-80 origin-(--radix-popover-content-transform-origin) rounded-lg bg-popover p-2 text-popover-foreground shadow-md ring-1 ring-foreground/10 outline-none duration-100 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95"
          >
            <Tabs
              value={section}
              onValueChange={(value) => setSection(value as AppMenuSection)}
              className="gap-0"
            >
              <TabsList className="w-full">
                <TabsTrigger value="file">File</TabsTrigger>
                <TabsTrigger value="settings">Settings</TabsTrigger>
              </TabsList>
              <div className="mt-2">
                <TabsContent value="file">
                  <div className="flex flex-col gap-0.5">
                    <MenuRow
                      icon={FolderOpenIcon}
                      label="Open repository"
                      onClick={() => choose(() => void openFolder())}
                    />
                    <MenuRow
                      icon={ClockIcon}
                      label="Recent repositories"
                      expanded={recentsOpen}
                      onClick={() => setRecentsOpen((current) => !current)}
                      trailing={
                        recentsOpen ? (
                          <ChevronDownIcon className="size-4 text-muted-foreground" />
                        ) : (
                          <ChevronRightIcon className="size-4 text-muted-foreground" />
                        )
                      }
                    />
                    {recentsOpen ? (
                      <div
                        id="app-menu-recents"
                        className="ml-4 max-h-64 overflow-y-auto border-l pl-1 [scrollbar-width:thin]"
                      >
                        {recents.length === 0 ? (
                          <p className="px-2 py-1.5 text-xs text-muted-foreground">No recent repositories</p>
                        ) : (
                          <ul>
                            {recents.map((repo) => {
                              const label = labels.get(repo.path) ?? repo.name;
                              const path = displayPath(repo.path);
                              return (
                                <li key={repo.path}>
                                  <button
                                    type="button"
                                    className="flex w-full min-w-0 flex-col rounded-md px-2 py-1.5 text-left outline-none hover:bg-accent hover:text-accent-foreground focus-visible:bg-accent focus-visible:text-accent-foreground"
                                    title={path}
                                    onClick={() => choose(() => void openPath(repo.path))}
                                  >
                                    <span className="truncate text-sm">{label}</span>
                                    <span className="truncate font-mono text-[11px] text-muted-foreground">
                                      {path}
                                    </span>
                                  </button>
                                </li>
                              );
                            })}
                          </ul>
                        )}
                      </div>
                    ) : null}
                    <MenuRow
                      icon={DownloadIcon}
                      label="Clone repository"
                      onClick={() => choose(() => setCloneOpen(true))}
                    />
                  </div>
                </TabsContent>
                <TabsContent value="settings">
                  <MenuRow
                    icon={SettingsIcon}
                    label="Open settings"
                    onClick={() => choose(() => setOpenPanel("settings"))}
                  />
                </TabsContent>
              </div>
            </Tabs>
            <div className="-mx-2 mt-2 border-t px-2 pt-2">
              <Button
                type="button"
                variant="outline"
                className="w-full"
                onClick={() => void getCurrentWindow().close()}
              >
                <LogOutIcon data-icon="inline-start" />
                Exit
              </Button>
            </div>
          </PopoverPrimitive.Content>
        </PopoverPrimitive.Portal>
      </PopoverPrimitive.Root>
      <CloneRepositoryDialog open={cloneOpen} onOpenChange={setCloneOpen} />
    </div>
  );
}

function MenuRow({
  icon: Icon,
  label,
  onClick,
  trailing,
  expanded,
}: {
  icon: typeof FolderOpenIcon;
  label: string;
  onClick: () => void;
  trailing?: ReactNode;
  expanded?: boolean;
}) {
  return (
    <button
      type="button"
      className={cn(
        "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm outline-none hover:bg-accent hover:text-accent-foreground focus-visible:bg-accent focus-visible:text-accent-foreground",
        expanded && "bg-muted",
      )}
      aria-expanded={expanded}
      aria-controls={expanded === undefined ? undefined : "app-menu-recents"}
      onClick={onClick}
    >
      <Icon className="size-4 shrink-0" />
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {trailing}
    </button>
  );
}
