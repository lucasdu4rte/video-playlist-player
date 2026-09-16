# Tunnel and Sharing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A signed-in owner switches on "Web access". The app fetches a pinned, checksum-verified `cloudflared` if needed and opens a quick tunnel to the PC server. It publishes the tunnel URL to `hosts` with a 60 s heartbeat, and it publishes tree snapshots for the libraries the owner marked "Available on web".

**Architecture:** A new Rust module `tunnel` has two jobs. `install.rs` finds `cloudflared` (first on `PATH`, then in `app_data_dir/bin`) and downloads the pinned build for this platform, checking its SHA-256 in memory before anything is written. `mod.rs` spawns `cloudflared tunnel`, reads stderr until the `trycloudflare.com` URL appears, keeps the `Child` in managed state and kills it on stop or app exit. On the TypeScript side, `src/lib/sharing.ts` drives the whole flow: PC server, then tunnel, then `hosts` row, then heartbeat and snapshots. It also keeps the owner's `on_web` set in memory, loaded from Supabase on sign-in. A `SharingControl` component in `AppHeader` and a checkbox item in the Home context menu are the only UI.

**Tech Stack:** Tauri v2 (managed state, `RunEvent::Exit`, `path().app_data_dir()`), Rust `std::process` + `std::sync::mpsc`, `reqwest` 0.13 (async, `native-tls`, added by plan 3), `sha2` 0.10, system `tar`, React 19 + TypeScript, `supabase-js` (via `getSupabase`), vitest.

**Spec:** docs/superpowers/specs/2026-09-16-web-access-design.md
**Index / shared contract:** docs/superpowers/plans/2026-09-16-web-access-00-index.md

## Global Constraints

All constraints in the index apply. Additionally:

- Every command runs from `tauri/`. `git add` paths are relative to `tauri/`.
- The download is verified **in memory** before a single byte is written. A mismatch writes nothing. A failure after writing (extraction, `--version` check) removes the installed file.
- `CLOUDFLARED_VERSION` and the asset table live together in `install.rs`. Bumping the version means recomputing every hash and size in the same commit.
- `cloudflared` is always spawned with `--no-autoupdate`. On Windows every spawn uses `CREATE_NO_WINDOW`.
- Tree snapshots are published only for libraries in the in-memory `on_web` set. The guard sits inside `publishTree`, so no caller can bypass it.
- The sharing UI renders only when `isTauri && supabaseConfigured` and an account is signed in.
- `libraries.updated_at`, `library_trees.scanned_at` and `hosts.updated_at` are written as ISO-8601 strings (`new Date().toISOString()`), which assumes plan 2 declared them `timestamptz`.
- No new npm dependency. No new Rust dependency: plan 3 already declares `reqwest` (with `native-tls`) and `sha2`.

---

## File Structure

| File | Responsibility |
|---|---|
| `src-tauri/Cargo.toml` (verify only) | `reqwest` and `sha2` already declared by plan 3 |
| `src-tauri/src/tunnel/install.rs` (create) | Pinned version, per-platform asset table, SHA-256 check, `cloudflared` lookup, download + install |
| `src-tauri/src/tunnel/mod.rs` (create) | `TunnelStatus`, `TunnelState`, `parse_tunnel_url`, the four `tunnel_*` commands, `shutdown` |
| `src-tauri/src/lib.rs` (modify) | Register the module, managed state, commands, and the `RunEvent::Exit` kill |
| `src/lib/libraryPath.ts` (modify) | `relativizeTree`: FileNode paths → `rel_path` |
| `src/lib/libraryPath.test.ts` (modify) | vitest cases for `relativizeTree` |
| `src/lib/platform.ts` (modify) | `TunnelStatus` type and the `tunnelStatus` / `installTunnel` / `startTunnel` / `stopTunnel` bridge |
| `src/lib/sharing.ts` (create) | Sharing lifecycle, `hosts` heartbeat, `on_web` set, tree snapshots, account tracking |
| `src/vite-env.d.ts` (modify) | Type `VITE_WEB_ORIGIN` |
| `src/components/SharingControl.tsx` (create) | Header switch: off / confirm download / installing / starting / on / error |
| `src/components/AppHeader.tsx` (modify) | Render `SharingControl` |
| `src/components/Home.tsx` (modify) | "Available on web" checkbox in the RecentCard context menu |
| `src/App.tsx` (modify) | Start account tracking, publish the tree after a scan, drop plan 3's dev hook |

### Contract extensions (beyond the index)

Rust, private to the `tunnel` module:
- `install::CLOUDFLARED_VERSION: &str`
- `install::Asset`
- `install::asset_for(os: &str, arch: &str) -> Option<&'static Asset>`
- `install::sha256_hex(bytes: &[u8]) -> String`
- `install::matches_pinned_hash(bytes: &[u8], expected: &str) -> bool`
- `tunnel::parse_tunnel_url(line: &str) -> Option<String>`
- `tunnel::TunnelState`
- `tunnel::shutdown(app: &AppHandle)`

TypeScript:
- `libraryPath.ts`: `relativizeTree(nodes: FileNode[], root: string, sep: string): FileNode[]`
- `platform.ts`:
  - `type TunnelStatus = { installed: boolean; source: "path" | "bundled" | null; downloadBytes: number }`
  - `tunnelStatus(): Promise<TunnelStatus>`
  - `installTunnel(): Promise<void>`
  - `startTunnel(): Promise<string>`
  - `stopTunnel(): Promise<void>`
- `sharing.ts`:
  - `subscribeSharing(listener: () => void): () => void`
  - `sharingAccount(): Account | null`
  - `onWebLibraries(): ReadonlySet<string>`
  - `trackAccount(): () => void`

Serde `rename_all = "camelCase"` (fixed by the index) means the Rust field `download_bytes` reaches TypeScript as `downloadBytes`.

---

### Task 1: Pinned cloudflared install

**Files:**
- Modify: `src-tauri/Cargo.toml`
- Create: `src-tauri/src/tunnel/install.rs`
- Create: `src-tauri/src/tunnel/mod.rs`
- Modify: `src-tauri/src/lib.rs`
- Test: `src-tauri/src/tunnel/install.rs` (`#[cfg(test)] mod tests`)

**Interfaces:**
- Consumes: `tauri::AppHandle`, `tauri::Manager::path`
- Produces: `tunnel_status() -> TunnelStatus` and `tunnel_install() -> Result<(), String>` (from the index), plus the `install::*` items listed under contract extensions.

- [ ] **Step 1: Confirm the dependencies from plan 3**

Plan 3 already declared both crates. Check that `src-tauri/Cargo.toml` contains exactly:

```toml
reqwest = { version = "0.13", default-features = false, features = ["json", "native-tls"] }
sha2 = "0.10"
```

Do not switch `reqwest` to its default features: they bring rustls on `aws-lc-rs`, whose C/assembly build (`aws-lc-sys`) complicates the Windows build. `native-tls` uses SChannel on Windows and Security.framework on macOS, which is enough for the HTTPS download from GitHub.

- [ ] **Step 2: Write the failing tests**

