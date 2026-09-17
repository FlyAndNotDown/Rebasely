import type { ComponentType } from "react";
import {
  CheckIcon,
  ChevronRightIcon,
  CircleCheckIcon,
  InfoIcon,
  Loader2Icon,
  OctagonXIcon,
  TriangleAlertIcon,
  XIcon,
  type LucideProps,
} from "lucide-react";

const ICONS: Record<string, ComponentType<LucideProps>> = {
  CheckIcon,
  ChevronRightIcon,
  CircleCheckIcon,
  InfoIcon,
  Loader2Icon,
  OctagonXIcon,
  TriangleAlertIcon,
  XIcon,
};

export function IconPlaceholder({
  lucide,
  className,
}: {
  lucide?: string;
  className?: string;
  [key: string]: unknown;
}) {
  const Icon = lucide ? ICONS[lucide] : undefined;
  if (!Icon) return null;
  return <Icon className={className} />;
}
