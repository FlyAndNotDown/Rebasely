import { cn } from "@/lib/utils";

export function AppMark({
  className,
  src = `${import.meta.env.BASE_URL}assets/mark.png`,
}: {
  className?: string;
  src?: string;
}) {
  return (
    <div className={cn("shrink-0", className)}>
      <img
        src={src}
        alt=""
        aria-hidden="true"
        width={256}
        height={256}
        draggable={false}
        className="block size-full object-contain"
      />
    </div>
  );
}
