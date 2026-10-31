import { formatBytes, t, useTranslation } from "@/i18n";
import { useEffect, useState, useSyncExternalStore, type CSSProperties } from "react";
import { RefreshCwIcon } from "lucide-react";
import { DiffSkeleton } from "@/components/skeletons";
import { Button } from "@/components/ui/button";
import { HoverTip } from "@/components/ui/tooltip";
import { errorMessage, gitApi } from "@/lib/git";
import { cn } from "@/lib/utils";
import { createImageLoader, imageLoadKey } from "@/lib/image-load";
import type { FileDiff, ImageSide, FileSource } from "@/types/git";

const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp", "ico", "avif"]);

export function isImagePath(path: string) {
  const ext = path.split(".").pop()?.toLowerCase();
  return Boolean(ext && IMAGE_EXTENSIONS.has(ext));
}

const CHECKERBOARD: CSSProperties = {
  backgroundImage:
    "conic-gradient(color-mix(in oklch, var(--foreground) 9%, transparent) 25%, transparent 0 50%, color-mix(in oklch, var(--foreground) 9%, transparent) 0 75%, transparent 0)",
  backgroundSize: "16px 16px",
};

type Mode = "split" | "swipe" | "fade";
type Size = { width: number; height: number };

/** Before and after views of a changed image, side by side or overlaid. */
export function ImageDiff({ repoPath, source, refreshIdentity }: {
  repoPath: string;
  source: FileSource;
  refreshIdentity: FileDiff | null;
}) {
  useTranslation();
  const sourceKey = JSON.stringify(source);
  const key = imageLoadKey(repoPath, source);
  const [loader] = useState(() => createImageLoader(gitApi.getImagePair, errorMessage));
  const loaded = useSyncExternalStore(loader.subscribe, loader.getSnapshot, loader.getSnapshot);
  const [attempt, setAttempt] = useState(0);
  const [mode, setMode] = useState<Mode>("split");
  const [amount, setAmount] = useState(50);
  const [sizes, setSizes] = useState<Partial<Record<"before" | "after", { key: string; url: string; size: Size }>>>({});

  useEffect(() => {
    if (!repoPath) return;
    return loader.start(repoPath, JSON.parse(sourceKey) as FileSource, refreshIdentity, attempt);
  }, [loader, sourceKey, repoPath, refreshIdentity, attempt]);

  const pair = loaded.key === key ? loaded.pair : null;
  const current = loaded.key === key && loaded.identity === refreshIdentity && loaded.attempt === attempt;
  const busy = Boolean(repoPath) && (!current || loaded.busy);
  const error = current ? loaded.error : null;
  const before = pair?.before ?? null;
  const after = pair?.after ?? null;
  const beforeSize = sizes.before?.key === key && sizes.before.url === before?.dataUrl ? sizes.before.size : undefined;
  const afterSize = sizes.after?.key === key && sizes.after.url === after?.dataUrl ? sizes.after.size : undefined;
  const comparable = Boolean(before?.dataUrl && after?.dataUrl);
  const shownMode = comparable ? mode : "split";
  const measure = (side: "before" | "after") => (event: React.SyntheticEvent<HTMLImageElement>) => {
    const image = event.currentTarget;
    setSizes((current) => ({ ...current, [side]: { key, url: image.currentSrc || image.src, size: { width: image.naturalWidth, height: image.naturalHeight } } }));
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col" aria-busy={busy}>
      <div className="flex h-9 shrink-0 items-center gap-1 border-b px-3">
        {comparable ? <>
          {(["split", "swipe", "fade"] as const).map((item) => (
            <Button
              key={item}
              size="xs"
              variant={mode === item ? "secondary" : "ghost"}
              aria-pressed={mode === item}
              onClick={() => setMode(item)}
            >
              {item === "split" ? t("desktop.imageDiff.side_by_side") : item === "swipe" ? t("desktop.imageDiff.swipe") : t("desktop.imageDiff.onion_skin")}
            </Button>
          ))}
          {shownMode !== "split" ? (
            <input
              type="range"
              min={0}
              max={100}
              value={amount}
              aria-label={shownMode === "swipe" ? t("desktop.imageDiff.swipe_position") : t("desktop.imageDiff.after_opacity")}
              className="ml-2 min-w-12 max-w-40 flex-1 accent-foreground"
              onChange={(event) => setAmount(Number(event.target.value))}
            />
          ) : null}
        </> : null}
        <HoverTip label={busy ? t("desktop.imageDiff.loading_image") : error ? t("desktop.imageDiff.retry_loading_image") : t("desktop.imageDiff.reload_image")}>
          <Button variant="ghost" size={comparable ? "icon-xs" : "xs"} className="ml-auto" aria-label={busy ? t("desktop.imageDiff.loading_image") : error ? t("desktop.imageDiff.retry_loading_image") : t("desktop.imageDiff.reload_image")} disabled={busy || !repoPath} onClick={() => setAttempt((value) => value + 1)}>
            <RefreshCwIcon className={busy ? "motion-safe:animate-spin" : ""} />
            {!comparable ? busy ? t("common.loading") : error ? t("common.retry") : t("desktop.imageDiff.reload_image") : null}
          </Button>
        </HoverTip>
      </div>
      {error ? <p role="alert" className="break-words px-3 py-2 text-xs text-destructive">{error}</p> : null}
      {!pair ? (error ? null : <div className="relative min-h-0 flex-1"><DiffSkeleton fill label={t("desktop.imageDiff.loading_image")} /></div>) : shownMode === "split" ? (
        <div className="grid min-h-0 flex-1 grid-cols-2 gap-3 p-3">
          <ImagePanel label={t("common.before")} side={before} size={beforeSize} missing={t("desktop.imageDiff.not_in_the_older_version")} onLoad={measure("before")} />
          <ImagePanel label={t("common.after")} side={after} size={afterSize} missing={t("desktop.imageDiff.deleted")} onLoad={measure("after")} />
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col gap-2 p-3">
          <div className="relative min-h-0 flex-1 overflow-hidden rounded-md border" style={CHECKERBOARD}>
            <img
              src={before?.dataUrl ?? undefined}
              alt={t("common.before")}
              className="absolute inset-0 m-auto max-h-full max-w-full object-contain"
              onLoad={measure("before")}
            />
            <img
              src={after?.dataUrl ?? undefined}
              alt={t("common.after")}
              className="absolute inset-0 m-auto max-h-full max-w-full object-contain"
              style={
                shownMode === "swipe"
                  ? { clipPath: `inset(0 0 0 ${amount}%)` }
                  : { opacity: amount / 100 }
              }
              onLoad={measure("after")}
            />
            {shownMode === "swipe" ? (
              <span
                className="pointer-events-none absolute inset-y-0 w-px bg-diff-hunk"
                style={{ left: `${amount}%` }}
              />
            ) : null}
          </div>
          <div className="flex justify-between text-[11px] text-muted-foreground">
            <span>{t("desktop.imageDiff.before")}{" "}{describe(before, beforeSize)}</span>
            <span>{t("desktop.imageDiff.after")}{" "}{describe(after, afterSize)}</span>
          </div>
        </div>
      )}
    </div>
  );
}

