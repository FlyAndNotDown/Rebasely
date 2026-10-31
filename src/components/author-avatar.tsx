import { avatarColor, avatarInitial, avatarSeed } from "@/lib/avatar";
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
  const initial = avatarInitial(seed);
  // Full-width glyphs sit slightly higher than Latin caps under the same baseline.
  const wide = (initial.codePointAt(0) ?? 0) >= 0x1100;
  return (
    <svg
      aria-hidden
      viewBox="0 0 18 18"
      className={cn("size-[18px] shrink-0", className)}
    >
      <circle
        cx="9"
        cy="9"
        r="8.7"
        fill={avatarColor(seed)}
        stroke="rgb(255 255 255 / 0.16)"
        strokeWidth="0.6"
      />
      <text
        x="9"
        y={wide ? 9.35 : 9.1}
        textAnchor="middle"
        dominantBaseline="central"
        fill="white"
        fontSize="11"
        fontWeight="500"
        fontFamily="Geist Variable, ui-sans-serif, sans-serif"
      >
        {initial}
      </text>
    </svg>
  );
}
