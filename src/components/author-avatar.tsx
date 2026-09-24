import { avatarHue, avatarInitial, avatarSeed, dicebearUrl } from "@/lib/avatar";
import { cn } from "@/lib/utils";
import type { AvatarProvider } from "@/types/git";

export function AuthorAvatar({
  name,
  email,
  provider,
  className,
}: {
  name: string;
  email: string;
  provider: AvatarProvider;
  className?: string;
}) {
  const seed = avatarSeed(name, email);
  if (provider === "dicebear-online") {
    return (
      <img
        src={dicebearUrl(seed)}
        alt=""
        loading="lazy"
        draggable={false}
        className={cn("size-4 shrink-0 rounded-full bg-muted object-cover", className)}
      />
    );
  }
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