function describe(side: ImageSide | null, size?: Size) {
  if (!side) return t("desktop.settingsDialog.none");
  const dimensions = size ? `${size.width} × ${size.height}` : null;
  return [dimensions, formatBytes(side.size)].filter(Boolean).join(" · ");
}

function ImagePanel({
  label,
  side,
  size,
  missing,
  onLoad,
}: {
  label: string;
  side: ImageSide | null;
  size?: Size;
  missing: string;
  onLoad: (event: React.SyntheticEvent<HTMLImageElement>) => void;
}) {
  useTranslation();
  const note = !side
    ? missing
    : side.lfs
      ? t("desktop.imageDiff.stored_in_git_lfs_only_the_pointer_is")
      : side.tooLarge
        ? t("desktop.imageDiff.tooLarge", { size: formatBytes(side.size) })
        : null;
  return (
    <div className="flex min-h-0 flex-col gap-1.5">
      <div className="flex items-baseline justify-between text-xs">
        <span className="font-medium">{label}</span>
        <span className="text-[11px] text-muted-foreground">{side ? describe(side, size) : ""}</span>
      </div>
      <div
        className={cn(
          "relative flex min-h-0 flex-1 items-center justify-center overflow-hidden rounded-md border",
          !side?.dataUrl && "bg-muted/30",
        )}
        style={side?.dataUrl ? CHECKERBOARD : undefined}
      >
        {side?.dataUrl ? (
          <img src={side.dataUrl} alt={label} className="max-h-full max-w-full object-contain" onLoad={onLoad} />
        ) : (
          <span className="px-4 text-center text-xs text-muted-foreground">{note}</span>
        )}
      </div>
    </div>
  );
}
