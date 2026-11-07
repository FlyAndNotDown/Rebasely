import { cn } from "@/lib/utils";

export function BrandMark({ className, src }: { className?: string; src: string }) {
  const mask = `url("${src}") center / contain no-repeat`;
  return <span aria-hidden="true" className={cn("block shrink-0 bg-current", className)} style={{ mask, WebkitMask: mask }} />;
}
