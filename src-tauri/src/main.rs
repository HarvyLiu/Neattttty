#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::collections::HashMap;

#[derive(serde::Serialize)]
struct AiFetchResponse {
    status: u16,
    body: String,
}

/// Server-side HTTP relay for AI providers.
///
/// Browsers/WebViews block cross-origin API calls when the provider doesn't
/// send CORS headers (e.g. OpenCode Zen) — the page would just see
/// "Failed to fetch". The Rust backend has no such restriction, so the
/// desktop app relays provider requests through here. API keys still live
/// only on the user's machine and are sent straight to the chosen provider.
#[tauri::command]
async fn ai_fetch(
    url: String,
    headers: HashMap<String, String>,
    body: Option<String>,
) -> Result<AiFetchResponse, String> {
    if !(url.starts_with("https://") || url.starts_with("http://localhost") || url.starts_with("http://127.")) {
        return Err("refusing non-HTTPS (or non-loopback) AI endpoint".to_string());
    }
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(120))
        .build()
        .map_err(|e| e.to_string())?;
    let mut req = client.post(&url);
    for (k, v) in headers {
        req = req.header(k, v);
    }
    if let Some(b) = body {
        req = req.body(b);
    }
    let resp = req
        .send()
        .await
        .map_err(|e| format!("network error: {e}"))?;
    let status = resp.status().as_u16();
    let text = resp.text().await.map_err(|e| e.to_string())?;
    Ok(AiFetchResponse { status, body: text })
}

fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![ai_fetch])
        .run(tauri::generate_context!())
        .expect("error while running Neattttty");
}
