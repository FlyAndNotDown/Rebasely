import { useState } from "react";
import { ArchiveIcon, CircleDotIcon, HistoryIcon, SettingsIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { SettingsDialog } from "@/components/settings-dialog";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { useGit, type View } from "@/state/git-context";

const items: { view: View; label: string; icon: typeof CircleDotIcon }[] = [
  { view: "changes", label: "Changes", icon: CircleDotIcon },
  { view: "history", label: "History", icon: HistoryIcon },
  { view: "stash", label: "Stash", icon: ArchiveIcon },
];

export function AppSidebar() {
  const { view, setView, activeTab } = useGit();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const repoOpen = activeTab.kind === "repo";

  return (
    <nav className="flex w-14 shrink-0 flex-col items-center gap-1 border-r bg-sidebar py-2">
      {items.map((item) => {
        const Icon = item.icon;
        const active = repoOpen && view === item.view;
        return (
          <Tooltip key={item.view}>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label={item.label}
                aria-current={active ? "page" : undefined}
                disabled={!repoOpen}
                className={cn(active && "bg-muted text-foreground")}
                onClick={() => setView(item.view)}
              >
                <Icon />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="right">{item.label}</TooltipContent>
          </Tooltip>
        );
      })}
      <div className="mt-auto">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label="Settings"
              onClick={() => setSettingsOpen(true)}
            >
              <SettingsIcon />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="right">Settings</TooltipContent>
        </Tooltip>
      </div>
      <SettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} />
    </nav>
  );
}
