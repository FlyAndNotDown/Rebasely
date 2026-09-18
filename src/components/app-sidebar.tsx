import { FilesIcon, HistoryIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { useGit, type View } from "@/state/git-context";

const items: { view: View; label: string; icon: typeof FilesIcon }[] = [
  { view: "changes", label: "Changes", icon: FilesIcon },
  { view: "history", label: "History", icon: HistoryIcon },
];

export function AppSidebar() {
  const { view, setView } = useGit();

  return (
    <nav className="flex w-14 shrink-0 flex-col items-center gap-1 border-r bg-sidebar py-2">
      {items.map((item) => {
        const Icon = item.icon;
        const active = view === item.view;
        return (
          <Tooltip key={item.view}>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label={item.label}
                aria-current={active ? "page" : undefined}
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
    </nav>
  );
}
