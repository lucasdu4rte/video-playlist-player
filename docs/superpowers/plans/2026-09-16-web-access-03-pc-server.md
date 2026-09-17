# PC Server Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A loopback HTTP server inside the Tauri app. When it runs, a signed-in, allowlisted browser user can list a shared library and stream its videos with Range support. It never serves anything outside a library root.

**Architecture:** An axum router (`src-tauri/src/server/routes.rs`) runs on `127.0.0.1:8787`. Tauri commands start it, stop it and set its libraries. It shares the port with plan 2's Google OAuth callback: while the server runs it also serves `/auth/callback`, and `await_oauth_code` only binds its own short-lived listener when the server is down. Both listeners hand the code to one process-wide `PENDING` slot in `server/oauth.rs`. `/api/*` requires a Supabase JWT, checked against the project JWKS, plus a cached `rpc/is_allowed` call. `/media/*` requires an HMAC-signed URL. The HMAC secret is generated once per machine and stays in `app_data_dir`. Files are served by `tower_http::services::ServeFile`.

**Tech Stack:** Rust (axum 0.8, tower-http 0.6 `fs`+`cors`, tokio, reqwest 0.13 with native-tls, jsonwebtoken 11 with `rust_crypto`, hmac 0.12 + sha2 0.10, getrandom 0.3, percent-encoding 2, tower 0.5), React 19 + TypeScript (`platform.ts`), local Supabase CLI.

**Spec:** docs/superpowers/specs/2026-09-16-web-access-design.md
**Index / shared contract:** docs/superpowers/plans/2026-09-16-web-access-00-index.md

## Global Constraints

All constraints in the index apply. This plan adds the following:

- Cargo commands run from `tauri/src-tauri/`, npm commands from `tauri/`.
- Responses are `401` for any authentication or signature failure and `404` for everything else, including unknown library, missing file, traversal and non-video. No response body or error string contains an absolute path.
- On `/media`, the signature is checked **before** the filesystem is touched.
- `/api/sign` resolves the path before signing, so a URL is only issued for a file that exists and is playable.
- Crate versions were checked against the registry and a scratch build on 2026-09-16: axum 0.8.9, tower-http 0.6.11, jsonwebtoken 11.1.0, reqwest 0.13.4, hmac 0.12.1, sha2 0.10.9, getrandom 0.3.4, tower 0.5.3, tempfile 3.27.0. The code in this plan was compiled and its 30 tests passed with those versions, with `cargo clippy --all-targets` clean. Newer majors exist (tower-http 0.7, hmac 0.13, sha2 0.11) and were not used: hmac/sha2 0.10 are already in `Cargo.lock`, and tower-http 0.6 is the version axum 0.8 builds on. If plan 2 pinned `tower-http` to anything but `"0.6"`, change it to `"0.6"`.
- `reqwest` uses `default-features = false, features = ["json", "native-tls"]`. The 0.13 default TLS is rustls on aws-lc-rs, which pulls a C/assembly build (`aws-lc-sys`) into the Windows build. native-tls uses SChannel on Windows and Security.framework on macOS (Linux needs `libssl-dev`).
- axum 0.8 route syntax is `/{param}` and `/{*wildcard}`. The index's `/api/tree/:library` and `/media/:library/*rel` are written `/api/tree/{library}` and `/media/{library}/{*rel}` in code.
- Tauri v2 allows every command registered in `invoke_handler` unless `build.rs` declares an `AppManifest` (tauri-docs, "Capabilities"). This app's `build.rs` is plain `tauri_build::build()`, so `capabilities/default.json` does **not** change.
- Tasks 1–4 add modules that nothing calls until Task 5. `cargo build` may print `dead_code` warnings in between. The zero-warning gate is `cargo clippy --all-targets` at the end of Task 5 and again at the end of the plan.

---

## File Structure

