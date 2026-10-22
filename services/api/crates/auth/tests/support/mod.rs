use atelier_auth::oidc_provider::{verify_id_token, VerifiedIdentity};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD as B64, Engine};
use ring::{
    rand::SystemRandom,
    signature::{RsaKeyPair, RSA_PKCS1_SHA256},
};
pub fn identity(sub: &str, email: &str) -> VerifiedIdentity {
    let claims = serde_json::json!({"iss":"https://accounts.google.com","aud":"client-id","sub":sub,"email":email,"email_verified":true,"nonce":"nonce","exp":2000});
    let data = format!(
        "{}.{}",
        B64.encode(r#"{"alg":"RS256","kid":"test-key"}"#),
        B64.encode(claims.to_string())
    );
    let key = RsaKeyPair::from_pkcs8(include_bytes!("../fixtures/oidc-test-only.pk8")).unwrap();
    let mut sig = vec![0; key.public().modulus_len()];
    key.sign(
        &RSA_PKCS1_SHA256,
        &SystemRandom::new(),
        data.as_bytes(),
        &mut sig,
    )
    .unwrap();
    verify_id_token(
        &format!("{data}.{}", B64.encode(sig)),
        include_str!("../fixtures/jwks.json"),
        "client-id",
        "nonce",
        1500,
    )
    .unwrap()
}
