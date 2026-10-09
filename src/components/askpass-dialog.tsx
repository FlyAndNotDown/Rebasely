import { useEffect, useState } from "react";
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
import { useActivities } from "@/state/git-context";

interface AskpassPrompt {
  id: number;
  prompt: string;
  activityId: string | null;
}

const SECRET = /password|passphrase|token|pin\b|secret/i;
const YES_NO = /\(yes\/no/i;

/** Answers the username, password, and passphrase prompts git and ssh raise. */
export function AskpassDialog() {
  const activities = useActivities();
  const [prompts, setPrompts] = useState<AskpassPrompt[]>([]);

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void listen<AskpassPrompt>("askpass-prompt", (event) => {
      setPrompts((current) => [...current, event.payload]);
    }).then((fn) => {
      if (disposed) fn();
      else unlisten = fn;
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  const running = (item: AskpassPrompt) =>
    !item.activityId || activities.some((activity) => activity.id === item.activityId);

  // A cancelled or finished activity no longer reads the answer; releasing the
  // prompt frees the thread waiting on it.
  useEffect(() => {
    const live = new Set(activities.map((activity) => activity.id));
    for (const item of prompts) {
      if (item.activityId && !live.has(item.activityId)) {
        void gitApi.answerAskpass(item.id, null).catch(() => undefined);
      }
    }
  }, [prompts, activities]);

  const current = prompts.find(running) ?? null;
  const activity = current?.activityId
    ? activities.find((item) => item.id === current.activityId)
    : undefined;

  function respond(item: AskpassPrompt, answer: string | null) {
    setPrompts((list) => list.filter((entry) => entry.id !== item.id));
    void gitApi.answerAskpass(item.id, answer).catch(() => undefined);
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
        <DialogTitle>{confirm ? "Confirm connection" : "Authentication required"}</DialogTitle>
        <DialogDescription>{context ?? "Git is asking for input"}</DialogDescription>
      </DialogHeader>
      <p className="mt-3 whitespace-pre-wrap break-words font-mono text-xs text-muted-foreground">
        {prompt}
      </p>
      {confirm ? (
        <DialogFooter className="mt-4">
          <Button type="button" variant="outline" onClick={() => onAnswer("no")}>
            No
          </Button>
          <Button type="button" onClick={() => onAnswer("yes")}>
            Yes
          </Button>
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
              Cancel
            </Button>
            <Button type="submit">Continue</Button>
          </DialogFooter>
        </>
      )}
    </form>
  );
}