Create `src-tauri/src/tunnel/install.rs` containing only the test module:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    const ABC_SHA256: &str = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";

    #[test]
    fn picks_the_asset_for_each_supported_target() {
        let name = |os, arch| asset_for(os, arch).map(|a| a.name);
        assert_eq!(name("macos", "aarch64"), Some("cloudflared-darwin-arm64.tgz"));
        assert_eq!(name("macos", "x86_64"), Some("cloudflared-darwin-amd64.tgz"));
        assert_eq!(name("windows", "x86_64"), Some("cloudflared-windows-amd64.exe"));
        assert_eq!(name("linux", "x86_64"), Some("cloudflared-linux-amd64"));
        assert_eq!(name("linux", "aarch64"), Some("cloudflared-linux-arm64"));
    }

    #[test]
    fn has_no_asset_for_unsupported_targets() {
        assert!(asset_for("windows", "aarch64").is_none());
        assert!(asset_for("freebsd", "x86_64").is_none());
        assert!(asset_for("linux", "arm").is_none());
    }

    #[test]
    fn every_pinned_hash_is_lowercase_sha256_hex() {
        for asset in ASSETS {
            assert_eq!(asset.sha256.len(), 64, "{}", asset.name);
            assert!(
                asset.sha256.chars().all(|c| matches!(c, '0'..='9' | 'a'..='f')),
                "{}",
                asset.name
            );
            assert!(asset.bytes > 0, "{}", asset.name);
        }
    }

    #[test]
    fn hashes_bytes_as_lowercase_hex() {
        assert_eq!(sha256_hex(b"abc"), ABC_SHA256);
    }

    #[test]
    fn accepts_matching_bytes_regardless_of_hex_case() {
        assert!(matches_pinned_hash(b"abc", ABC_SHA256));
        assert!(matches_pinned_hash(b"abc", &ABC_SHA256.to_uppercase()));
    }

    #[test]
    fn rejects_tampered_bytes_or_hash() {
        assert!(!matches_pinned_hash(b"abd", ABC_SHA256));
        let tampered = format!("0{}", &ABC_SHA256[1..]);
        assert!(!matches_pinned_hash(b"abc", &tampered));
    }
}
```

Create `src-tauri/src/tunnel/mod.rs`:

```rust
mod install;
```

In `src-tauri/src/lib.rs`, add `mod tunnel;` right after the `use tauri::Manager;` line.

- [ ] **Step 3: Run the tests to see them fail**

Run: `cargo test --manifest-path src-tauri/Cargo.toml tunnel::install`
Expected: compilation fails with `error[E0425]: cannot find function \`asset_for\` in this scope` (plus the same for `sha256_hex`, `matches_pinned_hash` and `ASSETS`).

- [ ] **Step 4: Implement `install.rs`**

Put this above the test module in `src-tauri/src/tunnel/install.rs`:

```rust
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Duration;

use sha2::{Digest, Sha256};
use tauri::{AppHandle, Manager};

pub const CLOUDFLARED_VERSION: &str = "2026.9.1";

const BINARY_NAME: &str = if cfg!(windows) { "cloudflared.exe" } else { "cloudflared" };
const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(600);

pub struct Asset {
    pub os: &'static str,
    pub arch: &'static str,
    pub name: &'static str,
    pub sha256: &'static str,
    pub bytes: u64,
}

// Cloudflare publishes neither checksums nor signatures for release assets, so
// these were computed from the 2026.9.1 downloads when the version was pinned.
// Bumping CLOUDFLARED_VERSION means recomputing every row.
const ASSETS: &[Asset] = &[
    Asset {
        os: "macos",
        arch: "aarch64",
        name: "cloudflared-darwin-arm64.tgz",
        sha256: "c27ab8fd0aa489449e3d201eb02f957ef460a13b613662928b1b23394bf1bcfe",
        bytes: 19_217_478,
    },
    Asset {
        os: "macos",
        arch: "x86_64",
        name: "cloudflared-darwin-amd64.tgz",
        sha256: "ff0d3b51d5ff70eceef89d6b32145fee985018a2174596a5dbe405e2766e2ac4",
        bytes: 21_118_723,
    },
    Asset {
        os: "windows",
        arch: "x86_64",
        name: "cloudflared-windows-amd64.exe",
        sha256: "2837888cc0f5d58f15b6dc478376de90b4d3ba5241c7947455d1e0a0df429712",
        bytes: 54_976_432,
    },
    Asset {
        os: "linux",
        arch: "x86_64",
        name: "cloudflared-linux-amd64",
        sha256: "03f1f25d1cc93b9ad6c60569d44060bc4f17ed97075760ed8cfca4b12dcd68cc",
        bytes: 39_838_488,
    },
    Asset {
        os: "linux",
        arch: "aarch64",
        name: "cloudflared-linux-arm64",
        sha256: "3d97437c71848bd8df68041e12436b484a661d95073ea1937f01a845ce88faa3",
        bytes: 37_466_252,
    },
];

pub fn asset_for(os: &str, arch: &str) -> Option<&'static Asset> {
    ASSETS.iter().find(|asset| asset.os == os && asset.arch == arch)
}

fn current_asset() -> Option<&'static Asset> {
    asset_for(std::env::consts::OS, std::env::consts::ARCH)
}

pub fn sha256_hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes).iter().map(|b| format!("{b:02x}")).collect()
}

pub fn matches_pinned_hash(bytes: &[u8], expected: &str) -> bool {
    sha256_hex(bytes).eq_ignore_ascii_case(expected)
}

#[cfg(windows)]
pub fn quiet_command(program: &Path) -> Command {
    use std::os::windows::process::CommandExt;
    // Without this flag Windows opens a console window for every spawn.
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let mut command = Command::new(program);
    command.creation_flags(CREATE_NO_WINDOW);
    command
}

#[cfg(not(windows))]
pub fn quiet_command(program: &Path) -> Command {
    Command::new(program)
}

fn find_on_path() -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    std::env::split_paths(&path)
        .map(|dir| dir.join(BINARY_NAME))
        .find(|candidate| candidate.is_file())
}

fn bundled_path(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|dir| dir.join("bin").join(BINARY_NAME))
        .map_err(|e| format!("no app data directory: {e}"))
}

pub fn locate(app: &AppHandle) -> Option<(PathBuf, &'static str)> {
    if let Some(found) = find_on_path() {
        return Some((found, "path"));
    }
    let bundled = bundled_path(app).ok()?;
    bundled.is_file().then_some((bundled, "bundled"))
}

pub fn status(app: &AppHandle) -> super::TunnelStatus {
    let located = locate(app);
    super::TunnelStatus {
        installed: located.is_some(),
        source: located.map(|(_, source)| source.to_string()),
        download_bytes: current_asset().map_or(0, |asset| asset.bytes),
    }
}

pub async fn install(app: &AppHandle) -> Result<(), String> {
    let asset = current_asset().ok_or_else(|| {
        format!(
            "cloudflared has no pinned build for {} {}; install it yourself and put it on PATH",
            std::env::consts::OS,
            std::env::consts::ARCH
        )
    })?;
    let bytes = download(asset).await?;
    if !matches_pinned_hash(&bytes, asset.sha256) {
        return Err("the downloaded cloudflared does not match its pinned checksum and was discarded".into());
    }

    let target = bundled_path(app)?;
    let bin_dir = target.parent().ok_or("invalid install directory")?;
    std::fs::create_dir_all(bin_dir).map_err(install_error)?;
    let staging = bin_dir.join(format!("{}.part", asset.name));
    std::fs::write(&staging, &bytes).map_err(install_error)?;

    let placed = place(&staging, &target, asset).and_then(|()| check_version(&target));
    let _ = std::fs::remove_file(&staging);
    if placed.is_err() {
        let _ = std::fs::remove_file(&target);
    }
    placed
}

async fn download(asset: &Asset) -> Result<Vec<u8>, String> {
    let url = format!(
        "https://github.com/cloudflare/cloudflared/releases/download/{CLOUDFLARED_VERSION}/{}",
        asset.name
    );
    let client = reqwest::Client::builder()
        .timeout(DOWNLOAD_TIMEOUT)
        .build()
        .map_err(download_error)?;
    let response = client
        .get(url)
        .send()
        .await
        .and_then(|r| r.error_for_status())
        .map_err(download_error)?;
    let bytes = response.bytes().await.map_err(download_error)?;
    Ok(bytes.to_vec())
}

fn place(staging: &Path, target: &Path, asset: &Asset) -> Result<(), String> {
    if asset.name.ends_with(".tgz") {
        extract(staging, target)?;
    } else {
        std::fs::rename(staging, target).map_err(install_error)?;
    }
    make_executable(target)
}

// The macOS archive holds a single `cloudflared` entry, so extracting into the
// target's directory writes exactly the target file. Only macOS assets are
// archives, and macOS ships `tar`, so no archive crate is needed.
fn extract(archive: &Path, target: &Path) -> Result<(), String> {
    let dir = target.parent().ok_or("invalid install directory")?;
    let status = Command::new("tar")
        .arg("-xzf")
        .arg(archive)
        .arg("-C")
        .arg(dir)
        .status()
        .map_err(|e| format!("could not run tar: {e}"))?;
    if !status.success() {
        return Err(format!("tar could not extract cloudflared ({status})"));
    }
    Ok(())
}

#[cfg(unix)]
fn make_executable(path: &Path) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755)).map_err(install_error)
}

#[cfg(not(unix))]
fn make_executable(_path: &Path) -> Result<(), String> {
    Ok(())
}

fn check_version(binary: &Path) -> Result<(), String> {
    let output = quiet_command(binary)
        .arg("--version")
        .output()
        .map_err(|e| format!("the installed cloudflared does not run: {e}"))?;
    let reported = format!(
        "{}{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    if !reported.contains(CLOUDFLARED_VERSION) {
        return Err(format!(
            "the installed cloudflared reports an unexpected version: {}",
            reported.trim()
        ));
    }
    Ok(())
}

fn install_error(e: std::io::Error) -> String {
    format!("could not install cloudflared: {e}")
}

fn download_error(e: reqwest::Error) -> String {
    format!("could not download cloudflared: {e}")
}
```

