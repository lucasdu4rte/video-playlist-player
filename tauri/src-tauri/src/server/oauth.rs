use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::extract::{Query, State};
use axum::response::Html;
use axum::routing::get;
use axum::Router;
use tokio::net::TcpListener;
use tokio::sync::oneshot;

// Supabase only redirects to exact allowlisted URLs, so the port cannot float.
const CALLBACK_ADDR: &str = "127.0.0.1:8787";

const DONE_PAGE: &str = r#"<!doctype html>
<meta charset="utf-8">
<title>Signed in</title>
<body style="font-family: system-ui; text-align: center; padding-top: 20vh">
  <h1>You can close this tab</h1>
  <p>Return to Video Playlist Player.</p>
</body>"#;

type Outcome = Result<String, String>;
type PendingCode = Arc<Mutex<Option<oneshot::Sender<Outcome>>>>;

pub async fn await_oauth_code(timeout: Duration) -> Result<String, String> {
    let listener = TcpListener::bind(CALLBACK_ADDR).await.map_err(|_| {
        "Port 8787 is already in use. Close the program using it and try again.".to_string()
    })?;
    let (code_tx, code_rx) = oneshot::channel();
    let (stop_tx, stop_rx) = oneshot::channel::<()>();
    let pending: PendingCode = Arc::new(Mutex::new(Some(code_tx)));
    let app = Router::new()
        .route("/auth/callback", get(callback))
        .with_state(pending);
    let mut server = tokio::spawn(async move {
        let _ = axum::serve(listener, app)
            .with_graceful_shutdown(async {
                let _ = stop_rx.await;
            })
            .await;
    });

    let outcome = tokio::time::timeout(timeout, code_rx).await;
    let _ = stop_tx.send(());
    // Bounded so a client that never closes its connection cannot keep the port
    // held; abort outright if graceful shutdown doesn't finish in time, so the
    // listener is guaranteed to be dropped before this function returns.
    if tokio::time::timeout(Duration::from_secs(2), &mut server)
        .await
        .is_err()
    {
        server.abort();
        let _ = server.await;
    }

    match outcome {
        Ok(Ok(result)) => result,
        Ok(Err(_)) => Err("Sign-in was interrupted. Try again.".into()),
        Err(_) => Err("Sign-in timed out. Try again.".into()),
    }
}

async fn callback(
    State(pending): State<PendingCode>,
    Query(params): Query<HashMap<String, String>>,
) -> Html<&'static str> {
    let error = params.get("error_description").or(params.get("error"));
    let outcome = match (params.get("code"), error) {
        (Some(code), _) => Ok(code.clone()),
        (None, Some(error)) => Err(format!("Sign-in failed: {error}")),
        (None, None) => Err("Sign-in failed: the callback carried no code.".into()),
    };
    if let Some(sender) = pending.lock().unwrap().take() {
        let _ = sender.send(outcome);
    }
    Html(DONE_PAGE)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpStream;

    async fn get_page(path: &str) -> String {
        let mut stream = TcpStream::connect(CALLBACK_ADDR).await.unwrap();
        let request = format!("GET {path} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n");
        stream.write_all(request.as_bytes()).await.unwrap();
        let mut response = String::new();
        stream.read_to_string(&mut response).await.unwrap();
        response
    }

    // A single test so the phases never race each other for the fixed port.
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

        // A connection stuck mid-request must not keep the port bound past
        // the graceful-shutdown bound: it gets aborted instead.
        let waiting = tokio::spawn(await_oauth_code(Duration::from_secs(5)));
        tokio::time::sleep(Duration::from_millis(100)).await;
        let mut stuck = TcpStream::connect(CALLBACK_ADDR).await.unwrap();
        stuck
            .write_all(b"GET /auth/callback?code=stuck HTTP/1.1\r\nHost: 127.0.0.1\r\n")
            .await
            .unwrap();
        get_page("/auth/callback?code=released").await;
        assert_eq!(waiting.await.unwrap(), Ok("released".to_string()));
        TcpListener::bind(CALLBACK_ADDR).await.unwrap();
        drop(stuck);

        let _busy = TcpListener::bind(CALLBACK_ADDR).await.unwrap();
        let error = await_oauth_code(Duration::from_secs(1)).await.unwrap_err();
        assert!(error.contains("8787"));
    }
}
