import { CircleUserRound, LogIn } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { signOut, type Account } from "@/lib/auth";
import { supabaseConfigured } from "@/lib/supabase";
import { flushNow } from "@/lib/sync";

type Props = {
  account: Account | null;
  onSignIn: () => void;
};

async function signOutAfterPush() {
  await flushNow();
  try {
    await signOut();
  } catch (error) {
    console.error("sign out failed", error);
  }
}

export function AccountMenu({ account, onSignIn }: Props) {
  if (!supabaseConfigured) return null;

  if (!account)
    return (
      <Button variant="ghost" size="sm" onClick={onSignIn} className="text-muted-foreground">
        <LogIn className="size-4" />
        Sign in
      </Button>
    );

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" aria-label="Account" className="text-muted-foreground">
          <CircleUserRound className="size-[18px]" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuLabel className="font-normal text-muted-foreground">
          {account.email}
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => void signOutAfterPush()}>Sign out</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
