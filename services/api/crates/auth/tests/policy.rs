use atelier_auth::policy::*;
use chrono::{Duration, TimeZone, Utc};

#[test]
fn gmail_aliases_canonicalize_but_other_domains_and_malformed_addresses_fail() {
    for address in [
        "A.B+first@gmail.com",
        "a.b+second@GMAIL.COM",
        "ab@googlemail.com",
    ] {
        assert_eq!(canonical_email(address).unwrap(), "ab@gmail.com");
    }
    for address in [
        "ab@example.com",
        "ab@gmail.com.evil",
        "@gmail.com",
        "a@@gmail.com",
        "a b@gmail.com",
        ".@gmail.com",
        "ab@gmail.com\r\n",
    ] {
        assert!(canonical_email(address).is_err(), "{address}");
    }
}

#[test]
fn verified_google_identity_still_requires_gmail_verified_email_and_no_workspace() {
    assert!(validate_google_identity("subject-123", "A.B@gmail.com", true, None).is_ok());
    assert!(validate_google_identity("subject-123", "ab@gmail.com", false, None).is_err());
    assert!(
        validate_google_identity("subject-123", "ab@gmail.com", true, Some("example.com")).is_err()
    );
    assert!(validate_google_identity("subject-123", "ab@gmail.com", true, Some("")).is_err());
    assert!(validate_google_identity("", "ab@gmail.com", true, None).is_err());
    assert!(validate_google_identity("subject-123", "ab@example.com", true, None).is_err());
    assert!(validate_google_identity("subject-123", "ab@googlemail.com", true, None).is_err());
}

#[test]
fn registration_modes_existing_identity_bootstrap_and_ip_limit_matrix() {
    for mode in [
        RegistrationMode::Open,
        RegistrationMode::InviteOnly,
        RegistrationMode::Closed,
    ] {
        assert!(registration_allowed(
            mode,
            RegistrationContext {
                existing_user: true,
                ..Default::default()
            }
        )
        .is_ok());
        assert!(registration_allowed(
            mode,
            RegistrationContext {
                bootstrap_admin: true,
                ..Default::default()
            }
        )
        .is_ok());
        assert_eq!(
            registration_allowed(
                mode,
                RegistrationContext {
                    registrations_24h: 3,
                    ..Default::default()
                }
            ),
            Err(PolicyError::RegistrationRateLimited)
        );
    }
    assert!(registration_allowed(RegistrationMode::Open, RegistrationContext::default()).is_ok());
    assert_eq!(
        registration_allowed(RegistrationMode::Closed, RegistrationContext::default()),
        Err(PolicyError::RegistrationClosed)
    );
    assert_eq!(
        registration_allowed(RegistrationMode::InviteOnly, RegistrationContext::default()),
        Err(PolicyError::InviteRequired)
    );
    for context in [
        RegistrationContext {
            whitelisted: true,
            ..Default::default()
        },
        RegistrationContext {
            valid_invite: true,
            ..Default::default()
        },
    ] {
        assert!(registration_allowed(RegistrationMode::InviteOnly, context).is_ok());
        assert_eq!(
            registration_allowed(RegistrationMode::Closed, context),
            Err(PolicyError::RegistrationClosed)
        );
    }
    assert!(registration_allowed(
        RegistrationMode::Open,
        RegistrationContext {
            registrations_24h: 3,
            max_registrations_24h: 4,
            ..Default::default()
        }
    )
    .is_ok());
    assert_eq!(
        registration_allowed(
            RegistrationMode::Open,
            RegistrationContext {
                max_registrations_24h: 0,
                ..Default::default()
            }
        ),
        Err(PolicyError::RegistrationRateLimited)
    );
}

#[test]
fn session_expiry_is_checked_at_exact_boundaries_and_disabled_always_denied() {
    let now = Utc.with_ymd_and_hms(2026, 10, 22, 12, 0, 0).unwrap();
    let valid = SessionWindow {
        created_at: now - Duration::days(10),
        last_seen_at: now - Duration::hours(1),
        expires_at: now + Duration::days(20),
        revoked: false,
    };
    assert!(session_allowed(&valid, UserStatus::Active, now).is_ok());
    assert_eq!(
        session_allowed(&valid, UserStatus::Disabled, now),
        Err(PolicyError::AccountDisabled)
    );
    for window in [
        SessionWindow {
            revoked: true,
            ..valid
        },
        SessionWindow {
            expires_at: now,
            ..valid
        },
        SessionWindow {
            last_seen_at: now - Duration::days(7),
            ..valid
        },
        SessionWindow {
            created_at: now - Duration::days(30),
            ..valid
        },
        SessionWindow {
            last_seen_at: now + Duration::seconds(1),
            ..valid
        },
    ] {
        assert_eq!(
            session_allowed(&window, UserStatus::Active, now),
            Err(PolicyError::Unauthenticated)
        );
    }
}

#[test]
fn every_admin_role_requires_bound_recent_mfa_and_hierarchy_is_server_owned() {
    let now = Utc.with_ymd_and_hms(2026, 10, 22, 12, 0, 0).unwrap();
    for role in [Role::User, Role::Admin, Role::SuperAdmin] {
        for required in [Role::Admin, Role::SuperAdmin] {
            let permitted_role =
                role == Role::SuperAdmin || (role == Role::Admin && required == Role::Admin);
            let recent = Some(now - Duration::hours(1));
            assert_eq!(
                require_admin(role, required, true, recent, now).is_ok(),
                permitted_role
            );
            assert!(require_admin(role, required, false, recent, now).is_err());
            assert!(require_admin(role, required, true, None, now).is_err());
            assert!(
                require_admin(role, required, true, Some(now - Duration::hours(12)), now).is_err()
            );
            assert!(
                require_admin(role, required, true, Some(now + Duration::seconds(1)), now).is_err()
            );
        }
    }
    assert!(require_mfa_enrollment(Role::Admin).is_ok());
    assert!(require_mfa_enrollment(Role::SuperAdmin).is_ok());
    assert_eq!(
        require_mfa_enrollment(Role::User),
        Err(PolicyError::Forbidden)
    );
    assert_eq!(Role::try_from("SUPER_ADMIN"), Ok(Role::SuperAdmin));
    assert!(Role::try_from("super_admin").is_err());
}

#[test]
fn csrf_binds_to_origin_and_session_and_rejects_missing_headers() {
    let token = "0123456789abcdef0123456789abcdef0123456789abc";
    for method in ["POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"] {
        assert!(csrf_allowed(
            method,
            "https://atelier.example",
            Some("https://atelier.example"),
            Some(token),
            token
        )
        .is_ok());
        for origin in [
            None,
            Some("null"),
            Some("https://evil.example"),
            Some("https://atelier.example.evil"),
            Some("http://atelier.example"),
            Some("https://atelier.example/path"),
            Some("https://user@atelier.example"),
        ] {
            assert!(csrf_allowed(
                method,
                "https://atelier.example",
                origin,
                Some(token),
                token
            )
            .is_err());
        }
        assert!(csrf_allowed(
            method,
            "https://atelier.example",
            Some("https://atelier.example"),
            None,
            token
        )
        .is_err());
        assert!(csrf_allowed(
            method,
            "https://atelier.example",
            Some("https://atelier.example"),
            Some("attacker"),
            token
        )
        .is_err());
    }
    assert!(csrf_allowed("GET", "https://atelier.example", None, None, token).is_ok());
}
