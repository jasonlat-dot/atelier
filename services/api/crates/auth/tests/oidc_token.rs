use atelier_auth::oidc_provider::verify_id_token;
use base64::{engine::general_purpose::URL_SAFE_NO_PAD as B64, Engine};
use ring::{
    rand::SystemRandom,
    signature::{RsaKeyPair, RSA_PKCS1_SHA256},
};
use serde_json::{json, Value};
fn claims() -> Value {
    json!({"iss":"https://accounts.google.com","aud":"client-id","sub":"sub-1","email":"A.B+test@gmail.com","email_verified":true,"nonce":"nonce-expected","iat":1_000,"exp":2_000})
}
fn sign(header: Value, claims: Value) -> String {
    let key = RsaKeyPair::from_pkcs8(include_bytes!("fixtures/oidc-test-only.pk8")).unwrap();
    let input = format!(
        "{}.{}",
        B64.encode(header.to_string()),
        B64.encode(claims.to_string())
    );
    let mut signature = vec![0; key.public().modulus_len()];
    key.sign(
        &RSA_PKCS1_SHA256,
        &SystemRandom::new(),
        input.as_bytes(),
        &mut signature,
    )
    .unwrap();
    format!("{input}.{}", B64.encode(signature))
}
fn token(claims: Value) -> String {
    sign(json!({"alg":"RS256","kid":"test-key"}), claims)
}
const KEYS: &str = include_str!("fixtures/jwks.json");
#[test]
fn valid_google_signature_and_claims_produce_canonical_identity() {
    for issuer in ["https://accounts.google.com", "accounts.google.com"] {
        let mut c = claims();
        c["iss"] = issuer.into();
        let id = verify_id_token(&token(c), KEYS, "client-id", "nonce-expected", 1_500).unwrap();
        assert_eq!(id.identity().canonical_email, "ab@gmail.com");
        assert_eq!(id.identity().google_sub, "sub-1");
    }
}
#[test]
fn forged_alg_key_signature_and_malformed_tokens_are_rejected() {
    for header in [
        json!({"alg":"none","kid":"test-key"}),
        json!({"alg":"HS256","kid":"test-key"}),
        json!({"alg":"RS256","kid":"unknown"}),
        json!({"alg":"RS256"}),
        json!({"alg":"RS256","kid":"test-key","crit":["unknown"]}),
    ] {
        assert!(verify_id_token(
            &sign(header, claims()),
            KEYS,
            "client-id",
            "nonce-expected",
            1500
        )
        .is_err());
    }
    let signed = token(claims());
    let mut bytes = signed.into_bytes();
    let end = bytes.len() - 5;
    bytes[end] = if bytes[end] == b'A' { b'B' } else { b'A' };
    assert!(verify_id_token(
        std::str::from_utf8(&bytes).unwrap(),
        KEYS,
        "client-id",
        "nonce-expected",
        1500
    )
    .is_err());
    for raw in ["", "a.b", "a.b.c.d", "a.b.c", &"A".repeat(20000)] {
        assert!(verify_id_token(raw, KEYS, "client-id", "nonce-expected", 1500).is_err());
    }
}
#[test]
fn issuer_audience_expiry_nonce_gmail_and_workspace_matrix() {
    for (key, value) in [
        ("iss", json!("https://evil.test")),
        ("aud", json!("other")),
        ("aud", json!(["client-id", "other"])),
        ("exp", json!(1500)),
        ("nonce", json!("wrong")),
        ("email_verified", json!(false)),
        ("email_verified", json!("true")),
        ("email", json!("user@example.com")),
        ("email", json!("user@googlemail.com")),
        ("hd", json!("")),
        ("hd", Value::Null),
        ("sub", json!("")),
        ("iat", json!(1601)),
        ("nbf", json!(1600)),
        ("azp", json!("other")),
    ] {
        let mut c = claims();
        c[key] = value;
        assert!(
            verify_id_token(&token(c), KEYS, "client-id", "nonce-expected", 1500).is_err(),
            "{key}"
        );
    }
    for key in [
        "iss",
        "aud",
        "exp",
        "nonce",
        "sub",
        "email",
        "email_verified",
    ] {
        let mut c = claims();
        c.as_object_mut().unwrap().remove(key);
        assert!(
            verify_id_token(&token(c), KEYS, "client-id", "nonce-expected", 1500).is_err(),
            "missing {key}"
        );
    }
}
