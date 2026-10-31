import { t, useTranslation } from "@/i18n";
import { useEffect, useState } from "react";
import { EllipsisIcon } from "lucide-react";
import { CreateBranchDialog } from "@/components/create-ref-dialogs";
import { Button } from "@/components/ui/button";
import { HoverTip } from "@/components/ui/tooltip";
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
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ScrollArea } from "@/components/ui/scroll-area";
import { formatAbsoluteTime, formatRelativeTime } from "@/lib/format";
import { errorMessage, gitApi } from "@/lib/git";
import { useGitPick, type ResetMode } from "@/state/git-context";
import type { ReflogEntry } from "@/types/git";

export function ReflogDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  useTranslation();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex h-[min(40rem,calc(100vh-4rem))] flex-col gap-3 overflow-hidden sm:max-w-4xl">
        {/* Mounted per open so the list is read fresh each time. */}
        <ReflogList onClose={() => onOpenChange(false)} />
      </DialogContent>
    </Dialog>
  );
}

function splitMessage(message: string) {
  const colon = message.indexOf(": ");
  if (colon <= 0) return { action: "", detail: message };
  return { action: message.slice(0, colon), detail: message.slice(colon + 2) };
}

function ReflogList({ onClose }: { onClose: () => void }) {
  useTranslation();
  const { snapshot, resetCommit, checkoutDetached, selectCommit } = useGitPick([
    "snapshot",
    "resetCommit",
    "checkoutDetached",
    "selectCommit",
  ]);
  const repoPath = snapshot?.repo.path;
  const branch = snapshot?.repo.isDetached ? null : snapshot?.repo.currentBranch;
  const [entries, setEntries] = useState<ReflogEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [branchFrom, setBranchFrom] = useState<ReflogEntry | null>(null);
  const [hardReset, setHardReset] = useState<ReflogEntry | null>(null);

  useEffect(() => {
    if (!repoPath) return;
    let live = true;
    gitApi
      .headReflog(repoPath)
      .then((items) => {
        if (live) setEntries(items);
      })
      .catch((err) => {
        if (live) setError(errorMessage(err));
      });
    return () => {
      live = false;
    };
  }, [repoPath]);

  function reset(entry: ReflogEntry, mode: ResetMode) {
    if (mode === "hard") {
      setHardReset(entry);
      return;
    }
    onClose();
    void resetCommit(entry.id, mode);
  }

  return (
    <>
      <DialogHeader>
        <DialogTitle>{t("git.ui.reflog")}</DialogTitle>
        <DialogDescription>{t("git.ui.recover_work_from_recent_head_positions")}</DialogDescription>
      </DialogHeader>
      <ScrollArea className="min-h-0 flex-1 rounded-md border">
        <div className="sticky top-0 z-10 flex h-8 items-center gap-3 border-b bg-popover px-3 text-[11px] text-muted-foreground">
          <span className="w-24 shrink-0">{t("git.ui.ref")}</span>
          <span className="w-16 shrink-0">{t("git.ui.commit")}</span>
          <span className="min-w-0 flex-1">{t("git.ui.description")}</span>
          <span className="w-20 shrink-0 text-right">{t("git.ui.when")}</span>
          <span className="size-6 shrink-0" />
        </div>
        {error ? <p role="alert" className="p-4 text-sm text-destructive">{error}</p> : null}
        {!error && entries === null ? <p role="status" className="p-4 text-sm text-muted-foreground">{t("git.ui.loading")}</p> : null}
        {entries?.length === 0 ? <p className="p-4 text-sm text-muted-foreground">{t("git.ui.the_reflog_is_empty")}</p> : null}
        {entries?.map((entry) => {
          const { action, detail } = splitMessage(entry.message);
          const title = [entry.message, entry.summary].filter(Boolean).join("\n");
          return (
            <div key={entry.selector} className="flex h-8 items-center gap-3 border-b px-3 last:border-b-0 hover:bg-muted/50">
              <span className="w-24 shrink-0 truncate font-mono text-[11px] text-muted-foreground">{entry.selector}</span>
              <span className="w-16 shrink-0 font-mono text-[11px]">{entry.shortId}</span>
              <HoverTip label={title}>
              <div className="min-w-0 flex-1 truncate text-sm">
                {action ? <span className="mr-1.5 font-medium">{action}</span> : null}
                <span className="text-muted-foreground">{detail}</span>
              </div>
              </HoverTip>
              <HoverTip label={formatAbsoluteTime(entry.timestamp)}>
              <span className="w-20 shrink-0 text-right text-[11px] text-muted-foreground tabular-nums">
                {formatRelativeTime(entry.timestamp)}
              </span>
              </HoverTip>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" size="icon-xs" aria-label={t("git.dynamic.reflogActions", { ref: entry.selector })}>
                    <EllipsisIcon />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="min-w-48">
                  <DropdownMenuItem
                    onClick={() => {
                      onClose();
                      void selectCommit(entry.id);
                    }}
                  >{t("git.ui.show_in_history")}</DropdownMenuItem>
                  <DropdownMenuItem onClick={() => setBranchFrom(entry)}>{t("git.ui.create_branch_here")}</DropdownMenuItem>
                  <DropdownMenuItem
                    onClick={() => {
                      onClose();
                      void checkoutDetached(entry.id);
                    }}
                  >{t("git.ui.check_out_without_a_branch")}</DropdownMenuItem>
                  {branch ? (
                    <>
                      <DropdownMenuSeparator />
                      <DropdownMenuSub>
                        <DropdownMenuSubTrigger>{t("git.dynamic.resetHere", { branch })}</DropdownMenuSubTrigger>
                        <DropdownMenuSubContent>
                          <DropdownMenuItem onClick={() => reset(entry, "soft")}>{t("git.ui.soft_keep_changes_staged")}</DropdownMenuItem>
                          <DropdownMenuItem onClick={() => reset(entry, "mixed")}>{t("git.ui.mixed_keep_changes_unstaged")}</DropdownMenuItem>
                          <DropdownMenuItem variant="destructive" onClick={() => reset(entry, "hard")}>{t("git.ui.hard_discard_changes")}</DropdownMenuItem>
                        </DropdownMenuSubContent>
                      </DropdownMenuSub>
                    </>
                  ) : null}
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          );
        })}
      </ScrollArea>
      <CreateBranchDialog
        open={branchFrom !== null}
        onOpenChange={(open) => !open && setBranchFrom(null)}
        commit={branchFrom ? { id: branchFrom.id, shortId: branchFrom.shortId, summary: branchFrom.summary } : null}
      />
      <Dialog open={hardReset !== null} onOpenChange={(open) => !open && setHardReset(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("git.dynamic.hardResetTitle", { branch })}</DialogTitle>
            <DialogDescription>
              {t("git.dynamic.hardResetDescription", { branch, target: hardReset?.shortId })}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setHardReset(null)}>{t("git.ui.cancel")}</Button>
            <Button
              variant="destructive"
              onClick={() => {
                const entry = hardReset;
                setHardReset(null);
                if (!entry) return;
                onClose();
                void resetCommit(entry.id, "hard");
              }}
            >{t("git.ui.reset")}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
