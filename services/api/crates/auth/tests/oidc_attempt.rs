use atelier_auth::{
    oidc_attempt::{AttemptFlow, AttemptRecord, BeginError},
    transient::{RateDecision, TransientError, TransientFuture, TransientStore, LOGIN_RATE},
};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    net::IpAddr,
    sync::{Arc, Mutex},
};
use url::Url;

#[derive(Default)]
struct MemoryStore {
    values: Mutex<HashMap<String, String>>,
    requests: Mutex<HashMap<String, u32>>,
    unavailable: bool,
}
impl TransientStore for MemoryStore {
    fn save_attempt(&self, key: String, value: String, ttl: u64) -> TransientFuture<'_, bool> {
        Box::pin(async move {
            assert_eq!(ttl, 600);
            if self.unavailable {
                return Err(TransientError);
            }
            let mut values = self.values.lock().unwrap();
            if values.contains_key(&key) {
                return Ok(false);
            }
            values.insert(key, value);
            Ok(true)
        })
    }
    fn consume_attempt(
        &self,
        key: String,
        browser_hash: String,
    ) -> TransientFuture<'_, Option<String>> {
        Box::pin(async move {
            if self.unavailable {
                return Err(TransientError);
            }
            let mut values = self.values.lock().unwrap();
            let matches = values.get(&key).is_some_and(|value| {
                serde_json::from_str::<AttemptRecord>(value)
                    .unwrap()
                    .browser_hash()
                    == browser_hash
            });
            Ok(if matches { values.remove(&key) } else { None })
        })
    }
    fn rate_limit(
        &self,
        key: String,
        rule: atelier_auth::transient::RateRule,
    ) -> TransientFuture<'_, RateDecision> {
        Box::pin(async move {
            if self.unavailable {
                return Err(TransientError);
            }
            assert_eq!(rule, LOGIN_RATE);
            let mut requests = self.requests.lock().unwrap();
            let count = requests.entry(key).or_default();
            *count += 1;
            Ok(if *count <= rule.limit {
                RateDecision::Allowed
            } else {
                RateDecision::Limited {
                    retry_after_seconds: 600,
                }
            })
        })
    }
}
fn make_flow(store: Arc<MemoryStore>) -> AttemptFlow {
    AttemptFlow::new(
        store,
        "client-id".into(),
        "https://atelier.test/api/v1/auth/google/callback".into(),
    )
    .unwrap()
}
fn binding(cookie: &str) -> String {
    cookie
        .split(';')
        .next()
        .unwrap()
        .split_once('=')
        .unwrap()
        .1
        .to_string()
}
fn state(url: &str) -> String {
    Url::parse(url)
        .unwrap()
        .query_pairs()
        .find(|(k, _)| k == "state")
        .unwrap()
        .1
        .into_owned()
}

#[tokio::test]
async fn authorization_has_pkce_and_nonce_but_never_verifier_or_binding_secret() {
    let store = Arc::new(MemoryStore::default());
    let flow = make_flow(store.clone());
    let started = flow.begin("127.0.0.1".parse().unwrap()).await.unwrap();
    let url = Url::parse(&started.authorization_url).unwrap();
    let query: HashMap<_, _> = url
        .query_pairs()
        .map(|(k, v)| (k.into_owned(), v.into_owned()))
        .collect();
    assert_eq!(
        url.origin().ascii_serialization(),
        "https://accounts.google.com"
    );
    assert_eq!(query["response_type"], "code");
    assert_eq!(query["client_id"], "client-id");
    assert_eq!(query["code_challenge_method"], "S256");
    for scope in ["openid", "email", "profile"] {
        assert!(query["scope"].split(' ').any(|v| v == scope));
    }
    let record: AttemptRecord =
        serde_json::from_str(store.values.lock().unwrap().values().next().unwrap()).unwrap();
    assert_eq!(
        query["code_challenge"],
        URL_SAFE_NO_PAD.encode(Sha256::digest(record.pkce_verifier().as_bytes()))
    );
    assert_eq!(query["nonce"], record.nonce());
    assert!(!started.authorization_url.contains(record.pkce_verifier()));
    assert!(!started
        .authorization_url
        .contains(&binding(&started.browser_cookie)));
    assert!(!format!("{record:?}").contains(record.pkce_verifier()));
    for attribute in [
        "HttpOnly",
        "Secure",
        "SameSite=Lax",
        "Path=/",
        "Max-Age=600",
    ] {
        assert!(started.browser_cookie.contains(attribute));
    }
}

