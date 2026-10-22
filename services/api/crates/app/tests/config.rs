//! Synthetic configuration fixtures only. Production Config has no credential defaults.
use atelier_app::config::Config;
use base64::{engine::general_purpose::STANDARD, Engine};
use ring::rand::{SecureRandom, SystemRandom};
use std::collections::HashMap;
fn fixture() -> HashMap<String, String> {
    let mut key = [0u8; 32];
    SystemRandom::new().fill(&mut key).unwrap();
    HashMap::from([
        (
            "DATABASE_URL".into(),
            "postgres://localhost/atelier_test".into(),
        ),
        ("PUBLIC_BASE_URL".into(), "https://atelier.test".into()),
        ("REDIS_URL".into(), "redis://localhost/15".into()),
        ("GOOGLE_CLIENT_ID".into(), "synthetic-client-id".into()),
        (
            "GOOGLE_CLIENT_SECRET".into(),
            "synthetic-test-only-value".into(),
        ),
        ("MASTER_KEY".into(), STANDARD.encode(key)),
        ("BOOTSTRAP_ADMIN_EMAILS".into(), "admin@gmail.com".into()),
    ])
}
#[test]
fn required_auth_configuration_has_no_defaults_and_errors_do_not_expose_values() {
    let values = fixture();
    for field in [
        "DATABASE_URL",
        "PUBLIC_BASE_URL",
        "REDIS_URL",
        "GOOGLE_CLIENT_ID",
        "GOOGLE_CLIENT_SECRET",
        "MASTER_KEY",
        "BOOTSTRAP_ADMIN_EMAILS",
    ] {
        let mut missing = values.clone();
        missing.remove(field);
        let err = Config::from_lookup(|k| missing.get(k).cloned())
            .err()
            .unwrap();
        assert_eq!(
            err.to_string(),
            format!("Invalid or missing configuration: {field}")
        );
    }
}
#[test]
fn invalid_configuration_is_rejected_and_redacted() {
    for (field, value) in [
        ("DATABASE_URL", "https://user:secret@host"),
        ("PUBLIC_BASE_URL", "https://user:secret@atelier.test"),
        ("PUBLIC_BASE_URL", "http://external.test"),
        ("REDIS_URL", "https://secret@host"),
        ("MASTER_KEY", "not-a-valid-master-key"),
        ("BOOTSTRAP_ADMIN_EMAILS", "admin@example.com"),
        ("TRUSTED_PROXY_IPS", "0.0.0.0/0"),
    ] {
        let mut values = fixture();
        values.insert(field.into(), value.into());
        let err = Config::from_lookup(|k| values.get(k).cloned())
            .err()
            .unwrap();
        assert!(!err.to_string().contains(value));
    }
}
#[test]
fn openapi_requires_explicit_loopback_config_and_proxy_trust_is_explicit() {
    let mut values = fixture();
    let config = Config::from_lookup(|k| values.get(k).cloned()).unwrap();
    assert!(!config.expose_openapi);
    assert!(config.trusted_proxy_ips.is_empty());
    values.insert("EXPOSE_OPENAPI".into(), "true".into());
    assert!(
        Config::from_lookup(|k| values.get(k).cloned())
            .unwrap()
            .expose_openapi
    );
    values.insert("BIND_ADDRESS".into(), "0.0.0.0:8080".into());
    assert!(Config::from_lookup(|k| values.get(k).cloned()).is_err());
}

#[test]
fn upstream_loopback_exception_requires_explicit_origins_and_local_service() {
    let mut values = fixture();
    values.insert(
        "UPSTREAM_DEV_ALLOW_ORIGINS".into(),
        "http://127.0.0.1:19999".into(),
    );
    assert!(Config::from_lookup(|k| values.get(k).cloned()).is_err());
    values.insert("PUBLIC_BASE_URL".into(), "http://127.0.0.1:5173".into());
    let config = Config::from_lookup(|k| values.get(k).cloned()).unwrap();
    assert!(config
        .upstream_egress
        .parse("http://127.0.0.1:19999/v1", false)
        .is_ok());
    assert!(config
        .upstream_egress
        .parse("http://127.0.0.1:19998/v1", false)
        .is_err());
    values.insert("BIND_ADDRESS".into(), "0.0.0.0:8080".into());
    assert!(Config::from_lookup(|k| values.get(k).cloned()).is_err());
}
