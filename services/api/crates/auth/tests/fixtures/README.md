# Synthetic OIDC test keys

`oidc-test-only.pk8` was generated locally on 2026-10-22 solely to sign fake Google ID tokens in automated tests. `jwks.json` is its public key. This key is public test data, has no real account or production use, and must never be configured as a trusted production issuer. Production verification downloads Google JWKS from a fixed HTTPS endpoint. These files are referenced only by Rust integration tests, never by production main or browser assets.
