import { cn } from "@/lib/utils";

// Keeps the distinguishing tail (e.g. "…03.mp4") visible while truncating the
// head.
export function MiddleTruncate({
  text,
  tail = 8,
  className,
}: {
  text: string;
  tail?: number;
  className?: string;
}) {
  if (text.length <= tail + 3) {
    return <span className={cn("truncate", className)}>{text}</span>;
  }
  const head = text.slice(0, text.length - tail);
  const end = text.slice(text.length - tail);
  return (
    <span className={cn("flex min-w-0", className)}>
      <span className="truncate">{head}</span>
      <span className="flex-none whitespace-pre">{end}</span>
    </span>
  );
}
