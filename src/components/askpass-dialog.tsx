import { t, useTranslation } from "@/i18n";
import { useEffect, useState, useSyncExternalStore } from "react";
import { listen } from "@tauri-apps/api/event";
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
import { gitApi } from "@/lib/git";
import { createAskpassQueue, type AskpassPrompt } from "@/lib/askpass-queue";
import { useActivities } from "@/state/git-context";

const SECRET = /password|passphrase|token|pin\b|secret/i;
const YES_NO = /\(yes\/no/i;

/** Answers the username, password, and passphrase prompts git and ssh raise. */
export function AskpassDialog() {

  const activities = useActivities();
  const [queue] = useState(() => createAskpassQueue(
    (id, answer) => gitApi.answerAskpass(id, answer),
    (activityId) => gitApi.cancelActivity(activityId),
  ));
  const prompts = useSyncExternalStore(queue.subscribe, queue.getSnapshot, queue.getSnapshot);

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void listen<AskpassPrompt>("askpass-prompt", (event) => {
      if (!disposed) queue.enqueue(event.payload);
    }).then((fn) => {
      if (disposed) fn();
      else unlisten = fn;
    });
    return () => {
      disposed = true;
      unlisten?.();
      queue.dispose();
    };
  }, [queue]);

  const running = (item: AskpassPrompt) =>
    !item.activityId || activities.some((activity) => activity.id === item.activityId);

  // A cancelled or finished activity no longer reads the answer; releasing the
  // prompt frees the thread waiting on it.
  useEffect(() => {
    const live = new Set(activities.map((activity) => activity.id));
    queue.releaseInactive(live);
  }, [prompts, activities, queue]);

  const current = prompts.find(running) ?? null;
  const activity = current?.activityId
    ? activities.find((item) => item.id === current.activityId)
    : undefined;

  function respond(item: AskpassPrompt, answer: string | null) {
    void queue.respond(item.id, answer);
  }

  return (
    <Dialog
      open={current !== null}
      onOpenChange={(open) => {
        if (!open && current) respond(current, null);
      }}
    >
      <DialogContent className="sm:max-w-md">
        {current ? (
          <PromptForm
            key={current.id}
            prompt={current.prompt}
            context={activity?.label}
            onAnswer={(answer) => respond(current, answer)}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function PromptForm({
  prompt,
  context,
  onAnswer,
}: {
  prompt: string;
  context?: string;
  onAnswer: (answer: string | null) => void;
}) {
  useTranslation();
  const [value, setValue] = useState("");
  const confirm = YES_NO.test(prompt);
  const secret = SECRET.test(prompt);

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        onAnswer(value);
      }}
    >
      <DialogHeader>
        <DialogTitle>{confirm ? t("desktop.askpassDialog.confirm_connection") : t("desktop.askpassDialog.authentication_required")}</DialogTitle>
        <DialogDescription>{context ?? t("desktop.askpassDialog.git_is_asking_for_input")}</DialogDescription>
      </DialogHeader>
      <p className="mt-3 whitespace-pre-wrap break-words font-mono text-xs text-muted-foreground">
        {prompt}
      </p>
      {confirm ? (
        <DialogFooter className="mt-4">
          <Button type="button" variant="outline" onClick={() => onAnswer("no")}>
            {t("desktop.askpassDialog.no")}</Button>
          <Button type="button" onClick={() => onAnswer("yes")}>
            {t("desktop.askpassDialog.yes")}</Button>
        </DialogFooter>
      ) : (
        <>
          <Input
            className="mt-3"
            type={secret ? "password" : "text"}
            autoFocus
            autoComplete="off"
            spellCheck={false}
            value={value}
            onChange={(event) => setValue(event.target.value)}
            aria-label={prompt}
          />
          <DialogFooter className="mt-4">
            <Button type="button" variant="outline" onClick={() => onAnswer(null)}>
              {t("common.cancel")}</Button>
            <Button type="submit">{t("desktop.askpassDialog.continue")}</Button>
          </DialogFooter>
        </>
      )}
    </form>
  );
}
