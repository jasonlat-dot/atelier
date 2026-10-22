use crate::{
    identity::{AuthFailure, IdentityRepository, LoginContext, PublicConfig},
    oidc_attempt::{AttemptFlow, BeginAttempt, BeginError},
    oidc_provider::IdentityProvider,
    session::SessionSecrets,
};
use std::{net::IpAddr, sync::Arc};
impl From<BeginError> for AuthFailure {
    fn from(e: BeginError) -> Self {
        match e {
            BeginError::Unavailable => Self::Store,
            BeginError::InvalidState => Self::State,
            BeginError::Limited {
                retry_after_seconds,
            } => Self::Rate(retry_after_seconds),
        }
    }
}
#[derive(Clone)]
pub struct LoginService {
    flow: AttemptFlow,
    provider: Arc<dyn IdentityProvider>,
    repository: Arc<dyn IdentityRepository>,
}
impl LoginService {
    pub fn new(
        flow: AttemptFlow,
        provider: Arc<dyn IdentityProvider>,
        repository: Arc<dyn IdentityRepository>,
    ) -> Self {
        Self {
            flow,
            provider,
            repository,
        }
    }
    pub async fn begin(
        &self,
        ip: IpAddr,
        invite: Option<String>,
    ) -> Result<BeginAttempt, AuthFailure> {
        Ok(self.flow.begin_with_invite(ip, invite).await?)
    }
    pub async fn public_config(&self) -> Result<PublicConfig, AuthFailure> {
        self.repository.public_config().await
    }
    pub async fn callback(
        &self,
        state: &str,
        browser: &str,
        code: String,
        mut context: LoginContext,
    ) -> Result<SessionSecrets, AuthFailure> {
        let attempt = self.flow.consume(state, browser).await?;
        let identity = self
            .provider
            .exchange(code, attempt.pkce_verifier().into(), attempt.nonce().into())
            .await?;
        context.invite = attempt.invite().map(str::to_string);
        self.repository.login(identity, context).await
    }
}
