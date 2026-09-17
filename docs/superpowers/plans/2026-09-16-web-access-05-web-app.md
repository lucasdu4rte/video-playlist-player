# Web on Vercel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Serve the same `src/` as a static web app on Vercel. Invited people sign in, browse the shared libraries from their Supabase snapshots, keep progress and notes in sync, and play videos streamed from the owner's PC. When the PC is off, the app says "PC offline" instead of breaking.

**Architecture:** `platform.ts` picks one of three runtime modes (`tauri`, `web`, `demo`). In web mode, `scanFolder` loads a `library_trees` snapshot and rewrites every node path to the synthetic `/<libraryId>/<relPath>`, so the stores, tree helpers and sync engine run unchanged. `resolveMediaSrc` turns such a path into a signed URL from the PC server that `hosts` points at. `main.tsx` wraps `App` in a `WebGate` that handles sign-in, the allowlist and starting sync, and `App` shows a `WebHome` listing Supabase libraries where desktop shows `Home`.

**Tech Stack:** React 19 + TypeScript + Vite 6 (`--mode web`), supabase-js v2 (PKCE redirect flow, `detectSessionInUrl`), vitest, Vercel CLI (manual deploy), Supabase CLI.

**Spec:** docs/superpowers/specs/2026-09-16-web-access-design.md
**Index / shared contract:** docs/superpowers/plans/2026-09-16-web-access-00-index.md

## Global Constraints

All constraints in the index apply. This plan adds:

- **Every deploy or remote write needs the user's explicit "yes" in the current conversation first.** That covers `npx vercel link`, `npx vercel env add`, `npx vercel deploy`, `npx supabase link`, `npx supabase db push`, and `git push`. Those steps are marked **REQUIRES USER CONFIRMATION**. Ask, wait for the answer, and only then run the command.
- **The web root string is `"/" + libraryId`, with no trailing slash.** `webRoot(id)` produces it. The stores append `SEP` (`"/"` on the web) when they match paths under a root, so `/<id>/` matches exactly that library's videos.
- **No runtime import cycles through `platform.ts`.** `platform.ts` may import `host.ts`, `webLibrary.ts` and `libraryPath.ts`. None of those may import `platform.ts` except as `import type`, and they must not import `auth.ts`, which does import `platform.ts`. `supabase.ts` (plan 2) must not import `platform.ts` either.
- **No dynamic `import()` of a module that is also imported statically.** Vite warns about it, and the build has to stay warning-free.
- Files under `src/lib/` import each other with relative paths (`./supabase`), as `tree.ts` already does, so vitest resolves them without relying on the alias.
- Web copy is fixed and must match exactly: "PC offline", "This video is no longer on the owner's computer.", "Ask the owner to invite <email>."

---

## File Structure

| File | Status | Responsibility |
|---|---|---|
| `tauri/src/lib/libraryPath.ts` | Modify | Add `webRoot`, `parseWebRoot` and `toWebTree` (web path conventions) |
| `tauri/src/lib/libraryPath.web.test.ts` | Create | Tests for the root convention, `toWebTree`, and the sync round trip |
| `tauri/src/lib/host.ts` | Create | Find the owner's host, decide whether it is online, and sign media URLs |
| `tauri/src/lib/host.test.ts` | Create | Tests for `isHostOnline` |
| `tauri/src/lib/webLibrary.ts` | Create | Supabase reads for the web: shared libraries and tree snapshots |
| `tauri/src/lib/webAuth.ts` | Create | Web-only auth: Google redirect, email link, `is_allowed` |
| `tauri/src/lib/platform.ts` | Modify | `mode`, `resolveMediaSrc`, and web behaviour of the native bridge; remove `toMediaSrc` |
| `tauri/src/lib/sync.ts` | Modify | `upsertLibrary` does nothing outside Tauri, because only the desktop writes `libraries` |
| `tauri/src/vite-env.d.ts` | Create if missing | `vite/client` types for `import.meta.env` |
| `tauri/src/components/Player.tsx` | Modify | Resolve the source asynchronously and show the offline or missing notice inline |
| `tauri/src/components/ui/input.tsx` | Create (shadcn CLI) | Text input used by the sign-in form |
| `tauri/src/components/SignInScreen.tsx` | Create | Google button, email link, and optional 6-digit code |
| `tauri/src/components/WebGate.tsx` | Create | Route between signed out, not invited, unreachable and ready; start sync |
| `tauri/src/main.tsx` | Modify | Wrap `App` in `WebGate` in web mode |
| `tauri/src/components/WebHome.tsx` | Create | Shared-library grid with watched counts, plus sign-out |
| `tauri/src/App.tsx` | Modify | Render `WebHome` on the web, open libraries, use the display-name root, poll host status |
| `tauri/src/components/AppHeader.tsx` | Modify | Traffic-light inset only in Tauri, and a "PC offline" badge |
| `tauri/src/components/Sidebar.tsx` | Modify | Hide "Reveal in file manager" on the web |
| `tauri/src/components/ShortcutsDialog.tsx` | Modify | Hide the "Open folder" shortcut on the web |
| `tauri/supabase/config.toml` | Modify | Allow `vite preview` origins as redirect URLs |
| `tauri/package.json` | Modify | `dev:web`, `build:web` and `preview:web` scripts |
| `tauri/.env.web.example` | Create | Web env template |
| `tauri/.gitignore` | Modify | Ignore `dist-web/`, `.env.web*` (except the example) and `.vercel/` |
| `tauri/vercel.json` | Create | Static build settings and the SPA rewrite |
| `tauri/.vercelignore` | Create | Keep `src-tauri/`, build output and env files out of the upload |

---

### Task 1: Web path conventions

**Files:**
- Modify: `tauri/src/lib/libraryPath.ts`
- Test: `tauri/src/lib/libraryPath.web.test.ts`

**Interfaces:**
- Consumes (plan 1): `toRelPath(path, root, sep)`, `webPath(libraryId, relPath)`, `parseWebPath(path)`, and `type FileNode` from `platform.ts`
- Produces (index extension):
  ```ts
  export function webRoot(libraryId: string): string;            // "/" + libraryId, no trailing slash
  export function parseWebRoot(root: string): string | null;     // inverse of webRoot
  export function toWebTree(libraryId: string, nodes: FileNode[]): FileNode[]; // rel paths → web paths, recursively
  ```

- [ ] **Step 1: Write the failing test**

Create `tauri/src/lib/libraryPath.web.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { FileNode } from "./platform";
import {
  parseWebPath,
  parseWebRoot,
  toRelPath,
  toWebTree,
  webPath,
  webRoot,
} from "./libraryPath";

const ID = "8c1d2f5e-0000-4000-8000-000000000001";

describe("web root convention", () => {
  it("is a slash and the library id, without a trailing slash", () => {
    expect(webRoot(ID)).toBe(`/${ID}`);
  });

  it("round-trips a web path to its rel_path for sync push", () => {
    expect(toRelPath(webPath(ID, "a/b.mp4"), "/" + ID, "/")).toBe("a/b.mp4");
    expect(toRelPath(webPath(ID, "a/b.mp4"), webRoot(ID), "/")).toBe("a/b.mp4");
  });

  it("puts every video of the library under the store prefix root + '/'", () => {
    expect(webPath(ID, "a.mp4").startsWith(webRoot(ID) + "/")).toBe(true);
  });

  it("does not treat a library whose id extends another as nested", () => {
    expect(toRelPath("/abcd/x.mp4", "/abc", "/")).toBeNull();
  });

  it("agrees with parseWebPath", () => {
    expect(parseWebPath(webPath(ID, "a/b.mp4"))).toEqual({
      libraryId: ID,
      relPath: "a/b.mp4",
    });
  });
});

describe("parseWebRoot", () => {
  it("returns the id of a web root", () => {
    expect(parseWebRoot(webRoot(ID))).toBe(ID);
  });

  it("rejects anything that is not exactly a root", () => {
    expect(parseWebRoot(`/${ID}/`)).toBeNull();
    expect(parseWebRoot(webPath(ID, "a.mp4"))).toBeNull();
    expect(parseWebRoot(ID)).toBeNull();
    expect(parseWebRoot("")).toBeNull();
    expect(parseWebRoot("/")).toBeNull();
  });
});

describe("toWebTree", () => {
  const snapshot: FileNode[] = [
    {
      path: "Module 1",
      name: "Module 1",
      type: "folder",
      children: [
        { path: "Module 1/01 Intro.mp4", name: "01 Intro.mp4", type: "video" },
      ],
    },
    { path: "README.mp4", name: "README.mp4", type: "video" },
  ];

  it("rewrites every path, recursively, keeping names and types", () => {
    expect(toWebTree(ID, snapshot)).toEqual([
      {
        path: `/${ID}/Module 1`,
        name: "Module 1",
        type: "folder",
        children: [
          { path: `/${ID}/Module 1/01 Intro.mp4`, name: "01 Intro.mp4", type: "video" },
        ],
      },
      { path: `/${ID}/README.mp4`, name: "README.mp4", type: "video" },
    ]);
  });

  it("leaves the snapshot untouched", () => {
    const before = structuredClone(snapshot);
    toWebTree(ID, snapshot);
    expect(snapshot).toEqual(before);
  });
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run from `tauri/`: `npx vitest run src/lib/libraryPath.web.test.ts`
Expected: FAIL. The imports `webRoot`, `parseWebRoot` and `toWebTree` do not exist (`is not a function`, or a TypeScript/esbuild missing-export error).

- [ ] **Step 3: Implement**

Append to `tauri/src/lib/libraryPath.ts`, and add the type import at the top of the file next to the existing imports:

```ts
import type { FileNode } from "./platform";
```

```ts
export function webRoot(libraryId: string): string {
  return `/${libraryId}`;
}