- [ ] **Step 5: Add the status and install commands**

Replace `src-tauri/src/tunnel/mod.rs` with:

```rust
mod install;

use serde::Serialize;
use tauri::AppHandle;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TunnelStatus {
    pub installed: bool,
    pub source: Option<String>,
    pub download_bytes: u64,
}

#[tauri::command(async)]
pub fn tunnel_status(app: AppHandle) -> TunnelStatus {
    install::status(&app)
}

#[tauri::command]
pub async fn tunnel_install(app: AppHandle) -> Result<(), String> {
    install::install(&app).await
}
```

In `src-tauri/src/lib.rs`, add the two commands to the `generate_handler!` list, next to whatever plans 2 and 3 registered:

```rust
        .invoke_handler(tauri::generate_handler![
            scan_folder,
            path_exists,
            tunnel::tunnel_status,
            tunnel::tunnel_install,
        ])
```

(Keep the plan 2/3 entries, such as `oauth_wait_code` and `server_start`, in that list.)

- [ ] **Step 6: Run the tests and lints**

Run: `cargo test --manifest-path src-tauri/Cargo.toml tunnel::install`
Expected: `test result: ok. 6 passed; 0 failed`.

Run: `cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets`
Expected: no warnings from `src/tunnel/`. `CLOUDFLARED_VERSION` is used by `download` and `check_version`, and `asset_for` by `current_asset`, so no dead-code warnings appear.

- [ ] **Step 7: Commit**

```sh
git add src-tauri/Cargo.toml src-tauri/Cargo.lock src-tauri/src/lib.rs src-tauri/src/tunnel/mod.rs src-tauri/src/tunnel/install.rs
git commit -m "feat(tauri): install pinned cloudflared with checksum verification"
```

---

### Task 2: Quick tunnel process

**Files:**
- Modify: `src-tauri/src/tunnel/mod.rs`
- Modify: `src-tauri/src/lib.rs`
- Test: `src-tauri/src/tunnel/mod.rs` (`#[cfg(test)] mod tests`)

**Interfaces:**
- Consumes: `install::locate`, `install::quiet_command` (Task 1); the PC server on `127.0.0.1:8787` (plan 3)
- Produces: `tunnel_start() -> Result<String, String>` and `tunnel_stop()` (from the index); `parse_tunnel_url`, `TunnelState`, `shutdown`

- [ ] **Step 1: Write the failing parser tests**

Append to `src-tauri/src/tunnel/mod.rs`:

```rust
#[cfg(test)]
mod tests {
    use super::parse_tunnel_url;

    #[test]
    fn reads_the_url_from_the_quick_tunnel_banner() {
        let line = "2026-09-16T12:00:03Z INF |  https://cadillac-tribute-hampshire-fewer.trycloudflare.com                                 |";
        assert_eq!(
            parse_tunnel_url(line).as_deref(),
            Some("https://cadillac-tribute-hampshire-fewer.trycloudflare.com")
        );
    }

    #[test]
    fn ignores_the_banner_frame_and_title() {
        assert_eq!(parse_tunnel_url("2026-09-16T12:00:03Z INF +--------------------------------------------------------------------------------------------+"), None);
        assert_eq!(parse_tunnel_url("2026-09-16T12:00:03Z INF |  Your quick Tunnel has been created! Visit it at (it may take some time to be reachable):  |"), None);
    }

    #[test]
    fn ignores_the_request_line_without_a_scheme() {
        let line = "2026-09-16T12:00:00Z INF Requesting new quick Tunnel on trycloudflare.com...";
        assert_eq!(parse_tunnel_url(line), None);
    }

    #[test]
    fn ignores_other_cloudflare_links() {
        let line = "2026-09-16T12:00:00Z INF Thank you for trying Cloudflare Tunnel. Doing so, without a Cloudflare account, is a quick way to experiment and try it out. However, be aware that these account-less Tunnels have no uptime guarantee, are subject to the Cloudflare Online Services Terms of Use (https://www.cloudflare.com/website-terms/), and Cloudflare reserves the right to investigate your use of Tunnels for violations of such terms.";
        assert_eq!(parse_tunnel_url(line), None);
    }

    #[test]
    fn ignores_the_quick_tunnel_api_host_in_errors() {
        let line = r#"2026-09-16T12:00:02Z ERR Error requesting quick Tunnel error="failed to request quick Tunnel: Post \"https://api.trycloudflare.com/tunnel\": dial tcp: lookup api.trycloudflare.com: no such host""#;
        assert_eq!(parse_tunnel_url(line), None);
        assert_eq!(parse_tunnel_url("see https://api.trycloudflare.com for status"), None);
    }

    #[test]
    fn ignores_lookalike_hosts() {
        assert_eq!(parse_tunnel_url("INF https://evil.trycloudflare.com.example.net"), None);
        assert_eq!(parse_tunnel_url("INF https://abc.trycloudflare.com/path"), None);
    }
}
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `cargo test --manifest-path src-tauri/Cargo.toml tunnel::tests`
Expected: compilation fails with `error[E0432]: unresolved import \`super::parse_tunnel_url\``.

- [ ] **Step 3: Implement the tunnel process**

Replace everything above the test module in `src-tauri/src/tunnel/mod.rs` with:

```rust
mod install;

use std::io::{BufRead, BufReader};
use std::process::{Child, ChildStderr, Stdio};
use std::sync::mpsc::{self, RecvTimeoutError, Sender};
use std::sync::Mutex;
use std::thread;
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Manager};

const ORIGIN: &str = "http://127.0.0.1:8787";
const URL_TIMEOUT: Duration = Duration::from_secs(30);
const QUICK_TUNNEL_SUFFIX: &str = ".trycloudflare.com";
// cloudflared's own API host appears in its error lines and is never a tunnel.
const QUICK_TUNNEL_API: &str = "api.trycloudflare.com";

#[derive(Default)]
pub struct TunnelState(Mutex<Option<Child>>);

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TunnelStatus {
    pub installed: bool,
    pub source: Option<String>,
    pub download_bytes: u64,
}

pub fn parse_tunnel_url(line: &str) -> Option<String> {
    line.split(|c: char| c.is_whitespace() || c == '"' || c == '|')
        .filter_map(|token| token.strip_prefix("https://"))
        .find(|host| host.ends_with(QUICK_TUNNEL_SUFFIX) && *host != QUICK_TUNNEL_API)
        .map(|host| format!("https://{host}"))
}

#[tauri::command(async)]
pub fn tunnel_status(app: AppHandle) -> TunnelStatus {
    install::status(&app)
}

#[tauri::command]
pub async fn tunnel_install(app: AppHandle) -> Result<(), String> {
    install::install(&app).await
}

// Holds the state lock for the whole start so a second start (or a stop)
// waits instead of racing a half-started process.
#[tauri::command(async)]
pub fn tunnel_start(app: AppHandle) -> Result<String, String> {
    let (binary, _) = install::locate(&app).ok_or("cloudflared is not installed")?;
    let state = app.state::<TunnelState>();
    let mut running = state.0.lock().map_err(|_| "tunnel state is unavailable")?;
    if let Some(previous) = running.take() {
        stop_child(previous);
    }

    let mut child = install::quiet_command(&binary)
        .args(["tunnel", "--no-autoupdate", "--url", ORIGIN])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("could not start cloudflared: {e}"))?;
    let stderr = child.stderr.take().ok_or("cloudflared has no stderr pipe")?;
    let (url_tx, url_rx) = mpsc::channel();
    thread::spawn(move || forward_tunnel_url(stderr, url_tx));

    match url_rx.recv_timeout(URL_TIMEOUT) {
        Ok(url) => {
            *running = Some(child);
            Ok(url)
        }
        Err(RecvTimeoutError::Timeout) => {
            stop_child(child);
            Err("cloudflared did not report a tunnel URL within 30 seconds".into())
        }
        Err(RecvTimeoutError::Disconnected) => {
            stop_child(child);
            Err("cloudflared exited before reporting a tunnel URL".into())
        }
    }
}

#[tauri::command(async)]
pub fn tunnel_stop(app: AppHandle) {
    shutdown(&app);
}

pub fn shutdown(app: &AppHandle) {
    let state = app.state::<TunnelState>();
    let Ok(mut running) = state.0.lock() else {
        return;
    };
    if let Some(child) = running.take() {
        stop_child(child);
    }
}

// Keeps reading after the URL arrives: cloudflared logs to stderr for its
// whole life, and a full, undrained pipe would block it.
fn forward_tunnel_url(stderr: ChildStderr, url_tx: Sender<String>) {
    for line in BufReader::new(stderr).lines().map_while(Result::ok) {
        if let Some(url) = parse_tunnel_url(&line) {
            let _ = url_tx.send(url);
        }
    }
}

fn stop_child(mut child: Child) {
    let _ = child.kill();
    let _ = child.wait();
}
```

- [ ] **Step 4: Register the state, the commands and the exit kill**

In `src-tauri/src/lib.rs`, the end of `run()` becomes:

```rust
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(tunnel::TunnelState::default())
        .invoke_handler(tauri::generate_handler![
            scan_folder,
            path_exists,
            tunnel::tunnel_status,
            tunnel::tunnel_install,
            tunnel::tunnel_start,
            tunnel::tunnel_stop,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            if let tauri::RunEvent::Exit = event {
                tunnel::shutdown(app);
            }
        });
```

Keep every plugin, `.manage(...)` and command that plans 2 and 3 added. If plan 3 already switched to `.build(...).run(|app, event| ...)` with a `RunEvent::Exit` arm, add `tunnel::shutdown(app);` inside that arm instead of adding a second closure.

- [ ] **Step 5: Run the tests and lints**

Run: `cargo test --manifest-path src-tauri/Cargo.toml tunnel`
Expected: `test result: ok. 12 passed; 0 failed` (6 parser + 6 install).

Run: `cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets`
Expected: no new warnings.

- [ ] **Step 6: Commit**

```sh
git add src-tauri/src/lib.rs src-tauri/src/tunnel/mod.rs
git commit -m "feat(tauri): run a cloudflared quick tunnel to the pc server"
```

---

### Task 3: Tree relativization

**Files:**
- Modify: `src/lib/libraryPath.ts`
- Test: `src/lib/libraryPath.test.ts`

**Interfaces:**
- Consumes: `toRelPath` (plan 1), `FileNode` (`platform.ts`)
- Produces: `relativizeTree(nodes: FileNode[], root: string, sep: string): FileNode[]`

- [ ] **Step 1: Write the failing tests**

In `src/lib/libraryPath.test.ts`, add `relativizeTree` to the existing `./libraryPath` import and add `import type { FileNode } from "./platform";` below it. Then append:

```ts
describe("relativizeTree", () => {
  it("rewrites nested POSIX paths as rel_paths", () => {
    const tree: FileNode[] = [
      {
        path: "/Courses/Rust/01 Intro",
        name: "01 Intro",
        type: "folder",
        children: [
          { path: "/Courses/Rust/01 Intro/a.mp4", name: "a.mp4", type: "video" },
        ],
      },
      { path: "/Courses/Rust/README.mp4", name: "README.mp4", type: "video" },
    ];
    expect(relativizeTree(tree, "/Courses/Rust", "/")).toEqual([
      {
        path: "01 Intro",
        name: "01 Intro",
        type: "folder",
        children: [{ path: "01 Intro/a.mp4", name: "a.mp4", type: "video" }],
      },
      { path: "README.mp4", name: "README.mp4", type: "video" },
    ]);
  });

  it("normalises Windows separators to forward slashes", () => {
    const tree: FileNode[] = [
      {
        path: "C:\\Courses\\Rust\\01 Intro",
        name: "01 Intro",
        type: "folder",
        children: [
          { path: "C:\\Courses\\Rust\\01 Intro\\a.mp4", name: "a.mp4", type: "video" },
        ],
      },
    ];
    expect(relativizeTree(tree, "C:\\Courses\\Rust", "\\")).toEqual([
      {
        path: "01 Intro",
        name: "01 Intro",
        type: "folder",
        children: [{ path: "01 Intro/a.mp4", name: "a.mp4", type: "video" }],
      },
    ]);
  });

  it("drops nodes that are not under the root", () => {
    const tree: FileNode[] = [
      { path: "/Elsewhere/b.mp4", name: "b.mp4", type: "video" },
      { path: "/Courses/Rust/a.mp4", name: "a.mp4", type: "video" },
    ];
    expect(relativizeTree(tree, "/Courses/Rust", "/")).toEqual([
      { path: "a.mp4", name: "a.mp4", type: "video" },
    ]);
  });

  it("does not mutate the input tree", () => {
    const video: FileNode = { path: "/Courses/Rust/a.mp4", name: "a.mp4", type: "video" };
    relativizeTree([video], "/Courses/Rust", "/");
    expect(video.path).toBe("/Courses/Rust/a.mp4");
  });
});
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `npm test -- src/lib/libraryPath.test.ts`
Expected: FAIL. `relativizeTree` is not exported (`TypeError: relativizeTree is not a function`, or a SyntaxError naming the missing export).

- [ ] **Step 3: Implement**

In `src/lib/libraryPath.ts`, add `import type { FileNode } from "./platform";` at the top (type-only, so no Tauri code is pulled in) and append:

```ts
/** Copies the tree with every path rewritten as a rel_path; nodes outside root are dropped. */
export function relativizeTree(nodes: FileNode[], root: string, sep: string): FileNode[] {
  return nodes.flatMap((node) => {
    const relPath = toRelPath(node.path, root, sep);
    if (relPath === null) return [];
    if (!node.children) return [{ ...node, path: relPath }];
    return [{ ...node, path: relPath, children: relativizeTree(node.children, root, sep) }];
  });
}
```

- [ ] **Step 4: Run the tests to see them pass**

Run: `npm test -- src/lib/libraryPath.test.ts`
Expected: PASS, including the 4 new `relativizeTree` cases.

- [ ] **Step 5: Commit**

```sh
git add src/lib/libraryPath.ts src/lib/libraryPath.test.ts
git commit -m "feat(tauri): convert scanned trees to rel_path snapshots"
```

---

### Task 4: Sharing lifecycle

**Files:**
- Modify: `src/lib/platform.ts`
- Create: `src/lib/sharing.ts`

**Interfaces:**
- Consumes:
  - `startServer`, `stopServer`, `setServerLibraries` (plan 3)
  - `getSupabase`, `supabaseConfigured` (plan 2)
  - `Account`, `currentAccount`, `onAccountChange` (plan 2)
  - `upsertLibrary` (plan 2)
  - `Recents.pathFor` (plan 1), `SEP` (plan 1), `relativizeTree` (Task 3)
  - the `tunnel_*` commands (Tasks 1–2)
- Produces:
  - `enableSharing`, `disableSharing`, `isSharing`, `setOnWeb`, `publishTree` (from the index)
  - `subscribeSharing`, `sharingAccount`, `onWebLibraries`, `trackAccount` (extensions)
  - `TunnelStatus`, `tunnelStatus`, `installTunnel`, `startTunnel`, `stopTunnel` (extensions)

This task is wiring with no pure logic left (Task 3 covers that), so it is checked with the type-checker and in Task 8's manual run.

- [ ] **Step 1: Add the tunnel bridge to `platform.ts`**

Append to `src/lib/platform.ts`:

```ts
export type TunnelStatus = {
  installed: boolean;
  source: "path" | "bundled" | null;
  downloadBytes: number;
};

const DESKTOP_ONLY = "Web access needs the desktop app";

export function tunnelStatus(): Promise<TunnelStatus> {
  if (!isTauri) return Promise.reject(new Error(DESKTOP_ONLY));
  return invoke("tunnel_status");
}

export function installTunnel(): Promise<void> {
  if (!isTauri) return Promise.reject(new Error(DESKTOP_ONLY));
  return invoke("tunnel_install");
}

export function startTunnel(): Promise<string> {
  if (!isTauri) return Promise.reject(new Error(DESKTOP_ONLY));
  return invoke("tunnel_start");
}

export function stopTunnel(): Promise<void> {
  if (!isTauri) return Promise.resolve();
  return invoke("tunnel_stop");
}
```

- [ ] **Step 2: Create `sharing.ts`**

Create `src/lib/sharing.ts`:

```ts
import { currentAccount, onAccountChange, type Account } from "@/lib/auth";
import { relativizeTree } from "@/lib/libraryPath";
import {
  SEP,
  isTauri,
  pathExists,
  scanFolder,
  setServerLibraries,
  startServer,
  startTunnel,
  stopServer,
  stopTunnel,
  tunnelStatus,
  type FileNode,
} from "@/lib/platform";
import { Recents } from "@/lib/store";
import { getSupabase, supabaseConfigured } from "@/lib/supabase";
import { upsertLibrary } from "@/lib/sync";

const HEARTBEAT_MS = 60_000;

// Module state is replaced, never mutated, so the getters below work as
// useSyncExternalStore snapshots.
let account: Account | null = null;
let onWeb: ReadonlySet<string> = new Set();
let tunnelUrl: string | null = null;
let heartbeat: ReturnType<typeof setInterval> | null = null;
const listeners = new Set<() => void>();

function changed() {
  for (const listener of listeners) listener();
}

