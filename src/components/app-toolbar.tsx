import { useState, type ReactNode } from "react";
import {
  ArrowDownFromLineIcon,
  ArrowDownToLineIcon,
  ArrowUpFromLineIcon,
  CheckIcon,
  ChevronDownIcon,
  FileInputIcon,
  Settings2Icon,
} from "lucide-react";
import { Popover as PopoverPrimitive } from "radix-ui";
import { RepoSettingsDialog } from "@/components/lazy-dialogs";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
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
import { Label } from "@/components/ui/label";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { defaultFetchRemote, primaryRemote, useGitPick } from "@/state/git-context";

type SyncAction = "fetch" | "pull" | "push" | null;

export function AppToolbar() {
  const {
    snapshot,
    prefs,
    updatePrefs,
    fetchRemote,
    fetchAllRemotes,
    pullRemote,
    pushRemote,
    publishPrompt,
    dismissPublish,
    confirmPublish,
    applyPatch,
  } = useGitPick([
    "snapshot",
    "prefs",
    "updatePrefs",
    "fetchRemote",
    "fetchAllRemotes",
    "pullRemote",
    "pushRemote",
    "publishPrompt",
    "dismissPublish",
    "confirmPublish",
    "applyPatch",
  ]);
  const [repoSettingsOpen, setRepoSettingsOpen] = useState(false);
  const [syncAction, setSyncAction] = useState<SyncAction>(null);
  if (!snapshot) return null;

  const ahead = snapshot.repo.ahead ?? 0;
  const behind = snapshot.repo.behind ?? 0;
  const primary = primaryRemote(snapshot);
  const fetchTarget = defaultFetchRemote(snapshot) ?? primary;
  const remotes = snapshot.remotes.map((remote) => remote.name);

  return (
    <>
      <div className="flex h-7 shrink-0 items-center gap-1.5 rounded-[min(var(--radius-md),12px)] border border-input bg-secondary px-0.5">
        <SyncPopover
          action="fetch"
          openAction={syncAction}
          onOpenAction={setSyncAction}
          label="Fetch"
          hint={fetchTarget ? `Fetch from ${fetchTarget}` : "Fetch"}
          icon={<ArrowDownFromLineIcon className="size-4" />}
        >
          <FetchPanel
            remotes={remotes}
            initial={fetchTarget}
            onFetch={(remote) => {
              setSyncAction(null);
              if (remote === "*") void fetchAllRemotes();
              else void fetchRemote(remote);
            }}
          />
        </SyncPopover>
        <SyncPopover
          action="pull"
          openAction={syncAction}
          onOpenAction={setSyncAction}
          label="Pull"
          hint={
            primary
              ? behind > 0
                ? `Pull from ${primary} · ${behind} behind`
                : `Pull from ${primary}`
              : "Pull"
          }
          badge={behind > 0 ? behind : undefined}
          icon={<ArrowDownToLineIcon className="size-4" />}
        >
          <PullPanel
            remotes={remotes}
            initial={primary}
            rebase={prefs.pullRebase}
            onPull={(remote, rebase) => {
              setSyncAction(null);
              if (prefs.pullRebase !== rebase) void updatePrefs({ ...prefs, pullRebase: rebase });
              void pullRemote(remote, rebase);
            }}
          />
        </SyncPopover>
        <SyncPopover
          action="push"
          openAction={syncAction}
          onOpenAction={setSyncAction}
          label="Push"
          hint={
            primary
              ? ahead > 0
                ? `Push to ${primary} · ${ahead} ahead`
                : `Push to ${primary}`
              : "Push"
          }
          badge={ahead > 0 ? ahead : undefined}
          icon={<ArrowUpFromLineIcon className="size-4" />}
        >
          <PushPanel
            remotes={remotes}
            initial={primary}
            branch={snapshot.repo.currentBranch}
            onPush={(remote, force) => {
              setSyncAction(null);
              void pushRemote({ remote, force });
            }}
          />
        </SyncPopover>
        <ToolbarAction label="Apply patch" onClick={() => void applyPatch()}>
          <FileInputIcon className="size-4" />
        </ToolbarAction>
        <span className="h-3.5 w-px self-center bg-foreground/20" />
        <ToolbarAction label="Repository settings" onClick={() => setRepoSettingsOpen(true)}>
          <Settings2Icon className="size-4" />
        </ToolbarAction>
      </div>
      <RepoSettingsDialog open={repoSettingsOpen} onOpenChange={setRepoSettingsOpen} />
      <Dialog
        open={!!publishPrompt}
        onOpenChange={(open) => {
          if (!open) dismissPublish();
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Publish branch?</DialogTitle>
            <DialogDescription>
              <span className="font-mono">{publishPrompt?.branch}</span> does not track a remote
              branch. Publish it to <span className="font-mono">{publishPrompt?.remote}</span> and
              set that as the upstream?
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={dismissPublish}>
              Cancel
            </Button>
            <Button onClick={() => void confirmPublish()}>Publish</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function SyncPopover({
  action,
  openAction,
  onOpenAction,
  label,
  hint,
  badge,
  icon,
  children,
}: {
  action: Exclude<SyncAction, null>;
  openAction: SyncAction;
  onOpenAction: (action: SyncAction) => void;
  label: string;
  hint: string;
  badge?: number;
  icon: ReactNode;
  children: ReactNode;
}) {
  const open = openAction === action;
  return (
    <PopoverPrimitive.Root
      open={open}
      onOpenChange={(next) => onOpenAction(next ? action : openAction === action ? null : openAction)}
    >
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverPrimitive.Trigger asChild>
            <ToolbarButton label={hint} badge={badge}>
              {icon}
            </ToolbarButton>
          </PopoverPrimitive.Trigger>
        </TooltipTrigger>
        <TooltipContent>{label}</TooltipContent>
      </Tooltip>
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Content
          side="bottom"
          align="start"
          sideOffset={6}
          className="z-50 w-64 origin-(--radix-popover-content-transform-origin) rounded-lg bg-popover p-3 text-popover-foreground shadow-md ring-1 ring-foreground/10 data-[side=bottom]:slide-in-from-top-2 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95"
          onInteractOutside={(event) => {
            const target = event.target;
            if (target instanceof Element && target.closest("[data-slot=dropdown-menu-content]")) {
              event.preventDefault();
            }
          }}
        >
          {children}
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  );
}

// The panels live in popover content, which mounts on each open, so their
// initial state is computed fresh every time.
function FetchPanel({
  remotes,
  initial,
  onFetch,
}: {
  remotes: string[];
  initial?: string;
  onFetch: (remote: string) => void;
}) {
  const [remote, setRemote] = useState(() => (initial && remotes.includes(initial) ? initial : "*"));
  return (
    <Panel
      title="Fetch"
      action="Fetch"
      disabled={remotes.length === 0}
      onSubmit={() => onFetch(remote)}
    >
      <SelectField
        label="Remote"
        value={remote}
        empty="Add a remote before fetching"
        options={[...remotes.map((name) => ({ id: name, label: name })), { id: "*", label: "All remotes" }]}
        onChange={setRemote}
      />
    </Panel>
  );
}

function PullPanel({
  remotes,
  initial,
  rebase,
  onPull,
}: {
  remotes: string[];
  initial?: string;
  rebase: boolean;
  onPull: (remote: string, rebase: boolean) => void;
}) {
  const [remote, setRemote] = useState(() => pickRemote(remotes, initial));
  const [strategy, setStrategy] = useState(rebase ? "rebase" : "merge");
  return (
    <Panel title="Pull" action="Pull" disabled={!remote} onSubmit={() => onPull(remote, strategy === "rebase")}>
      <SelectField
        label="Remote"
        value={remote}
        empty="Add a remote before pulling"
        options={remotes.map((name) => ({ id: name, label: name }))}
        onChange={setRemote}
      />
      <SelectField
        label="Strategy"
        value={strategy}
        options={[
          { id: "merge", label: "Merge" },
          { id: "rebase", label: "Rebase" },
        ]}
        onChange={setStrategy}
      />
    </Panel>
  );
}

function pickRemote(remotes: string[], initial?: string) {
  return initial && remotes.includes(initial) ? initial : (remotes[0] ?? "");
}

function PushPanel({
  remotes,
  initial,
  branch,
  onPush,
}: {
  remotes: string[];
  initial?: string;
  branch: string | null;
  onPush: (remote: string, force: boolean) => void;
}) {
  const [remote, setRemote] = useState(() => pickRemote(remotes, initial));
  const [force, setForce] = useState(false);
  const target = remote && branch ? `${remote}/${branch}` : "the remote branch";
  return (
    <Panel
      title="Push"
      action={force ? "Force push" : "Push"}
      destructive={force}
      disabled={!remote}
      onSubmit={() => onPush(remote, force)}
    >
      <SelectField
        label="Remote"
        value={remote}
        empty="Add a remote before pushing"
        options={remotes.map((name) => ({ id: name, label: name }))}
        onChange={setRemote}
      />
      <label className="flex items-start gap-2 text-sm">
        <Checkbox className="mt-0.5" checked={force} onCheckedChange={(value) => setForce(value === true)} />
        <span>Force push</span>
      </label>
      {force ? (
        <p className="text-xs text-muted-foreground">
          Overwrites <span className="font-mono text-foreground">{target}</span>. Others who pushed
          here may need to recover their work.
        </p>
      ) : null}
    </Panel>
  );
}

function Panel({
  title,
  action,
  disabled,
  destructive,
  onSubmit,
  children,
}: {
  title: string;
  action: string;
  disabled?: boolean;
  destructive?: boolean;
  onSubmit: () => void;
  children: ReactNode;
}) {
  return (
    <form
      className="grid gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        if (!disabled) onSubmit();
      }}
    >
      <div className="text-sm font-medium">{title}</div>
      {children}
      <Button type="submit" size="sm" variant={destructive ? "destructive" : "default"} disabled={disabled}>
        {action}
      </Button>
    </form>
  );
}

function SelectField({
  label,
  value,
  options,
  empty,
  onChange,
}: {
  label: string;
  value: string;
  options: { id: string; label: string }[];
  empty?: string;
  onChange: (id: string) => void;
}) {
  const current = options.find((option) => option.id === value);
  return (
    <div className="grid gap-1.5">
      <Label>{label}</Label>
      {options.length === 0 ? (
        <p className="text-xs text-muted-foreground">{empty}</p>
      ) : (
        <DropdownMenu modal={false}>
          <DropdownMenuTrigger asChild>
            <Button type="button" variant="outline" size="sm" className="w-full justify-between font-normal">
              <span className="truncate font-mono">{current?.label ?? options[0]?.label}</span>
              <ChevronDownIcon />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-(--radix-dropdown-menu-trigger-width)">
            {options.map((option) => (
              <DropdownMenuItem key={option.id} onClick={() => onChange(option.id)}>
                <span className="min-w-4">
                  {option.id === value ? <CheckIcon className="size-3.5" /> : null}
                </span>
                <span className="font-mono">{option.label}</span>
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </div>
  );
}

const actionClass =
  "h-[calc(1.75rem-2px)]! w-[calc(1.75rem-2px)]! rounded-[6px] text-foreground hover:bg-background dark:hover:bg-background";

function ToolbarButton({
  label,
  badge,
  children,
  ...props
}: React.ComponentProps<typeof Button> & { label: string; badge?: number }) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-xs"
      className={cn(actionClass, "relative")}
      aria-label={label}
      {...props}
    >
      {children}
      {badge != null ? (
        <span className="pointer-events-none absolute top-0.5 right-0.5 z-10 flex h-3 min-w-3 items-center justify-center rounded-full bg-foreground px-0.5 text-[9px] leading-none font-semibold text-background tabular-nums ring-2 ring-secondary">
          {badge}
        </span>
      ) : null}
    </Button>
  );
}

function ToolbarAction({
  label,
  hint,
  badge,
  onClick,
  children,
}: {
  label: string;
  hint?: string;
  badge?: number;
  onClick: () => void;
  children: ReactNode;
}) {
  const tip = hint ?? label;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <ToolbarButton label={tip} badge={badge} onClick={onClick}>
          {children}
        </ToolbarButton>
      </TooltipTrigger>
      <TooltipContent>{tip}</TooltipContent>
    </Tooltip>
  );
}
