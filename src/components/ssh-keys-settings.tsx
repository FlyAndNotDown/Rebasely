import { useEffect, useState, type Dispatch, type SetStateAction } from "react";
import { open as openFile } from "@tauri-apps/plugin-dialog";
import { CheckIcon, ChevronDownIcon, CircleAlertIcon, FolderOpenIcon } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { HoverTip } from "@/components/ui/tooltip";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { displayPath } from "@/lib/format";
import { errorMessage, gitApi } from "@/lib/git";
import type { SshKeyInfo, SshKeyList } from "@/types/git";

type Algorithm = "ed25519" | "rsa";

type Draft = {
  algorithm: Algorithm;
  name: string;
  nameEdited: boolean;
  comment: string;
  passphrase: string;
  confirm: string;
};

type ImportDraft = {
  path: string;
  fileName: string;
  passphrase: string;
  inFolder: boolean;
};

function suggestedName(algorithm: Algorithm, keys: SshKeyInfo[]) {
  const base = algorithm === "rsa" ? "id_rsa" : "id_ed25519";
  if (!keys.some((key) => key.name === base)) return base;
  for (let index = 2; index < 100; index += 1) {
    const name = `${base}_${index}`;
    if (!keys.some((key) => key.name === name)) return name;
  }
  return base;
}

function keyFileNameOk(name: string) {
  const trimmed = name.trim();
  return (
    trimmed.length > 0 &&
    trimmed.length <= 80 &&
    !trimmed.startsWith(".") &&
    !trimmed.toLowerCase().endsWith(".pub") &&
    /^[A-Za-z0-9._-]+$/.test(trimmed)
  );
}

function algorithmLabel(key: SshKeyInfo) {
  if (key.algorithm === "ed25519") return "Ed25519";
  if (key.algorithm === "rsa") return key.bits ? `RSA ${key.bits}` : "RSA";
  if (key.algorithm === "ecdsa") return key.bits ? `ECDSA ${key.bits}` : "ECDSA";
  if (key.algorithm === "dsa") return "DSA";
  return null;
}

function joinSsh(directory: string, name: string) {
  const sep = directory.includes("\\") ? "\\" : "/";
  return `${directory.replace(/[\\/]+$/, "")}${sep}${name}`;
}

function keygenMissingCopy() {
  const windows = typeof navigator !== "undefined" && /windows/i.test(navigator.userAgent);
  return windows
    ? "Generating a key needs ssh-keygen. It ships with Git for Windows and with the Windows OpenSSH Client."
    : "Generating a key needs ssh-keygen. Install OpenSSH to create keys.";
}

