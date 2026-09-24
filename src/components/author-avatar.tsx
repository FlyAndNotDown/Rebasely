import { avatarHue, avatarInitial, avatarSeed } from "@/lib/avatar";
import { cn } from "@/lib/utils";

export function AuthorAvatar({
  name,
  email,
  className,
}: {
  name: string;
  email: string;
  className?: string;
}) {
  const seed = avatarSeed(name, email);
  return (
    <span
      aria-hidden
      className={cn(
        "inline-flex size-4 shrink-0 items-center justify-center rounded-full text-[9px] leading-none font-semibold text-white select-none",
        className,
      )}
      style={{ backgroundColor: `hsl(${avatarHue(seed)} 45% 42%)` }}
    >
      {avatarInitial(seed)}
    </span>
  );
}