#[tokio::test]
async fn browser_mismatch_does_not_burn_attempt_and_one_hundred_callbacks_consume_once() {
    let flow = Arc::new(make_flow(Arc::new(MemoryStore::default())));
    let started = flow.begin("127.0.0.1".parse().unwrap()).await.unwrap();
    let state = state(&started.authorization_url);
    let browser = binding(&started.browser_cookie);
    assert!(flow.consume(&state, &"A".repeat(43)).await.is_err());
    let mut tasks = Vec::new();
    for _ in 0..100 {
        let flow = flow.clone();
        let state = state.clone();
        let browser = browser.clone();
        tasks.push(tokio::spawn(async move {
            flow.consume(&state, &browser).await.is_ok()
        }));
    }
    let mut accepted = 0;
    for task in tasks {
        accepted += usize::from(task.await.unwrap());
    }
    assert_eq!(accepted, 1);
    assert!(flow.consume(&state, &browser).await.is_err());
}

#[tokio::test]
async fn malformed_missing_expired_state_and_backend_failure_fail_closed() {
    let store = Arc::new(MemoryStore::default());
    let flow = make_flow(store.clone());
    for state in ["", "forged", "../state", &"A".repeat(43)] {
        assert!(flow.consume(state, &"A".repeat(43)).await.is_err());
    }
    let started = flow.begin("127.0.0.1".parse().unwrap()).await.unwrap();
    {
        let mut records = store.values.lock().unwrap();
        let payload = records.values_mut().next().unwrap();
        let mut value: serde_json::Value = serde_json::from_str(payload).unwrap();
        value["created_at"] = (chrono::Utc::now().timestamp() - 601).into();
        *payload = value.to_string();
    }
    assert!(flow
        .consume(
            &state(&started.authorization_url),
            &binding(&started.browser_cookie)
        )
        .await
        .is_err());
    let failing = make_flow(Arc::new(MemoryStore {
        unavailable: true,
        ..Default::default()
    }));
    assert!(matches!(
        failing.begin("127.0.0.1".parse().unwrap()).await,
        Err(BeginError::Unavailable)
    ));
    assert!(matches!(
        failing.consume(&"A".repeat(43), &"A".repeat(43)).await,
        Err(BeginError::Unavailable)
    ));
}

#[test]
fn invalid_client_and_callback_configuration_is_rejected() {
    let store = Arc::new(MemoryStore::default());
    for callback in [
        "http://atelier.test/api/v1/auth/google/callback",
        "https://user:password@atelier.test/api/v1/auth/google/callback",
        "https://atelier.test/api/v1/auth/google/callback?next=evil",
        "https://atelier.test/api/v1/auth/google/callback#fragment",
        "https://atelier.test/other",
    ] {
        assert!(AttemptFlow::new(store.clone(), "client-id".into(), callback.into()).is_err());
    }
    for client_id in ["", "client id", &"a".repeat(513)] {
        assert!(AttemptFlow::new(
            store.clone(),
            client_id.into(),
            "https://atelier.test/api/v1/auth/google/callback".into()
        )
        .is_err());
    }
}

#[tokio::test]
async fn login_rate_precedes_state_creation_and_ipv4_mapped_ipv6_is_same_principal() {
    let store = Arc::new(MemoryStore::default());
    let flow = make_flow(store.clone());
    for _ in 0..20 {
        flow.begin("127.0.0.1".parse().unwrap()).await.unwrap();
    }
    assert!(matches!(
        flow.begin("::ffff:127.0.0.1".parse::<IpAddr>().unwrap())
            .await,
        Err(BeginError::Limited {
            retry_after_seconds: 600
        })
    ));
    assert_eq!(store.values.lock().unwrap().len(), 20);
    flow.begin("127.0.0.2".parse().unwrap()).await.unwrap();
    assert_eq!(store.values.lock().unwrap().len(), 21);
}
