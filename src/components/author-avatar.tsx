import { avatarUrl } from "@/lib/avatar";
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
  return (
    <img
      src={avatarUrl(provider, name, email)}
      alt=""
      draggable={false}
      className={cn("size-4 shrink-0 rounded-full bg-muted object-cover", className)}
    />
  );
}
