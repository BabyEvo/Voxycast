
#[cfg(windows)]
use std::sync::mpsc;

#[cfg(windows)]
use std::time::Duration;

#[cfg(windows)]
use webview2_com::{
    Microsoft::Web::WebView2::Win32::{
        ICoreWebView2_13,
        ICoreWebView2Profile4,
        COREWEBVIEW2_PERMISSION_KIND_MICROPHONE,
        COREWEBVIEW2_PERMISSION_STATE_DEFAULT,
    },
    SetPermissionStateCompletedHandler,
};

#[cfg(windows)]
use windows::core::{HSTRING, Interface};

// Reset only the microphone permission for this WebView's origin.
// No profile folders or application settings are deleted.
#[cfg(windows)]
#[tauri::command]
async fn reset_microphone_permission(
    window: tauri::WebviewWindow,
) -> Result<(), String> {
    // Use the real current origin, rather than assuming that
    // development and production builds use the same URL.
    let origin = window
        .url()
        .map_err(|e| format!("Cannot read WebView URL: {e}"))?
        .origin()
        .ascii_serialization();

    if origin == "null" {
        return Err(
            "The current WebView has no valid origin.".into()
        );
    }

    let (tx, rx) = mpsc::channel::<Result<(), String>>();

    window
        .with_webview(move |webview| {
            let result = (|| -> Result<(), String> {
                unsafe {
                    // Obtain the running WebView2 instance.
                    let core = webview
                        .controller()
                        .CoreWebView2()
                        .map_err(|e| e.to_string())?;

                    // The profile API is exposed by a newer
                    // CoreWebView2 interface.
                    let core13: ICoreWebView2_13 = core
                        .cast()
                        .map_err(|e| e.to_string())?;

                    let profile = core13
                        .Profile()
                        .map_err(|e| e.to_string())?;

                    let profile4: ICoreWebView2Profile4 =
                        profile
                            .cast()
                            .map_err(|e| e.to_string())?;

                    let completion_tx = tx.clone();

                    let handler =
                        SetPermissionStateCompletedHandler::create(
                            Box::new(move |status| {
                                let result = if status.is_ok() {
                                    Ok(())
                                } else {
                                    Err(format!(
                                        "WebView2 returned {status:?}"
                                    ))
                                };

                                let _ = completion_tx.send(result);
                                Ok(())
                            }),
                        );

                    let origin = HSTRING::from(origin);

                    profile4
                        .SetPermissionState(
                            COREWEBVIEW2_PERMISSION_KIND_MICROPHONE,
                            &origin,
                            COREWEBVIEW2_PERMISSION_STATE_DEFAULT,
                            &handler,
                        )
                        .map_err(|e| e.to_string())?;
                }

                Ok(())
            })();

            if let Err(error) = result {
                let _ = tx.send(Err(error));
            }
        })
        .map_err(|e| format!("Cannot access WebView2: {e}"))?;

    // The WebView2 callback is asynchronous. Wait off the
    // UI thread so the callback can complete.
    tauri::async_runtime::spawn_blocking(move || {
        rx.recv_timeout(Duration::from_secs(10))
            .map_err(|_| {
                "Timed out waiting for WebView2.".to_string()
            })?
    })
    .await
    .map_err(|e| format!("Permission task failed: {e}"))?
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init());

    #[cfg(windows)]
    let builder = builder.invoke_handler(
        tauri::generate_handler![reset_microphone_permission]
    );

    builder
        .run(tauri::generate_context!())
        .expect("error while running VoxyCast");
}