| File | Change | Responsibility |
|---|---|---|
| `tauri/src-tauri/Cargo.toml` | Modify | Adds `hmac`, `sha2`, `hex`, `getrandom`, `jsonwebtoken`, `reqwest`, `percent-encoding`, `tower`; adds `rt` to plan 2's `tokio` features; dev-dep `tempfile` |
| `tauri/src-tauri/src/lib.rs` | Modify | Makes `is_video`, `Node` (+ `path`, `children`) and `build_tree` `pub(crate)`; manages `ServerState`; registers the three new commands |
| `tauri/src-tauri/src/server/paths.rs` | Create | `resolve_media_path` + `PathError`: turns a `rel_path` into a playable file under a root, or refuses |
| `tauri/src-tauri/src/server/signing.rs` | Create | `sign` / `verify` for media URLs; `load_or_create_secret` for the per-machine secret |
| `tauri/src-tauri/src/server/jwt.rs` | Create | `JwksCache` + `verify_token`: Supabase access-token verification |
| `tauri/src-tauri/src/server/allowlist.rs` | Create | `Allowlist`: cached call to `rpc/is_allowed` |
| `tauri/src-tauri/src/server/routes.rs` | Create | `AppState`, `router`, CORS, the `Viewer` extractor and the `/health`, `/api/tree`, `/api/sign`, `/media` handlers |
| `tauri/src-tauri/src/server/mod.rs` | Replace (created by plan 2) | Module wiring, `ServerConfig`, `SharedLibrary`, `ServerState`, `bind`/`spawn_server`, and the `server_*` commands |
| `tauri/src-tauri/src/server/oauth.rs` | Create or replace (plan 2's listener) | `await_oauth_code` and the `/auth/callback` handler, shared between the sharing server and the short-lived listener |
| `tauri/src/lib/platform.ts` | Modify | `SharedLibrary`, `startServer`, `stopServer`, `setServerLibraries` |
| `tauri/src/lib/devServer.ts` | Create (temporary, removed by plan 4) | `window.devServer` console handle for manual verification |
| `tauri/src/main.tsx` | Modify (temporary, reverted by plan 4) | Installs `devServer` in dev builds only |
| `tauri/.env.example` | Modify | Documents `VITE_WEB_ORIGIN` |
| `tauri/supabase/config.toml`, `tauri/supabase/.gitignore` | Modify (only if plan 2 did not) | ES256 signing key for local Supabase so JWKS verification works |

---

### Task 1: Media path resolution

**Files:**
- Create: `tauri/src-tauri/src/server/paths.rs`
- Modify: `tauri/src-tauri/src/server/mod.rs`, `tauri/src-tauri/src/lib.rs`, `tauri/src-tauri/Cargo.toml`
- Test: `tauri/src-tauri/src/server/paths.rs` (`#[cfg(test)] mod tests`)

**Interfaces:**
- Consumes: `crate::is_video(&Path) -> bool` (existing, made `pub(crate)`; it checks `VIDEO_EXTS` lowercased)
- Produces:
  ```rust
  pub enum PathError { Invalid, NotFound, OutsideRoot, NotVideo }
  pub fn resolve_media_path(root: &Path, rel: &str) -> Result<PathBuf, PathError>;
  ```

- [ ] **Step 1: Add the test-only dependency**

In `tauri/src-tauri/Cargo.toml`, append at the end of the file:

```toml

[dev-dependencies]
tempfile = "3"
```

- [ ] **Step 2: Write the failing tests**

Add `pub mod paths;` as the first line of `tauri/src-tauri/src/server/mod.rs`.

Create `tauri/src-tauri/src/server/paths.rs` containing only the test module:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn library() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        fs::create_dir_all(dir.path().join("Module 1")).unwrap();
        fs::write(dir.path().join("Module 1/01 Intro.mp4"), b"video").unwrap();
        fs::write(dir.path().join("notes.txt"), b"text").unwrap();
        dir
    }

    #[test]
    fn resolves_a_nested_video() {
        let lib = library();
        let path = resolve_media_path(lib.path(), "Module 1/01 Intro.mp4").unwrap();
        assert!(path.ends_with("Module 1/01 Intro.mp4"));
    }

    #[test]
    fn rejects_parent_segments() {
        let lib = library();
        let result = resolve_media_path(lib.path(), "Module 1/../../etc/passwd");
        assert_eq!(result, Err(PathError::Invalid));
    }

    #[test]
    fn rejects_dot_and_empty_segments() {
        let lib = library();
        assert_eq!(resolve_media_path(lib.path(), "./Module 1/01 Intro.mp4"), Err(PathError::Invalid));
        assert_eq!(resolve_media_path(lib.path(), "Module 1//01 Intro.mp4"), Err(PathError::Invalid));
        assert_eq!(resolve_media_path(lib.path(), ""), Err(PathError::Invalid));
    }

    #[test]
    fn rejects_a_leading_slash() {
        let lib = library();
        let result = resolve_media_path(lib.path(), "/Module 1/01 Intro.mp4");
        assert_eq!(result, Err(PathError::Invalid));
    }

    #[test]
    fn rejects_backslashes() {
        let lib = library();
        let result = resolve_media_path(lib.path(), "Module 1\\01 Intro.mp4");
        assert_eq!(result, Err(PathError::Invalid));
    }

    #[test]
    fn rejects_non_video_files() {
        let lib = library();
        assert_eq!(resolve_media_path(lib.path(), "notes.txt"), Err(PathError::NotVideo));
    }

    #[test]
    fn rejects_folders() {
        let lib = library();
        assert_eq!(resolve_media_path(lib.path(), "Module 1"), Err(PathError::NotFound));
    }

    #[test]
    fn reports_missing_files() {
        let lib = library();
        let result = resolve_media_path(lib.path(), "Module 1/99 Missing.mp4");
        assert_eq!(result, Err(PathError::NotFound));
    }

    #[cfg(unix)]
    #[test]
    fn rejects_a_symlink_that_escapes_the_root() {
        let lib = library();
        let outside = tempfile::tempdir().unwrap();
        fs::write(outside.path().join("secret.mp4"), b"secret").unwrap();
        std::os::unix::fs::symlink(outside.path().join("secret.mp4"), lib.path().join("escape.mp4")).unwrap();
        assert_eq!(resolve_media_path(lib.path(), "escape.mp4"), Err(PathError::OutsideRoot));
    }
}
```

- [ ] **Step 3: Run the tests to see them fail**

Run: `cargo test server::paths`
Expected: compilation fails with `cannot find function `resolve_media_path`` and `failed to resolve: use of undeclared type `PathError``.

- [ ] **Step 4: Implement**

In `tauri/src-tauri/src/lib.rs`, change `fn is_video(p: &Path) -> bool {` to `pub(crate) fn is_video(p: &Path) -> bool {`.

In `tauri/src-tauri/src/server/paths.rs`, insert above `#[cfg(test)]`:

```rust
use std::path::{Path, PathBuf};

use crate::is_video;

#[derive(Debug, PartialEq, Eq)]
pub enum PathError {
    Invalid,
    NotFound,
    OutsideRoot,
    NotVideo,
}

/// Resolves a `/`-separated path relative to a library root to a playable file.
pub fn resolve_media_path(root: &Path, rel: &str) -> Result<PathBuf, PathError> {
    if !is_plain_rel_path(rel) {
        return Err(PathError::Invalid);
    }
    let root = root.canonicalize().map_err(|_| PathError::NotFound)?;
    // Canonicalising after the join resolves symlinks, so a link inside the
    // library that points at ~/.ssh fails the starts_with check below.
    let path = root.join(rel).canonicalize().map_err(|_| PathError::NotFound)?;
    if !path.starts_with(&root) {
        return Err(PathError::OutsideRoot);
    }
    if !path.is_file() {
        return Err(PathError::NotFound);
    }
    if !is_video(&path) {
        return Err(PathError::NotVideo);
    }
    Ok(path)
}

fn is_plain_rel_path(rel: &str) -> bool {
    !rel.is_empty()
        && !rel.starts_with('/')
        && !rel.contains(['\\', '\0'])
        && rel.split('/').all(|segment| !matches!(segment, "" | "." | ".."))
}
```

- [ ] **Step 5: Run the tests to see them pass**

Run: `cargo test server::paths`
Expected: `test result: ok. 9 passed` on macOS/Linux (8 on Windows, where the symlink test is compiled out).

- [ ] **Step 6: Commit**

```sh
git add src-tauri/Cargo.toml src-tauri/Cargo.lock src-tauri/src/lib.rs src-tauri/src/server/mod.rs src-tauri/src/server/paths.rs
git commit -m "feat(tauri): resolve media paths inside a library root"
```

---

### Task 2: Media URL signing and the machine secret

**Files:**
- Create: `tauri/src-tauri/src/server/signing.rs`
- Modify: `tauri/src-tauri/src/server/mod.rs`, `tauri/src-tauri/Cargo.toml`
- Test: `tauri/src-tauri/src/server/signing.rs`

**Interfaces:**
- Produces:
  ```rust
  pub fn sign(secret: &[u8], user: &str, library: &str, rel: &str, exp: u64) -> String; // hex HMAC-SHA256 of "{user}\n{library}\n{rel}\n{exp}"
  pub fn verify(secret: &[u8], user: &str, library: &str, rel: &str, exp: u64, sig: &str, now: u64) -> bool; // false when exp <= now
  pub fn load_or_create_secret(dir: &Path) -> std::io::Result<Vec<u8>>; // dir/share_secret, 32 bytes, 0600 on Unix
  ```

- [ ] **Step 1: Add dependencies**

In `tauri/src-tauri/Cargo.toml`, add under `[dependencies]` (after the lines plan 2 added):

```toml
hmac = "0.12"
sha2 = "0.10"
hex = "0.4"
getrandom = "0.3"
```

- [ ] **Step 2: Write the failing tests**

Add `pub mod signing;` below `pub mod paths;` in `tauri/src-tauri/src/server/mod.rs`.

Create `tauri/src-tauri/src/server/signing.rs` with only the test module:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    const SECRET: &[u8] = b"0123456789abcdef0123456789abcdef";
    const NOW: u64 = 1_000_000;
    const EXP: u64 = NOW + 60;

    fn signature() -> String {
        sign(SECRET, "user-1", "lib-1", "Module 1/01 Intro.mp4", EXP)
    }

    #[test]
    fn accepts_a_valid_signature() {
        assert!(verify(SECRET, "user-1", "lib-1", "Module 1/01 Intro.mp4", EXP, &signature(), NOW));
    }

    #[test]
    fn rejects_an_expired_signature() {
        assert!(!verify(SECRET, "user-1", "lib-1", "Module 1/01 Intro.mp4", EXP, &signature(), EXP));
    }

    #[test]
    fn rejects_a_tampered_path() {
        assert!(!verify(SECRET, "user-1", "lib-1", "Module 1/02 Other.mp4", EXP, &signature(), NOW));
    }

    #[test]
    fn rejects_a_tampered_user() {
        assert!(!verify(SECRET, "user-2", "lib-1", "Module 1/01 Intro.mp4", EXP, &signature(), NOW));
    }

    #[test]
    fn rejects_a_tampered_library() {
        assert!(!verify(SECRET, "user-1", "lib-2", "Module 1/01 Intro.mp4", EXP, &signature(), NOW));
    }

    #[test]
    fn rejects_a_tampered_expiry() {
        assert!(!verify(SECRET, "user-1", "lib-1", "Module 1/01 Intro.mp4", EXP + 1, &signature(), NOW));
    }

    #[test]
    fn rejects_a_different_secret() {
        let other = b"fedcba9876543210fedcba9876543210";
        assert!(!verify(other, "user-1", "lib-1", "Module 1/01 Intro.mp4", EXP, &signature(), NOW));
    }

    #[test]
    fn rejects_a_malformed_signature() {
        assert!(!verify(SECRET, "user-1", "lib-1", "Module 1/01 Intro.mp4", EXP, "not-hex", NOW));
    }

    #[test]
    fn keeps_the_secret_across_loads() {
        let dir = tempfile::tempdir().unwrap();
        let first = load_or_create_secret(dir.path()).unwrap();
        let second = load_or_create_secret(dir.path()).unwrap();
        assert_eq!(first.len(), SECRET_LEN);
        assert_eq!(first, second);
    }

    #[cfg(unix)]
    #[test]
    fn stores_the_secret_owner_only() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        load_or_create_secret(dir.path()).unwrap();
        let mode = fs::metadata(dir.path().join(SECRET_FILE)).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, 0o600);
    }
}
```

- [ ] **Step 3: Run the tests to see them fail**

Run: `cargo test server::signing`
Expected: compilation fails with `cannot find function `sign``, `cannot find function `verify``, `cannot find function `load_or_create_secret`` and `cannot find value `SECRET_FILE``.

- [ ] **Step 4: Implement**

In `tauri/src-tauri/src/server/signing.rs`, insert above `#[cfg(test)]`:

```rust
use std::fs;
use std::io::{self, Write};
use std::path::Path;

use hmac::{Hmac, Mac};
use sha2::Sha256;

type HmacSha256 = Hmac<Sha256>;

const SECRET_FILE: &str = "share_secret";
const SECRET_LEN: usize = 32;

pub fn sign(secret: &[u8], user: &str, library: &str, rel: &str, exp: u64) -> String {
    hex::encode(mac(secret, user, library, rel, exp).finalize().into_bytes())
}

pub fn verify(
    secret: &[u8],
    user: &str,
    library: &str,
    rel: &str,
    exp: u64,
    sig: &str,
    now: u64,
) -> bool {
    if exp <= now {
        return false;
    }
    let Ok(sig) = hex::decode(sig) else {
        return false;
    };
    // verify_slice compares in constant time.
    mac(secret, user, library, rel, exp).verify_slice(&sig).is_ok()
}

fn mac(secret: &[u8], user: &str, library: &str, rel: &str, exp: u64) -> HmacSha256 {
    let mut mac = HmacSha256::new_from_slice(secret).expect("HMAC accepts keys of any length");
    mac.update(format!("{user}\n{library}\n{rel}\n{exp}").as_bytes());
    mac
}

/// Reads the per-machine signing secret, creating it on first use.
pub fn load_or_create_secret(dir: &Path) -> io::Result<Vec<u8>> {
    let path = dir.join(SECRET_FILE);
    if let Some(secret) = fs::read(&path).ok().filter(|s| s.len() == SECRET_LEN) {
        return Ok(secret);
    }
    let mut secret = vec![0u8; SECRET_LEN];
    getrandom::fill(&mut secret).map_err(|e| io::Error::other(e.to_string()))?;
    fs::create_dir_all(dir)?;
    write_private(&path, &secret)?;
    Ok(secret)
}

#[cfg(unix)]
fn write_private(path: &Path, bytes: &[u8]) -> io::Result<()> {
    use std::os::unix::fs::OpenOptionsExt;
    fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o600)
        .open(path)?
        .write_all(bytes)
}

#[cfg(not(unix))]
fn write_private(path: &Path, bytes: &[u8]) -> io::Result<()> {
    fs::File::create(path)?.write_all(bytes)
}
```

- [ ] **Step 5: Run the tests to see them pass**

Run: `cargo test server::signing`
Expected: `test result: ok. 10 passed` (9 on Windows).

- [ ] **Step 6: Commit**

