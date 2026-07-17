//! Owns the WarcraftLogs authentication lifecycle and in-memory HTTP session.

use std::sync::{Arc, Mutex};

use tauri::AppHandle;

use crate::wcl_upload::auth::{
    clear_saved_login, has_any_saved_login_credentials, read_saved_login_email,
    resolve_login_credentials, resolve_saved_login_for_email, save_login_credentials,
};
use crate::wcl_upload::core::WclSession;
use crate::wcl_upload::error::UploadError;
use crate::wcl_upload::types::{WclAuthState, WclAuthStatus, WclLoginRequest};

#[derive(Clone)]
pub(crate) struct AuthenticatedWclSession {
    pub session: WclSession,
    pub email: String,
    pub user_name: Option<String>,
}

#[derive(Clone)]
pub struct WclAuthService {
    session: Arc<Mutex<Option<AuthenticatedWclSession>>>,
}

impl WclAuthService {
    pub fn new() -> Self {
        Self {
            session: Arc::new(Mutex::new(None)),
        }
    }

    pub(crate) fn status(
        &self,
        app_handle: &AppHandle,
        email_to_check: Option<&str>,
    ) -> Result<WclAuthStatus, UploadError> {
        let current_session = self.current_session()?;
        let saved_email = read_saved_login_email(app_handle)?;
        let has_any_saved_credentials = has_any_saved_login_credentials(app_handle)?;
        let checked_email = email_to_check
            .map(str::trim)
            .filter(|email| !email.is_empty())
            .or_else(|| {
                current_session
                    .as_ref()
                    .map(|session| session.email.as_str())
            })
            .or(saved_email.as_deref());
        let has_saved_credentials_for_email = match checked_email {
            Some(email) => resolve_saved_login_for_email(app_handle, email)?.is_some(),
            None => false,
        };

        Ok(WclAuthStatus {
            status: if current_session.is_some() {
                WclAuthState::Authenticated
            } else {
                WclAuthState::SignedOut
            },
            authenticated_email: current_session
                .as_ref()
                .map(|session| session.email.clone()),
            user_name: current_session
                .as_ref()
                .and_then(|session| session.user_name.clone()),
            saved_email,
            has_any_saved_credentials,
            has_saved_credentials_for_email,
        })
    }

    pub(crate) fn login(
        &self,
        app_handle: &AppHandle,
        request: WclLoginRequest,
    ) -> Result<WclAuthStatus, UploadError> {
        let remember_login = request.remember_login.unwrap_or(false);
        let resolved = resolve_login_credentials(
            app_handle,
            request.email.trim(),
            request.password,
            request.use_saved_login.unwrap_or(false),
        )?;
        let session = WclSession::new(crate::wcl_upload::core::resolve_client_version())?;
        let user_name = session.login(&resolved.email, &resolved.password)?;

        if remember_login {
            save_login_credentials(app_handle, &resolved.email, &resolved.password)?;
        }

        self.replace_session(Some(AuthenticatedWclSession {
            session,
            email: resolved.email.clone(),
            user_name,
        }))?;
        self.status(app_handle, Some(&resolved.email))
    }

    pub(crate) fn restore(&self, app_handle: &AppHandle) -> Result<WclAuthStatus, UploadError> {
        if self.current_session()?.is_some() {
            return self.status(app_handle, None);
        }

        let Some(email) = read_saved_login_email(app_handle)? else {
            return self.status(app_handle, None);
        };
        let resolved = resolve_login_credentials(app_handle, &email, None, true)?;
        let session = WclSession::new(crate::wcl_upload::core::resolve_client_version())?;
        let user_name = session.login(&resolved.email, &resolved.password)?;
        self.replace_session(Some(AuthenticatedWclSession {
            session,
            email: resolved.email.clone(),
            user_name,
        }))?;
        self.status(app_handle, Some(&resolved.email))
    }

    pub(crate) fn session_or_restore(
        &self,
        app_handle: &AppHandle,
    ) -> Result<AuthenticatedWclSession, UploadError> {
        if let Some(session) = self.current_session()? {
            return Ok(session);
        }

        self.restore(app_handle)?;
        self.current_session()?.ok_or_else(|| {
            UploadError::Message("Sign in to WarcraftLogs before continuing".to_string())
        })
    }

    pub(crate) fn sign_out(&self, app_handle: &AppHandle) -> Result<WclAuthStatus, UploadError> {
        self.replace_session(None)?;
        self.status(app_handle, None)
    }

    pub(crate) fn invalidate_if_authentication_failed(
        &self,
        error_message: &str,
    ) -> Result<(), UploadError> {
        if error_message.contains("status 401") || error_message.contains("status 403") {
            self.replace_session(None)?;
        }
        Ok(())
    }

    pub(crate) fn forget(&self, app_handle: &AppHandle) -> Result<WclAuthStatus, UploadError> {
        clear_saved_login(app_handle)?;
        self.replace_session(None)?;
        self.status(app_handle, None)
    }

    fn current_session(&self) -> Result<Option<AuthenticatedWclSession>, UploadError> {
        self.session
            .lock()
            .map(|session| session.clone())
            .map_err(|error| {
                UploadError::Message(format!("Failed to lock WarcraftLogs auth state: {error}"))
            })
    }

    fn replace_session(&self, session: Option<AuthenticatedWclSession>) -> Result<(), UploadError> {
        let mut current = self.session.lock().map_err(|error| {
            UploadError::Message(format!("Failed to lock WarcraftLogs auth state: {error}"))
        })?;
        *current = session;
        Ok(())
    }
}

impl Default for WclAuthService {
    fn default() -> Self {
        Self::new()
    }
}