export function SshKeysSettings({ email }: { email: string }) {
  const [list, setList] = useState<SshKeyList | null>(null);
  const [loadError, setLoadError] = useState("");
  const [draft, setDraft] = useState<Draft | null>(null);
  const [importing, setImporting] = useState<ImportDraft | null>(null);
  const [pendingRemove, setPendingRemove] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function reload() {
    const next = await gitApi.listSshKeys();
    setList(next);
    setLoadError("");
    return next;
  }

  useEffect(() => {
    let cancelled = false;
    void gitApi
      .listSshKeys()
      .then((next) => {
        if (!cancelled) setList(next);
      })
      .catch((error: unknown) => {
        if (!cancelled) setLoadError(errorMessage(error));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  function openDraft(algorithm: Algorithm, keys: SshKeyInfo[]) {
    setImporting(null);
    setPendingRemove(null);
    setDraft({
      algorithm,
      name: suggestedName(algorithm, keys),
      nameEdited: false,
      comment: email.trim(),
      passphrase: "",
      confirm: "",
    });
  }

  async function createKey() {
    if (!draft || !keyFileNameOk(draft.name) || draft.passphrase !== draft.confirm) return;
    setBusy(true);
    try {
      const created = await gitApi.generateSshKey(
        draft.name.trim(),
        draft.algorithm,
        draft.comment.trim(),
        draft.passphrase,
      );
      toast.success(`Created ${created.name}`);
      setDraft(null);
      await reload();
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  async function addExisting() {
    const picked = await openFile({ multiple: false, title: "Private SSH key" });
    if (typeof picked !== "string") return;
    setBusy(true);
    try {
      const preview = await gitApi.previewSshKey(picked);
      if (preview.inSshFolder && preview.hasPublic) {
        toast.success("That key is already in your SSH folder");
        await reload();
        return;
      }
      if (preview.encrypted && !preview.hasPublic) {
        setDraft(null);
        setImporting({
          path: picked,
          fileName: preview.fileName,
          passphrase: "",
          inFolder: preview.inSshFolder,
        });
        return;
      }
      const added = await gitApi.importSshKey(picked, "");
      toast.success(preview.inSshFolder ? `Created the public key for ${added.name}` : `Added ${added.name}`);
      setImporting(null);
      await reload();
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  async function confirmImport() {
    if (!importing || importing.passphrase.length === 0) return;
    setBusy(true);
    try {
      const added = await gitApi.importSshKey(importing.path, importing.passphrase);
      toast.success(importing.inFolder ? `Created the public key for ${added.name}` : `Added ${added.name}`);
      setImporting(null);
      await reload();
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  async function removeKey(name: string) {
    setBusy(true);
    try {
      await gitApi.deleteSshKey(name);
      toast.success(`Removed ${name}`);
      setPendingRemove(null);
      await reload();
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  async function copyPublicKey(key: SshKeyInfo) {
    try {
      await navigator.clipboard.writeText(key.publicKey);
      toast.success("Copied the public key");
    } catch {
      toast.error("Could not copy to the clipboard");
    }
  }

  async function showFolder() {
    if (!list?.directory) return;
    try {
      await gitApi.openInFileManager(list.directory);
    } catch (error) {
      toast.error(errorMessage(error));
    }
  }

  return (
    <>
      <DialogHeader>
        <DialogTitle>SSH keys</DialogTitle>
        <DialogDescription>Keys in your .ssh folder. Git uses them for SSH remotes.</DialogDescription>
      </DialogHeader>
      <div className="mt-6 grid min-w-0 gap-4">
        {list ? (
          <div className="flex items-center gap-2">
            <HoverTip label={displayPath(list.directory)}>
              <p className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground">
                {displayPath(list.directory)}
              </p>
            </HoverTip>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={!list.directoryExists || busy}
              onClick={() => void showFolder()}
            >
              <FolderOpenIcon />
              Open folder
            </Button>
          </div>
        ) : loadError ? (
          <p className="flex items-start gap-1.5 text-sm text-destructive" role="status">
            <CircleAlertIcon className="mt-0.5 size-3.5 shrink-0" />
            {loadError}
          </p>
        ) : (
          <Skeleton className="h-8 w-full" role="status" aria-label="Loading SSH keys" />
        )}

        {list && !list.keygenAvailable ? (
          <p className="flex items-start gap-1.5 text-xs text-muted-foreground" role="status">
            <CircleAlertIcon className="mt-0.5 size-3.5 shrink-0" />
            {keygenMissingCopy()}
          </p>
        ) : null}

        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            variant="outline"
            disabled={!list?.keygenAvailable || busy}
            onClick={() => list && openDraft("ed25519", list.keys)}
          >
            Generate key
          </Button>
          <Button type="button" variant="outline" disabled={!list || busy} onClick={() => void addExisting()}>
            Add existing key
          </Button>
        </div>

        <GenerateKeyDialog
          draft={draft}
          keys={list?.keys ?? []}
          busy={busy}
          onDraft={setDraft}
          onClose={() => setDraft(null)}
          onCreate={() => void createKey()}
        />

        {importing ? (
          <div className="grid gap-4 rounded-lg border p-4">
            <div className="grid gap-1">
              <h3 className="text-sm font-medium">Passphrase for {importing.fileName}</h3>
              <p className="text-xs text-muted-foreground">
                ssh-keygen uses this once to write the public key. It is not saved.
              </p>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="ssh-import-passphrase">Passphrase</Label>
              <Input
                id="ssh-import-passphrase"
                type="password"
                autoComplete="current-password"
                value={importing.passphrase}
                disabled={busy}
                onChange={(event) =>
                  setImporting((current) =>
                    current ? { ...current, passphrase: event.target.value } : current,
                  )
                }
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    void confirmImport();
                  }
                }}
              />
            </div>
            <div className="flex gap-2">
              <Button
                type="button"
                disabled={busy || importing.passphrase.length === 0}
                onClick={() => void confirmImport()}
              >
                {importing.inFolder ? "Create public key" : "Add key"}
              </Button>
              <Button type="button" variant="outline" disabled={busy} onClick={() => setImporting(null)}>
                Cancel
              </Button>
            </div>
          </div>
        ) : null}

        {!list && !loadError ? (
          <div className="grid gap-2" role="status" aria-label="Loading SSH keys">
            <Skeleton className="h-16 w-full" />
            <Skeleton className="h-16 w-full" />
          </div>
        ) : null}

        {list && list.keys.length === 0 ? (
          <p className="rounded-lg border px-3 py-8 text-center text-sm text-muted-foreground">
            {list.directoryExists
              ? "No SSH keys in this folder."
              : "Your SSH folder will be created when you generate or add a key."}
          </p>
        ) : null}

        {list && list.keys.length > 0 ? (
          <ul className="min-w-0 divide-y overflow-x-auto rounded-lg border">
            {list.keys.map((key) => {
              const label = algorithmLabel(key);
              return (
                <li key={key.name} className="grid gap-1.5 px-3 py-3">
                  <div className="flex w-max min-w-full items-center gap-2">
                    <HoverTip label={key.name}>
                      <span className="font-mono text-xs whitespace-nowrap">{key.name}</span>
                    </HoverTip>
                    <span className="min-w-2 flex-1" />
                    {label ? <Badge variant="outline">{label}</Badge> : null}
                    {key.defaultIdentity ? (
                      <HoverTip label="OpenSSH tries this file name on its own">
                        <Badge variant="secondary">Default</Badge>
                      </HoverTip>
                    ) : null}
                    {key.encrypted ? <Badge variant="secondary">Passphrase</Badge> : null}
                  </div>
                  {key.comment ? (
                    <p className="w-max whitespace-nowrap text-xs text-muted-foreground">{key.comment}</p>
                  ) : null}
                  {key.fingerprint ? (
                    <HoverTip label={key.fingerprint}>
                      <p className="w-max font-mono text-[11px] whitespace-nowrap text-muted-foreground select-text">
                        {key.fingerprint}
                      </p>
                    </HoverTip>
                  ) : null}
                  {pendingRemove === key.name ? (
                    <div className="mt-1 flex flex-wrap items-center gap-2">
                      <span className="text-xs text-muted-foreground">
                        Remove this key and its public key from your SSH folder? Git hosts that already have the public
                        key keep it.
                      </span>
                      <Button
                        type="button"
                        size="sm"
                        variant="destructive"
                        disabled={busy}
                        onClick={() => void removeKey(key.name)}
                      >
                        Remove
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        disabled={busy}
                        onClick={() => setPendingRemove(null)}
                      >
                        Cancel
                      </Button>
                    </div>
                  ) : (
                    <div className="mt-1 flex flex-wrap gap-2">
                      {key.publicKey ? (
                        <Button type="button" size="sm" variant="outline" onClick={() => void copyPublicKey(key)}>
                          Copy public key
                        </Button>
                      ) : (
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          disabled={busy || !list.keygenAvailable}
                          onClick={() => {
                            if (key.encrypted) {
                              setDraft(null);
                              setImporting({
                                path: joinSsh(list.directory, key.name),
                                fileName: key.name,
                                passphrase: "",
                                inFolder: true,
                              });
                              return;
                            }
                            void gitApi
                              .importSshKey(joinSsh(list.directory, key.name), "")
                              .then(async () => {
                                toast.success(`Created the public key for ${key.name}`);
                                await reload();
                              })
                              .catch((error: unknown) => toast.error(errorMessage(error)));
                          }}
                        >
                          Create public key
                        </Button>
                      )}
                      <Button
                        type="button"
                        size="sm"
                        variant="destructive"
                        disabled={busy}
                        onClick={() => setPendingRemove(key.name)}
                      >
                        Remove
                      </Button>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        ) : null}
      </div>
    </>
  );
}

function GenerateKeyDialog({
  draft,
  keys,
  busy,
  onDraft,
  onClose,
  onCreate,
}: {
  draft: Draft | null;
  keys: SshKeyInfo[];
  busy: boolean;
  onDraft: Dispatch<SetStateAction<Draft | null>>;
  onClose: () => void;
  onCreate: () => void;
}) {
  const nameInvalid = draft !== null && draft.name.trim() !== "" && !keyFileNameOk(draft.name);
  const passphraseMismatch = draft !== null && draft.passphrase !== draft.confirm;

  function selectAlgorithm(algorithm: Algorithm) {
    onDraft((current) =>
      current
        ? {
            ...current,
            algorithm,
            name: current.nameEdited ? current.name : suggestedName(algorithm, keys),
          }
        : current,
    );
  }

  return (
    <Dialog
      open={draft !== null}
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <DialogContent
        className="sm:max-w-md"
        overlayClassName="bg-black/40! supports-backdrop-filter:backdrop-blur-md!"
      >
        {draft ? (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              if (busy || !keyFileNameOk(draft.name) || draft.passphrase !== draft.confirm) return;
              onCreate();
            }}
          >
            <DialogHeader>
              <DialogTitle>Generate key</DialogTitle>
              <DialogDescription>Creates an OpenSSH key in your .ssh folder.</DialogDescription>
            </DialogHeader>
            <div className="mt-4 grid gap-4">
              <div className="grid gap-2">
                <Label htmlFor="ssh-key-type">Key type</Label>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      id="ssh-key-type"
                      type="button"
                      variant="outline"
                      className="w-full justify-between font-normal"
                      disabled={busy}
                    >
                      <span>{draft.algorithm === "rsa" ? "RSA 4096" : "Ed25519"}</span>
                      <ChevronDownIcon />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="start" className="w-(--radix-dropdown-menu-trigger-width)">
                    <DropdownMenuItem onClick={() => selectAlgorithm("ed25519")}>
                      <span className="min-w-4">
                        {draft.algorithm === "ed25519" ? <CheckIcon className="size-3.5" /> : null}
                      </span>
                      Ed25519
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={() => selectAlgorithm("rsa")}>
                      <span className="min-w-4">
                        {draft.algorithm === "rsa" ? <CheckIcon className="size-3.5" /> : null}
                      </span>
                      RSA 4096
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
                <p className="text-xs text-muted-foreground">
                  {draft.algorithm === "ed25519"
                    ? "Ed25519 is the type Git hosts expect for a new key."
                    : "RSA 4096 remains the type some older hosts require."}
                </p>
              </div>
              <div className="grid gap-2">
                <Label htmlFor="ssh-key-name">File name</Label>
                <Input
                  id="ssh-key-name"
                  value={draft.name}
                  spellCheck={false}
                  autoCapitalize="off"
                  autoCorrect="off"
                  autoComplete="off"
                  disabled={busy}
                  onChange={(event) =>
                    onDraft((current) =>
                      current ? { ...current, name: event.target.value, nameEdited: true } : current,
                    )
                  }
                />
                {nameInvalid ? (
                  <p className="text-xs text-destructive">Use letters, numbers, dots, hyphens, and underscores.</p>
                ) : (
                  <p className="text-xs text-muted-foreground">
                    OpenSSH tries id_ed25519, id_ecdsa, and id_rsa on its own.
                  </p>
                )}
              </div>
              <div className="grid gap-2">
                <Label htmlFor="ssh-key-comment">Comment</Label>
                <Input
                  id="ssh-key-comment"
                  value={draft.comment}
                  placeholder="you@example.com"
                  spellCheck={false}
                  autoComplete="off"
                  disabled={busy}
                  onChange={(event) =>
                    onDraft((current) => (current ? { ...current, comment: event.target.value } : current))
                  }
                />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="ssh-key-passphrase">Passphrase</Label>
                <Input
                  id="ssh-key-passphrase"
                  type="password"
                  autoComplete="off"
                  value={draft.passphrase}
                  disabled={busy}
                  onChange={(event) =>
                    onDraft((current) => (current ? { ...current, passphrase: event.target.value } : current))
                  }
                />
                <p className="text-xs text-muted-foreground">
                  Leave this empty to use the key without a prompt. A passphrase protects the file if it is copied.
                </p>
              </div>
              <div className="grid gap-2">
                <Label htmlFor="ssh-key-passphrase-confirm">Confirm passphrase</Label>
                <Input
                  id="ssh-key-passphrase-confirm"
                  type="password"
                  autoComplete="off"
                  value={draft.confirm}
                  disabled={busy}
                  onChange={(event) =>
                    onDraft((current) => (current ? { ...current, confirm: event.target.value } : current))
                  }
                />
                {passphraseMismatch && draft.confirm.length > 0 ? (
                  <p className="text-xs text-destructive">Passphrases do not match.</p>
                ) : null}
              </div>
            </div>
            <DialogFooter className="mt-4">
              <Button type="button" variant="outline" disabled={busy} onClick={onClose}>
                Cancel
              </Button>
              <Button type="submit" disabled={busy || !keyFileNameOk(draft.name) || passphraseMismatch}>
                Create key
              </Button>
            </DialogFooter>
          </form>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
