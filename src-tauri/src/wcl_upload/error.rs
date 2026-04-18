#[derive(Debug)]
pub(crate) enum UploadError {
    Message(String),
    Cancelled,
    Io(std::io::Error),
    Json(serde_json::Error),
    Http(reqwest::Error),
    HttpStatus { request_label: String, status: u16 },
    Zip(zip::result::ZipError),
}

impl std::fmt::Display for UploadError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Message(message) => write!(formatter, "{message}"),
            Self::Cancelled => write!(formatter, "WarcraftLogs upload cancelled"),
            Self::Io(error) => write!(formatter, "{error}"),
            Self::Json(error) => write!(formatter, "{error}"),
            Self::Http(error) => write!(formatter, "{error}"),
            Self::HttpStatus {
                request_label,
                status,
            } => {
                write!(
                    formatter,
                    "WarcraftLogs request '{request_label}' failed with status {status}"
                )
            }
            Self::Zip(error) => write!(formatter, "{error}"),
        }
    }
}

impl std::error::Error for UploadError {}

impl From<std::io::Error> for UploadError {
    fn from(error: std::io::Error) -> Self {
        Self::Io(error)
    }
}

impl From<serde_json::Error> for UploadError {
    fn from(error: serde_json::Error) -> Self {
        Self::Json(error)
    }
}

impl From<reqwest::Error> for UploadError {
    fn from(error: reqwest::Error) -> Self {
        Self::Http(error)
    }
}

impl From<zip::result::ZipError> for UploadError {
    fn from(error: zip::result::ZipError) -> Self {
        Self::Zip(error)
    }
}