```sh
git add src-tauri/Cargo.toml src-tauri/Cargo.lock src-tauri/src/server/mod.rs src-tauri/src/server/signing.rs
git commit -m "feat(tauri): sign media URLs with a per-machine secret"
```

---

### Task 3: Supabase access-token verification

**Files:**
- Create: `tauri/src-tauri/src/server/jwt.rs`
- Modify: `tauri/src-tauri/src/server/mod.rs`, `tauri/src-tauri/Cargo.toml`
- Test: `tauri/src-tauri/src/server/jwt.rs`

**Interfaces:**
- Produces:
  ```rust
  pub struct Claims { pub sub: String, pub email: String } // + Debug, Deserialize
  pub enum AuthError { Invalid, KeysUnavailable }
  pub struct JwksCache { /* private */ }
  impl JwksCache { pub fn new(supabase_url: &str, http: reqwest::Client) -> Self; }
  pub async fn verify_token(jwks: &JwksCache, token: &str) -> Result<Claims, AuthError>;
  ```
- Behaviour: keys come from `{supabase_url}/auth/v1/.well-known/jwks.json` and are cached for 10 minutes. An unknown `kid` triggers a refetch, at most once every 30 s. Only `ES256` and `RS256` are accepted, and the algorithm is taken from the token header only after that allowlist check (`DecodingKey::from_jwk` plus `decode` also refuse a key and algorithm from different families). `iss` must be `{supabase_url}/auth/v1`, `aud` must be `authenticated`, and `exp` is required and checked.

- [ ] **Step 1: Add dependencies**

In `tauri/src-tauri/Cargo.toml`, add under `[dependencies]`:

```toml
jsonwebtoken = { version = "11", features = ["rust_crypto"] }
reqwest = { version = "0.13", default-features = false, features = ["json", "native-tls"] }
```

and add `"rt"` to the features of plan 2's `tokio` line (`#[tokio::test]` here and `tokio::spawn` in Task 5 need it):

```toml
tokio = { version = "1", features = ["net", "sync", "time", "macros", "rt"] }
```

- [ ] **Step 2: Write the failing tests**

Add `pub mod jwt;` in `tauri/src-tauri/src/server/mod.rs`, keeping the `pub mod` lines alphabetical (`jwt`, `paths`, `signing`).

Create `tauri/src-tauri/src/server/jwt.rs` with only the test module. The embedded key is a throwaway P-256 key generated for this test. It signs nothing real.

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use jsonwebtoken::{encode, EncodingKey, Header};
    use serde_json::json;

    // Throwaway P-256 key generated for these tests only.
    const TEST_KEY_PEM: &str = "-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQga/FdZlLYCypmyPN8
u9pEnMt7C2qIYxOo7gamIwtWTXahRANCAAQdfID2P+xDap9DYEl4/kHD7iHr655N
yDsSQpenA9wkU+VT8fnhBljfD+BmRiTlO4BFyyMChK5D9s6bmB4wVGXS
-----END PRIVATE KEY-----";
    const SUPABASE_URL: &str = "http://127.0.0.1:54321";
    const KID: &str = "test-key";

    fn cache_with_test_key() -> JwksCache {
        let encoding = EncodingKey::from_ec_pem(TEST_KEY_PEM.as_bytes()).unwrap();
        let mut jwk = Jwk::from_encoding_key(&encoding, Algorithm::ES256).unwrap();
        jwk.common.key_id = Some(KID.into());
        let cache = JwksCache::new(SUPABASE_URL, reqwest::Client::new());
        *cache.cached.try_write().unwrap() = Some(FetchedKeys {
            keys: JwkSet { keys: vec![jwk] },
            fetched_at: Instant::now(),
        });
        cache
    }

    fn token(claims: serde_json::Value) -> String {
        let mut header = Header::new(Algorithm::ES256);
        header.kid = Some(KID.into());
        let key = EncodingKey::from_ec_pem(TEST_KEY_PEM.as_bytes()).unwrap();
        encode(&header, &claims, &key).unwrap()
    }

    fn in_one_hour() -> u64 {
        jsonwebtoken::get_current_timestamp() + 3600
    }

    #[tokio::test]
    async fn accepts_a_valid_token() {
        let token = token(json!({
            "sub": "user-1", "email": "a@example.com", "aud": AUDIENCE,
            "iss": format!("{SUPABASE_URL}/auth/v1"), "exp": in_one_hour(),
        }));
        let claims = verify_token(&cache_with_test_key(), &token).await.unwrap();
        assert_eq!(claims.sub, "user-1");
        assert_eq!(claims.email, "a@example.com");
    }

    #[tokio::test]
    async fn rejects_another_issuer() {
        let token = token(json!({
            "sub": "user-1", "aud": AUDIENCE,
            "iss": "https://evil.example/auth/v1", "exp": in_one_hour(),
        }));
        assert!(verify_token(&cache_with_test_key(), &token).await.is_err());
    }

    #[tokio::test]
    async fn rejects_another_audience() {
        let token = token(json!({
            "sub": "user-1", "aud": "anon",
            "iss": format!("{SUPABASE_URL}/auth/v1"), "exp": in_one_hour(),
        }));
        assert!(verify_token(&cache_with_test_key(), &token).await.is_err());
    }

    #[tokio::test]
    async fn rejects_an_expired_token() {
        let token = token(json!({
            "sub": "user-1", "aud": AUDIENCE,
            "iss": format!("{SUPABASE_URL}/auth/v1"), "exp": 1_000,
        }));
        assert!(verify_token(&cache_with_test_key(), &token).await.is_err());
    }

    #[tokio::test]
    async fn rejects_a_symmetric_token() {
        let token = encode(
            &Header::new(Algorithm::HS256),
            &json!({ "sub": "user-1", "aud": AUDIENCE, "exp": in_one_hour() }),
            &EncodingKey::from_secret(b"guessable"),
        )
        .unwrap();
        assert!(verify_token(&cache_with_test_key(), &token).await.is_err());
    }
}
```

- [ ] **Step 3: Run the tests to see them fail**

Run: `cargo test server::jwt`
Expected: compilation fails with unresolved names `JwksCache`, `FetchedKeys`, `verify_token` and `AUDIENCE`.

- [ ] **Step 4: Implement**

In `tauri/src-tauri/src/server/jwt.rs`, insert above `#[cfg(test)]`:

```rust
use std::time::{Duration, Instant};

use jsonwebtoken::jwk::{Jwk, JwkSet};
use jsonwebtoken::{decode, decode_header, Algorithm, DecodingKey, Validation};
use serde::Deserialize;
use tokio::sync::RwLock;

const KEYS_TTL: Duration = Duration::from_secs(10 * 60);
// Bounds how often a token with an unknown `kid` can make us refetch.
const MIN_REFETCH_INTERVAL: Duration = Duration::from_secs(30);
const AUDIENCE: &str = "authenticated";

#[derive(Debug, Deserialize)]
pub struct Claims {
    pub sub: String,
    #[serde(default)]
    #[allow(dead_code, reason = "part of the shared contract; no route reads it yet")]
    pub email: String,
}

#[derive(Debug)]
pub enum AuthError {
    Invalid,
    KeysUnavailable,
}

struct FetchedKeys {
    keys: JwkSet,
    fetched_at: Instant,
}

pub struct JwksCache {
    url: String,
    issuer: String,
    http: reqwest::Client,
    cached: RwLock<Option<FetchedKeys>>,
}

impl JwksCache {
    pub fn new(supabase_url: &str, http: reqwest::Client) -> Self {
        let auth_url = format!("{}/auth/v1", supabase_url.trim_end_matches('/'));
        Self {
            url: format!("{auth_url}/.well-known/jwks.json"),
            issuer: auth_url,
            http,
            cached: RwLock::new(None),
        }
    }

    async fn key(&self, kid: &str) -> Result<Jwk, AuthError> {
        if let Some(jwk) = self.cached_key(kid, KEYS_TTL).await {
            return Ok(jwk);
        }
        let mut cached = self.cached.write().await;
        let recently_fetched = cached
            .as_ref()
            .is_some_and(|c| c.fetched_at.elapsed() < MIN_REFETCH_INTERVAL);
        if !recently_fetched {
            *cached = Some(self.fetch().await?);
        }
        cached
            .as_ref()
            .and_then(|c| c.keys.find(kid).cloned())
            .ok_or(AuthError::Invalid)
    }

    async fn cached_key(&self, kid: &str, max_age: Duration) -> Option<Jwk> {
        let cached = self.cached.read().await;
        let fresh = cached.as_ref().filter(|c| c.fetched_at.elapsed() < max_age)?;
        fresh.keys.find(kid).cloned()
    }

    async fn fetch(&self) -> Result<FetchedKeys, AuthError> {
        let response = self
            .http
            .get(&self.url)
            .send()
            .await
            .and_then(|r| r.error_for_status())
            .map_err(|_| AuthError::KeysUnavailable)?;
        let keys = response
            .json::<JwkSet>()
            .await
            .map_err(|_| AuthError::KeysUnavailable)?;
        Ok(FetchedKeys { keys, fetched_at: Instant::now() })
    }
}

pub async fn verify_token(jwks: &JwksCache, token: &str) -> Result<Claims, AuthError> {
    let header = decode_header(token).map_err(|_| AuthError::Invalid)?;
    // Only asymmetric algorithms: an HS256 token would mean the project still
    // uses the legacy shared secret, which never lives on this machine.
    if !matches!(header.alg, Algorithm::ES256 | Algorithm::RS256) {
        return Err(AuthError::Invalid);
    }
    let kid = header.kid.ok_or(AuthError::Invalid)?;
    let jwk = jwks.key(&kid).await?;
    let key = DecodingKey::from_jwk(&jwk).map_err(|_| AuthError::Invalid)?;
    let mut validation = Validation::new(header.alg);
    validation.set_issuer(&[&jwks.issuer]);
    validation.set_audience(&[AUDIENCE]);
    let data = decode::<Claims>(token, &key, &validation).map_err(|_| AuthError::Invalid)?;
    Ok(data.claims)
}
```

