import { useState } from "react";
import { ChevronDownIcon, Loader2Icon } from "lucide-react";
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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useP4 } from "@/state/p4-context";

const charsets = [
  { id: "", label: "Server default" },
  { id: "utf8", label: "utf8" },
  { id: "utf8-bom", label: "utf8-bom" },
  { id: "utf16", label: "utf16" },
  { id: "utf16le", label: "utf16le" },
  { id: "utf16be", label: "utf16be" },
  { id: "utf32le", label: "utf32le" },
  { id: "utf32be", label: "utf32be" },
];

export function P4ConnectionDialog() {
  const { connection, connectionOpen, setConnectionOpen, saveConnection } = useP4();
  const [port, setPort] = useState("");
  const [user, setUser] = useState("");
  const [password, setPassword] = useState("");
  const [client, setClient] = useState("");
  const [charset, setCharset] = useState("");
  const [saving, setSaving] = useState(false);
  const [seed, setSeed] = useState("");
  const nextSeed = connectionOpen && connection ? `${connection.root}\n${connection.client}` : "";
  if (nextSeed !== seed) {
    setSeed(nextSeed);
    setPort(connection?.port ?? "");
    setUser(connection?.user ?? "");
    setPassword("");
    setClient(connection?.client ?? "");
    setCharset(connection?.charset ?? "");
    setSaving(false);
  }
  const charsetLabel = charsets.find((item) => item.id === charset)?.label ?? charset;

  async function submit() {
    if (!port.trim() || !user.trim() || !client.trim() || saving) return;
    setSaving(true);
    try {
      await saveConnection({
        port: port.trim(),
        user: user.trim(),
        password,
        client: client.trim(),
        charset,
      });
      setConnectionOpen(false);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={connectionOpen} onOpenChange={(open) => !saving && setConnectionOpen(open)}>
      <DialogContent
        className="sm:max-w-md"
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          const input = document.getElementById("edit-p4-port");
          if (!(input instanceof HTMLInputElement)) return;
          input.focus();
          const placeCaret = () => {
            if (document.activeElement !== input) return;
            if (input.selectionStart === 0 && input.selectionEnd === input.value.length) {
              const end = input.value.length;
              input.setSelectionRange(end, end);
            }
          };
          // WebView2 selects the whole field when a dialog focuses it.
          placeCaret();
          requestAnimationFrame(placeCaret);
          window.setTimeout(placeCaret, 0);
          window.setTimeout(placeCaret, 50);
        }}
      >
        <DialogHeader>
          <DialogTitle>Edit connection</DialogTitle>
          <DialogDescription>
            {connection?.stream
              ? `Stream ${connection.stream}`
              : "Server, user, and client for this workspace."}
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <div className="grid gap-2">
            <Label htmlFor="edit-p4-port">Server</Label>
            <Input id="edit-p4-port" className="font-mono" value={port} onChange={(event) => setPort(event.target.value)} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-2">
              <Label htmlFor="edit-p4-user">User</Label>
              <Input id="edit-p4-user" className="font-mono" value={user} onChange={(event) => setUser(event.target.value)} />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="edit-p4-password">Password</Label>
              <Input
                id="edit-p4-password"
                type="password"
                value={password}
                placeholder="Optional"
                onChange={(event) => setPassword(event.target.value)}
              />
            </div>
          </div>
          <div className="grid gap-2">
            <Label htmlFor="edit-p4-client">Client</Label>
            <Input id="edit-p4-client" className="font-mono" value={client} onChange={(event) => setClient(event.target.value)} />
          </div>
          <div className="grid gap-2">
            <Label>Charset</Label>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button type="button" variant="outline" className="justify-between font-normal">
                  {charsetLabel}
                  <ChevronDownIcon />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="w-(--radix-dropdown-menu-trigger-width)">
                {charsets.map((item) => (
                  <DropdownMenuItem key={item.id || "default"} onClick={() => setCharset(item.id)}>
                    {item.label}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" disabled={saving} onClick={() => setConnectionOpen(false)}>
            Cancel
          </Button>
          <Button type="button" disabled={saving || !port.trim() || !user.trim() || !client.trim()} onClick={() => void submit()}>
            {saving ? <Loader2Icon className="animate-spin" /> : null}
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
