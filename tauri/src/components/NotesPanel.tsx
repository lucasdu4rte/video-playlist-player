import { useEffect, useState } from "react";
import { StickyNote } from "lucide-react";
import { Notes } from "@/lib/store";
import type { FileNode } from "@/lib/platform";
import { MiddleTruncate } from "@/components/MiddleTruncate";

export function NotesPanel({
  video,
  onNotesChange,
}: {
  video: FileNode | null;
  onNotesChange: () => void;
}) {
  const [text, setText] = useState("");

  useEffect(() => {
    setText(video ? Notes.note(video.path) : "");
  }, [video?.path]);

  return (
    <aside className="flex h-full w-full flex-col border-l bg-background">
      {video ? (
        <>
          <div className="flex items-center gap-1.5 border-b px-3 py-3 text-muted-foreground">
            <StickyNote className="size-4 shrink-0" />
            <MiddleTruncate
              text={video.name}
              className="font-semibold text-foreground"
            />
          </div>
          <textarea
            className="flex-1 resize-none select-text bg-transparent p-3 text-sm leading-relaxed outline-none"
            placeholder="Notes…"
            value={text}
            onChange={(e) => {
              const had = Notes.note(video.path).length > 0;
              setText(e.target.value);
              Notes.setNote(e.target.value, video.path);
              // Only ping the parent when the note appears or disappears —
              // that is all the sidebar marker depends on.
              if (had !== e.target.value.length > 0) onNotesChange();
            }}
          />
        </>
      ) : (
        <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center text-muted-foreground">
          <StickyNote className="size-11 opacity-40" />
          <div className="text-base font-semibold text-foreground">
            No video selected
          </div>
          <div className="max-w-72 text-xs">
            Choose a video to start taking notes.
          </div>
        </div>
      )}
    </aside>
  );
}
