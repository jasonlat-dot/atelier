use atelier_auth::mfa::{totp, MfaCipher};
use base64::{engine::general_purpose::STANDARD, Engine};
use uuid::Uuid;
#[test]
fn encryption_is_random_authenticated_and_bound_to_user() {
    let cipher = MfaCipher::from_base64(&STANDARD.encode([7u8; 32])).unwrap();
    let owner = Uuid::new_v4();
    let secret = vec![42u8; 20];
    let a = cipher.seal(owner, &secret).unwrap();
    let b = cipher.seal(owner, &secret).unwrap();
    assert_ne!(a, b);
    assert_eq!(cipher.open(owner, &a).unwrap(), secret);
    assert!(cipher.open(Uuid::new_v4(), &a).is_err());
    let mut corrupt = a;
    corrupt[15] ^= 1;
    assert!(cipher.open(owner, &corrupt).is_err());
    assert!(cipher.open(owner, &[0; 10]).is_err());
    assert!(!format!("{cipher:?}").contains(&STANDARD.encode([7u8; 32])));
    for key in [
        "invalid".to_string(),
        STANDARD.encode([0u8; 31]),
        STANDARD.encode([0u8; 33]),
    ] {
        assert!(MfaCipher::from_base64(&key).is_err());
    }
}
#[test]
fn totp_uses_six_digits_thirty_seconds_and_reports_step_for_replay_guard() {
    let otp = totp(&[42u8; 20], "admin@gmail.com").unwrap();
    assert_eq!(otp.digits(), 6);
    assert_eq!(otp.step(), 30);
    let code = otp.generate(1500).to_string();
    assert_eq!(otp.check(&code, 1500), Some(50));
    assert!(otp.check("12345", 1500).is_none());
    assert!(otp.check(&code, 1590).is_none());
    assert!(otp.to_url().unwrap().starts_with("otpauth://totp/"));
}
