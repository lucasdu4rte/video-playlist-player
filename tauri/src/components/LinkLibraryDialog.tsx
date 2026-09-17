import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Recents } from "@/lib/store";
import { linkLibrary, upsertLibrary, type LinkRequest } from "@/lib/sync";

type Props = {
  request: LinkRequest | null;
  onClose: () => void;
};

export function LinkLibraryDialog({ request, onClose }: Props) {
  const [busy, setBusy] = useState(false);

  const choose = async (libraryId: string | null) => {
    if (!request) return;
    setBusy(true);
    try {
      if (libraryId) await linkLibrary(request.path, libraryId, request.name);
      else await upsertLibrary(Recents.libraryIdFor(request.path), request.name);
    } catch (error) {
      console.error("library sync failed", error);
    } finally {
      setBusy(false);
      onClose();
    }
  };

  return (
    <Dialog open={request !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Already syncing this folder?</DialogTitle>
          <DialogDescription>
            If “{request?.name}” is a library you opened on another device, link it to share
            its progress and notes.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-2">
          {request?.candidates.map((library) => (
            <Button
              key={library.id}
              variant="outline"
              className="justify-start"
              disabled={busy}
              onClick={() => void choose(library.id)}
            >
              {library.name}
            </Button>
          ))}
        </div>
        <DialogFooter>
          <Button variant="secondary" disabled={busy} onClick={() => void choose(null)}>
            Keep as a new library
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