export function parseWebRoot(root: string): string | null {
  const match = /^\/([^/]+)$/.exec(root);
  return match ? match[1] : null;
}

export function toWebTree(libraryId: string, nodes: FileNode[]): FileNode[] {
  return nodes.map((node) => ({
    ...node,
    path: webPath(libraryId, node.path),
    children: node.children && toWebTree(libraryId, node.children),
  }));
}
```

- [ ] **Step 4: Run the test and confirm it passes**

Run: `npx vitest run src/lib/libraryPath.web.test.ts`
Expected: PASS, 10 tests. If "does not treat a library whose id extends another as nested" fails, the bug is in plan 1's `toRelPath`, which must require `root + sep` as the prefix. Fix it there. Loosening the test would make `watchedCount` count a sibling library's videos.

- [ ] **Step 5: Commit**

```sh
git add tauri/src/lib/libraryPath.ts tauri/src/lib/libraryPath.web.test.ts
git commit -m "feat(tauri): add web root and snapshot path helpers"
```

---

### Task 2: Host status and media signing

**Files:**
- Create: `tauri/src/lib/host.ts`
- Test: `tauri/src/lib/host.test.ts`

**Interfaces:**
- Consumes (plan 2): `getSupabase()` from `./supabase`; the `hosts` table (`owner_id, url, updated_at`). Consumes (plan 3): `GET {url}/health`, and `POST {url}/api/sign` with body `{ library, path }`, which returns `{ url }` as a relative URL.
- Produces (index extension):
  ```ts
  export const HOST_OFFLINE_AFTER_MS = 180_000;
  export type HostStatus = { url: string | null; online: boolean };
  export type MediaFailure = "offline" | "missing";
  export class MediaUnavailableError extends Error { reason: MediaFailure }
  export function isHostOnline(updatedAt: string, now: number): boolean;
  export function hostStatus(): Promise<HostStatus>;          // never rejects
  export function signMediaUrl(libraryId: string, relPath: string): Promise<string>; // absolute URL, or throws MediaUnavailableError
  ```

**Owner resolution:** guests don't know the owner's id. The web reads every `hosts` row RLS lets it see and uses the one with the latest `updated_at`. In this app that is the single owner's row.

- [ ] **Step 1: Write the failing test**

Create `tauri/src/lib/host.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { HOST_OFFLINE_AFTER_MS, isHostOnline } from "./host";

const NOW = Date.parse("2026-09-16T12:00:00Z");
const secondsAgo = (s: number) => new Date(NOW - s * 1000).toISOString();

