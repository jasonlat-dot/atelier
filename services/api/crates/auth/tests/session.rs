use atelier_auth::session::*;
use axum::http::{header, HeaderMap, HeaderValue};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use sha2::{Digest, Sha256};

#[test]
fn tokens_have_256_random_bits_and_only_hash_is_used_for_lookup() {
    let first = SessionSecrets::generate().unwrap();
    let second = SessionSecrets::generate().unwrap();
    assert_ne!(first.cookie(), second.cookie());
    assert!(first.cookie().starts_with("__Host-sid="));
    for attribute in [
        "; Secure",
        "; HttpOnly",
        "; SameSite=Lax",
        "; Path=/",
        "; Max-Age=2592000",
    ] {
        assert!(first.cookie().contains(attribute));
    }
    let cookie = first.cookie();
    let encoded = cookie.split(';').next().unwrap().split_once('=').unwrap().1;
    assert_eq!(encoded.len(), 43);
    assert_eq!(URL_SAFE_NO_PAD.decode(encoded).unwrap().len(), 32);
    let mut headers = HeaderMap::new();
    headers.insert(
        header::COOKIE,
        HeaderValue::from_str(cookie.split(';').next().unwrap()).unwrap(),
    );
    let hash = token_hash(&headers).unwrap();
    assert_eq!(hash, <[u8; 32]>::from(Sha256::digest(encoded.as_bytes())));
    assert_eq!(hash, first.token_hash());
    assert_eq!(
        URL_SAFE_NO_PAD.decode(first.csrf_token()).unwrap().len(),
        32
    );
    assert!(!format!("{first:?}").contains(encoded));
    assert!(!format!("{first:?}").contains(first.csrf_token()));
}

#[test]
fn missing_forged_and_duplicate_cookies_are_rejected() {
    for cookies in [
        vec![],
        vec!["atelier_sid=fake".to_string()],
        vec!["__Host-sid=fake".to_string()],
        vec!["__Host-sid=".to_string()],
    ] {
        let mut headers = HeaderMap::new();
        for cookie in cookies {
            headers.append(header::COOKIE, cookie.parse().unwrap());
        }
        assert!(token_hash(&headers).is_err());
    }
    let valid = SessionSecrets::generate()
        .unwrap()
        .cookie()
        .split(';')
        .next()
        .unwrap()
        .to_string();
    for cookies in [
        vec![valid.clone(), valid.clone()],
        vec![format!("{valid}; {valid}")],
    ] {
        let mut headers = HeaderMap::new();
        for cookie in cookies {
            headers.append(header::COOKIE, cookie.parse().unwrap());
        }
        assert!(token_hash(&headers).is_err());
    }
}

#[test]
fn repeated_origin_or_csrf_headers_cannot_be_smuggled_into_policy() {
    let token = "a".repeat(43);
    let mut headers = HeaderMap::new();
    headers.insert(header::ORIGIN, "https://atelier.example".parse().unwrap());
    headers.insert("x-csrf-token", token.parse().unwrap());
    assert!(validate_csrf_headers("POST", &headers, "https://atelier.example", &token).is_ok());
    let mut duplicated = headers.clone();
    duplicated.append(header::ORIGIN, "https://evil.example".parse().unwrap());
    assert!(validate_csrf_headers("POST", &duplicated, "https://atelier.example", &token).is_err());
    let mut duplicated = headers.clone();
    duplicated.append("x-csrf-token", "attacker".parse().unwrap());
    assert!(validate_csrf_headers("POST", &duplicated, "https://atelier.example", &token).is_err());
    headers.remove(header::ORIGIN);
    assert!(validate_csrf_headers("POST", &headers, "https://atelier.example", &token).is_err());
}
