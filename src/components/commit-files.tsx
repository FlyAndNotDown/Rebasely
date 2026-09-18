import { fileName } from "@/lib/format";
import { cn } from "@/lib/utils";
import { useGit } from "@/state/git-context";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable";

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

  return (
    <ResizablePanelGroup orientation="vertical" className="h-full min-h-0">
      <ResizablePanel defaultSize="28%" minSize="12%" maxSize="55%">
        <div className="h-full overflow-auto px-3 py-2">
          <div className="text-sm font-medium">{commitDetails.commit.summary}</div>
          <div className="text-[11px] text-muted-foreground">
            {commitDetails.commit.authorName} · {commitDetails.commit.shortId}
          </div>
          {commitDetails.commit.body ? (
            <p className="mt-2 whitespace-pre-wrap text-xs text-muted-foreground">
              {commitDetails.commit.body}
            </p>
          ) : null}
        </div>
      </ResizablePanel>
      <ResizableHandle withHandle />
      <ResizablePanel defaultSize="72%" minSize="30%">
        <ul className="h-full overflow-auto px-1 py-1">
          {commitDetails.files.map((file) => (
            <li key={file.path}>
              <button
                type="button"
                className={cn(
                  "flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-xs hover:bg-muted/70",
                  selectedPath === file.path && "bg-muted",
                )}
                onClick={() => void selectCommitFile(commitDetails.commit.id, file.path)}
              >
                <span className="font-mono text-[11px] text-muted-foreground">
                  {file.kind[0]?.toUpperCase()}
                </span>
                <span className="truncate font-mono">{file.path}</span>
                <span className="ml-auto truncate text-muted-foreground">
                  {file.binary ? "binary" : fileName(file.path)}
                </span>
              </button>
            </li>
          ))}
        </ul>
      </ResizablePanel>
    </ResizablePanelGroup>
  );
}
