//! Private durable text conversations. All credits go through the wallet service.
mod service;
mod turns;
mod types;
use atelier_common::ApiError;
use axum::http::StatusCode;
pub use service::ChatService;
pub use types::*;
#[derive(Debug, thiserror::Error)]
pub enum ChatError {
    #[error("Invalid conversation input")]
    Validation,
    #[error("Conversation not found")]
    NotFound,
    #[error("Another reply is still running")]
    Busy,
    #[error("Conversation request conflicts with an earlier request")]
    Conflict,
    #[error("Chat model is not configured")]
    Model,
    #[error("Content rejected")]
    ContentPolicy,
    #[error("Conversation service unavailable")]
    Store,
    #[error("Context is too large; start a new conversation")]
    Context,
    #[error(transparent)]
    Wallet(#[from] atelier_wallet::WalletError),
}
impl From<sqlx::Error> for ChatError {
    fn from(_: sqlx::Error) -> Self {
        Self::Store
    }
}
impl From<ChatError> for ApiError {
    fn from(error: ChatError) -> Self {
        if let ChatError::Wallet(e) = error {
            return e.into();
        }
        let (status, code) = match &error {
            ChatError::Validation => (StatusCode::UNPROCESSABLE_ENTITY, "VALIDATION"),
            ChatError::NotFound => (StatusCode::NOT_FOUND, "NOT_FOUND"),
            ChatError::Busy => (StatusCode::CONFLICT, "CHAT_BUSY"),
            ChatError::Conflict => (StatusCode::CONFLICT, "CHAT_REQUEST_CONFLICT"),
            ChatError::ContentPolicy => (StatusCode::UNPROCESSABLE_ENTITY, "CONTENT_POLICY"),
            ChatError::Context => (StatusCode::UNPROCESSABLE_ENTITY, "CONTEXT_LIMIT"),
            ChatError::Model => (StatusCode::SERVICE_UNAVAILABLE, "CHAT_MODEL_UNAVAILABLE"),
            _ => (StatusCode::SERVICE_UNAVAILABLE, "SERVICE_UNAVAILABLE"),
        };
        Self::new(status, code, &error.to_string())
    }
}
