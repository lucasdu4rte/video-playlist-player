import type { SupabaseClient } from "@supabase/supabase-js";
import { AUTH_STORAGE_KEY } from "@/lib/store";

export const SUPABASE_URL: string = import.meta.env.VITE_SUPABASE_URL ?? "";
export const SUPABASE_KEY: string = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY ?? "";
export const supabaseConfigured = SUPABASE_URL !== "";

let client: Promise<SupabaseClient> | null = null;

// Dynamic import keeps supabase-js out of the main bundle: signed-out users never fetch it.
export function getSupabase(): Promise<SupabaseClient> {
  client ??= import("@supabase/supabase-js").then(({ createClient }) =>
    createClient(SUPABASE_URL, SUPABASE_KEY, {
      auth: { flowType: "pkce", storageKey: AUTH_STORAGE_KEY },
    })
  );
  return client;
}
