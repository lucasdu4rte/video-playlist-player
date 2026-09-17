import type { Session, SupabaseClient } from "@supabase/supabase-js";
import { getSupabase, supabaseConfigured } from "@/lib/supabase";
import { openExternal, waitOAuthCode } from "@/lib/platform";
import { SyncCursor, hasStoredSession } from "@/lib/store";

export type Account = { userId: string; email: string };

const OAUTH_REDIRECT = "http://127.0.0.1:8787/auth/callback";
const PORT_CHECK_MS = 300;

const listeners = new Set<(account: Account | null) => void>();
let announcedUserId: string | null = null;
let watching = false;

function toAccount(session: Session | null): Account | null {
  const user = session?.user;
  if (!user) return null;
  return { userId: user.id, email: user.email ?? "" };
}

function requireAccount(session: Session | null): Account {
  const account = toAccount(session);
  if (!account) throw new Error("Sign-in finished without a session.");
  return account;
}

async function client(): Promise<SupabaseClient> {
  const supabase = await getSupabase();
  if (watching) return supabase;
  watching = true;
  // Token refreshes re-announce the same user; listeners only care about who is signed in.
  supabase.auth.onAuthStateChange((_event, session) => {
    const account = toAccount(session);
    const userId = account?.userId ?? null;
    if (userId === announcedUserId) return;
    announcedUserId = userId;
    if (userId === null) SyncCursor.clear();
    for (const listener of listeners) listener(account);
  });
  return supabase;
}

async function storedSession(): Promise<Session | null> {
  if (!supabaseConfigured || !hasStoredSession()) return null;
  const supabase = await client();
  const { data } = await supabase.auth.getSession();
  return data.session;
}

export async function sendEmailCode(email: string): Promise<void> {
  const supabase = await client();
  const { error } = await supabase.auth.signInWithOtp({ email });
  if (error) throw error;
}

export async function verifyEmailCode(email: string, code: string): Promise<Account> {
  const supabase = await client();
  const { data, error } = await supabase.auth.verifyOtp({ email, token: code, type: "email" });
  if (error) throw error;
  return requireAccount(data.session);
}

export async function signInWithGoogle(): Promise<Account> {
  const supabase = await client();
  const code = waitOAuthCode();
  // A busy port rejects almost immediately; surface that before sending the user to Google.
  const portError = await Promise.race([
    code.then(() => null, (error: unknown) => error),
    new Promise((resolve) => setTimeout(resolve, PORT_CHECK_MS)),
  ]);
  if (portError) throw portError;

  const { data, error } = await supabase.auth.signInWithOAuth({
    provider: "google",
    options: { redirectTo: OAUTH_REDIRECT, skipBrowserRedirect: true },
  });
  if (error) throw error;
  await openExternal(data.url);

  const exchanged = await supabase.auth.exchangeCodeForSession(await code);
  if (exchanged.error) throw exchanged.error;
  return requireAccount(exchanged.data.session);
}

export async function signOut(): Promise<void> {
  if (!supabaseConfigured) return;
  const supabase = await client();
  // "local" ends only this device's session; the default would sign out every device.
  const { error } = await supabase.auth.signOut({ scope: "local" });
  if (error) throw error;
}

export async function currentAccount(): Promise<Account | null> {
  return toAccount(await storedSession());
}

export async function accessToken(): Promise<string | null> {
  const session = await storedSession();
  return session?.access_token ?? null;
}

export function onAccountChange(cb: (account: Account | null) => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}
