import { t, useTranslation } from "@/i18n";
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
  useTranslation();
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
  useTranslation();
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
        <DialogTitle>{t("p4.perforceLogin")}</DialogTitle>
        <DialogDescription>
          {target
            ? t("p4.ticketExpired", { target })
            : t("p4.theServerWantsAPasswordBeforeThisWorkspaceCanBeRead")}
        </DialogDescription>
      </DialogHeader>
      <div className="mt-4 grid gap-2">
        <Label htmlFor="p4-password">{t("p4.password")}</Label>
        <Input
          id="p4-password"
          type="password"
          autoFocus
          value={password}
          onChange={(event) => setPassword(event.target.value)}
        />
      </div>
      <DialogFooter className="mt-4">
        <Button type="button" variant="outline" onClick={onCancel}>{t("p4.cancel")}</Button>
        <Button type="submit" disabled={!password || busy}>
          {busy ? <Loader2Icon className="animate-spin" /> : null}{t("p4.logIn")}</Button>
      </DialogFooter>
    </form>
  );
}