- [ ] **Step 5: Run the tests to see them pass**

Run: `cargo test server::jwt`
Expected: `test result: ok. 5 passed`. No network is used: the cache is pre-filled with the test key.

- [ ] **Step 6: Commit**

```sh
git add src-tauri/Cargo.toml src-tauri/Cargo.lock src-tauri/src/server/mod.rs src-tauri/src/server/jwt.rs
git commit -m "feat(tauri): verify Supabase access tokens against the JWKS"
```

---

### Task 4: HTTP routes, allowlist and Range-capable media

**Files:**
- Create: `tauri/src-tauri/src/server/allowlist.rs`, `tauri/src-tauri/src/server/routes.rs`
- Modify: `tauri/src-tauri/src/server/mod.rs`, `tauri/src-tauri/src/lib.rs`, `tauri/src-tauri/Cargo.toml`
- Test: `tauri/src-tauri/src/server/routes.rs`

**Interfaces:**
- Consumes: `resolve_media_path` (Task 1), `sign`/`verify` (Task 2), `JwksCache`/`verify_token`/`Claims` (Task 3), `crate::build_tree(&Path) -> Vec<Node>` and `crate::Node` (existing, made `pub(crate)`).
- Produces:
  ```rust
  // allowlist.rs
  pub struct Allowlist { /* private */ }
  impl Allowlist {
      pub fn new(supabase_url: &str, api_key: &str, http: reqwest::Client) -> Self;
      pub async fn is_allowed(&self, user_id: &str, token: &str) -> bool; // positive answers cached 5 min per sub
  }
  // routes.rs
  pub type Libraries = Arc<RwLock<HashMap<String, PathBuf>>>; // library id -> canonical root
  #[derive(Clone)]
  pub struct AppState { pub secret: Arc<Vec<u8>>, pub libraries: Libraries, pub jwks: Arc<JwksCache>, pub allowlist: Arc<Allowlist> }
  pub fn router(state: AppState, allowed_origins: &[String]) -> Router;
  ```
- HTTP (index "HTTP surface"): `GET /health`, `GET /api/tree/{library}`, `POST /api/sign`, `GET /media/{library}/{*rel}?u&exp&sig`. The signed URL is path-relative (`/media/...`). Every segment of it is percent-encoded, and axum's `Path` decodes it back to the exact `rel` that was signed.
- Allowlist calls `POST {supabase_url}/rest/v1/rpc/is_allowed` with `apikey` and the caller's bearer. A network error or non-2xx counts as "not allowed" (401). Only positive answers are cached, so a newly allowed user gets in immediately.
- CORS allows `allowed_origins`, plus `http://localhost:1420` in debug builds only.

- [ ] **Step 1: Add dependencies**

In `tauri/src-tauri/Cargo.toml`, add under `[dependencies]`:

```toml
percent-encoding = "2"
tower = { version = "0.5", features = ["util"] }
```

`tower` is a regular dependency, not a dev one: the `/media` handler drives `ServeFile` with `ServiceExt::oneshot`. It is already in `Cargo.lock` through axum.

- [ ] **Step 2: Make the tree walker reachable**

In `tauri/src-tauri/src/lib.rs`:
- `struct Node {` → `pub(crate) struct Node {`
- inside `Node`, `path: String,` → `pub(crate) path: String,` and `children: Option<Vec<Node>>,` → `pub(crate) children: Option<Vec<Node>>,`
- `fn build_tree(dir: &Path) -> Vec<Node> {` → `pub(crate) fn build_tree(dir: &Path) -> Vec<Node> {`

- [ ] **Step 3: Write the allowlist client**

Add `pub mod allowlist;` and `pub mod routes;` to `tauri/src-tauri/src/server/mod.rs`, keeping the `pub mod` lines alphabetical.

Create `tauri/src-tauri/src/server/allowlist.rs`. There is no unit test here: it is a thin HTTP call, covered by the manual allowlist check in Task 7.

```rust
use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

const ALLOWED_TTL: Duration = Duration::from_secs(5 * 60);

/// Asks Supabase whether the caller's email is on the allowlist, remembering
/// positive answers briefly so every tree request doesn't round-trip.
pub struct Allowlist {
    rpc_url: String,
    api_key: String,
    http: reqwest::Client,
    allowed_at: Mutex<HashMap<String, Instant>>,
}

impl Allowlist {
    pub fn new(supabase_url: &str, api_key: &str, http: reqwest::Client) -> Self {
        Self {
            rpc_url: format!("{}/rest/v1/rpc/is_allowed", supabase_url.trim_end_matches('/')),
            api_key: api_key.to_string(),
            http,
            allowed_at: Mutex::new(HashMap::new()),
        }
    }

    pub async fn is_allowed(&self, user_id: &str, token: &str) -> bool {
        if self.recently_allowed(user_id) {
            return true;
        }
        if !self.ask_supabase(token).await {
            return false;
        }
        self.allowed_at
            .lock()
            .unwrap()
            .insert(user_id.to_string(), Instant::now());
        true
    }

    fn recently_allowed(&self, user_id: &str) -> bool {
        self.allowed_at
            .lock()
            .unwrap()
            .get(user_id)
            .is_some_and(|at| at.elapsed() < ALLOWED_TTL)
    }

    async fn ask_supabase(&self, token: &str) -> bool {
        let response = self
            .http
            .post(&self.rpc_url)
            .header("apikey", &self.api_key)
            .bearer_auth(token)
            .json(&serde_json::json!({}))
            .send()
            .await
            .and_then(|r| r.error_for_status());
        let Ok(response) = response else {
            return false;
        };
        response.json::<bool>().await.unwrap_or(false)
    }
}
```

- [ ] **Step 4: Write the failing route tests**

