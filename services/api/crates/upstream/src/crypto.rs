use crate::Error;
use base64::{engine::general_purpose::STANDARD, Engine};
use chacha20poly1305::{
    aead::{Aead, Payload},
    KeyInit, XChaCha20Poly1305, XNonce,
};
use sha2::{Digest, Sha256};
use uuid::Uuid;
use zeroize::Zeroizing;
#[derive(Clone)]
pub struct SecretCipher {
    cipher: XChaCha20Poly1305,
}
impl std::fmt::Debug for SecretCipher {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("SecretCipher([REDACTED])")
    }
}
impl SecretCipher {
    pub fn from_base64(value: &str) -> Result<Self, Error> {
        let key = Zeroizing::new(STANDARD.decode(value).map_err(|_| Error::Store)?);
        if key.len() != 32 {
            return Err(Error::Store);
        }
        let mut hash = Sha256::new();
        hash.update(b"atelier.upstream.secret.v1\0");
        hash.update(&*key);
        let derived = Zeroizing::new(<[u8; 32]>::from(hash.finalize()));
        Ok(Self {
            cipher: XChaCha20Poly1305::new_from_slice(&*derived).map_err(|_| Error::Store)?,
        })
    }
    pub fn seal(&self, id: Uuid, value: &str) -> Result<Vec<u8>, Error> {
        if !(8..=8192).contains(&value.len()) || !value.bytes().all(|b| (33..=126).contains(&b)) {
            return Err(Error::Validation);
        }
        let mut nonce = [0u8; 24];
        getrandom::fill(&mut nonce).map_err(|_| Error::Store)?;
        let aad = format!("atelier.upstream:{id}:1");
        let encrypted = self
            .cipher
            .encrypt(
                &XNonce::from(nonce),
                Payload {
                    msg: value.as_bytes(),
                    aad: aad.as_bytes(),
                },
            )
            .map_err(|_| Error::Store)?;
        let mut output = vec![1];
        output.extend(nonce);
        output.extend(encrypted);
        Ok(output)
    }
    pub fn open(&self, id: Uuid, value: &[u8]) -> Result<Zeroizing<String>, Error> {
        if value.len() < 49 || value[0] != 1 {
            return Err(Error::Store);
        }
        let aad = format!("atelier.upstream:{id}:1");
        let nonce: [u8; 24] = value[1..25].try_into().map_err(|_| Error::Store)?;
        let plain = self
            .cipher
            .decrypt(
                &XNonce::from(nonce),
                Payload {
                    msg: &value[25..],
                    aad: aad.as_bytes(),
                },
            )
            .map_err(|_| Error::Store)?;
        Ok(Zeroizing::new(
            String::from_utf8(plain).map_err(|_| Error::Store)?,
        ))
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn randomized_encryption_binds_account_version_and_key() {
        let cipher = SecretCipher::from_base64(&STANDARD.encode([71; 32])).unwrap();
        let id = Uuid::new_v4();
        let secret = "synthetic-server-only-key";
        let one = cipher.seal(id, secret).unwrap();
        let two = cipher.seal(id, secret).unwrap();
        assert_ne!(one, two);
        assert_eq!(&**cipher.open(id, &one).unwrap(), secret);
        assert!(cipher.open(Uuid::new_v4(), &one).is_err());
        let mut tampered = one.clone();
        tampered[26] ^= 1;
        assert!(cipher.open(id, &tampered).is_err());
        assert!(SecretCipher::from_base64(&STANDARD.encode([72; 32]))
            .unwrap()
            .open(id, &one)
            .is_err());
        assert!(!format!("{cipher:?}").contains(secret));
    }
}