export function subscribeSharing(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function sharingAccount(): Account | null {
  return account;
}

export function onWebLibraries(): ReadonlySet<string> {
  return onWeb;
}

export function isSharing(): boolean {
  return tunnelUrl !== null;
}

function now() {
  return new Date().toISOString();
}

function folderName(root: string) {
  return root.split(/[\\/]/).filter(Boolean).pop() ?? root;
}

function withMember(set: ReadonlySet<string>, id: string, member: boolean): ReadonlySet<string> {
  const next = new Set(set);
  if (member) next.add(id);
  else next.delete(id);
  return next;
}

function sharedLibraries(): { id: string; root: string }[] {
  return [...onWeb].flatMap((id) => {
    const root = Recents.pathFor(id);
    return root ? [{ id, root }] : [];
  });
}

async function requireOk(query: PromiseLike<{ error: unknown }>) {
  const { error } = await query;
  if (error) throw error;
}

async function publishHost() {
  if (!account || !tunnelUrl) return;
  const supabase = await getSupabase();
  await requireOk(
    supabase
      .from("hosts")
      .upsert(
        { owner_id: account.userId, url: tunnelUrl, updated_at: now() },
        { onConflict: "owner_id" }
      )
  );
}

async function deleteHost(ownerId: string) {
  const supabase = await getSupabase();
  await requireOk(supabase.from("hosts").delete().eq("owner_id", ownerId));
}

async function deleteTree(libraryId: string) {
  const supabase = await getSupabase();
  await requireOk(supabase.from("library_trees").delete().eq("library_id", libraryId));
}

async function loadOnWeb(owner: Account): Promise<ReadonlySet<string>> {
  const supabase = await getSupabase();
  const { data, error } = await supabase
    .from("libraries")
    .select("id")
    .eq("owner_id", owner.userId)
    .eq("on_web", true);
  if (error) throw error;
  return new Set((data ?? []).map((row: { id: string }) => row.id));
}

async function publishTreeFromDisk(libraryId: string) {
  const root = Recents.pathFor(libraryId);
  if (!root || !(await pathExists(root))) return;
  await publishTree(libraryId, await scanFolder(root), root);
}

export async function publishTree(
  libraryId: string,
  roots: FileNode[],
  root: string
): Promise<void> {
  // Folder and file names leave the machine only for libraries the owner shared.
  if (!onWeb.has(libraryId)) return;
  const supabase = await getSupabase();
  await requireOk(
    supabase
      .from("library_trees")
      .upsert(
        { library_id: libraryId, tree: relativizeTree(roots, root, SEP), scanned_at: now() },
        { onConflict: "library_id" }
      )
  );
}

export async function enableSharing(owner: Account): Promise<string> {
  const status = await tunnelStatus();
  if (!status.installed) throw new Error("cloudflared is not installed");
  account = owner;

  let url: string;
  try {
    await startServer(sharedLibraries());
    url = await startTunnel();
    tunnelUrl = url;
    await publishHost();
  } catch (e) {
    await disableSharing();
    throw e;
  }

  heartbeat = setInterval(() => {
    publishHost().catch((e) => console.error("host heartbeat failed", e));
  }, HEARTBEAT_MS);
  changed();
  for (const id of onWeb) {
    publishTreeFromDisk(id).catch((e) => console.error("publish tree failed", e));
  }
  return url;
}

export async function disableSharing(): Promise<void> {
  if (heartbeat) clearInterval(heartbeat);
  heartbeat = null;
  const wasPublished = tunnelUrl !== null;
  tunnelUrl = null;
  changed();

  const steps = [stopTunnel(), stopServer()];
  if (wasPublished && account) steps.push(deleteHost(account.userId));
  const results = await Promise.allSettled(steps);
  for (const result of results) {
    if (result.status === "rejected") console.error("disable sharing step failed", result.reason);
  }
}

export async function setOnWeb(libraryId: string, value: boolean): Promise<void> {
  if (!account) throw new Error("Sign in to make folders available on the web");
  const root = Recents.pathFor(libraryId);
  if (root) await upsertLibrary(libraryId, folderName(root));
  const supabase = await getSupabase();
  await requireOk(
    supabase.from("libraries").update({ on_web: value, updated_at: now() }).eq("id", libraryId)
  );
  onWeb = withMember(onWeb, libraryId, value);
  changed();

  if (isSharing()) await setServerLibraries(sharedLibraries());
  if (value) await publishTreeFromDisk(libraryId);
  else await deleteTree(libraryId);
}

async function applyAccount(next: Account | null) {
  if (!next) {
    if (isSharing()) await disableSharing();
    account = null;
    onWeb = new Set();
    changed();
    return;
  }
  account = next;
  changed();
  onWeb = await loadOnWeb(next);
  changed();
}

export function trackAccount(): () => void {
  if (!isTauri || !supabaseConfigured) return () => {};
  const report = (e: unknown) => console.error("sharing state failed", e);
  currentAccount().then(applyAccount).catch(report);
  const unsubscribe = onAccountChange((next) => {
    applyAccount(next).catch(report);
  });
  // Best effort: the webview may be gone before the request completes. A row
  // that survives goes stale after 180 s and the web treats the PC as offline.
  const onUnload = () => {
    void disableSharing();
  };
  window.addEventListener("beforeunload", onUnload);
  return () => {
    unsubscribe();
    window.removeEventListener("beforeunload", onUnload);
  };
}
```

- [ ] **Step 3: Type-check**

Run: `npx tsc -p tsconfig.app.json --noEmit`
Expected: no errors.

- [ ] **Step 4: Commit**

```sh
git add src/lib/platform.ts src/lib/sharing.ts
git commit -m "feat(tauri): publish tunnel host and tree snapshots while sharing"
```

---

### Task 5: Web access control in the header

**Files:**
- Modify: `src/vite-env.d.ts`
- Create: `src/components/SharingControl.tsx`
- Modify: `src/components/AppHeader.tsx`

**Interfaces:**
- Consumes: `enableSharing`, `disableSharing`, `isSharing`, `sharingAccount`, `subscribeSharing` (Task 4); `tunnelStatus`, `installTunnel` (Task 4); `VITE_WEB_ORIGIN`
- Produces: `SharingControl(): JSX.Element | null`

- [ ] **Step 1: Type the web origin**

Append to `src/vite-env.d.ts` (plan 2 creates this file). If a `/// <reference types="vite/client" />` line is not already there, add it at the top. The interface merges with any `ImportMetaEnv` block plan 2 declared:

```ts
interface ImportMetaEnv {
  readonly VITE_WEB_ORIGIN?: string;
}
```

For local runs, add `VITE_WEB_ORIGIN=http://localhost:1420` to `tauri/.env.local`, next to plan 2's Supabase variables. The file is not committed.

- [ ] **Step 2: Create the component**

Create `src/components/SharingControl.tsx`:

```tsx
import { useState, useSyncExternalStore } from "react";
import { Check, Copy, Globe, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { installTunnel, tunnelStatus } from "@/lib/platform";
import {
  disableSharing,
  enableSharing,
  isSharing,
  sharingAccount,
  subscribeSharing,
} from "@/lib/sharing";

const WEB_ORIGIN = import.meta.env.VITE_WEB_ORIGIN ?? "";

type Phase =
  | { kind: "off" }
  | { kind: "confirm"; downloadBytes: number }
  | { kind: "installing"; downloadBytes: number }
  | { kind: "starting" }
  | { kind: "on" }
  | { kind: "error"; message: string };

function megabytes(bytes: number) {
  return `${Math.round(bytes / 1_000_000)} MB`;
}

function errorMessage(e: unknown) {
  if (typeof e === "string") return e;
  if (e && typeof e === "object" && "message" in e) return String(e.message);
  return "Something went wrong";
}

export function SharingControl() {
  const account = useSyncExternalStore(subscribeSharing, sharingAccount);
  const sharing = useSyncExternalStore(subscribeSharing, isSharing);
  const [phase, setPhase] = useState<Phase>(() =>
    isSharing() ? { kind: "on" } : { kind: "off" }
  );
  const [copied, setCopied] = useState(false);

  if (!account) return null;

  // Sign-out and page reloads stop sharing outside this component.
  const current: Phase = phase.kind === "on" && !sharing ? { kind: "off" } : phase;
  const pendingDownload = current.kind === "confirm" ? current.downloadBytes : 0;

  const fail = (e: unknown) => setPhase({ kind: "error", message: errorMessage(e) });

  const start = async () => {
    setPhase({ kind: "starting" });
    try {
      await enableSharing(account);
      setPhase({ kind: "on" });
    } catch (e) {
      fail(e);
    }
  };

  const install = async (downloadBytes: number) => {
    setPhase({ kind: "installing", downloadBytes });
    try {
      await installTunnel();
    } catch (e) {
      fail(e);
      return;
    }
    await start();
  };

  const turnOn = async () => {
    try {
      const status = await tunnelStatus();
      if (status.installed) return await start();
      // No pinned build for this platform: let the install call report why.
      if (status.downloadBytes === 0) return await install(0);
      setPhase({ kind: "confirm", downloadBytes: status.downloadBytes });
    } catch (e) {
      fail(e);
    }
  };

  const turnOff = async () => {
    await disableSharing();
    setPhase({ kind: "off" });
  };

  const copyLink = async () => {
    await navigator.clipboard.writeText(WEB_ORIGIN);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <>
      <StatusButton
        phase={current}
        onTurnOn={() => void turnOn()}
        onTurnOff={() => void turnOff()}
      />

      {current.kind === "on" && WEB_ORIGIN && (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              onClick={() => void copyLink()}
              aria-label="Copy web link"
              className="text-muted-foreground"
            >
              {copied ? <Check className="size-[18px]" /> : <Copy className="size-[18px]" />}
            </Button>
          </TooltipTrigger>
          <TooltipContent>{copied ? "Copied" : WEB_ORIGIN}</TooltipContent>
        </Tooltip>
      )}

      <Dialog
        open={current.kind === "confirm"}
        onOpenChange={(open) => !open && setPhase({ kind: "off" })}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Download cloudflared?</DialogTitle>
            <DialogDescription>
              Web access streams your videos through a Cloudflare tunnel, and
              the tunnel program isn’t installed yet. The app will download
              cloudflared ({megabytes(pendingDownload)}) from Cloudflare’s
              GitHub releases and check it against a pinned checksum before
              running it.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="secondary" onClick={() => setPhase({ kind: "off" })}>
              Cancel
            </Button>
            <Button onClick={() => void install(pendingDownload)}>
              Download
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function StatusButton({
  phase,
  onTurnOn,
  onTurnOff,
}: {
  phase: Phase;
  onTurnOn: () => void;
  onTurnOff: () => void;
}) {
  switch (phase.kind) {
    case "installing":
      return (
        <Button variant="ghost" size="sm" disabled>
          <Loader2 className="animate-spin" />
          Downloading cloudflared ({megabytes(phase.downloadBytes)})…
        </Button>
      );
    case "starting":
      return (
        <Button variant="ghost" size="sm" disabled>
          <Loader2 className="animate-spin" />
          Starting web access…
        </Button>
      );
    case "on":
      return (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="sm" onClick={onTurnOff} className="text-primary">
              <Globe />
              Web access on
            </Button>
          </TooltipTrigger>
          <TooltipContent>Turn off web access</TooltipContent>
        </Tooltip>
      );
    case "error":
      return (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="sm" onClick={onTurnOn} className="text-destructive">
              <Globe />
              Web access failed · Retry
            </Button>
          </TooltipTrigger>
          <TooltipContent className="max-w-80">{phase.message}</TooltipContent>
        </Tooltip>
      );
    default:
      return (
        <Button variant="ghost" size="sm" onClick={onTurnOn} className="text-muted-foreground">
          <Globe />
          Web access
        </Button>
      );
  }
}
```

- [ ] **Step 3: Render it in the header**

In `src/components/AppHeader.tsx`, add the import:

```tsx
import { SharingControl } from "@/components/SharingControl";
```

and make `<SharingControl />` the first child of the right-hand group:

```tsx
      <div className="ml-auto flex items-center gap-1">
        <SharingControl />
        <Tooltip>
```

(If plan 2 put an account menu in that group, keep `SharingControl` before it.)

- [ ] **Step 4: Type-check and build**

Run: `npx tsc -p tsconfig.app.json --noEmit && npm run build`
Expected: no type errors and a Vite build with no warnings.

- [ ] **Step 5: Commit**

```sh
git add src/vite-env.d.ts src/components/SharingControl.tsx src/components/AppHeader.tsx
git commit -m "feat(tauri): add web access switch to the header"
```

---

### Task 6: "Available on web" toggle on recent folders

**Files:**
- Modify: `src/components/Home.tsx`

**Interfaces:**
- Consumes: `setOnWeb`, `onWebLibraries`, `sharingAccount`, `subscribeSharing` (Task 4); `Recents.libraryIdFor` (plan 1); `ContextMenuCheckboxItem` (already in `src/components/ui/context-menu.tsx`)
- Produces: new `RecentCard` props `canShare: boolean`, `onWeb: boolean`, `onToggleWeb: (value: boolean) => void`

- [ ] **Step 1: Wire the sharing state into `Home`**

In `src/components/Home.tsx`, change the React import to:

```tsx
import { useEffect, useState, useSyncExternalStore } from "react";
```

add `ContextMenuCheckboxItem` to the `@/components/ui/context-menu` import, and add:

```tsx
import {
  onWebLibraries,
  setOnWeb,
  sharingAccount,
  subscribeSharing,
} from "@/lib/sharing";
```

Inside `Home`, right after `const [dialog, setDialog] = useState<DialogState>(null);`, add:

```tsx
  const account = useSyncExternalStore(subscribeSharing, sharingAccount);
  const shared = useSyncExternalStore(subscribeSharing, onWebLibraries);

  const toggleWeb = (folder: RecentFolder, value: boolean) => {
    setOnWeb(Recents.libraryIdFor(folder.path), value).catch((e) =>
      console.error("toggle web access failed", e)
    );
  };
```

Pass the new props where `RecentCard` is rendered:

```tsx
            <RecentCard
              key={folder.id}
              folder={folder}
              canShare={account !== null}
              onWeb={shared.has(Recents.libraryIdFor(folder.path))}
              onOpen={() => void openFolder(folder)}
              onReveal={() => void revealInFinder(folder.path)}
              onRemove={() => requestRemove(folder)}
              onToggleWeb={(value) => toggleWeb(folder, value)}
            />
```

- [ ] **Step 2: Add the menu item to `RecentCard`**

Change the `RecentCard` signature to:

```tsx
function RecentCard({
  folder,
  canShare,
  onWeb,
  onOpen,
  onReveal,
  onRemove,
  onToggleWeb,
}: {
  folder: RecentFolder;
  canShare: boolean;
  onWeb: boolean;
  onOpen: () => void;
  onReveal: () => void;
  onRemove: () => void;
  onToggleWeb: (value: boolean) => void;
}) {
```

and insert the checkbox between "Reveal in file manager" and the separator. Turning sharing off stays possible when the disk is missing:

```tsx
        <ContextMenuItem disabled={!available} onClick={onReveal}>
          Reveal in file manager
        </ContextMenuItem>
        {canShare && (
          <ContextMenuCheckboxItem
            checked={onWeb}
            disabled={!available && !onWeb}
            onCheckedChange={onToggleWeb}
          >
            Available on web
          </ContextMenuCheckboxItem>
        )}
        <ContextMenuSeparator />
```

- [ ] **Step 3: Type-check**

Run: `npx tsc -p tsconfig.app.json --noEmit`
Expected: no errors.

- [ ] **Step 4: Commit**

```sh
git add src/components/Home.tsx
git commit -m "feat(tauri): toggle web availability from recent folders"
```

---

### Task 7: App wiring and dev hook removal

**Files:**
- Modify: `src/App.tsx`
- Modify: the file holding plan 3's dev-only server hook (see Step 3)

**Interfaces:**
- Consumes: `trackAccount`, `isSharing`, `publishTree` (Task 4); `Recents.libraryIdFor` (plan 1)
- Produces: nothing new

- [ ] **Step 1: Track the account for sharing**

In `src/App.tsx`, add:

```tsx
import { isSharing, publishTree, trackAccount } from "@/lib/sharing";
```

and next to the other mount-only effects (just above the `onFolderDrop` effect):

```tsx
  useEffect(() => trackAccount(), []);
```

- [ ] **Step 2: Publish the snapshot after a scan**

In `openFolder`, right after `Recents.record(path, name);`, add:

```tsx
      if (isSharing()) {
        publishTree(Recents.libraryIdFor(path), tree, path).catch((e) =>
          console.error("publish tree failed", e)
        );
      }
```

`publishTree` returns without a request when the library is not `on_web`.

- [ ] **Step 3: Remove plan 3's dev-only hook**

Plan 3 left a development-only `window` property (guarded by `import.meta.env.DEV`) that calls `startServer` so the server could be tested before this UI existed. Find it:

Run: `grep -rn "import.meta.env.DEV" src`
Expected: one block that assigns a function calling `startServer` onto `window` (in `src/main.tsx` or `src/lib/platform.ts`), plus its `declare global` / `Window` typing if plan 3 added one.

Delete that block and its typing, plus any import that becomes unused because of the deletion. Then confirm nothing else references it:

Run: `grep -rn "startServer" src`
Expected: matches only in `src/lib/platform.ts` (the definition) and `src/lib/sharing.ts`.

- [ ] **Step 4: Type-check, test and build**

Run: `npx tsc -p tsconfig.app.json --noEmit && npm test && npm run build`
Expected: no type errors, all vitest suites pass, and the Vite build has no warnings.

- [ ] **Step 5: Commit**

```sh
git add -u src
git commit -m "feat(tauri): publish snapshots on scan and drop dev server hook"
```

---

### Task 8: Manual verification

**Files:** none (verification only)

**Interfaces:**
- Consumes: everything above plus plan 2's local Supabase (`npx supabase start`) and plan 3's server

- [ ] **Step 1: Full automated pass**

Run: `cargo test --manifest-path src-tauri/Cargo.toml && cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets && npm test && npx tsc -p tsconfig.app.json --noEmit && npm run build`
Expected: everything passes and nothing new warns.

- [ ] **Step 2: Start with no cloudflared anywhere**

- `which cloudflared` prints nothing. If it prints a path, start the app with a `PATH` that leaves that directory out.
- Delete the bundled copy: `rm -f "$HOME/Library/Application Support/com.lucasduarte.videoplaylistplayer.tauri/bin/cloudflared"`. On Windows the copy is `%APPDATA%\com.lucasduarte.videoplaylistplayer.tauri\bin\cloudflared.exe`; on Linux it is `~/.local/share/com.lucasduarte.videoplaylistplayer.tauri/bin/cloudflared`.
- `npx supabase start`, then `npm run tauri dev`.

- [ ] **Step 3: Signed out means no UI and no network**

With the app signed out: the header shows no "Web access" button, and the Home context menu has no "Available on web" item.

- [ ] **Step 4: Confirm and download**

1. Sign in (plan 2 flow) and click **Web access**.
2. The dialog reads "cloudflared (19 MB)" on macOS arm64 (55 MB on Windows). Cancel returns the button to "Web access" with nothing downloaded.
3. Click again, then **Download**. The button shows "Downloading cloudflared (19 MB)…", then "Starting web access…", then "Web access on".
4. The bundled path from Step 2 now exists, has mode `-rwxr-xr-x`, and running it with `--version` prints `2026.9.1`. No `*.part` file is left in that `bin` directory.

- [ ] **Step 5: Host row and tunnel**

1. In Studio (`http://127.0.0.1:54323`), `hosts` has one row with your `owner_id`, an `https://…trycloudflare.com` URL and a fresh `updated_at`.
2. After a little over a minute, `updated_at` has moved forward (heartbeat).
3. `curl -s https://<that-host>/health` prints `{"ok":true}`. DNS for a new quick tunnel can take a few seconds.
4. Hover the copy button: the tooltip shows `VITE_WEB_ORIGIN`. Clicking it puts that origin on the clipboard.

- [ ] **Step 6: on_web and snapshots**

1. Right-click a recent folder and tick **Available on web**. `libraries.on_web` is `true` for that id, and `library_trees` has a row whose `tree` paths are relative and `/`-separated (no leading `/`, no drive letter).
2. Open that folder. `library_trees.scanned_at` updates.
3. Open a folder that is not on web. No `library_trees` row appears for it.
4. Untick the item. The `library_trees` row is gone and `on_web` is `false`.

- [ ] **Step 7: Turn off, sign out and quit**

1. Click **Web access on**. The `hosts` row is gone, `curl https://<that-host>/health` fails, and `pgrep -fl cloudflared` prints nothing.
2. Turn web access on again, then sign out. The button disappears, the `hosts` row is deleted or goes stale within 180 s, and `pgrep -fl cloudflared` prints nothing.
3. Turn web access on again, then quit the app with Cmd+Q. `pgrep -fl cloudflared` prints nothing (the `RunEvent::Exit` kill).

- [ ] **Step 8: PATH reuse**

Put a `cloudflared` on `PATH` (for example `brew install cloudflared`) and delete the bundled copy. Start the app from a terminal so it inherits that `PATH`. "Web access" goes straight to "Starting…" with no dialog.

- [ ] **Step 9: Tamper test**

1. Delete the bundled copy again and make sure no `cloudflared` is on `PATH`.
2. In `install.rs`, change one hex character of this platform's `sha256`. The format test still passes as long as the character stays in `0-9a-f`.
3. Run `npm run tauri dev`, then click **Web access** and **Download**.
4. The button shows "Web access failed · Retry", and its tooltip reads "the downloaded cloudflared does not match its pinned checksum and was discarded".
5. The `bin` directory holds neither `cloudflared` nor a `*.part` file.
6. `git checkout src-tauri/src/tunnel/install.rs` to restore the hash.

- [ ] **Step 10: Timeout path**

Temporarily disconnect from the network, keeping a `cloudflared` available, and turn on web access. Within about 30 s the button shows the error state with "cloudflared exited before reporting a tunnel URL" or "…within 30 seconds". `pgrep -fl cloudflared` prints nothing, and the PC server is stopped: `curl http://127.0.0.1:8787/health` fails.

---

## Self-review

### Spec coverage

| Spec requirement | Task |
|---|---|
| Reuse `cloudflared` from `PATH` | 1 (`find_on_path`), 8.8 |
| Otherwise ask before downloading, showing the size | 1 (`download_bytes`), 5 (confirm dialog), 8.4 |
| Download into `app_data_dir/bin/` | 1 (`bundled_path`) |
| Version pinned in code (`2026.9.1`) | 1 (`CLOUDFLARED_VERSION`) |
| Per-platform SHA-256 pinned alongside it | 1 (`ASSETS`) |
| Mismatched download deleted, never executed | 1 (in-memory check before write), 8.9 |
| Never download `latest` | 1 (fixed release URL) |
| Publish tunnel URL to `hosts` | 4 (`publishHost`), 8.5 |
| Heartbeat every 60 s | 4 (`HEARTBEAT_MS`), 8.5 |
| Clean shutdown deletes the row | 4 (`disableSharing`), 8.7 |
| Tunnel process killed on stop and app exit | 2 (`tunnel_stop`, `RunEvent::Exit`), 8.7 |
| URL public while it lives; protection comes from the server | unchanged, relies on plan 3; checked in 8.5 via `/health` only |
| `on_web` toggle | 4 (`setOnWeb`), 6, 8.6 |
| Snapshots only for `on_web` libraries | 4 (guard in `publishTree`), 8.6 |
| Snapshot refreshed on scan | 7, 8.6 |
| `rel_path` `/`-separated, Windows normalised | 3 |
| Server starts only while sharing (lifecycle) | 4 (`startServer` in `enableSharing`, `stopServer` in `disableSharing`) |
| Signed-out user: no UI, no socket, no request | 4 (`trackAccount` guard), 5, 6, 8.3 |
| Remove plan 3's dev-only window hook | 7.3 |
| Tests: tunnel URL parser, asset selection, SHA-256 | 1, 2 |
| Tests: FileNode → `rel_path` conversion | 3 |

### Contract check

- Rust commands match the index: `tunnel_status() -> TunnelStatus`, `tunnel_install() -> Result<(), String>`, `tunnel_start() -> Result<String, String>`, `tunnel_stop()`.
- `TunnelStatus { installed, source: Option<String>, download_bytes }` uses `rename_all = "camelCase"`. `source` is `"path"` or `"bundled"`.
- `sharing.ts` exports match the index exactly:
  - `enableSharing(account: Account): Promise<string>`
  - `disableSharing(): Promise<void>`
  - `isSharing(): boolean`
  - `setOnWeb(libraryId: string, onWeb: boolean): Promise<void>` (the parameter is named `value` so it doesn't shadow the module's `onWeb` set; the signature is the same)
  - `publishTree(libraryId: string, roots: FileNode[], root: string): Promise<void>`
- Consumed names are used as the index defines them:
  - plan 1: `Recents.libraryIdFor`, `Recents.pathFor`, `toRelPath`, `SEP`
  - plan 2: `getSupabase`, `supabaseConfigured`, `Account`, `currentAccount`, `onAccountChange`, `upsertLibrary`
  - plan 3: `startServer`, `stopServer`, `setServerLibraries`
- SQL columns are used as the index defines them:
  - `libraries.id`, `owner_id`, `on_web`, `updated_at`
  - `library_trees.library_id`, `tree`, `scanned_at`
  - `hosts.owner_id`, `url`, `updated_at`
- Extensions are listed under "Contract extensions" above. Plan 5 may rely on `relativizeTree`, `subscribeSharing`, `sharingAccount` and `onWebLibraries`.