Create `tauri/src-tauri/src/server/routes.rs` with only the test module:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::{to_bytes, Body};

    const SECRET: &[u8] = b"0123456789abcdef0123456789abcdef";
    const LIBRARY: &str = "lib-1";
    const REL: &str = "Module 1/01 Intro.mp4";

    fn app(root: &FsPath) -> Router {
        let supabase_url = "http://127.0.0.1:54321";
        let http = reqwest::Client::new();
        let libraries = HashMap::from([(LIBRARY.to_string(), root.canonicalize().unwrap())]);
        let state = AppState {
            secret: Arc::new(SECRET.to_vec()),
            libraries: Arc::new(RwLock::new(libraries)),
            jwks: Arc::new(JwksCache::new(supabase_url, http.clone())),
            allowlist: Arc::new(Allowlist::new(supabase_url, "test-key", http)),
        };
        router(state, &[])
    }

    fn library() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("Module 1")).unwrap();
        std::fs::write(dir.path().join(REL), b"0123456789").unwrap();
        dir
    }

    fn signed_uri(rel: &str) -> String {
        let exp = unix_now() + 60;
        let sig = sign(SECRET, "user-1", LIBRARY, rel, exp);
        let encoded = rel.split('/').map(encode_segment).collect::<Vec<_>>().join("/");
        format!("/media/{LIBRARY}/{encoded}?u=user-1&exp={exp}&sig={sig}")
    }

    async fn get(app: Router, uri: &str, range: Option<&str>) -> Response {
        let mut request = Request::builder().uri(uri);
        if let Some(range) = range {
            request = request.header(RANGE, range);
        }
        app.oneshot(request.body(Body::empty()).unwrap()).await.unwrap()
    }

    #[tokio::test]
    async fn serves_a_byte_range_of_a_signed_url() {
        let lib = library();
        let response = get(app(lib.path()), &signed_uri(REL), Some("bytes=0-3")).await;
        assert_eq!(response.status(), StatusCode::PARTIAL_CONTENT);
        let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        assert_eq!(&body[..], b"0123");
    }

    #[tokio::test]
    async fn rejects_an_unsigned_media_request() {
        let lib = library();
        let uri = format!("/media/{LIBRARY}/Module%201/01%20Intro.mp4");
        let response = get(app(lib.path()), &uri, None).await;
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn hides_files_that_are_gone() {
        let lib = library();
        let uri = signed_uri("Module 1/02 Missing.mp4");
        let response = get(app(lib.path()), &uri, None).await;
        assert_eq!(response.status(), StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn requires_a_bearer_for_the_tree() {
        let lib = library();
        let response = get(app(lib.path()), &format!("/api/tree/{LIBRARY}"), None).await;
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    }

    #[test]
    fn relativizes_tree_paths() {
        let lib = library();
        let root = lib.path().canonicalize().unwrap();
        let mut nodes = build_tree(&root);
        relativize(&mut nodes, &root);
        let folder = &nodes[0];
        assert_eq!(folder.path, "Module 1");
        assert_eq!(folder.children.as_ref().unwrap()[0].path, REL);
    }
}
```

- [ ] **Step 5: Run the tests to see them fail**

Run: `cargo test server::routes`
Expected: compilation fails with unresolved names `AppState`, `router`, `encode_segment`, `unix_now`, `relativize`, `sign`.

- [ ] **Step 6: Implement the routes**

In `tauri/src-tauri/src/server/routes.rs`, insert above `#[cfg(test)]`:

```rust
use std::collections::HashMap;
use std::path::{Path as FsPath, PathBuf};
use std::sync::{Arc, RwLock};
use std::time::{SystemTime, UNIX_EPOCH};

use axum::extract::{FromRequestParts, Path, Query, Request, State};
use axum::http::header::{
    ACCEPT_RANGES, AUTHORIZATION, CONTENT_LENGTH, CONTENT_RANGE, CONTENT_TYPE, RANGE,
};
use axum::http::request::Parts;
use axum::http::{HeaderValue, Method, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use percent_encoding::{utf8_percent_encode, AsciiSet, NON_ALPHANUMERIC};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tower::ServiceExt;
use tower_http::cors::{AllowOrigin, CorsLayer};
use tower_http::services::ServeFile;

use super::allowlist::Allowlist;
use super::jwt::{verify_token, Claims, JwksCache};
use super::paths::resolve_media_path;
use super::signing::{sign, verify};
use crate::{build_tree, Node};

const MEDIA_URL_TTL_SECS: u64 = 12 * 60 * 60;
const DEV_ORIGIN: &str = "http://localhost:1420";
// RFC 3986 unreserved characters stay readable; everything else is escaped.
const PATH_SEGMENT: &AsciiSet = &NON_ALPHANUMERIC.remove(b'-').remove(b'.').remove(b'_').remove(b'~');

pub type Libraries = Arc<RwLock<HashMap<String, PathBuf>>>;

#[derive(Clone)]
pub struct AppState {
    pub secret: Arc<Vec<u8>>,
    pub libraries: Libraries,
    pub jwks: Arc<JwksCache>,
    pub allowlist: Arc<Allowlist>,
}

impl AppState {
    fn library_root(&self, id: &str) -> Option<PathBuf> {
        self.libraries.read().unwrap().get(id).cloned()
    }
}

pub fn router(state: AppState, allowed_origins: &[String]) -> Router {
    Router::new()
        .route("/health", get(health))
        .route("/api/tree/{library}", get(tree))
        .route("/api/sign", post(sign_media))
        .route("/media/{library}/{*rel}", get(media))
        .layer(cors(allowed_origins))
        .with_state(state)
}

fn cors(allowed_origins: &[String]) -> CorsLayer {
    let dev_origin = cfg!(debug_assertions).then_some(DEV_ORIGIN);
    let origins: Vec<HeaderValue> = allowed_origins
        .iter()
        .map(String::as_str)
        .chain(dev_origin)
        .filter_map(|origin| origin.parse().ok())
        .collect();
    CorsLayer::new()
        .allow_origin(AllowOrigin::list(origins))
        .allow_methods([Method::GET, Method::POST, Method::OPTIONS])
        .allow_headers([AUTHORIZATION, CONTENT_TYPE, RANGE])
        .expose_headers([CONTENT_RANGE, ACCEPT_RANGES, CONTENT_LENGTH])
}

/// A signed-in caller whose email is on the allowlist.
pub struct Viewer(Claims);

impl FromRequestParts<AppState> for Viewer {
    type Rejection = StatusCode;

    async fn from_request_parts(parts: &mut Parts, state: &AppState) -> Result<Self, StatusCode> {
        let token = parts
            .headers
            .get(AUTHORIZATION)
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.strip_prefix("Bearer "))
            .ok_or(StatusCode::UNAUTHORIZED)?;
        let claims = verify_token(&state.jwks, token)
            .await
            .map_err(|_| StatusCode::UNAUTHORIZED)?;
        if !state.allowlist.is_allowed(&claims.sub, token).await {
            return Err(StatusCode::UNAUTHORIZED);
        }
        Ok(Viewer(claims))
    }
}

async fn health() -> Json<Value> {
    Json(json!({ "ok": true }))
}

async fn tree(
    _viewer: Viewer,
    State(state): State<AppState>,
    Path(library): Path<String>,
) -> Result<Json<Vec<Node>>, StatusCode> {
    let root = state.library_root(&library).ok_or(StatusCode::NOT_FOUND)?;
    let nodes = tokio::task::spawn_blocking(move || {
        let mut nodes = build_tree(&root);
        relativize(&mut nodes, &root);
        nodes
    })
    .await
    .map_err(|_| StatusCode::NOT_FOUND)?;
    Ok(Json(nodes))
}

fn relativize(nodes: &mut [Node], root: &FsPath) {
    for node in nodes {
        node.path = rel_path(FsPath::new(&node.path), root);
        if let Some(children) = node.children.as_mut() {
            relativize(children, root);
        }
    }
}

fn rel_path(path: &FsPath, root: &FsPath) -> String {
    path.strip_prefix(root)
        .unwrap_or(FsPath::new(""))
        .components()
        .map(|c| c.as_os_str().to_string_lossy())
        .collect::<Vec<_>>()
        .join("/")
}

#[derive(Deserialize)]
struct SignRequest {
    library: String,
    path: String,
}

#[derive(Serialize)]
struct SignResponse {
    url: String,
}

async fn sign_media(
    Viewer(claims): Viewer,
    State(state): State<AppState>,
    Json(request): Json<SignRequest>,
) -> Result<Json<SignResponse>, StatusCode> {
    let root = state.library_root(&request.library).ok_or(StatusCode::NOT_FOUND)?;
    resolve_media_path(&root, &request.path).map_err(|_| StatusCode::NOT_FOUND)?;
    let exp = unix_now() + MEDIA_URL_TTL_SECS;
    let sig = sign(&state.secret, &claims.sub, &request.library, &request.path, exp);
    let url = format!(
        "/media/{}/{}?u={}&exp={exp}&sig={sig}",
        encode_segment(&request.library),
        request.path.split('/').map(encode_segment).collect::<Vec<_>>().join("/"),
        encode_segment(&claims.sub),
    );
    Ok(Json(SignResponse { url }))
}

fn encode_segment(segment: &str) -> String {
    utf8_percent_encode(segment, PATH_SEGMENT).to_string()
}

// Missing parameters deserialize to values that fail verification, so they
// surface as 401 rather than axum's 400.
#[derive(Deserialize)]
struct MediaQuery {
    #[serde(default)]
    u: String,
    #[serde(default)]
    exp: u64,
    #[serde(default)]
    sig: String,
}

async fn media(
    State(state): State<AppState>,
    Path((library, rel)): Path<(String, String)>,
    Query(query): Query<MediaQuery>,
    request: Request,
) -> Response {
    let now = unix_now();
    if !verify(&state.secret, &query.u, &library, &rel, query.exp, &query.sig, now) {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    let Some(root) = state.library_root(&library) else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let Ok(file) = resolve_media_path(&root, &rel) else {
        return StatusCode::NOT_FOUND.into_response();
    };
    match ServeFile::new(file).oneshot(request).await {
        Ok(response) => response.into_response(),
        Err(never) => match never {},
    }
}

fn unix_now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}
```

- [ ] **Step 7: Run the tests to see them pass**

Run: `cargo test server::routes`
Expected: `test result: ok. 5 passed`. `serves_a_byte_range_of_a_signed_url` shows that `Range: bytes=0-3` returns `206` with body `0123`. `requires_a_bearer_for_the_tree` returns `401` before any network call.

- [ ] **Step 8: Commit**

```sh
git add src-tauri/Cargo.toml src-tauri/Cargo.lock src-tauri/src/lib.rs src-tauri/src/server/mod.rs src-tauri/src/server/allowlist.rs src-tauri/src/server/routes.rs
git commit -m "feat(tauri): serve library trees and signed media over HTTP"
```

---

### Task 5: Server lifecycle, commands and the shared OAuth callback

**Files:**
- Replace: `tauri/src-tauri/src/server/mod.rs` (created by plan 2)
- Create or replace: `tauri/src-tauri/src/server/oauth.rs` (plan 2's one-shot listener, whether plan 2 kept it in `oauth.rs` or in `mod.rs`)
- Modify: `tauri/src-tauri/src/lib.rs`
- Test: `tauri/src-tauri/src/server/oauth.rs` (plan 2's lifecycle test, extended)

**Interfaces:**
- Consumes: `routes::{router, AppState, Libraries}`, `Allowlist::new`, `JwksCache::new`, `signing::load_or_create_secret`.
- Produces (index contract, same names):
  ```rust
  pub struct ServerConfig { pub supabase_url: String, pub supabase_key: String, pub allowed_origins: Vec<String> } // camelCase
  pub struct SharedLibrary { pub id: String, pub root: String } // camelCase
  #[tauri::command] pub async fn server_start(app: AppHandle, server: State<'_, ServerState>, config: ServerConfig) -> Result<u16, String>;
  #[tauri::command] pub async fn server_stop(server: State<'_, ServerState>) -> Result<(), String>;
  #[tauri::command(async)] pub fn server_set_libraries(server: State<'_, ServerState>, libraries: Vec<SharedLibrary>);
  pub async fn await_oauth_code(timeout: Duration) -> Result<String, String>; // plan 2's signature and messages, kept
  #[derive(Default)] pub struct ServerState { /* libraries, running */ }
  pub const PORT: u16 = 8787;
  ```
- How the two listeners share the port:
  - `oauth.rs` owns `static PENDING: Mutex<Option<oneshot::Sender<Result<String, String>>>>`, the only place a callback outcome is delivered, and `static SHARING_SERVER_UP: AtomicBool`. The `/auth/callback` handler (`callback_router()`) `take()`s the sender and sends either the `code` or the provider's error.
  - `await_oauth_code` installs a fresh sender. When `SHARING_SERVER_UP` is false, it binds `127.0.0.1:8787` itself, serving only `callback_router()`, and shuts that listener down afterwards. When the flag is true, it binds nothing, because the sharing server's router has `callback_router()` merged in. On success, error or timeout, it clears `PENDING`.
  - `server_start` sets the flag after a successful bind. `server_stop` clears it before shutting down.
  - A bind failure returns plan 2's message, `"Port 8787 is already in use. Close the program using it and try again."` There is no fallback port.
  - Accepted race: if sharing is stopped while a Google sign-in is waiting on the sharing server, that sign-in times out after 2 minutes and the user retries.
- Lifecycle:
  - `server_start` is idempotent: a second call returns `Ok(8787)`. It reads or creates the secret, binds, and spawns `axum::serve(...).with_graceful_shutdown(...)`.
  - `RunningServer::shutdown` fires the signal and waits at most 2 s. axum drops the listener when the signal fires, so the port is free at once. Media responses already in flight run to completion.
  - `server_set_libraries` replaces the whole map, canonicalises each root, and drops roots that no longer exist. The map lives in `ServerState`, so it can be set before or after `server_start`.

- [ ] **Step 1: Write the failing test**

Create or replace `tauri/src-tauri/src/server/oauth.rs` with only this test module. It is plan 2's `callback_listener_lifecycle` test plus a "sharing server holds the port" phase. If plan 2's `server/mod.rs` has no `mod oauth;` line, add one at its top, so this file is compiled.

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::{TcpListener, TcpStream};

    const CALLBACK_ADDR: &str = "127.0.0.1:8787";

    async fn get_page(path: &str) -> String {
        let mut stream = TcpStream::connect(CALLBACK_ADDR).await.unwrap();
        let request = format!("GET {path} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n");
        stream.write_all(request.as_bytes()).await.unwrap();
        let mut response = String::new();
        stream.read_to_string(&mut response).await.unwrap();
        response
    }

    // A single test so the phases never race each other for the fixed port
    // or the process-wide PENDING slot.
    #[tokio::test]
    async fn callback_listener_lifecycle() {
        let waiting = tokio::spawn(await_oauth_code(Duration::from_secs(5)));
        tokio::time::sleep(Duration::from_millis(100)).await;
        let page = get_page("/auth/callback?code=abc123").await;
        assert!(page.contains("You can close this tab"));
        assert_eq!(waiting.await.unwrap(), Ok("abc123".to_string()));

        let waiting = tokio::spawn(await_oauth_code(Duration::from_secs(5)));
        tokio::time::sleep(Duration::from_millis(100)).await;
        get_page("/auth/callback?error=access_denied&error_description=User%20cancelled").await;
        assert_eq!(
            waiting.await.unwrap(),
            Err("Sign-in failed: User cancelled".to_string())
        );

        assert_eq!(
            await_oauth_code(Duration::from_millis(50)).await,
            Err("Sign-in timed out. Try again.".to_string())
        );

        // With the sharing server holding the port, the code must arrive
        // through its router instead of a second bind (which would fail).
        let sharing = spawn_server(bind().await.unwrap(), callback_router());
        SHARING_SERVER_UP.store(true, Ordering::SeqCst);
        let waiting = tokio::spawn(await_oauth_code(Duration::from_secs(5)));
        tokio::time::sleep(Duration::from_millis(100)).await;
        get_page("/auth/callback?code=shared").await;
        assert_eq!(waiting.await.unwrap(), Ok("shared".to_string()));
        SHARING_SERVER_UP.store(false, Ordering::SeqCst);
        sharing.shutdown().await;

        let _busy = TcpListener::bind(CALLBACK_ADDR).await.unwrap();
        let error = await_oauth_code(Duration::from_secs(1)).await.unwrap_err();
        assert!(error.contains("8787"));
    }
}
```

- [ ] **Step 2: Run it to see it fail**

Quit any running `npm run tauri dev` first, because this test binds the real port 8787.

Run: `cargo test server::oauth`
Expected: compilation fails. The unresolved names include `bind` and `spawn_server`, which `server/mod.rs` does not define yet, and `callback_router` and `SHARING_SERVER_UP`, which `oauth.rs` does not define yet.

- [ ] **Step 3: Implement the shared callback**

In `tauri/src-tauri/src/server/oauth.rs`, insert above `#[cfg(test)]`:

```rust
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use axum::extract::Query;
use axum::response::Html;
use axum::routing::get;
use axum::Router;
use tokio::sync::oneshot;

use super::{bind, spawn_server};

const DONE_PAGE: &str = r#"<!doctype html>
<meta charset="utf-8">
<title>Signed in</title>
<body style="font-family: system-ui; text-align: center; padding-top: 20vh">
  <h1>You can close this tab</h1>
  <p>Return to Video Playlist Player.</p>
</body>"#;

type Outcome = Result<String, String>;

// Supabase redirects to one exact URL, so whichever listener owns the port —
// the sharing server or the short-lived one below — delivers the code here.
static PENDING: Mutex<Option<oneshot::Sender<Outcome>>> = Mutex::new(None);
pub(super) static SHARING_SERVER_UP: AtomicBool = AtomicBool::new(false);

pub(super) fn callback_router() -> Router {
    Router::new().route("/auth/callback", get(callback))
}

pub async fn await_oauth_code(timeout: Duration) -> Result<String, String> {
    let own_listener = if SHARING_SERVER_UP.load(Ordering::SeqCst) {
        None
    } else {
        Some(bind().await?)
    };
    let (code_tx, code_rx) = oneshot::channel();
    *PENDING.lock().unwrap() = Some(code_tx);
    let own_server = own_listener.map(|listener| spawn_server(listener, callback_router()));

    let outcome = tokio::time::timeout(timeout, code_rx).await;

    PENDING.lock().unwrap().take();
    if let Some(server) = own_server {
        server.shutdown().await;
    }
    match outcome {
        Ok(Ok(result)) => result,
        Ok(Err(_)) => Err("Sign-in was interrupted. Try again.".into()),
        Err(_) => Err("Sign-in timed out. Try again.".into()),
    }
}

async fn callback(Query(params): Query<HashMap<String, String>>) -> Html<&'static str> {
    let error = params.get("error_description").or(params.get("error"));
    let outcome = match (params.get("code"), error) {
        (Some(code), _) => Ok(code.clone()),
        (None, Some(error)) => Err(format!("Sign-in failed: {error}")),
        (None, None) => Err("Sign-in failed: the callback carried no code.".into()),
    };
    if let Some(sender) = PENDING.lock().unwrap().take() {
        let _ = sender.send(outcome);
    }
    Html(DONE_PAGE)
}
```

- [ ] **Step 4: Replace the module root**

Replace the whole of `tauri/src-tauri/src/server/mod.rs` with the code below. If plan 2 declared a `#[tauri::command]` in this file (for example `oauth_wait_code`), copy that item verbatim to the end of the new file, so the path `server::oauth_wait_code` in `lib.rs` still resolves.

```rust
pub mod allowlist;
pub mod jwt;
mod oauth;
pub mod paths;
pub mod routes;
pub mod signing;

pub use oauth::await_oauth_code;

use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::Duration;

use axum::Router;
use serde::Deserialize;
use tauri::{AppHandle, Manager, State};
use tokio::net::TcpListener;
use tokio::sync::oneshot;
use tokio::task::JoinHandle;

use allowlist::Allowlist;
use jwt::JwksCache;
use routes::{AppState, Libraries};

pub const PORT: u16 = 8787;
const SHUTDOWN_GRACE: Duration = Duration::from_secs(2);

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerConfig {
    pub supabase_url: String,
    pub supabase_key: String,
    pub allowed_origins: Vec<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SharedLibrary {
    pub id: String,
    pub root: String,
}

#[derive(Default)]
pub struct ServerState {
    libraries: Libraries,
    running: tokio::sync::Mutex<Option<RunningServer>>,
}

struct RunningServer {
    stop: oneshot::Sender<()>,
    task: JoinHandle<()>,
}

impl RunningServer {
    async fn shutdown(self) {
        let _ = self.stop.send(());
        // axum closes the listener as soon as the signal fires; the bounded
        // wait only lets in-flight responses finish without hanging the caller.
        let _ = tokio::time::timeout(SHUTDOWN_GRACE, self.task).await;
    }
}

async fn bind() -> Result<TcpListener, String> {
    TcpListener::bind(SocketAddr::from(([127, 0, 0, 1], PORT)))
        .await
        .map_err(|_| format!("Port {PORT} is already in use. Close the program using it and try again."))
}

fn spawn_server(listener: TcpListener, router: Router) -> RunningServer {
    let (stop, stop_rx) = oneshot::channel::<()>();
    let task = tokio::spawn(async move {
        let _ = axum::serve(listener, router)
            .with_graceful_shutdown(async {
                let _ = stop_rx.await;
            })
            .await;
    });
    RunningServer { stop, task }
}

#[tauri::command]
pub async fn server_start(
    app: AppHandle,
    server: State<'_, ServerState>,
    config: ServerConfig,
) -> Result<u16, String> {
    let mut running = server.running.lock().await;
    if running.is_some() {
        return Ok(PORT);
    }
    let data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let secret = signing::load_or_create_secret(&data_dir)
        .map_err(|e| format!("Could not read the share secret: {e}"))?;
    let http = reqwest::Client::new();
    let state = AppState {
        secret: Arc::new(secret),
        libraries: server.libraries.clone(),
        jwks: Arc::new(JwksCache::new(&config.supabase_url, http.clone())),
        allowlist: Arc::new(Allowlist::new(&config.supabase_url, &config.supabase_key, http)),
    };
    let router = routes::router(state, &config.allowed_origins).merge(oauth::callback_router());
    *running = Some(spawn_server(bind().await?, router));
    oauth::SHARING_SERVER_UP.store(true, Ordering::SeqCst);
    Ok(PORT)
}

#[tauri::command]
pub async fn server_stop(server: State<'_, ServerState>) -> Result<(), String> {
    let Some(running) = server.running.lock().await.take() else {
        return Ok(());
    };
    oauth::SHARING_SERVER_UP.store(false, Ordering::SeqCst);
    running.shutdown().await;
    Ok(())
}

// A root that no longer exists is dropped rather than failing the whole call.
#[tauri::command(async)]
pub fn server_set_libraries(server: State<'_, ServerState>, libraries: Vec<SharedLibrary>) {
    let roots = libraries
        .into_iter()
        .filter_map(|library| {
            let root = PathBuf::from(library.root).canonicalize().ok()?;
            Some((library.id, root))
        })
        .collect();
    *server.libraries.write().unwrap() = roots;
}
```

In `tauri/src-tauri/Cargo.toml`, make sure plan 2's tokio line includes `"rt"` (`tokio::spawn` needs it; Task 3 added it):

```toml
tokio = { version = "1", features = ["net", "sync", "time", "macros", "rt"] }
```

- [ ] **Step 5: Register the state and commands**

In `tauri/src-tauri/src/lib.rs`, add `.manage(server::ServerState::default())` right before `.invoke_handler(`. Append these three entries to the end of the existing `tauri::generate_handler![...]` list, keeping plan 2's entries as they are:

```rust
            server::server_start,
            server::server_stop,
            server::server_set_libraries,
```

With plan 2's `oauth_wait_code`, the chain reads:

```rust
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(server::ServerState::default())
        .invoke_handler(tauri::generate_handler![
            scan_folder,
            path_exists,
            server::oauth_wait_code,
            server::server_start,
            server::server_stop,
            server::server_set_libraries,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
```

Do not edit `capabilities/default.json` (see Global Constraints).

- [ ] **Step 6: Run the whole suite and the linter**

Run: `cargo test`
Expected: `test result: ok. 30 passed` for `app_lib` (28 on Windows), plus any other tests plan 2 added.

Run: `cargo clippy --all-targets`
Expected: finishes with no `warning:` lines.

- [ ] **Step 7: Commit**

```sh
git add src-tauri/Cargo.toml src-tauri/Cargo.lock src-tauri/src/lib.rs src-tauri/src/server/mod.rs src-tauri/src/server/oauth.rs
git commit -m "feat(tauri): start and stop the sharing server from commands"
```

---

### Task 6: Frontend bridge and a temporary dev handle

**Files:**
- Modify: `tauri/src/lib/platform.ts`, `tauri/src/main.tsx`, `tauri/.env.example`
- Create: `tauri/src/lib/devServer.ts` (removed by plan 4)

**Interfaces:**
- Consumes: `SUPABASE_URL`, `SUPABASE_KEY` from `src/lib/supabase.ts` (plan 2); `accessToken()` from `src/lib/auth.ts` (plan 2); `Recents.libraryIdFor(path)` from `src/lib/store.ts` (plan 1).
- Produces (index contract):
  ```ts
  export type SharedLibrary = { id: string; root: string };
  export function startServer(libraries: SharedLibrary[]): Promise<void>;
  export function stopServer(): Promise<void>;
  export function setServerLibraries(libraries: SharedLibrary[]): Promise<void>;
  ```
  All three resolve to no-ops outside Tauri. `startServer` sets the libraries first, so the server never answers with an empty map.
- Temporary: `window.devServer = { start(root): Promise<string /* libraryId */>, stop(), setLibraries(libs), token() }`, installed only when `import.meta.env.DEV`. Plan 4 deletes `src/lib/devServer.ts` and the `import.meta.env.DEV` block in `main.tsx` when it adds the sharing toggle.

- [ ] **Step 1: Check the prerequisites plan 2 left**

Run: `grep -n 'lib/platform"\|./platform"' src/lib/supabase.ts src/lib/store.ts src/lib/lww.ts; ls src/vite-env.d.ts`
Expected: the grep prints nothing and `src/vite-env.d.ts` exists.
- No grep output means `supabase.ts` and what it imports (`store.ts`, `lww.ts`) never import `platform.ts`, so the new static import creates no cycle.
- If `store.ts` does import `platform.ts`, check that it reads `SEP`/`isTauri` only inside functions. A top-level read would hit the `platform → supabase → store → platform` cycle at startup.
- If `src/vite-env.d.ts` is missing, create it with the single line `/// <reference types="vite/client" />`.

A dynamic `import()` of `supabase.ts` is not an option: `auth.ts` imports that module statically, and Vite warns about the mix.

- [ ] **Step 2: Add the bridge functions**

In `tauri/src/lib/platform.ts`, add below the existing `import type { UnlistenFn } ...` line:

```ts
import { SUPABASE_KEY, SUPABASE_URL } from "@/lib/supabase";
```

and append at the end of the file:

```ts
export type SharedLibrary = { id: string; root: string };

export async function startServer(libraries: SharedLibrary[]): Promise<void> {
  if (!isTauri) return;
  const webOrigin: string | undefined = import.meta.env.VITE_WEB_ORIGIN;
  const config = {
    supabaseUrl: SUPABASE_URL,
    supabaseKey: SUPABASE_KEY,
    allowedOrigins: webOrigin ? [webOrigin] : [],
  };
  await setServerLibraries(libraries);
  await invoke("server_start", { config });
}

export function stopServer(): Promise<void> {
  if (!isTauri) return Promise.resolve();
  return invoke("server_stop");
}

export function setServerLibraries(libraries: SharedLibrary[]): Promise<void> {
  if (!isTauri) return Promise.resolve();
  return invoke("server_set_libraries", { libraries });
}
```

- [ ] **Step 3: Add the dev handle**

Create `tauri/src/lib/devServer.ts`:

```ts
import { accessToken } from "@/lib/auth";
import { setServerLibraries, startServer, stopServer } from "@/lib/platform";
import { Recents } from "@/lib/store";

// Console handle for exercising the PC server until plan 4 adds the sharing
// toggle; plan 4 deletes this file and its import in main.tsx.
export function installDevServer(): void {
  Object.assign(window, {
    devServer: {
      start: async (root: string) => {
        const id = Recents.libraryIdFor(root);
        await startServer([{ id, root }]);
        return id;
      },
      stop: stopServer,
      setLibraries: setServerLibraries,
      token: accessToken,
    },
  });
}
```

In `tauri/src/main.tsx`, insert after `mq.addEventListener("change", applyTheme);`:

```ts

if (import.meta.env.DEV) {
  void import("@/lib/devServer").then((m) => m.installDevServer());
}
```

- [ ] **Step 4: Document the web origin**

Run from `tauri/`:

```sh
printf '\n# Origin of the hosted web app (plan 5); the PC server allows it through CORS\nVITE_WEB_ORIGIN=\n' >> .env.example
```

- [ ] **Step 5: Type-check and build**

Run: `npx tsc -p tsconfig.app.json --noEmit`
Expected: no output.

Run: `npm run build && grep -l "devServer" dist/assets/*.js`
Expected: the build succeeds. The only warnings are the two already there (the `@tauri-apps/api/window.js` mixed-import notice and the >500 kB chunk notice). The grep prints nothing (exit code 1), because the dev handle is not in the production bundle.

- [ ] **Step 6: Commit**

```sh
git add src/lib/platform.ts src/lib/devServer.ts src/main.tsx .env.example
git commit -m "feat(tauri): expose the sharing server to the frontend"
```

---

### Task 7: Manual verification over localhost

**Files:**
- Modify (only if Step 1 says so): `tauri/supabase/config.toml`, `tauri/supabase/.gitignore`

No code changes. This task checks the whole surface against a real local Supabase, with no tunnel.

- [ ] **Step 1: Make local Supabase sign tokens with an asymmetric key**

The local stack signs with the legacy HS256 secret unless `signing_keys_path` is set, and `verify_token` rejects HS256 on purpose. Run from `tauri/`:

```sh
grep -n '^signing_keys_path' supabase/config.toml
```

If that prints a line, plan 2 already did this; go to Step 2. Otherwise:

```sh
echo '[]' > supabase/signing_keys.json
sed -i.bak 's|^# signing_keys_path = "./signing_keys.json"|signing_keys_path = "./signing_keys.json"|' supabase/config.toml && rm supabase/config.toml.bak
npx supabase gen signing-key --algorithm ES256 --yes
printf '\n# Local JWT signing keys\nsigning_keys.json\n' >> supabase/.gitignore
npx supabase stop && npx supabase start
curl -s http://127.0.0.1:54321/auth/v1/.well-known/jwks.json
```

Expected: the gen command prints `JWT signing key appended to: supabase/signing_keys.json (now contains 1 keys)`, and the JWKS response lists one key with `"alg":"ES256"`. Commit:

```sh
git add supabase/config.toml supabase/.gitignore
git commit -m "chore(tauri): sign local Supabase tokens with an ES256 key"
```

- [ ] **Step 2: Start the app and the server**

`tauri/.env.local` must have `VITE_SUPABASE_URL=http://127.0.0.1:54321`, written exactly like that because it has to match the token's `iss`. Your email must be in `allowed_emails` (Supabase Studio at `http://127.0.0.1:54323`).

Run `npm run tauri dev`, sign in through plan 2's UI, open a course folder, then open devtools (right-click → Inspect) and run:

```js
const lib = await devServer.start("/absolute/path/of/the/open/course");
const token = await devServer.token();
copy(`export LIB='${lib}' TOKEN='${token}'`);
```

Paste the copied line into a shell and also set `export S=http://127.0.0.1:8787`.

Check the issuer: `node -e "console.log(JSON.parse(Buffer.from(process.argv[1].split('.')[1],'base64url')).iss)" "$TOKEN"`
Expected: `http://127.0.0.1:54321/auth/v1`.

- [ ] **Step 3: Health, auth and tree**

```sh
curl -s $S/health
curl -s -o /dev/null -w '%{http_code}\n' $S/api/tree/$LIB
curl -s -o /dev/null -w '%{http_code}\n' -H "Authorization: Bearer nope" $S/api/tree/$LIB
curl -s -H "Authorization: Bearer $TOKEN" $S/api/tree/$LIB | head -c 400; echo
curl -s -o /dev/null -w '%{http_code}\n' -H "Authorization: Bearer $TOKEN" $S/api/tree/not-a-library
```

Expected, in order: `{"ok":true}`, `401`, `401`, a JSON array whose `path` values are relative and `/`-separated (for example `"Module 1/01 Intro.mp4"`) with no absolute prefix, then `404`.

- [ ] **Step 4: Sign and stream**

Pick a video `path` from the tree output:

```sh
export REL='Module 1/01 Intro.mp4'
export URL=$(curl -s -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d "{\"library\":\"$LIB\",\"path\":\"$REL\"}" $S/api/sign | node -pe 'JSON.parse(require("fs").readFileSync(0)).url')
echo "$URL"
curl -s -D - -o /dev/null -r 0-99 "$S$URL"
```

Expected: `URL` looks like `/media/<lib>/Module%201/01%20Intro.mp4?u=<uuid>&exp=<now+43200>&sig=<64 hex>`. The headers include `HTTP/1.1 206 Partial Content`, `content-range: bytes 0-99/<size>` and `accept-ranges: bytes`.

- [ ] **Step 5: Refusals**

```sh
curl -s -o /dev/null -w '%{http_code}\n' "${S}$(echo "$URL" | sed 's/sig=[0-9a-f]*/sig=00/')"
curl -s -o /dev/null -w '%{http_code}\n' "${S}$(echo "$URL" | sed 's/exp=[0-9]*/exp=1/')"
curl -s -o /dev/null -w '%{http_code}\n' "${S}$(echo "$URL" | sed 's/Intro/Outro/')"
curl -s -o /dev/null -w '%{http_code}\n' --path-as-is "$S/media/$LIB/..%2F..%2Fetc%2Fpasswd?${URL#*\?}"
curl -s -o /dev/null -w '%{http_code}\n' -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d "{\"library\":\"$LIB\",\"path\":\"../../etc/passwd\"}" $S/api/sign
curl -s -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d "{\"library\":\"$LIB\",\"path\":\"nope.mp4\"}" $S/api/sign -w ' %{http_code}\n'
```

Expected: `401` (tampered signature), `401` (expired), `401` (tampered path), `401` (traversal, rejected by the signature before the filesystem is touched), `404` (traversal at signing), then an empty body and `404`. No response body contains an absolute path.

- [ ] **Step 6: CORS**

```sh
curl -s -D - -o /dev/null -X OPTIONS -H 'Origin: http://localhost:1420' \
  -H 'Access-Control-Request-Method: POST' -H 'Access-Control-Request-Headers: authorization,content-type' $S/api/sign
curl -s -D - -o /dev/null -H 'Origin: https://evil.example' $S/health | grep -i access-control-allow-origin
```

Expected: the first response has `access-control-allow-origin: http://localhost:1420`, and the second grep prints nothing.

- [ ] **Step 7: Browser playback**

Run `echo "$S$URL"` and open the printed URL in Chrome/Safari. Expected: the video plays and seeking works (DevTools → Network shows `206` responses).

- [ ] **Step 8: Allowlist**

In the app, sign out and sign in with an email that is **not** in `allowed_emails` (the code arrives in Mailpit at `http://127.0.0.1:54324`). In devtools, run `copy(await devServer.token())` and `export TOKEN=<pasted>`. Then:

```sh
curl -s -o /dev/null -w '%{http_code}\n' -H "Authorization: Bearer $TOKEN" $S/api/tree/$LIB
```

Expected: `401`. Add that email in Studio and repeat: expected `200`, with no wait, because only positive answers are cached.

- [ ] **Step 9: OAuth callback coexistence and stop**

With the server still running, sign out and use "Sign in with Google". Expected: sign-in completes, because the long-lived router serves `/auth/callback`.

Then run `await devServer.stop()` in devtools, followed by `curl -s -o /dev/null -w '%{http_code}\n' $S/health`. Expected: `000` (connection refused), which shows no socket is left open.

Sign in with Google again. Expected: it still completes through the ephemeral listener, and `curl $S/health` afterwards is `000` again.

- [ ] **Step 10: Final gate**

From `tauri/src-tauri`, run `cargo test && cargo clippy --all-targets`. From `tauri/`, run `npx tsc -p tsconfig.app.json --noEmit && npm run build`. Expected: all green, with no new warnings.

---

## Self-Review

### Spec coverage

| Spec requirement | Task |
|---|---|
| Not started with the app; starts for OAuth callback (ephemeral, torn down after callback or 2 min) and while sharing | 5 (`await_oauth_code` skips its own bind while sharing; `server_start`/`server_stop`), 6 (no auto-start) |
| Binds `127.0.0.1:8787` only; fixed port with clear error | 5 (`bind`, `PORT`) |
| `/auth/callback` no auth, loopback | 5 (`callback_router`, merged into the sharing router; lifecycle test covers both listeners) |
| `/api/*` Bearer JWT + allowlist + sharing enabled | 3 (`verify_token`), 4 (`Viewer`, `Allowlist`); "sharing enabled" = the server only listens while sharing (5) |
| JWT verified against JWKS (`iss`, `aud`, signature), no Supabase secret on PC | 3 |
| `/media/<library>/<rel>` HMAC signature, `?u&exp&sig`, 12 h TTL, secret never leaves PC | 2, 4 (`MEDIA_URL_TTL_SECS`), 5 (`load_or_create_secret` in `app_data_dir`) |
| Allowlist checked at signing time, not per range | 4 (`/api/sign` uses `Viewer`; `/media` checks only the signature) |
| Path traversal: `..`, leading and inverted separators, canonicalise under root, symlink escape, `VIDEO_EXTS` only, no absolute paths in errors | 1, 4 (status-only responses) |
| Range / If-Range / ETag from `tower-http` `ServeFile` | 4 |
| CORS: hosted origin + localhost in dev | 4 (`cors`), 6 (`VITE_WEB_ORIGIN`) |
| New crates `axum`, `tower-http`, `tokio`, `reqwest`, `jsonwebtoken`, `hmac`, `sha2` | plan 2 + Tasks 2, 3 |
| `/api/tree` reuses the scanner, `rel_path` `/`-separated | 4 (`build_tree` + `relativize`) |
| Rust tests: path resolution (`..`, leading slash, escaping symlink, non-video) and HMAC (valid, expired, tampered `rel_path`) | 1, 2 (plus tampered user/library/expiry, wrong secret), 3 (JWT), 4 (Range 206), 5 (shared callback) |
| Verified over localhost with no tunnel (delivery step 3) | 7 |
| Index: `platform.ts` `startServer` / `stopServer` / `setServerLibraries` | 6 |

### Contract check

- `resolve_media_path(root: &Path, rel: &str) -> Result<PathBuf, PathError>`: matches the index.
- `sign(secret, user, library, rel, exp) -> String` and `verify(secret, user, library, rel, exp, sig, now) -> bool`: match the index.
- `pub struct Claims { pub sub: String, pub email: String }` and `verify_token(jwks: &JwksCache, token: &str) -> Result<Claims, AuthError>`: match the index.
- `ServerConfig` and `SharedLibrary` (camelCase serde) plus the commands `server_start(config) -> Result<u16, String>` and `server_set_libraries(libraries)`: match the index.
- HTTP routes match the index, written in axum 0.8 syntax.
- `startServer(libraries)`, `stopServer()` and `setServerLibraries(libraries)` match the index.
- Plan 2's `await_oauth_code(timeout: Duration) -> Result<String, String>` (re-exported from `server`) and its `oauth_wait_code` command are kept with the same signatures and user-facing messages.

### Deviations and extensions

- `server_stop` returns `Result<(), String>` rather than `()`. Tauri requires async commands that borrow `State<'_, _>` to return `Result`. On the JS side it is still `Promise<void>`.
- `platform.ts` also exports `type SharedLibrary = { id: string; root: string }`. The index writes the same shape inline.
- The crate-private helpers `is_video` (instead of exposing `VIDEO_EXTS`), `Node.path`/`Node.children` and `build_tree` become `pub(crate)`. `is_video` already encodes the lowercased `VIDEO_EXTS` check, so reusing it keeps one definition.
- Extra public Rust items not in the index: `PathError`, `AuthError`, `JwksCache::new`, `Allowlist`, `routes::{AppState, Libraries, router}`, `signing::load_or_create_secret`, `server::{ServerState, PORT}`.
- `Claims.email` carries `#[allow(dead_code)]` because no route reads it yet. The index requires the field.
- Plan 2's OAuth listener moves into, or stays in, `server/oauth.rs`. Its per-call `Arc<Mutex<..>>` state becomes the process-wide `PENDING` slot, and the new `pub(super)` items `SHARING_SERVER_UP` and `callback_router()` are added. `server/mod.rs` is replaced wholesale and re-exports `await_oauth_code`.
- `tokio` gains the `rt` feature, which plan 2's list in the index omits.
