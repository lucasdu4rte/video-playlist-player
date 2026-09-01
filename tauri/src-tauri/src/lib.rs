use std::cmp::Ordering;
use std::path::{Path, PathBuf};

use serde::Serialize;
use tauri::Manager;

const VIDEO_EXTS: &[&str] = &[
    "mp4", "mov", "m4v", "avi", "mkv", "wmv", "ts", "mpg", "mpeg",
];

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Node {
    path: String,
    name: String,
    #[serde(rename = "type")]
    kind: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    children: Option<Vec<Node>>,
}

fn is_video(p: &Path) -> bool {
    p.extension()
        .and_then(|e| e.to_str())
        .map(|e| VIDEO_EXTS.contains(&e.to_lowercase().as_str()))
        .unwrap_or(false)
}

fn file_name(p: &Path) -> String {
    p.file_name()
        .and_then(|n| n.to_str())
        .unwrap_or_default()
        .to_string()
}

fn take_number<I: Iterator<Item = char>>(it: &mut std::iter::Peekable<I>) -> u128 {
    let mut n: u128 = 0;
    while let Some(&c) = it.peek() {
        match c.to_digit(10) {
            Some(d) => {
                n = n.saturating_mul(10).saturating_add(d as u128);
                it.next();
            }
            None => break,
        }
    }
    n
}

// ponytail: Finder-style natural order (numeric runs compared as numbers).
// Ceiling: numbers wider than u128 saturate; fine for filenames.
fn natural_cmp(a: &str, b: &str) -> Ordering {
    let a = a.to_lowercase();
    let b = b.to_lowercase();
    let mut ai = a.chars().peekable();
    let mut bi = b.chars().peekable();
    loop {
        match (ai.peek().copied(), bi.peek().copied()) {
            (None, None) => return Ordering::Equal,
            (None, _) => return Ordering::Less,
            (_, None) => return Ordering::Greater,
            (Some(ca), Some(cb)) => {
                if ca.is_ascii_digit() && cb.is_ascii_digit() {
                    match take_number(&mut ai).cmp(&take_number(&mut bi)) {
                        Ordering::Equal => continue,
                        o => return o,
                    }
                }
                match ca.cmp(&cb) {
                    Ordering::Equal => {
                        ai.next();
                        bi.next();
                    }
                    o => return o,
                }
            }
        }
    }
}

fn build_tree(dir: &Path) -> Vec<Node> {
    let mut paths: Vec<PathBuf> = match std::fs::read_dir(dir) {
        Ok(rd) => rd
            .filter_map(|e| e.ok())
            .map(|e| e.path())
            .filter(|p| !file_name(p).starts_with('.'))
            .collect(),
        Err(_) => return vec![],
    };
    paths.sort_by(|a, b| natural_cmp(&file_name(a), &file_name(b)));

    let mut out = Vec::new();
    for p in paths {
        if p.is_dir() {
            let children = build_tree(&p);
            if !children.is_empty() {
                out.push(Node {
                    path: p.to_string_lossy().into_owned(),
                    name: file_name(&p),
                    kind: "folder",
                    children: Some(children),
                });
            }
        } else if is_video(&p) {
            out.push(Node {
                path: p.to_string_lossy().into_owned(),
                name: file_name(&p),
                kind: "video",
                children: None,
            });
        }
    }
    out
}

#[tauri::command]
fn scan_folder(app: tauri::AppHandle, path: String) -> Vec<Node> {
    let root = PathBuf::from(&path);
    // Grant playback access to everything under the opened folder — the
    // web <video> loads files through the asset protocol, which is scoped.
    let _ = app.asset_protocol_scope().allow_directory(&root, true);
    build_tree(&root)
}

#[tauri::command]
fn path_exists(path: String) -> bool {
    Path::new(&path).is_dir()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![scan_folder, path_exists])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