describe("isHostOnline", () => {
  it("uses the 180 s window from the index", () => {
    expect(HOST_OFFLINE_AFTER_MS).toBe(180_000);
  });

  it("is online for a recent heartbeat", () => {
    expect(isHostOnline(secondsAgo(59), NOW)).toBe(true);
    expect(isHostOnline(secondsAgo(179), NOW)).toBe(true);
  });

  it("is still online exactly at the limit", () => {
    expect(isHostOnline(secondsAgo(180), NOW)).toBe(true);
  });

  it("is offline past the limit", () => {
    expect(isHostOnline(secondsAgo(181), NOW)).toBe(false);
  });

  it("parses Postgres timestamptz with microseconds and an offset", () => {
    expect(isHostOnline("2026-09-16T11:59:30.123456+00:00", NOW)).toBe(true);
    expect(isHostOnline("2026-09-16T11:50:00.123456+00:00", NOW)).toBe(false);
  });

  it("tolerates a device clock that runs behind the database", () => {
    expect(isHostOnline(secondsAgo(-30), NOW)).toBe(true);
  });

  it("is offline for an unparseable timestamp", () => {
    expect(isHostOnline("not a date", NOW)).toBe(false);
    expect(isHostOnline("", NOW)).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `npx vitest run src/lib/host.test.ts`
Expected: FAIL with `Failed to resolve import "./host"`.

- [ ] **Step 3: Implement**

Create `tauri/src/lib/host.ts`:

```ts
import { getSupabase } from "./supabase";

export const HOST_OFFLINE_AFTER_MS = 180_000;
const REQUEST_TIMEOUT_MS = 4_000;

export type HostStatus = { url: string | null; online: boolean };

export type MediaFailure = "offline" | "missing";

export class MediaUnavailableError extends Error {
  reason: MediaFailure;

  constructor(reason: MediaFailure) {
    super(`media unavailable: ${reason}`);
    this.reason = reason;
  }
}

export function isHostOnline(updatedAt: string, now: number): boolean {
  const at = Date.parse(updatedAt);
  if (Number.isNaN(at)) return false;
  return now - at <= HOST_OFFLINE_AFTER_MS;
}

type HostRow = { url: string; updated_at: string };

async function latestHost(): Promise<HostRow | null> {
  try {
    const supabase = await getSupabase();
    const { data, error } = await supabase
      .from("hosts")
      .select("url, updated_at")
      .order("updated_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) throw error;
    return data;
  } catch (error) {
    console.error("hosts query failed", error);
    return null;
  }
}

async function answersHealth(url: string): Promise<boolean> {
  try {
    const res = await fetch(`${url}/health`, {
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export async function hostStatus(): Promise<HostStatus> {
  const host = await latestHost();
  if (!host) return { url: null, online: false };
  const url = host.url.replace(/\/+$/, "");
  if (!isHostOnline(host.updated_at, Date.now())) return { url, online: false };
  return { url, online: await answersHealth(url) };
}

// Read the token straight from the client: auth.ts imports platform.ts, which
// imports this module, so going through auth.ts would close an import cycle.
async function bearerToken(): Promise<string> {
  const supabase = await getSupabase();
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new MediaUnavailableError("offline");
  return token;
}

export async function signMediaUrl(libraryId: string, relPath: string): Promise<string> {
  const host = await hostStatus();
  if (!host.url || !host.online) throw new MediaUnavailableError("offline");
  const token = await bearerToken();
  const res = await fetch(`${host.url}/api/sign`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ library: libraryId, path: relPath }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  }).catch(() => null);
  if (!res) throw new MediaUnavailableError("offline");
  if (res.status === 404) throw new MediaUnavailableError("missing");
  if (!res.ok) throw new MediaUnavailableError("offline");
  const body = (await res.json()) as { url: string };
  return host.url + body.url;
}
```

- [ ] **Step 4: Run the test and confirm it passes**

Run: `npx vitest run src/lib/host.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Type-check**

Run: `npx tsc -p tsconfig.app.json --noEmit`
Expected: no errors.

- [ ] **Step 6: Commit**

```sh
git add tauri/src/lib/host.ts tauri/src/lib/host.test.ts
git commit -m "feat(tauri): resolve the sharing host and sign media urls"
```

---

### Task 3: Platform web mode

**Files:**
- Create: `tauri/src/lib/webLibrary.ts`
- Create if missing: `tauri/src/vite-env.d.ts`
- Modify: `tauri/src/lib/platform.ts`
- Modify: `tauri/src/lib/sync.ts`

**Interfaces:**
- Consumes: `getSupabase` (plan 2); `parseWebPath` (plan 1); `parseWebRoot` and `toWebTree` (Task 1); `signMediaUrl` and `MediaUnavailableError` (Task 2); tables `libraries` and `library_trees`.
- Produces:
  ```ts
  // platform.ts (index contract)
  export type PlatformMode = "tauri" | "web" | "demo";
  export const mode: PlatformMode;
  export function resolveMediaSrc(path: string): Promise<string>;
  // webLibrary.ts (index extension)
  export type WebLibrary = { id: string; name: string };
  export function listWebLibraries(): Promise<WebLibrary[]>;   // on_web only, ordered by name
  export function loadWebTree(root: string): Promise<FileNode[]>; // root = webRoot(id)
  ```
- Removes: `toMediaSrc`. `Player.tsx` is its only caller and moves over in Task 4. This task and Task 4 must land together before the build is green.

**Web behaviour of the bridge, exactly:**

| Function | `web` |
|---|---|
| `scanFolder(root)` | `loadWebTree(root)`: the snapshot mapped with `toWebTree`. An unknown or unshared library throws, and `App.openFolder` already logs and shows an empty tree |
| `pathExists(path)` | `false`, because nothing on the web is a local path. Only `Home` and the drop handler call it, and neither runs on the web |
| `pickFolder()` | `null`, so Cmd/Ctrl+O does nothing |
| `revealInFinder(path)` | no-op |
| `onFolderDrop(...)` | no-op unlisten, as it already is outside Tauri |
| `resolveMediaSrc(path)` | `parseWebPath` → `signMediaUrl`. A path that isn't a web path throws `MediaUnavailableError("missing")` |

**Mode rule:** `tauri` when `isTauri`. `web` when not in Tauri **and** Vite's `MODE` is `"web"` **and** `VITE_SUPABASE_URL` is set. Otherwise `demo`. Requiring `MODE === "web"` is a deliberate narrowing of the index's "`!isTauri && supabaseConfigured`": the desktop `.env` also carries the Supabase URL, and without the extra check `npm run preview` would stop showing the demo tree.

- [ ] **Step 1: Check the plan 2 preconditions**

Run from `tauri/`:
```sh
grep -n "platform" src/lib/supabase.ts
grep -n "flowType\|detectSessionInUrl" src/lib/supabase.ts
grep -n "export async function upsertLibrary\|export function upsertLibrary" src/lib/sync.ts
test -f src/vite-env.d.ts && echo present || echo missing
```
Expected:
- The first grep prints nothing, so `supabase.ts` does not import `platform.ts`. If it does, stop and report it, because Task 2's import graph depends on this.
- The second grep shows `flowType: "pkce"` and no `detectSessionInUrl: false`. If `detectSessionInUrl: false` is there, delete that line. Desktop exchanges its loopback code by calling `exchangeCodeForSession` itself, and the option only does anything when the page URL carries `?code=`. The web needs it on.
- The third grep prints one definition.

- [ ] **Step 2: Add Vite client types when missing**

Run: `test -f src/vite-env.d.ts || printf '/// <reference types="vite/client" />\n' > src/vite-env.d.ts`

- [ ] **Step 3: Write `webLibrary.ts`**

Create `tauri/src/lib/webLibrary.ts`:

```ts
import type { FileNode } from "./platform";
import { parseWebRoot, toWebTree } from "./libraryPath";
import { getSupabase } from "./supabase";

export type WebLibrary = { id: string; name: string };

// RLS already hides unshared libraries from guests, but the owner can read all
// of theirs, and the web shows only what is shared for everyone.
export async function listWebLibraries(): Promise<WebLibrary[]> {
  const supabase = await getSupabase();
  const { data, error } = await supabase
    .from("libraries")
    .select("id, name")
    .eq("on_web", true)
    .order("name");
  if (error) throw error;
  return data;
}

export async function loadWebTree(root: string): Promise<FileNode[]> {
  const libraryId = parseWebRoot(root);
  if (!libraryId) throw new Error(`not a web library root: ${root}`);
  const supabase = await getSupabase();
  const { data, error } = await supabase
    .from("library_trees")
    .select("tree")
    .eq("library_id", libraryId)
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new Error(`no snapshot for library ${libraryId}`);
  return toWebTree(libraryId, data.tree as FileNode[]);
}
```

- [ ] **Step 4: Add `mode` and the web branches to `platform.ts`**

In `tauri/src/lib/platform.ts`, add these imports below the existing ones:

```ts
import { parseWebPath } from "./libraryPath";
import { MediaUnavailableError, signMediaUrl } from "./host";
import { loadWebTree } from "./webLibrary";
```

Directly below `export const isTauri = "__TAURI_INTERNALS__" in window;`, add:

```ts
export type PlatformMode = "tauri" | "web" | "demo";

function detectMode(): PlatformMode {
  if (isTauri) return "tauri";
  // Checked on the env rather than supabase.ts to keep this module free of an
  // import cycle. MODE is required too: the desktop .env also carries the URL,
  // and `npm run preview` must keep showing the demo tree.
  if (import.meta.env.MODE === "web" && import.meta.env.VITE_SUPABASE_URL) return "web";
  return "demo";
}

export const mode: PlatformMode = detectMode();
```

If plan 1 defined `SEP` by reading `isTauri`, leave it as it is. `SEP` only needs `isTauri`, and `mode` is declared after `isTauri`.

Replace `scanFolder`:

```ts
export function scanFolder(path: string): Promise<FileNode[]> {
  if (!isTauri) return Promise.resolve(DEMO_TREE);
  return invoke("scan_folder", { path });
}
```
with:
```ts
export function scanFolder(path: string): Promise<FileNode[]> {
  if (mode === "web") return loadWebTree(path);
  if (!isTauri) return Promise.resolve(DEMO_TREE);
  return invoke("scan_folder", { path });
}
```

Replace `pathExists`:

```ts
export function pathExists(path: string): Promise<boolean> {
  if (!isTauri) return Promise.resolve(true);
  return invoke("path_exists", { path });
}
```
with:
```ts
export function pathExists(path: string): Promise<boolean> {
  if (mode === "web") return Promise.resolve(false);
  if (!isTauri) return Promise.resolve(true);
  return invoke("path_exists", { path });
}
```

Replace `toMediaSrc`:

```ts
export function toMediaSrc(path: string): string {
  return isTauri ? convertFileSrc(path) : path;
}
```
with:
```ts
export async function resolveMediaSrc(path: string): Promise<string> {
  if (mode === "tauri") return convertFileSrc(path);
  if (mode === "demo") return path;
  const target = parseWebPath(path);
  if (!target) throw new MediaUnavailableError("missing");
  return signMediaUrl(target.libraryId, target.relPath);
}
```

In `pickFolder`, replace:
```ts
  if (!isTauri) return "/Demo/Course Folder";
```
with:
```ts
  if (mode === "web") return null;
  if (!isTauri) return "/Demo/Course Folder";
```

In `revealInFinder`, replace:
```ts
export async function revealInFinder(path: string): Promise<void> {
  try {
```
with:
```ts
export async function revealInFinder(path: string): Promise<void> {
  if (!isTauri) return;
  try {
```

- [ ] **Step 5: Keep the web from writing `libraries`**

> **Note (plan 2 final review):** on the `lucas/web-access-02-supabase-auth` branch, `upsertLibrary` is a thin `serialized(() => registerLibrary(...))` wrapper, and `registerRecents` (run from `startSync`) calls the inner `registerLibrary` directly, bypassing `upsertLibrary` entirely. Put the guard below in `registerLibrary` itself, not in `upsertLibrary`, or a guest's `registerRecents` pass still writes `libraries`. Also note `registerOpenedLibrary` is now `async`, returning `Promise<LinkRequest | null>` (it decides inside the sync queue after the library list has loaded) — callers already `await` or `.then()` it, so this guard doesn't need to change its signature further.

`libraries` rows belong to the owner's desktop. On the web, `App.openFolder` runs for every library a guest opens, and RLS would reject a guest's upsert. In `tauri/src/lib/sync.ts`, make this the first statement of `registerLibrary`:

```ts
  if (mode !== "tauri") return;
```

Add `mode` to the existing `platform` import in `sync.ts`. If there is none, add `import { mode } from "./platform";`.

- [ ] **Step 6: Type-check (Player is still pending)**

Run: `npx tsc -p tsconfig.app.json --noEmit`
Expected: exactly one error, in `src/components/Player.tsx`: `Module '"@/lib/platform"' has no exported member 'toMediaSrc'`. Task 4 fixes it. Any other error has to be fixed now.

- [ ] **Step 7: Run the unit tests**

Run: `npx vitest run`
Expected: every suite passes, including plans 1–2 and Tasks 1–2.

No commit yet: the tree does not build until Task 4 is done. Task 4 commits both.

---

### Task 4: Player resolves its source asynchronously

**Files:**
- Modify: `tauri/src/components/Player.tsx`

**Interfaces:**
- Consumes: `resolveMediaSrc` (Task 3), plus `MediaUnavailableError` and `MediaFailure` (Task 2)
- Produces: the `Player` props and `PlayerHandle` stay exactly as they are.

**UX:** while the source resolves, the player area stays blank on the existing black background with `aria-busy`. On failure, the player area shows an inline notice styled like the existing "No video selected" state in `PlayerArea`, with a "Try again" button that resolves again:

| Reason | Title | Body |
|---|---|---|
| `offline` | PC offline | The owner's computer isn't sharing right now. The library, notes and progress still work. |
| `missing` | This video is no longer on the owner's computer. | It was moved or deleted after the library was last scanned. |

Any other error counts as `offline`. In Tauri and demo mode the source resolves within a microtask, so nothing visible changes there.

- [ ] **Step 1: Update imports**

In `tauri/src/components/Player.tsx`, replace:
```tsx
import { useImperativeHandle, useRef, useState, type Ref } from "react";
import { Play, Pause, ChevronsRight, ChevronsLeft } from "lucide-react";
```
with:
```tsx
import { useEffect, useImperativeHandle, useRef, useState, type Ref } from "react";
import { Play, Pause, ChevronsRight, ChevronsLeft, CloudOff, FileX } from "lucide-react";
```

and replace:
```tsx
import { toMediaSrc } from "@/lib/platform";
```
with:
```tsx
import { resolveMediaSrc } from "@/lib/platform";
import { MediaUnavailableError, type MediaFailure } from "@/lib/host";
import { Button } from "@/components/ui/button";
```

- [ ] **Step 2: Add the source state types and copy**

Directly below the `mimeFor` function, add:

```tsx
type Source =
  | { status: "resolving" }
  | { status: "ready"; src: string }
  | { status: "failed"; reason: MediaFailure };

function failureOf(error: unknown): MediaFailure {
  return error instanceof MediaUnavailableError ? error.reason : "offline";
}

const FAILURE_COPY = {
  offline: {
    icon: CloudOff,
    title: "PC offline",
    body: "The owner's computer isn't sharing right now. The library, notes and progress still work.",
  },
  missing: {
    icon: FileX,
    title: "This video is no longer on the owner's computer.",
    body: "It was moved or deleted after the library was last scanned.",
  },
} as const;
```

- [ ] **Step 3: Resolve the source inside `Player`**

Replace:
```tsx
  const startedRef = useRef(false);
  const resumedRef = useRef(false);
```
with:
```tsx
  const startedRef = useRef(false);
  const resumedRef = useRef(false);
  const [source, setSource] = useState<Source>({ status: "resolving" });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setSource({ status: "resolving" });
    resolveMediaSrc(path).then(
      (src) => {
        if (!cancelled) setSource({ status: "ready", src });
      },
      (error: unknown) => {
        if (!cancelled) setSource({ status: "failed", reason: failureOf(error) });
      }
    );
    return () => {
      cancelled = true;
    };
  }, [path, attempt]);
```

Replace:
```tsx
  const FlashIcon = flash && FLASH_ICONS[flash.kind];
  const type = mimeFor(path);
  const src = toMediaSrc(path);

  return (
```
with:
```tsx
  const FlashIcon = flash && FLASH_ICONS[flash.kind];
  const type = mimeFor(path);

  if (source.status === "failed") {
    return (
      <MediaFailureNotice
        reason={source.reason}
        onRetry={() => setAttempt((n) => n + 1)}
      />
    );
  }
  if (source.status === "resolving") {
    return <div className="h-full w-full" aria-busy="true" />;
  }
  const { src } = source;

  return (
```

The `src={type ? { src, type } : src}` line stays as it is.

- [ ] **Step 4: Add the notice component**

Append to the end of `Player.tsx`, after `FLASH_ICONS`:

```tsx
function MediaFailureNotice({
  reason,
  onRetry,
}: {
  reason: MediaFailure;
  onRetry: () => void;
}) {
  const copy = FAILURE_COPY[reason];
  const Icon = copy.icon;
  return (
    <div
      role="alert"
      className="flex h-full w-full flex-col items-center justify-center gap-2 bg-card px-6 text-center text-muted-foreground"
    >
      <Icon className="size-11 opacity-40" />
      <div className="text-base font-semibold text-foreground">{copy.title}</div>
      <div className="max-w-80 text-xs">{copy.body}</div>
      <Button variant="outline" size="sm" className="mt-2 text-xs" onClick={onRetry}>
        Try again
      </Button>
    </div>
  );
}
```

- [ ] **Step 5: Type-check and build**

Run: `npx tsc -p tsconfig.app.json --noEmit && npm run build`
Expected: no type errors, and the Vite build finishes with no warnings. In particular there must be no "dynamically imported by … but also statically imported" warning.

- [ ] **Step 6: Check the desktop and demo modes by hand**

- `npm run tauri dev`, signed out: open a folder and play a video. It starts as before, with no visible blank frame and no request in the devtools Network tab.
- `npm run preview`, then open `http://localhost:4173` in a normal browser: the demo tree loads as before. The demo videos never played in a browser, so nothing changes there.

- [ ] **Step 7: Commit Tasks 3 and 4**

```sh
git add tauri/src/lib/webLibrary.ts tauri/src/lib/platform.ts tauri/src/lib/sync.ts tauri/src/components/Player.tsx
git add tauri/src/vite-env.d.ts 2>/dev/null || true
git commit -m "feat(tauri): add web platform mode with signed media sources"
```

---

### Task 5: Web sign-in gate

**Files:**
- Create: `tauri/src/lib/webAuth.ts`
- Create (shadcn CLI): `tauri/src/components/ui/input.tsx`
- Create: `tauri/src/components/SignInScreen.tsx`
- Create: `tauri/src/components/WebGate.tsx`
- Modify: `tauri/src/main.tsx`
- Modify: `tauri/supabase/config.toml`
- Modify (only if plan 2 starts sync there): `tauri/src/App.tsx`

**Interfaces:**
- Consumes (plan 2): `Account`, `currentAccount`, `onAccountChange`, `verifyEmailCode`, `signOut` from `auth.ts`; `startSync` from `sync.ts`; `getSupabase`; SQL `public.is_allowed()`
- Produces (index extension):
  ```ts
  // webAuth.ts
  export function signInWithGoogleRedirect(): Promise<void>;
  export function sendEmailLink(email: string): Promise<void>;
  export function isAllowed(): Promise<boolean>;
  // components
  export function SignInScreen(): JSX.Element;
  export function WebGate(props: { children: ReactNode }): JSX.Element;
  ```

**Flow:** Google and the email link both use the normal browser redirect back to `window.location.origin`. With `flowType: "pkce"` and `detectSessionInUrl` on (checked in Task 3, Step 1), supabase-js exchanges `?code=` while the client initialises, so `currentAccount()` resolves to the new account. The PKCE verifier lives in this browser's storage, so an email link only works on the device that requested it. The 6-digit code from the same email works anywhere through `verifyEmailCode`.

- [ ] **Step 1: Write `webAuth.ts`**

Create `tauri/src/lib/webAuth.ts`:

```ts
import { getSupabase } from "./supabase";

export async function signInWithGoogleRedirect(): Promise<void> {
  const supabase = await getSupabase();
  const { error } = await supabase.auth.signInWithOAuth({
    provider: "google",
    options: { redirectTo: window.location.origin },
  });
  if (error) throw error;
}

// Creating the user is fine: the allowlist, not the account, decides access.
export async function sendEmailLink(email: string): Promise<void> {
  const supabase = await getSupabase();
  const { error } = await supabase.auth.signInWithOtp({
    email,
    options: { emailRedirectTo: window.location.origin, shouldCreateUser: true },
  });
  if (error) throw error;
}

export async function isAllowed(): Promise<boolean> {
  const supabase = await getSupabase();
  const { data, error } = await supabase.rpc("is_allowed");
  if (error) throw error;
  return data === true;
}
```

- [ ] **Step 2: Add the shadcn input**

Run from `tauri/`: `npx shadcn@latest add input`
Expected: `src/components/ui/input.tsx` is created, and `package.json` gains no new dependencies. Check with `git diff --stat package.json`, which should print nothing.

- [ ] **Step 3: Write `SignInScreen.tsx`**

Create `tauri/src/components/SignInScreen.tsx`:

```tsx
import { useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { verifyEmailCode } from "@/lib/auth";
import { sendEmailLink, signInWithGoogleRedirect } from "@/lib/webAuth";

function redirectError(): string | null {
  return new URLSearchParams(window.location.search).get("error_description");
}

export function SignInScreen() {
  const [email, setEmail] = useState("");
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(redirectError);

  const attempt = async (action: () => Promise<unknown>, failure: string) => {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (e) {
      console.error(failure, e);
      setError(failure);
    } finally {
      setBusy(false);
    }
  };

  const sendLink = (event: FormEvent) => {
    event.preventDefault();
    const address = email.trim();
    if (!address) return;
    void attempt(async () => {
      await sendEmailLink(address);
      setSentTo(address);
      setCode("");
    }, "Couldn't send the email. Check the address and try again.");
  };

  const verifyCode = (event: FormEvent) => {
    event.preventDefault();
    if (!sentTo) return;
    void attempt(
      () => verifyEmailCode(sentTo, code.trim()),
      "That code didn't work. Check it or send a new email."
    );
  };

  const continueWithGoogle = () =>
    void attempt(signInWithGoogleRedirect, "Couldn't start Google sign-in. Try again.");

  return (
    <main className="grid h-full place-items-center overflow-auto px-4 py-10">
      <div className="flex w-full max-w-sm flex-col gap-6">
        <header className="flex flex-col gap-2 text-center">
          <h1 className="text-2xl font-semibold tracking-[-0.03em]">Sign in to watch</h1>
          <p className="text-sm text-muted-foreground">
            Only invited people can open these libraries.
          </p>
        </header>

        {sentTo ? (
          <form onSubmit={verifyCode} className="flex flex-col gap-3">
            <p className="text-sm">
              <strong>Check your email.</strong> We sent a link to {sentTo}. Open it
              on this device, or enter the 6-digit code from the same email.
            </p>
            <Input
              value={code}
              onChange={(e) => setCode(e.target.value)}
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              placeholder="123456"
              aria-label="6-digit code"
            />
            <Button type="submit" disabled={busy || code.trim().length !== 6}>
              Verify code
            </Button>
            <Button type="button" variant="ghost" onClick={() => setSentTo(null)}>
              Use a different email
            </Button>
          </form>
        ) : (
          <>
            <Button size="lg" disabled={busy} onClick={continueWithGoogle}>
              Continue with Google
            </Button>
            <div className="flex items-center gap-3 text-xs text-muted-foreground">
              <span className="h-px flex-1 bg-border" />
              or
              <span className="h-px flex-1 bg-border" />
            </div>
            <form onSubmit={sendLink} className="flex flex-col gap-3">
              <Input
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                autoComplete="email"
                placeholder="you@example.com"
                aria-label="Email"
              />
              <Button type="submit" variant="outline" disabled={busy}>
                Email me a sign-in link
              </Button>
            </form>
          </>
        )}

        {error && (
          <p role="alert" className="text-center text-sm text-destructive">
            {error}
          </p>
        )}
      </div>
    </main>
  );
}
```

- [ ] **Step 4: Write `WebGate.tsx`**

Create `tauri/src/components/WebGate.tsx`:

```tsx
import { useEffect, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { SignInScreen } from "@/components/SignInScreen";
import { currentAccount, onAccountChange, signOut, type Account } from "@/lib/auth";
import { startSync } from "@/lib/sync";
import { isAllowed } from "@/lib/webAuth";

type Gate =
  | { kind: "checking" }
  | { kind: "signedOut" }
  | { kind: "unreachable" }
  | { kind: "notInvited"; account: Account }
  | { kind: "ready"; account: Account };

async function gateFor(account: Account | null): Promise<Gate> {
  if (!account) return { kind: "signedOut" };
  try {
    const allowed = await isAllowed();
    return allowed ? { kind: "ready", account } : { kind: "notInvited", account };
  } catch (error) {
    console.error("is_allowed failed", error);
    return { kind: "unreachable" };
  }
}

function dropAuthParams() {
  const url = new URL(window.location.href);
  if (!url.searchParams.has("code")) return;
  window.history.replaceState(null, "", url.pathname);
}

export function WebGate({ children }: { children: ReactNode }) {
  const [gate, setGate] = useState<Gate>({ kind: "checking" });

  useEffect(() => {
    let alive = true;
    let latest = 0;
    const settle = async (account: Account | null) => {
      const seq = ++latest;
      const next = await gateFor(account);
      if (!alive || seq !== latest) return;
      if (account) dropAuthParams();
      setGate(next);
    };
    currentAccount().then(settle, () => {
      if (alive) setGate({ kind: "unreachable" });
    });
    const unsubscribe = onAccountChange((account) => void settle(account));
    return () => {
      alive = false;
      unsubscribe();
    };
  }, []);

  const userId = gate.kind === "ready" ? gate.account.userId : null;
  const email = gate.kind === "ready" ? gate.account.email : null;
  useEffect(() => {
    if (!userId || !email) return;
    return startSync({ userId, email });
  }, [userId, email]);

  if (gate.kind === "ready") return <>{children}</>;
  if (gate.kind === "signedOut") return <SignInScreen />;
  if (gate.kind === "checking") return <GateMessage title="Checking your account…" />;
  if (gate.kind === "unreachable") {
    return (
      <GateMessage
        title="Couldn't reach the server"
        body="Check your connection and try again."
        action={<Button onClick={() => window.location.reload()}>Try again</Button>}
      />
    );
  }
  return (
    <GateMessage
      title="You're not on the guest list"
      body={`Ask the owner to invite ${gate.account.email}.`}
      action={
        <Button variant="outline" onClick={() => void signOut()}>
          Sign out
        </Button>
      }
    />
  );
}

function GateMessage({
  title,
  body,
  action,
}: {
  title: string;
  body?: string;
  action?: ReactNode;
}) {
  return (
    <main className="grid h-full place-items-center px-4">
      <div className="flex max-w-sm flex-col items-center gap-3 text-center">
        <h1 className="text-2xl font-semibold tracking-[-0.03em]">{title}</h1>
        {body && <p className="text-sm text-muted-foreground">{body}</p>}
        {action}
      </div>
    </main>
  );
}
```

- [ ] **Step 5: Mount the gate in `main.tsx`**

In `tauri/src/main.tsx`, add the imports:
```tsx
import { mode } from "@/lib/platform";
import { WebGate } from "@/components/WebGate";
```

and replace the `<App />` element inside `<TooltipProvider …>`:
```tsx
      <App />
```
with:
```tsx
      {mode === "web" ? (
        <WebGate>
          <App />
        </WebGate>
      ) : (
        <App />
      )}
```

- [ ] **Step 6: Start sync once per mode**

Run: `grep -rn "startSync(" src --include=*.tsx --include=*.ts`
Expected: the definition in `src/lib/sync.ts`, the new call in `src/components/WebGate.tsx`, and possibly one call plan 2 added in `src/App.tsx`.

If `App.tsx` has a call, change its guard so it only runs on the desktop. For example, if plan 2 wrote

```tsx
    if (!account) return;
    return startSync(account);
```
change it to
```tsx
    if (!account || mode !== "tauri") return;
    return startSync(account);
```
and add `mode` to `App.tsx`'s `@/lib/platform` import. Whatever the exact shape, the rule is: the `App.tsx` call returns early unless `mode === "tauri"`.

- [ ] **Step 7: Allow the preview origin as a local redirect**

In `tauri/supabase/config.toml`, add `"http://localhost:4173"` and `"http://127.0.0.1:4173"` to the existing `additional_redirect_urls` array. Keep every entry already there, including the desktop loopback callback from plan 2. If plan 2 added `http://127.0.0.1:8787/auth/callback` and nothing else, the line becomes:

```toml
additional_redirect_urls = ["http://localhost:1420", "http://127.0.0.1:1420", "http://127.0.0.1:8787/auth/callback", "http://localhost:4173", "http://127.0.0.1:4173"]
```

Restart the local stack so Auth picks up the change: `npx supabase stop && npx supabase start`. This is local only and needs no confirmation.

- [ ] **Step 8: Type-check and build**

Run: `npx tsc -p tsconfig.app.json --noEmit && npm run build`
Expected: no errors and no warnings.

- [ ] **Step 9: Commit**

```sh
git add tauri/src/lib/webAuth.ts tauri/src/components/ui/input.tsx tauri/src/components/SignInScreen.tsx tauri/src/components/WebGate.tsx tauri/src/main.tsx tauri/supabase/config.toml tauri/src/App.tsx
git commit -m "feat(tauri): gate the web build behind sign-in and the allowlist"
```

---

### Task 6: Web home, library opening and offline badge

**Files:**
- Create: `tauri/src/components/WebHome.tsx`
- Modify: `tauri/src/App.tsx`
- Modify: `tauri/src/components/AppHeader.tsx`
- Modify: `tauri/src/components/Sidebar.tsx`
- Modify: `tauri/src/components/ShortcutsDialog.tsx`

**Interfaces:**
- Consumes: `listWebLibraries` and `WebLibrary` (Task 3); `webRoot` (Task 1); `hostStatus` (Task 2); `Recents.link` (plan 1); `currentAccount` and `signOut` (plan 2); `mode` (Task 3)
- Produces:
  ```ts
  export function WebHome(props: { onOpen: (library: WebLibrary) => void }): JSX.Element;
  // AppHeader gains an optional prop
  type Props = { canGoBack: boolean; onHome: () => void; onShowShortcuts: () => void; hostOffline?: boolean };
  // App.openFolder gains an optional display name (internal)
  openFolder(path: string, displayName?: string): Promise<void>
  ```

**Opening a library on the web:** `Recents.link(webRoot(id), id)` runs first, so `Recents.libraryIdFor(webRoot(id)) === id`. Then `openFolder(webRoot(id), library.name)` runs. Sync push maps a dirty key `/<id>/<rel>` through `Recents.pathFor(id) === "/<id>"` and `toRelPath(key, "/<id>", "/")` to `<rel>`, which Task 1 tests. Everything after that (sidebar, notes, watched, keyboard, "continue" state) runs unchanged. The sidebar title and breadcrumb now use the library's name instead of the last path segment, which on the web would be the UUID.

**Host polling:** in web mode only, `App` checks `hostStatus()` on mount, on window `focus`, and every 60 s while a video is open. The header shows "PC offline" when the last check was offline. Play stays clickable: the player itself shows the "PC offline" notice (Task 4), while the tree, notes and watched toggles keep working.

- [ ] **Step 1: Write `WebHome.tsx`**

Create `tauri/src/components/WebHome.tsx`:

```tsx
import { useEffect, useState } from "react";
import { FolderOpen, LogOut } from "lucide-react";
import { Button } from "@/components/ui/button";
import { MiddleTruncate } from "@/components/MiddleTruncate";
import { currentAccount, signOut } from "@/lib/auth";
import { webRoot } from "@/lib/libraryPath";
import { Watched } from "@/lib/store";
import { listWebLibraries, type WebLibrary } from "@/lib/webLibrary";

type Listing =
  | { status: "loading" }
  | { status: "failed" }
  | { status: "ready"; libraries: WebLibrary[] };

type Props = { onOpen: (library: WebLibrary) => void };

export function WebHome({ onOpen }: Props) {
  const [listing, setListing] = useState<Listing>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);
  const [email, setEmail] = useState("");

  useEffect(() => {
    let alive = true;
    void currentAccount().then((account) => {
      if (alive) setEmail(account?.email ?? "");
    });
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    let alive = true;
    setListing({ status: "loading" });
    listWebLibraries().then(
      (libraries) => {
        if (alive) setListing({ status: "ready", libraries });
      },
      (error: unknown) => {
        console.error("libraries query failed", error);
        if (alive) setListing({ status: "failed" });
      }
    );
    return () => {
      alive = false;
    };
  }, [attempt]);

  return (
    <div className="relative min-h-0 flex-1 overflow-auto">
      <div className="mx-auto max-w-[1180px] px-4 pb-20 pt-10 sm:px-11 sm:pt-14">
        <section className="flex flex-col gap-6 pb-10 sm:flex-row sm:items-end sm:justify-between sm:gap-8 sm:pb-14">
          <div>
            <p className="eyebrow mb-3">Shared libraries</p>
            <h1 className="text-3xl font-semibold tracking-[-0.04em] sm:text-5xl">
              Pick up where you left off.
            </h1>
            <p className="mt-4 text-[17px] text-muted-foreground">
              Signed in as {email}
            </p>
          </div>
          <Button
            variant="outline"
            size="lg"
            className="shrink-0 self-start sm:self-auto"
            onClick={() => void signOut()}
          >
            <LogOut className="size-[18px]" />
            Sign out
          </Button>
        </section>

        <ListingBody
          listing={listing}
          onOpen={onOpen}
          onRetry={() => setAttempt((n) => n + 1)}
        />
      </div>
    </div>
  );
}

function ListingBody({
  listing,
  onOpen,
  onRetry,
}: {
  listing: Listing;
  onOpen: (library: WebLibrary) => void;
  onRetry: () => void;
}) {
  if (listing.status === "loading") {
    return <p className="text-sm text-muted-foreground">Loading libraries…</p>;
  }
  if (listing.status === "failed") {
    return (
      <div className="flex flex-col items-start gap-3">
        <p className="text-sm text-muted-foreground">
          Couldn't load the libraries. Check your connection.
        </p>
        <Button variant="outline" size="sm" onClick={onRetry}>
          Try again
        </Button>
      </div>
    );
  }
  if (listing.libraries.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        Nothing has been shared to the web yet.
      </p>
    );
  }
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      {listing.libraries.map((library) => (
        <LibraryCard
          key={library.id}
          library={library}
          onOpen={() => onOpen(library)}
        />
      ))}
    </div>
  );
}

function LibraryCard({
  library,
  onOpen,
}: {
  library: WebLibrary;
  onOpen: () => void;
}) {
  const watched = Watched.watchedCount(webRoot(library.id));
  return (
    <button
      onClick={onOpen}
      className="group relative rounded-xl border bg-card p-[18px] text-left transition-all hover:-translate-y-0.5 hover:border-primary/50"
    >
      <div className="relative grid h-[150px] place-items-center rounded-lg bg-primary-soft text-primary">
        <FolderOpen className="size-14" strokeWidth={1.4} />
        {watched > 0 && (
          <span className="absolute right-3 top-3 rounded-md bg-background/80 px-2.5 py-1.5 text-[11px] text-muted-foreground">
            {watched} watched
          </span>
        )}
      </div>
      <div className="mt-4">
        <MiddleTruncate text={library.name} className="text-base font-semibold" />
      </div>
    </button>
  );
}
```

- [ ] **Step 2: `App.tsx`, imports and state**

Replace the `@/lib/platform` import block:
```tsx
import {
  scanFolder,
  pathExists,
  pickFolder,
  onFolderDrop,
  setWindowTitle,
  type FileNode,
} from "@/lib/platform";
```
with (keep any names plans 1–4 added to this import):
```tsx
import {
  mode,
  scanFolder,
  pathExists,
  pickFolder,
  onFolderDrop,
  setWindowTitle,
  type FileNode,
} from "@/lib/platform";
import { hostStatus } from "@/lib/host";
import { webRoot } from "@/lib/libraryPath";
import type { WebLibrary } from "@/lib/webLibrary";
import { WebHome } from "@/components/WebHome";
```

Replace:
```tsx
const SEEK_STEP = 5; // seconds per arrow press
```
with:
```tsx
const SEEK_STEP = 5; // seconds per arrow press
const HOST_POLL_MS = 60_000;
```

Replace:
```tsx
  const [rootPath, setRootPath] = useState<string | null>(null);
```
with:
```tsx
  const [rootPath, setRootPath] = useState<string | null>(null);
  const [rootName, setRootName] = useState("Library");
  const [hostOffline, setHostOffline] = useState(false);
```

- [ ] **Step 3: `App.tsx`, use the display name for the root**

In `folderTrailFor`, replace:
```tsx
      if (ancestors.length === 0) return rootPath ? [basename(rootPath)] : [];
      return [...ancestors].reverse().map(basename);
    },
    [roots, rootPath]
```
with:
```tsx
      if (ancestors.length === 0) return rootPath ? [rootName] : [];
      return [...ancestors].reverse().map(basename);
    },
    [roots, rootPath, rootName]
```

In `openFolder`, replace:
```tsx
    async (path: string) => {
      persistProgress();
      void releaseWake();
      const name = path.split(/[\\/]/).filter(Boolean).pop() ?? path;
```
with:
```tsx
    async (path: string, displayName?: string) => {
      persistProgress();
      void releaseWake();
      const name = displayName ?? path.split(/[\\/]/).filter(Boolean).pop() ?? path;
```

and, in the same function, replace:
```tsx
      setRootPath(path);
```
with:
```tsx
      setRootPath(path);
      setRootName(name);
```

Delete the derived line near the end of the component:
```tsx
  const rootName = rootPath?.split(/[\\/]/).filter(Boolean).pop() ?? "Library";
```

- [ ] **Step 4: `App.tsx`, open a web library**

Directly below `selectFolder`'s `useCallback`, add:

```tsx
  const openLibrary = useCallback(
    (library: WebLibrary) => {
      const root = webRoot(library.id);
      Recents.link(root, library.id);
      void openFolder(root, library.name);
    },
    [openFolder]
  );
```

- [ ] **Step 5: `App.tsx`, poll host status on the web**

Directly after the `visibilitychange` / `beforeunload` `useEffect` block, add:

```tsx
  const videoOpen = currentVideo !== null;
  useEffect(() => {
    if (mode !== "web") return;
    let alive = true;
    const check = () => {
      void hostStatus().then((status) => {
        if (alive) setHostOffline(!status.online);
      });
    };
    check();
    window.addEventListener("focus", check);
    const timer = videoOpen ? window.setInterval(check, HOST_POLL_MS) : undefined;
    return () => {
      alive = false;
      window.removeEventListener("focus", check);
      window.clearInterval(timer);
    };
  }, [videoOpen]);
```

- [ ] **Step 6: `App.tsx`, render `WebHome` and pass the badge**

Directly before `return (` of the component, add:

```tsx
  const homeScreen =
    mode === "web" ? (
      <WebHome onOpen={openLibrary} />
    ) : (
      <Home
        dropping={dropping}
        onOpenFolder={selectFolder}
        onOpenPath={openFolder}
        onResume={resumeLast}
        onChanged={() => {
          setWatchedState(new Set(Watched.watched));
          bumpRecents((v) => v + 1);
        }}
      />
    );
```

Replace:
```tsx
      <AppHeader canGoBack={hasOpenedFolder} onHome={goHome} onShowShortcuts={() => setShowShortcuts(true)} />

      {!hasOpenedFolder ? (
        <Home
          dropping={dropping}
          onOpenFolder={selectFolder}
          onOpenPath={openFolder}
          onResume={resumeLast}
          onChanged={() => {
            setWatchedState(new Set(Watched.watched));
            bumpRecents((v) => v + 1);
          }}
        />
      ) : (
```
with:
```tsx
      <AppHeader
        canGoBack={hasOpenedFolder}
        onHome={goHome}
        onShowShortcuts={() => setShowShortcuts(true)}
        hostOffline={mode === "web" && hostOffline}
      />

      {!hasOpenedFolder ? (
        homeScreen
      ) : (
```

If plans 2–4 added props to `<Home …>` or `<AppHeader …>`, carry them over unchanged into the new JSX.

- [ ] **Step 7: `AppHeader.tsx`, Tauri-only inset and offline badge**

Replace:
```tsx
import { CircleHelp, Settings2, ChevronLeft } from "lucide-react";
```
with:
```tsx
import { CircleHelp, Settings2, ChevronLeft, CloudOff } from "lucide-react";
import { isTauri } from "@/lib/platform";
```

Replace:
```tsx
const IS_MAC = navigator.platform.toLowerCase().includes("mac");

type Props = {
  canGoBack: boolean;
  onHome: () => void;
  onShowShortcuts: () => void;
};
```
with:
```tsx
const HAS_TRAFFIC_LIGHTS = isTauri && navigator.platform.toLowerCase().includes("mac");

type Props = {
  canGoBack: boolean;
  onHome: () => void;
  onShowShortcuts: () => void;
  hostOffline?: boolean;
};
```

Replace:
```tsx
export function AppHeader({ canGoBack, onHome, onShowShortcuts }: Props) {
```
with:
```tsx
export function AppHeader({ canGoBack, onHome, onShowShortcuts, hostOffline }: Props) {
```

Replace:
```tsx
      style={IS_MAC ? { paddingLeft: 82 } : undefined}
```
with:
```tsx
      style={HAS_TRAFFIC_LIGHTS ? { paddingLeft: 82 } : undefined}
```

Directly after the brand `</button>` (the one containing `<span>Video Playlist Player</span>`), add:
```tsx
      {hostOffline && (
        <span className="ml-2 flex items-center gap-1.5 rounded-md border border-amber-500/40 px-2 py-1 text-[11px] font-medium text-amber-600 dark:text-amber-400">
          <CloudOff className="size-3.5" />
          PC offline
        </span>
      )}
```

- [ ] **Step 8: Hide the Tauri-only menu items**

In `tauri/src/components/Sidebar.tsx`, replace:
```tsx
import { revealInFinder, type FileNode } from "@/lib/platform";
```
with:
```tsx
import { mode, revealInFinder, type FileNode } from "@/lib/platform";
```
and replace:
```tsx
        <ContextMenuSeparator />
        <ContextMenuItem onClick={() => void revealInFinder(node.path)}>
          Reveal in file manager
        </ContextMenuItem>
```
with:
```tsx
        {mode !== "web" && (
          <>
            <ContextMenuSeparator />
            <ContextMenuItem onClick={() => void revealInFinder(node.path)}>
              Reveal in file manager
            </ContextMenuItem>
          </>
        )}
```

In `tauri/src/components/ShortcutsDialog.tsx`, add `import { mode } from "@/lib/platform";` below the dialog import, and replace:
```tsx
const SHORTCUTS: [string, string][] = [
  ["Open folder", `${mod} O`],
  ["Back to home", `${mod} ⇧ H`],
```
with:
```tsx
const OPEN_FOLDER: [string, string][] = mode === "web" ? [] : [["Open folder", `${mod} O`]];

const SHORTCUTS: [string, string][] = [
  ...OPEN_FOLDER,
  ["Back to home", `${mod} ⇧ H`],
```

- [ ] **Step 9: Type-check, test, build**

Run: `npx tsc -p tsconfig.app.json --noEmit && npx vitest run && npm run build`
Expected: no errors, all tests pass, and the build has no warnings.

- [ ] **Step 10: Check the desktop by hand**

`npm run tauri dev`: Home, recent folders, "Reveal in file manager", Cmd/Ctrl+O and the macOS traffic-light inset all behave as before. The sidebar title still shows the folder name.

- [ ] **Step 11: Commit**

```sh
git add tauri/src/components/WebHome.tsx tauri/src/App.tsx tauri/src/components/AppHeader.tsx tauri/src/components/Sidebar.tsx tauri/src/components/ShortcutsDialog.tsx
git commit -m "feat(tauri): list shared libraries and flag an offline pc on the web"
```

---

### Task 7: Web build and Vercel config

**Files:**
- Modify: `tauri/package.json`
- Create: `tauri/.env.web.example`
- Modify: `tauri/.gitignore`
- Create: `tauri/vercel.json`
- Create: `tauri/.vercelignore`

**Interfaces:**
- Produces: the scripts `dev:web`, `build:web` and `preview:web`, and the output directory `tauri/dist-web/`.

`vite build --mode web` loads `.env`, `.env.local`, `.env.web` and `.env.web.local`. On Vercel no `.env.web` exists, so the values come from project env vars, which Vite reads from `process.env` for the `VITE_` prefix. Vercel serves real files first and applies rewrites only afterwards, so the catch-all rewrite leaves `/assets/*` alone.

- [ ] **Step 1: Scripts**

In `tauri/package.json` `"scripts"`, add these three entries after `"preview"` and keep every existing entry:

```json
    "dev:web": "vite --mode web",
    "build:web": "vite build --mode web --outDir dist-web",
    "preview:web": "vite preview --mode web --outDir dist-web --port 4173 --strictPort",
```

- [ ] **Step 2: Env template and ignores**

Create `tauri/.env.web.example`:

```dotenv
# Copy to .env.web for npm run dev:web / build:web / preview:web.
# Local stack: both values come from `npx supabase status` (API URL, Publishable key).
VITE_SUPABASE_URL=http://127.0.0.1:54321
VITE_SUPABASE_PUBLISHABLE_KEY=paste-the-publishable-key-here
```

Append to `tauri/.gitignore`:

```gitignore
dist-web/
.env.web
.env.web.local
.vercel/
```

- [ ] **Step 3: Vercel files**

Create `tauri/vercel.json`:

```json
{
  "$schema": "https://openapi.vercel.sh/vercel.json",
  "framework": null,
  "installCommand": "npm ci",
  "buildCommand": "npm run build:web",
  "outputDirectory": "dist-web",
  "rewrites": [{ "source": "/(.*)", "destination": "/index.html" }]
}
```

Create `tauri/.vercelignore`:

```gitignore
src-tauri
dist
dist-web
.env*
```

- [ ] **Step 4: Build the web bundle**

Run: `cp .env.web.example .env.web`, then put the real publishable key from `npx supabase status` into `.env.web`. Then run `npm run build:web`.
Expected: the build finishes with no warnings and `dist-web/index.html` exists. Then run `ls dist-web/assets`. supabase-js should appear as its own chunk (a separate `*.js` file), because `supabase.ts` imports it dynamically.

- [ ] **Step 5: Check the desktop build is untouched**

Run: `npm run build`
Expected: no warnings. `dist/` is produced and `dist-web/` is not modified.

- [ ] **Step 6: Commit**

```sh
git add tauri/package.json tauri/.env.web.example tauri/.gitignore tauri/vercel.json tauri/.vercelignore
git commit -m "build(tauri): add the static web build and vercel config"
```

---

### Task 8: Local end-to-end check

No code changes. Every step below is manual and runs against the local Supabase stack. Check each box only after you have seen the expected result.

**Setup**

- [ ] **Step 1: Local stack and env**
  - `npx supabase start` (from `tauri/`). Note the API URL and publishable key.
  - `tauri/.env.web` has the local values (Task 7).
  - The desktop env (`tauri/.env.local`, from plan 2) has the local `VITE_SUPABASE_URL` and key, plus `VITE_WEB_ORIGIN=http://localhost:4173`, so the PC server's CORS accepts the preview origin.
  - `npm run build:web && npm run preview:web` serves the web app at `http://localhost:4173`. Use port 4173 because the desktop dev server already holds 1420.

- [ ] **Step 2: Owner on the desktop**
  - `npm run tauri dev`. Sign in with the owner email. The code arrives in Mailpit at `http://127.0.0.1:54324`.
  - Open a course folder, turn on "on web" for it, and enable sharing (plan 4). The `library_trees` row for it now exists, and `hosts` holds the tunnel URL with a fresh `updated_at`. Check both in Studio at `http://127.0.0.1:54323`.
  - To test without a tunnel, with the PC server running on `127.0.0.1:8787` through plan 3's localhost path, point `hosts` at localhost in the Studio SQL editor. Put the owner's email in place of `owner@example.com`:
    ```sql
    insert into public.hosts (owner_id, url, updated_at)
    select id, 'http://127.0.0.1:8787', now() from auth.users where email = 'owner@example.com'
    on conflict (owner_id) do update set url = excluded.url, updated_at = now();
    ```
    Without a heartbeat the row goes stale after 3 minutes. Re-run `update public.hosts set updated_at = now();` before each play. If sharing is on, its heartbeat overwrites this row with the tunnel URL.

**Owner on the web**

- [ ] **Step 3: Sign in by email link.** At `http://localhost:4173`, enter the owner email and choose "Email me a sign-in link". The screen switches to "Check your email." Open the Mailpit link in the same browser. It lands on `http://localhost:4173` with no `?code=` left in the address bar, and shows "Shared libraries" with only the on-web library.
- [ ] **Step 4: Sign in by code.** Sign out, send a new email, and type the 6-digit code instead of clicking the link. The result is the same.
- [ ] **Step 5: Play.** Open the library. The sidebar shows the snapshot with the library name as its title. Play a video: it streams, and seeking works (Range requests). Check the devtools Network tab: `POST …/api/sign` returns 200, and the media request goes to `…/media/<library>/…?u=&exp=&sig=`.
- [ ] **Step 6: Sync.** Mark a video as watched and write a note on the web. Wait for a push (30 s, or pause/change video), then focus the desktop window: the watched mark and note show up there. Make a change on the desktop, then focus the web tab (a pull on focus): the change appears after the next render, for example after going Home and back.

**Guest**

- [ ] **Step 7: Not invited.** In a private window, sign in with `guest@example.com` through the email code. The screen reads "You're not on the guest list" and "Ask the owner to invite guest@example.com." The "Sign out" button returns to the sign-in screen.
- [ ] **Step 8: Invited.** In Studio SQL, run `insert into public.allowed_emails (email) values ('guest@example.com');`. Sign in again as the guest. Only on-web libraries are listed. Playback works. The owner's notes do **not** appear, and a note the guest writes does not appear on the owner's desktop.

**PC offline and stale snapshot**

- [ ] **Step 9: PC offline.** Disable sharing on the desktop (the `hosts` row is deleted), or quit the app. Refocus the web tab: the header shows "PC offline". Click a video: the player shows "PC offline" with the body text and "Try again". Marking watched, notes and search all still work. Re-enable sharing and click "Try again": the video plays. The badge clears on the next focus, or within 60 s while a video is open.
- [ ] **Step 10: Stale snapshot.** With sharing on, delete or rename one video file on disk without rescanning. On the web, play that video: the player shows "This video is no longer on the owner's computer." If it shows "PC offline" instead, `/api/sign` is not returning 404 for a missing file. Report that against plan 3.

**Regression**

- [ ] **Step 11: Signed-out desktop.** Sign out on the desktop and restart `npm run tauri dev`. The devtools Network tab shows no request to Supabase, and `lsof -iTCP:8787 -sTCP:LISTEN` prints nothing.
- [ ] **Step 12: Demo preview.** `npm run build && npm run preview` in a normal browser shows the demo tree, with no sign-in screen.

---

### Task 9: Hosted Supabase and Vercel deploy (manual)

The user chose manual deploys. Every command in this task changes remote state. **Before each step marked REQUIRES USER CONFIRMATION, show the exact command, ask "Can I run this now?", and wait for an explicit yes in the current conversation.** Interactive logins (`npx supabase login`, `npx vercel login`) are for the user to run in their own terminal.

- [ ] **Step 1: Create the hosted project (user, in the dashboard)**
  The user creates the Supabase project at supabase.com and notes the project ref, the API URL (`https://<ref>.supabase.co`) and the publishable key. New projects use asymmetric JWT signing keys, which plan 3's JWKS check needs. Confirm this under Project Settings → JWT Keys.

- [ ] **Step 2: Link and push migrations — REQUIRES USER CONFIRMATION**
  From `tauri/`, with the user already logged in through `npx supabase login`:
  ```sh
  npx supabase link --project-ref <ref>
  npx supabase db push --dry-run
  ```
  Show the dry-run's migration list to the user. Only after a second, separate yes, run:
  ```sh
  npx supabase db push
  ```

- [ ] **Step 3: Invite people (user, in the SQL editor)**
  ```sql
  insert into public.allowed_emails (email) values ('guest@example.com');
  ```
  Add one row per guest. The owner needs no row.

- [ ] **Step 4: Link the Vercel project — REQUIRES USER CONFIRMATION**
  From `tauri/`, with the user already logged in through `npx vercel login`:
  ```sh
  npx vercel link
  ```
  Answer the prompts: create a new project, with `./` (that is, `tauri/`) as the code directory. `vercel.json` supplies the build settings. This creates `tauri/.vercel/`, which is already gitignored.

- [ ] **Step 5: Production env vars — REQUIRES USER CONFIRMATION**
  ```sh
  npx vercel env add VITE_SUPABASE_URL production
  npx vercel env add VITE_SUPABASE_PUBLISHABLE_KEY production
  ```
  Each command prompts for its value: the hosted API URL and the publishable key. Never the `service_role` key.

- [ ] **Step 6: Deploy — REQUIRES USER CONFIRMATION**
  ```sh
  npx vercel deploy --prod
  ```
  Note the production URL it prints (`https://<app>.vercel.app`). Steps 7–8 use it.

- [ ] **Step 7: Hosted Auth settings (user, in the dashboard)**
  - Authentication → URL Configuration → **Site URL**: `https://<app>.vercel.app`
  - Authentication → URL Configuration → **Redirect URLs**: `https://<app>.vercel.app` and `http://127.0.0.1:8787/auth/callback` (desktop Google loopback). Preview deployment URLs are not listed, so sign-in only works on production.
  - Authentication → Sign In / Providers → **Google**: enabled, with the client ID and secret from the owner's Google Cloud OAuth client. That client's authorized redirect URI must be `https://<ref>.supabase.co/auth/v1/callback`.
  - Authentication → Sign In / Providers → **Email**: enabled, with a 6-digit OTP length.
  - Authentication → Email Templates → **Magic Link**: the same template as plan 2's local one, carrying both `{{ .ConfirmationURL }}` and `{{ .Token }}`.
  - Authentication → Emails → **SMTP**: set up custom SMTP before inviting guests. The built-in sender is heavily rate-limited.
  - Authentication → Sign In / Providers → **Email**: **Confirm email** enabled — `is_allowed()` matches `auth.users.email_confirmed_at`, so an unconfirmed guest is never allowed in (plan 2 final review).
  - Settings → API → **max_rows**: at least 1000, to match `PAGE_SIZE` in `tauri/src/lib/sync.ts` (plan 2 final review).
  - Authentication → Sign In / Providers → **Google**: **Skip nonce checks** left off (plan 2 final review).

- [ ] **Step 8: Point the desktop at production**
  In the desktop env used for release builds, set `VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY` to the hosted values and `VITE_WEB_ORIGIN=https://<app>.vercel.app`. Rebuild with `npm run tauri build`, so the PC server's CORS accepts the production origin.

- [ ] **Step 9: Production smoke test**
  Repeat Task 8, Steps 3, 5, 7–9, against `https://<app>.vercel.app`, with the release desktop build sharing through its tunnel.

- [ ] **Step 10: Push the branch — REQUIRES USER CONFIRMATION**
  Ask "Can I push now? (branch `<current branch>` → `origin`)". Only after a yes, run `git push -u origin HEAD`.

---

## Self-Review

### Spec coverage

| Spec / brief requirement | Task |
|---|---|
| One frontend, three runtime modes chosen in `platform.ts` | 3 |
| Web `FileNode.path` is `/<library_id>/<rel_path>`; stores and tree helpers unchanged | 1, 3, 6 |
| `SEP` is `/` on the web (plan 1); root convention `"/" + id`, no trailing slash, proven by test | 1 |
| Libraries and trees come from `library_trees`; list, progress and notes work with the PC off | 3, 6, 8 (step 9) |
| Web shows only `on_web` libraries, filtered explicitly | 3 |
| Playback disabled with "PC offline" label; header badge | 4, 6 |
| Host online = heartbeat within 180 s and `/health` answers within 4 s; re-check on focus and every 60 s while a video is open | 2, 6 |
| Stale snapshot: sign → 404 → "no longer on disk" copy | 2, 4, 8 (step 10) |
| `resolveMediaSrc`: Tauri `convertFileSrc`, web signed URL, demo path; Player props unchanged | 3, 4 |
| Web behaviour of `scanFolder`, `pathExists`, `pickFolder`, `revealInFinder`, `onFolderDrop` | 3 |
| Sign-in screen: Google redirect, email link with `emailRedirectTo`, optional code via `verifyEmailCode` | 5 |
| Not allowed → "Ask the owner to invite <email>" with sign-out | 5 |
| Sync runs on the web with the same engine, exactly once per mode | 5 |
| Guests never write `libraries` | 3 |
| Tauri-only UI hidden on the web (traffic-light inset, reveal, open folder) | 6 |
| `build:web`, `.env.web.example`, gitignore, `vercel.json` with SPA rewrite and build settings | 7 |
| Local redirect URLs for `vite preview`; hosted dashboard checklist | 5, 9 |
| Manual Vercel and Supabase deploy, each step confirmation-gated | 9 |
| Tests: `toWebTree`, root convention, `isHostOnline` | 1, 2 |
| Manual E2E: local stack, `hosts` row via Studio, guest allowlisted vs not, PC offline, stale snapshot | 8 |
| Signed-out / unconfigured build unchanged (index constraint) | 4 (step 6), 8 (steps 11–12) |

### Contract names check

- Consumed exactly as the index defines them: `isTauri`, `SEP`, `toRelPath`, `webPath`, `parseWebPath`, `Recents.link`, `Recents.libraryIdFor`/`pathFor` (through sync), `supabaseConfigured`/`getSupabase`, `Account`, `verifyEmailCode`, `signOut`, `currentAccount`, `onAccountChange`, `startSync`, `upsertLibrary`, `is_allowed`, the `libraries`/`library_trees`/`hosts` columns, `GET /health`, `POST /api/sign` → `{ url }`.
- Produced exactly as the index defines them: `PlatformMode`, `mode`, `resolveMediaSrc(path): Promise<string>`. `Player` props are unchanged.
- Extensions (new names, none in conflict with the index): `webRoot`, `parseWebRoot`, `toWebTree` (libraryPath.ts); `HOST_OFFLINE_AFTER_MS`, `HostStatus`, `MediaFailure`, `MediaUnavailableError`, `isHostOnline`, `hostStatus`, `signMediaUrl` (host.ts); `WebLibrary`, `listWebLibraries`, `loadWebTree` (webLibrary.ts); `signInWithGoogleRedirect`, `sendEmailLink`, `isAllowed` (webAuth.ts); `SignInScreen`, `WebGate`, `WebHome`; the optional `AppHeader` prop `hostOffline`; the optional second parameter `displayName` on `App`'s internal `openFolder`.
- Deviations: `toMediaSrc` is removed, since `resolveMediaSrc` replaces it. `mode === "web"` also requires Vite `MODE === "web"`. `upsertLibrary` (plan 2) becomes a no-op outside Tauri.
