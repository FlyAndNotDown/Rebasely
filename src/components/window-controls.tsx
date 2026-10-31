import { useEffect, useState, type ReactNode } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { cn } from "@/lib/utils";
import { desktopPlatform } from "@/lib/desktop-platform";

export function WindowControls() {
  return desktopPlatform() === "windows" ? <WindowsControls /> : null;
}

function WindowsControls() {
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    const appWindow = getCurrentWindow();
    let disposed = false;
    let unlisten: (() => void) | undefined;

    void appWindow.isMaximized().then((value) => {
      if (!disposed) setMaximized(value);
    });
    void appWindow.onResized(() => {
      void appWindow.isMaximized().then((value) => {
        if (!disposed) setMaximized(value);
      });
    }).then((fn) => {
      if (disposed) fn();
      else unlisten = fn;
    });

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  return (
    <div className="flex h-full shrink-0">
      <CaptionButton label="Minimize" onClick={() => void getCurrentWindow().minimize()}>
        <MinimizeGlyph />
      </CaptionButton>
      <CaptionButton
        label={maximized ? "Restore" : "Maximize"}
        onClick={() => void getCurrentWindow().toggleMaximize()}
      >
        {maximized ? <RestoreGlyph /> : <MaximizeGlyph />}
      </CaptionButton>
      <CaptionButton
        label="Close"
        tone="danger"
        onClick={() => void getCurrentWindow().close()}
      >
        <CloseGlyph />
      </CaptionButton>
    </div>
  );
}

function CaptionButton({
  label,
  tone = "default",
  onClick,
  children,
}: {
  label: string;
  tone?: "default" | "danger";
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={onClick}
      className={cn(
        "flex h-full w-[46px] items-center justify-center text-foreground/80",
        tone === "danger"
          ? "hover:bg-destructive hover:text-white"
          : "hover:bg-black/10 hover:text-foreground dark:hover:bg-white/10",
      )}
    >
      {children}
    </button>
  );
}

function MinimizeGlyph() {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden>
      <path d="M1 5h8" fill="none" stroke="currentColor" strokeWidth="1" />
    </svg>
  );
}

function MaximizeGlyph() {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden>
      <rect x="1.5" y="1.5" width="7" height="7" fill="none" stroke="currentColor" strokeWidth="1" />
    </svg>
  );
}

function RestoreGlyph() {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden>
      <path d="M3 1.5h5.5V7" fill="none" stroke="currentColor" strokeWidth="1" />
      <rect x="1.5" y="3.5" width="5" height="5" fill="none" stroke="currentColor" strokeWidth="1" />
    </svg>
  );
}

function CloseGlyph() {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden>
      <path d="M2 2l6 6M8 2L2 8" fill="none" stroke="currentColor" strokeWidth="1" />
    </svg>
  );
}
