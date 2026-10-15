import { useState } from "react";
import { Loader2Icon } from "lucide-react";
import { Button } from "@/components/ui/button";
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

export function P4LoginDialog({
  open,
  client,
  port,
  onCancel,
  onSubmit,
}: {
  open: boolean;
  client: string;
  port: string;
  onCancel: () => void;
  onSubmit: (password: string) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={(next) => !next && onCancel()}>
      <DialogContent className="sm:max-w-md">
        {open ? (
          <LoginForm client={client} port={port} onCancel={onCancel} onSubmit={onSubmit} />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function LoginForm({
  client,
  port,
  onCancel,
  onSubmit,
}: {
  client: string;
  port: string;
  onCancel: () => void;
  onSubmit: (password: string) => void;
}) {
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const target = [client, port].filter(Boolean).join(" @ ");

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        if (!password || busy) return;
        setBusy(true);
        onSubmit(password);
      }}
    >
      <DialogHeader>
        <DialogTitle>Perforce login</DialogTitle>
        <DialogDescription>
          {target
            ? `The ticket for ${target} is missing or expired.`
            : "The server wants a password before this workspace can be read."}
        </DialogDescription>
      </DialogHeader>
      <div className="mt-4 grid gap-2">
        <Label htmlFor="p4-password">Password</Label>
        <Input
          id="p4-password"
          type="password"
          autoFocus
          value={password}
          onChange={(event) => setPassword(event.target.value)}
        />
      </div>
      <DialogFooter className="mt-4">
        <Button type="button" variant="outline" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" disabled={!password || busy}>
          {busy ? <Loader2Icon className="animate-spin" /> : null}
          Log in
        </Button>
      </DialogFooter>
    </form>
  );
}
