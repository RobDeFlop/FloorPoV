use std::sync::Mutex;
use tauri::AppHandle;
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};

use std::sync::LazyLock;

static CURRENT_HOTKEY: LazyLock<Mutex<Option<String>>> = LazyLock::new(|| Mutex::new(None));

#[tauri::command]
pub async fn register_marker_hotkey(app_handle: AppHandle, hotkey: String) -> Result<(), String> {
    if hotkey == "none" {
        return Ok(());
    }

    let mut current = CURRENT_HOTKEY.lock().map_err(|e| e.to_string())?;

    if let Some(old_hotkey) = current.as_ref() {
        if let Err(e) = app_handle.global_shortcut().unregister(old_hotkey.as_str()) {
            tracing::warn!("Failed to unregister old hotkey '{}': {}", old_hotkey, e);
        }
    }

    let app_handle_clone = app_handle.clone();
    let hotkey_str = hotkey.as_str();

    app_handle
        .global_shortcut()
        .register(hotkey_str)
        .map_err(|e| format!("Failed to register hotkey '{}': {}. This key might already be in use by another application.", hotkey, e))?;

    app_handle
        .global_shortcut()
        .on_shortcut(hotkey_str, move |_app, _shortcut, event| {
            if event.state == ShortcutState::Pressed {
                let handle = app_handle_clone.clone();
                tauri::async_runtime::spawn(async move {
                    let _ = crate::combat_log::watch::emit_manual_marker(handle).await;
                });
            }
        })
        .map_err(|e| {
            let _ = app_handle.global_shortcut().unregister(hotkey_str);
            format!("Failed to set hotkey handler: {}", e)
        })?;

    *current = Some(hotkey);

    Ok(())
}

#[tauri::command]
pub async fn unregister_marker_hotkey(app_handle: AppHandle) -> Result<(), String> {
    let mut current = CURRENT_HOTKEY.lock().map_err(|e| e.to_string())?;

    if let Some(hotkey) = current.take() {
        app_handle
            .global_shortcut()
            .unregister(hotkey.as_str())
            .map_err(|e| format!("Failed to unregister hotkey: {}", e))?;
    }

    Ok(())
}
