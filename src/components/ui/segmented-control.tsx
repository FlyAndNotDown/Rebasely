import { Fragment, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { HoverTip } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

export function SegmentedControl<T extends string>({
  label,
  value,
  options,
  onChange,
  disabled,
  dense,
  className,
}: {
  label: string;
  value: T;
  options: { value: T; label: ReactNode; tip?: string }[];
  onChange: (value: T) => void;
  disabled?: boolean;
  dense?: boolean;
  className?: string;
}) {
  return (
    <div role="group" aria-label={label} className={cn("flex h-7 shrink-0 rounded-md bg-muted p-0.5", className)}>
      {options.map((option) => {
        const selected = value === option.value;
        const button = (
          <Button
            type="button"
            size={dense ? "icon-xs" : "sm"}
            variant="ghost"
            disabled={disabled}
            aria-pressed={selected}
            aria-label={option.tip}
            className={cn(
              "shadow-none",
              dense ? "size-6" : "h-6 px-2 text-xs",
              selected
                ? "bg-background text-foreground ring-1 ring-foreground/20"
                : "text-muted-foreground hover:text-foreground",
            )}
            onClick={() => onChange(option.value)}
          >
            {option.label}
          </Button>
        );
        return option.tip ? (
          <HoverTip key={option.value} label={option.tip}>
            {button}
          </HoverTip>
        ) : (
          <Fragment key={option.value}>{button}</Fragment>
        );
      })}
    </div>
  );
}
