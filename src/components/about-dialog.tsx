import { toast } from "sonner";
import { version } from "../../package.json";
import { AppMark } from "@/components/app-mark";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import { errorMessage, gitApi } from "@/lib/git";

const AUTHOR = "FlyAndNotDown";
const EMAIL = "johnkindem@qq.com";

export function AboutDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="gap-0 p-0 sm:max-w-[24rem]">
        <div className="px-7 pt-7 pr-12 pb-7">
          <div className="flex items-center gap-3.5">
            <AppMark className="size-10 shrink-0" iconClassName="size-5" />
            <div className="flex min-w-0 items-baseline gap-2">
              <DialogTitle className="text-2xl leading-none font-medium tracking-tight">
                <span className="sr-only">About </span>
                Rebasely
              </DialogTitle>
              <span className="font-mono text-[11px] text-muted-foreground">v{version}</span>
            </div>
          </div>
          <DialogDescription className="mt-4 text-sm leading-relaxed">
            A unified version control client.
          </DialogDescription>
          <div className="mt-7">
            <p className="text-sm font-medium tracking-tight">{AUTHOR}</p>
            <button
              type="button"
              className="mt-1.5 border-b border-foreground/20 pb-px font-mono text-[12px] text-muted-foreground outline-none hover:border-foreground/55 hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
              onClick={() => void sendMail()}
            >
              {EMAIL}
            </button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

async function sendMail() {
  try {
    await gitApi.openMailto(EMAIL);
  } catch (error) {
    toast.error(errorMessage(error));
  }
}
