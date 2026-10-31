import { t, useTranslation } from "@/i18n";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { HoverTip } from "@/components/ui/tooltip";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { useGitPick } from "@/state/git-context";

type CommitLike = { id: string; shortId: string; summary: string };

function commitSubject(summary: string) {
  return summary.split(/\r?\n/, 1)[0]?.replace(/\s+/g, " ").trim() ?? "";
}

export function CommitLine({ commit }: { commit?: { shortId: string; summary: string } | null }) {
  useTranslation();
  if (!commit) return null;
  const subject = commitSubject(commit.summary);
  return (
    <div className="mt-2 flex w-full min-w-0 items-baseline gap-2 font-mono text-xs">
      <span className="shrink-0 text-foreground">{commit.shortId}</span>
      {subject ? (
        <HoverTip label={subject}>
          <span className="min-w-0 truncate text-muted-foreground">{subject}</span>
        </HoverTip>
      ) : null}
    </div>
  );
}

/** Creates a branch at `commit`, or at HEAD when no commit is given. */
export function CreateBranchDialog({
  open,
  onOpenChange,
  commit,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  commit?: CommitLike | null;
}) {
  useTranslation();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        {/* The form unmounts when the dialog closes, so every open starts empty. */}
        <BranchForm commit={commit ?? null} onDone={() => onOpenChange(false)} />
      </DialogContent>
    </Dialog>
  );
}

function BranchForm({ commit, onDone }: { commit: CommitLike | null; onDone: () => void }) {
  useTranslation();
  const { createBranch } = useGitPick(["createBranch"]);
  const [name, setName] = useState("");
  const [checkout, setCheckout] = useState(true);
  const [busy, setBusy] = useState(false);

  return (
    <form
      className="min-w-0"
      onSubmit={(event) => {
        event.preventDefault();
        const trimmed = name.trim();
        if (!trimmed || busy) return;
        setBusy(true);
        void createBranch(trimmed, checkout, commit?.id).then((ok) => {
          setBusy(false);
          if (ok) onDone();
        });
      }}
    >
      <DialogHeader className="min-w-0">
        <DialogTitle>{t("git.ui.create_branch")}</DialogTitle>
        <DialogDescription>
          {commit ? t("git.ui.starts_a_branch_at_this_commit") : t("git.ui.starts_a_branch_at_the_current_head")}
        </DialogDescription>
      </DialogHeader>
      <CommitLine commit={commit} />
      <Input
        className="mt-3 font-mono"
        autoFocus
        placeholder={t("git.dynamic.branchExample")}
        value={name}
        onChange={(event) => setName(event.target.value)}
      />
      <label className="mt-3 flex items-center gap-2 text-sm">
        <Checkbox checked={checkout} onCheckedChange={(value) => setCheckout(value === true)} />
        <span>{t("git.ui.check_out_after_creating")}</span>
      </label>
      <DialogFooter className="mt-4">
        <Button type="button" variant="outline" onClick={onDone}>{t("git.ui.cancel")}</Button>
        <Button type="submit" disabled={!name.trim() || busy}>{t("git.ui.create")}</Button>
      </DialogFooter>
    </form>
  );
}

/** Creates a tag on `commit`, or on HEAD when no commit is given. */
export function CreateTagDialog({
  open,
  onOpenChange,
  commit,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  commit?: CommitLike | null;
}) {
  useTranslation();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <TagForm commit={commit ?? null} onDone={() => onOpenChange(false)} />
      </DialogContent>
    </Dialog>
  );
}

function TagForm({ commit, onDone }: { commit: CommitLike | null; onDone: () => void }) {
  useTranslation();
  const { createTag } = useGitPick(["createTag"]);
  const [name, setName] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);

  return (
    <form
      className="min-w-0"
      onSubmit={(event) => {
        event.preventDefault();
        const trimmed = name.trim();
        if (!trimmed || busy) return;
        setBusy(true);
        void createTag(trimmed, message.trim() || undefined, commit?.id).then((ok) => {
          setBusy(false);
          if (ok) onDone();
        });
      }}
    >
      <DialogHeader className="min-w-0">
        <DialogTitle>{t("git.ui.create_tag")}</DialogTitle>
        <DialogDescription>
          {commit ? t("git.ui.tags_this_commit") : t("git.ui.tags_the_current_commit")}{" "}{t("git.ui.a_message_makes_it_an_annotated_tag")}</DialogDescription>
      </DialogHeader>
      <CommitLine commit={commit} />
      <Input
        className="mt-3 font-mono"
        autoFocus
        placeholder={t("git.dynamic.tagExample")}
        value={name}
        onChange={(event) => setName(event.target.value)}
      />
      <Input
        className="mt-3"
        placeholder={t("git.ui.message_optional")}
        value={message}
        onChange={(event) => setMessage(event.target.value)}
      />
      <DialogFooter className="mt-4">
        <Button type="button" variant="outline" onClick={onDone}>{t("git.ui.cancel")}</Button>
        <Button type="submit" disabled={!name.trim() || busy}>{t("git.ui.create")}</Button>
      </DialogFooter>
    </form>
  );
}
