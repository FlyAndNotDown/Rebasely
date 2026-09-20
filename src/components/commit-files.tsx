import { toast } from "sonner";
import { fileKindClass, fileKindLabel } from "@/lib/file-kind";
import { fileName } from "@/lib/format";
import { cn } from "@/lib/utils";
import { useGit } from "@/state/git-context";

export function CommitFiles() {
  const { commitDetails, historySelection, selectCommitFile } = useGit();
  if (!commitDetails) {
    return (
      <div className="flex h-full items-center justify-center p-4 text-sm text-muted-foreground">
        Select a commit to see its files
      </div>
    );
  }
  const selectedPath = historySelection?.path;
  const commit = commitDetails.commit;

  async function copyHash() {
    try {
      await navigator.clipboard.writeText(commit.id);
      toast.success("Copied commit hash");
    } catch {
      toast.error("Could not copy hash");
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="shrink-0 px-3 py-2">
        <div className="text-sm font-medium">{commit.summary}</div>
        <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-muted-foreground">
          <span>{commit.authorName}</span>
          <button
            type="button"
            title="Copy full hash"
            className="rounded-md bg-muted px-1.5 py-0.5 font-mono text-[11px] text-foreground/80 hover:bg-muted/80 hover:text-foreground"
            onClick={() => void copyHash()}
          >
            {commit.shortId}
          </button>
        </div>
        {commit.body ? (
          <p className="mt-2 max-h-24 overflow-auto whitespace-pre-wrap text-xs text-muted-foreground">
            {commit.body}
          </p>
        ) : null}
      </div>
      <ul className="min-h-0 flex-1 overflow-auto border-t px-1 py-1">
        {commitDetails.files.map((file) => (
          <li key={file.path}>
            <button
              type="button"
              className={cn(
                "flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-xs hover:bg-muted/70",
                selectedPath === file.path && "bg-muted",
              )}
              onClick={() => void selectCommitFile(commit.id, file.path)}
            >
              <span className={cn("w-3 shrink-0 font-mono text-[11px] font-medium", fileKindClass(file.kind))}>
                {fileKindLabel(file.kind)}
              </span>
              <span className="truncate font-mono">{file.path}</span>
              <span className="ml-auto truncate text-muted-foreground">
                {file.binary ? "binary" : fileName(file.path)}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
