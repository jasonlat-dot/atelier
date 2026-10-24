//! The only module permitted to write wallet balances.
mod billing;
mod billing_types;
mod code_crypto;
mod postgres;
mod service;
mod views;
pub use billing::{BillingService, ManualProvider, PaymentProvider};
pub use billing_types::*;
pub use code_crypto::RedeemCodeCipher;
pub use service::{Operation, WalletError, WalletService};
pub use views::*;

use atelier_common::ApiError;
use axum::http::StatusCode;
impl From<WalletError> for ApiError {
    fn from(error: WalletError) -> Self {
        let (status, code) = match error {
            WalletError::Insufficient => (StatusCode::PAYMENT_REQUIRED, "INSUFFICIENT_CREDITS"),
            WalletError::Conflict => (StatusCode::UNPROCESSABLE_ENTITY, "IDEMPOTENCY_CONFLICT"),
            WalletError::Validation => (StatusCode::UNPROCESSABLE_ENTITY, "VALIDATION"),
            WalletError::InvalidCode => (StatusCode::UNPROCESSABLE_ENTITY, "INVALID_REDEEM_CODE"),
            WalletError::NotFound => (StatusCode::NOT_FOUND, "NOT_FOUND"),
            WalletError::CodeNotRecoverable => (StatusCode::CONFLICT, "CODE_NOT_RECOVERABLE"),
            WalletError::CodeChanged => (StatusCode::CONFLICT, "REDEEM_CODE_CHANGED"),
            WalletError::Store => (StatusCode::SERVICE_UNAVAILABLE, "SERVICE_UNAVAILABLE"),
        };
        ApiError::new(status, code, &error.to_string())
    }
}
