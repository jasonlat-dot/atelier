use atelier_auth::{
    oidc_attempt::AttemptFlow,
    transient::{RateDecision, RateRule, RedisTransient, TransientStore},
};
use std::{sync::Arc, time::Duration};
use uuid::Uuid;

#[tokio::test]
#[ignore = "Requires isolated Redis 7 via TEST_REDIS_URL; run in CI or after deployment"]
async fn redis_atomic_state_ttl_and_sliding_window_concurrency() {
    let url = std::env::var("TEST_REDIS_URL")
        .expect("TEST_REDIS_URL must explicitly target isolated test Redis");
    let store = Arc::new(RedisTransient::connect(&url).await.unwrap());
    let flow = Arc::new(
        AttemptFlow::new(
            store.clone(),
            "test-client-id".into(),
            "https://atelier.test/api/v1/auth/google/callback".into(),
        )
        .unwrap(),
    );
    let ip = std::net::Ipv6Addr::from(Uuid::new_v4().as_u128());
    let started = flow.begin(ip.into()).await.unwrap();
    let state = url::Url::parse(&started.authorization_url)
        .unwrap()
        .query_pairs()
        .find(|(k, _)| k == "state")
        .unwrap()
        .1
        .into_owned();
    let browser = started
        .browser_cookie
        .split(';')
        .next()
        .unwrap()
        .split_once('=')
        .unwrap()
        .1
        .to_string();
    assert!(flow.consume(&state, &"A".repeat(43)).await.is_err());
    let mut callbacks = Vec::new();
    for _ in 0..100 {
        let flow = flow.clone();
        let state = state.clone();
        let browser = browser.clone();
        callbacks.push(tokio::spawn(async move {
            flow.consume(&state, &browser).await.is_ok()
        }));
    }
    let mut accepted = 0;
    for task in callbacks {
        accepted += usize::from(task.await.unwrap());
    }
    assert_eq!(accepted, 1);
    let key = format!("test:oidc:{}", Uuid::new_v4());
    let payload = r#"{"browser_hash":"hash"}"#.to_string();
    assert!(store
        .save_attempt(key.clone(), payload.clone(), 1)
        .await
        .unwrap());
    assert!(!store.save_attempt(key.clone(), payload, 1).await.unwrap());
    tokio::time::sleep(Duration::from_millis(1100)).await;
    assert!(store
        .consume_attempt(key, "hash".into())
        .await
        .unwrap()
        .is_none());
    let key = format!("test:rate:{}", Uuid::new_v4());
    let rule = RateRule {
        limit: 8,
        window_seconds: 3,
    };
    let mut requests = Vec::new();
    for _ in 0..100 {
        let store = store.clone();
        let key = key.clone();
        requests.push(tokio::spawn(async move {
            store.rate_limit(key, rule).await.unwrap()
        }));
    }
    let mut admitted = 0;
    for task in requests {
        match task.await.unwrap() {
            RateDecision::Allowed => admitted += 1,
            RateDecision::Limited {
                retry_after_seconds,
            } => assert!((1..=3).contains(&retry_after_seconds)),
        }
    }
    assert_eq!(admitted, 8);
    tokio::time::sleep(Duration::from_millis(3100)).await;
    assert_eq!(
        store.rate_limit(key, rule).await.unwrap(),
        RateDecision::Allowed
    );
}
