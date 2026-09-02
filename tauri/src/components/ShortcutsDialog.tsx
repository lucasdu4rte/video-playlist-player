import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

const IS_MAC = navigator.platform.toLowerCase().includes("mac");
const mod = IS_MAC ? "⌘" : "Ctrl";

const SHORTCUTS: [string, string][] = [
  ["Open folder", `${mod} O`],
  ["Back to home", `${mod} ⇧ H`],
  ["Search the library", `${mod} K`],
  ["Toggle notes", `${mod} N`],
  ["Previous video", `${mod} ←`],
  ["Next video", `${mod} →`],
  ["Seek back 5s", "←"],
  ["Seek forward 5s", "→"],
];

export function ShortcutsDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Keyboard shortcuts</DialogTitle>
        </DialogHeader>
        <dl className="grid gap-1">
          {SHORTCUTS.map(([label, keys]) => (
            <div
              key={label}
              className="flex items-center justify-between rounded-md px-1 py-1.5 text-sm"
            >
              <dt className="text-muted-foreground">{label}</dt>
              <dd>
                <kbd className="rounded border bg-muted px-2 py-0.5 font-sans text-xs">
                  {keys}
                </kbd>
              </dd>
            </div>
          ))}
        </dl>
      </DialogContent>
    </Dialog>
  );
}
