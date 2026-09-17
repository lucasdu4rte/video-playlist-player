import { useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { sendEmailCode, signInWithGoogle, verifyEmailCode } from "@/lib/auth";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

export function SignInDialog({ open, onOpenChange }: Props) {
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [codeSentTo, setCodeSentTo] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const close = () => {
    onOpenChange(false);
    setCodeSentTo(null);
    setCode("");
    setError(null);
  };

  const run = async (task: () => Promise<unknown>, onSuccess: () => void) => {
    setBusy(true);
    setError(null);
    try {
      await task();
      onSuccess();
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setBusy(false);
    }
  };

  const requestCode = (event: FormEvent) => {
    event.preventDefault();
    const address = email.trim();
    void run(() => sendEmailCode(address), () => setCodeSentTo(address));
  };

  const submitCode = (event: FormEvent) => {
    event.preventDefault();
    if (codeSentTo === null) return;
    void run(() => verifyEmailCode(codeSentTo, code.trim()), close);
  };

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? onOpenChange(true) : close())}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Sign in</DialogTitle>
          <DialogDescription>
            Keep watched videos, progress and notes in sync across your devices.
          </DialogDescription>
        </DialogHeader>

        <Button variant="outline" disabled={busy} onClick={() => void run(signInWithGoogle, close)}>
          Continue with Google
        </Button>

        {codeSentTo === null ? (
          <form className="flex flex-col gap-2" onSubmit={requestCode}>
            <Input
              type="email"
              required
              autoComplete="email"
              placeholder="you@example.com"
              aria-label="Email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
            <Button type="submit" disabled={busy}>
              Email me a code
            </Button>
          </form>
        ) : (
          <form className="flex flex-col gap-2" onSubmit={submitCode}>
            <p className="text-sm text-muted-foreground">
              Enter the code sent to {codeSentTo}.
            </p>
            <Input
              required
              inputMode="numeric"
              autoComplete="one-time-code"
              pattern="[0-9]+"
              aria-label="Sign-in code"
              value={code}
              onChange={(e) => setCode(e.target.value)}
            />
            <Button type="submit" disabled={busy}>
              Verify
            </Button>
            <Button type="button" variant="ghost" onClick={() => setCodeSentTo(null)}>
              Use a different email
            </Button>
          </form>
        )}

        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
      </DialogContent>
    </Dialog>
  );
}
