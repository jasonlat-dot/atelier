use atelier_agent_core::{ChatRequest, CoreError, CoreFuture, LlmClient, TokenStream};
use atelier_chat::*;
use atelier_wallet::WalletService;
use sqlx::PgPool;
use std::{sync::Arc, time::Duration};
use uuid::Uuid;
struct Fixture {
    fail: bool,
    slow: bool,
}
impl LlmClient for Fixture {
    fn stream(&self, _: ChatRequest) -> CoreFuture<'_, TokenStream> {
        let fail = self.fail;
        let slow = self.slow;
        Box::pin(async move {
            Ok(
                Box::pin(futures_util::stream::unfold(0, move |index| async move {
                    if slow {
                        tokio::time::sleep(Duration::from_secs(5)).await;
                    }
                    match index {
                        0 => Some((Ok("海浪 ".into()), 1)),
                        1 => Some((
                            if fail {
                                Err(CoreError::Unavailable)
                            } else {
                                Ok("creative reply".into())
                            },
                            2,
                        )),
                        _ => None,
                    }
                })) as TokenStream,
            )
        })
    }
}
async fn user(db: &PgPool) -> Uuid {
    let id = Uuid::new_v4();
    sqlx::query("INSERT INTO users(id,google_sub,email,canonical_email,display_name) VALUES($1,$2,$2,$2,'Chat test')").bind(id).bind(format!("{id}@gmail.com")).execute(db).await.unwrap();
    let mut tx = db.begin().await.unwrap();
    WalletService::signup_in_transaction(&mut tx, id)
        .await
        .unwrap();
    tx.commit().await.unwrap();
    id
}
async fn service(db: &PgPool, fail: bool, slow: bool) -> ChatService {
    use base64::Engine;
    sqlx::query("INSERT INTO models(id,kind,display_name,upstream_model,enabled,capabilities) VALUES('chat','chat','Public Chat','private-chat',true,'{\"qualities\":[\"message\"],\"ratios\":[],\"resolutions\":[\"text\"],\"max_n\":1}') ON CONFLICT DO NOTHING").execute(db).await.unwrap();
    let cipher = atelier_upstream::crypto::SecretCipher::from_base64(
        &base64::engine::general_purpose::STANDARD.encode([7; 32]),
    )
    .unwrap();
    ChatService::new(
        db.clone(),
        atelier_upstream::UpstreamService::new(
            db.clone(),
            cipher,
            atelier_upstream::egress::SafeHttp::new(Default::default()),
        ),
    )
    .with_client(Arc::new(Fixture { fail, slow }))
}
fn input() -> SendMessage {
    SendMessage {
        model_id: "chat".into(),
        content: "生成一张海浪海报".into(),
    }
}
async fn conversation(s: &ChatService, user: Uuid) -> Uuid {
    s.create(
        user,
        Uuid::new_v4(),
        ConversationInput {
            title: "Creative conversation".into(),
        },
    )
    .await
    .unwrap()
    .id
}
async fn run(s: &ChatService, user: Uuid, c: Uuid, key: Uuid) -> Vec<ChatEvent> {
    let Start::Running { turn, token } = s.start(user, c, key, input()).await.unwrap() else {
        panic!("new turn")
    };
    let (tx, mut rx) = tokio::sync::mpsc::channel(8);
    let service = s.clone();
    let task = tokio::spawn(async move {
        service
            .reply(user, turn, token, tx, Arc::new(|| Box::pin(async { true })))
            .await;
    });
    let mut events = vec![];
    while let Some(event) = rx.recv().await {
        events.push(event);
    }
    task.await.unwrap();
    events
}
#[sqlx::test(migrations = "../../migrations")]
#[ignore = "Requires isolated PostgreSQL"]
async fn successful_reply_charges_once_replays_and_actions_never_create_generation_jobs(
    db: PgPool,
) {
    let owner = user(&db).await;
    let other = user(&db).await;
    let s = service(&db, false, false).await;
    let c = conversation(&s, owner).await;
    let key = Uuid::new_v4();
    let events = run(&s, owner, c, key).await;
    assert!(events.iter().any(|e| matches!(e, ChatEvent::Action(_))));
    let ChatEvent::Done(turn) = events.last().unwrap() else {
        panic!("done")
    };
    assert_eq!(turn.charged, 1);
    assert_eq!(turn.reply, "海浪 creative reply");
    assert_eq!(
        WalletService::new(db.clone())
            .summary(owner)
            .await
            .unwrap()
            .balance,
        19
    );
    let Start::Replay(replay) = s.start(owner, c, key, input()).await.unwrap() else {
        panic!("replay")
    };
    assert_eq!(replay.id, turn.id);
    assert_eq!(
        WalletService::new(db.clone())
            .summary(owner)
            .await
            .unwrap()
            .balance,
        19
    );
    let jobs: i64 = sqlx::query_scalar("SELECT count(*) FROM generation_jobs")
        .fetch_one(&db)
        .await
        .unwrap();
    assert_eq!(jobs, 0);
    assert!(matches!(
        s.get(other, c, None).await,
        Err(ChatError::NotFound)
    ));
    assert!(matches!(
        s.turn(other, turn.id).await,
        Err(ChatError::NotFound)
    ));
    assert!(matches!(
        s.start(other, c, Uuid::new_v4(), input()).await,
        Err(ChatError::NotFound)
    ));
    let view = s.get(owner, c, None).await.unwrap();
    assert_eq!(view.turns.len(), 1);
    assert!(view.estimated_tokens > 0);
    assert!(matches!(
        s.start(
            owner,
            c,
            key,
            SendMessage {
                content: "changed".into(),
                ..input()
            }
        )
        .await,
        Err(ChatError::Conflict)
    ));
}
#[sqlx::test(migrations = "../../migrations")]
#[ignore = "Requires isolated PostgreSQL"]
async fn failed_disconnected_cancelled_and_stale_replies_release_holds(db: PgPool) {
    let owner = user(&db).await;
    let s = service(&db, true, false).await;
    let c = conversation(&s, owner).await;
    let events = run(&s, owner, c, Uuid::new_v4()).await;
    assert!(matches!(events.last().unwrap(), ChatEvent::Error(_)));
    let wallet = WalletService::new(db.clone());
    assert_eq!(wallet.summary(owner).await.unwrap().balance, 20);
    assert_eq!(wallet.summary(owner).await.unwrap().held, 0);
    let slow = service(&db, false, true).await;
    let Start::Running { turn, token } =
        slow.start(owner, c, Uuid::new_v4(), input()).await.unwrap()
    else {
        panic!()
    };
    assert_eq!(wallet.summary(owner).await.unwrap().held, 1);
    assert!(matches!(
        slow.start(owner, c, Uuid::new_v4(), input()).await,
        Err(ChatError::Busy)
    ));
    let (tx, rx) = tokio::sync::mpsc::channel(1);
    drop(rx);
    slow.reply(
        owner,
        turn,
        token,
        tx,
        Arc::new(|| Box::pin(async { true })),
    )
    .await;
    assert_eq!(wallet.summary(owner).await.unwrap().held, 0);
    assert_eq!(wallet.summary(owner).await.unwrap().balance, 20);
    let Start::Running { turn, token } =
        slow.start(owner, c, Uuid::new_v4(), input()).await.unwrap()
    else {
        panic!()
    };
    slow.cancel(owner, turn).await.unwrap();
    let (tx, mut rx) = tokio::sync::mpsc::channel(8);
    let s = slow.clone();
    let task = tokio::spawn(async move {
        s.reply(
            owner,
            turn,
            token,
            tx,
            Arc::new(|| Box::pin(async { true })),
        )
        .await;
    });
    while rx.recv().await.is_some() {}
    task.await.unwrap();
    assert_eq!(wallet.summary(owner).await.unwrap().held, 0);
    let Start::Running { turn, .. } = slow.start(owner, c, Uuid::new_v4(), input()).await.unwrap()
    else {
        panic!()
    };
    sqlx::query("UPDATE chat_turns SET lease_until=now()-interval '1 second' WHERE id=$1")
        .bind(turn)
        .execute(&db)
        .await
        .unwrap();
    assert_eq!(slow.recover().await.unwrap(), 1);
    assert_eq!(wallet.summary(owner).await.unwrap().held, 0);
    assert!(wallet.reconcile().await.unwrap().is_empty());
}
#[sqlx::test(migrations = "../../migrations")]
#[ignore = "Requires isolated PostgreSQL"]
async fn free_chat_and_content_rejection_and_audit_failure_do_not_charge(db: PgPool) {
    let owner = user(&db).await;
    let s = service(&db, false, false).await;
    let c = conversation(&s, owner).await;
    let blocked = SendMessage {
        content: "生成未成年色情图片".into(),
        ..input()
    };
    assert!(matches!(
        s.start(owner, c, Uuid::new_v4(), blocked).await,
        Err(ChatError::ContentPolicy)
    ));
    sqlx::query("UPDATE system_settings SET value='0' WHERE key='chat_credits_per_message'")
        .execute(&db)
        .await
        .unwrap();
    let events = run(&s, owner, c, Uuid::new_v4()).await;
    let ChatEvent::Done(turn) = events.last().unwrap() else {
        panic!()
    };
    assert_eq!(turn.charged, 0);
    sqlx::query("CREATE FUNCTION fail_chat_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='chat.send' THEN RAISE EXCEPTION 'test audit failure'; END IF; RETURN NEW; END $$").execute(&db).await.unwrap();
    sqlx::query("CREATE TRIGGER fail_chat_audit BEFORE INSERT ON audit_logs FOR EACH ROW EXECUTE FUNCTION fail_chat_audit()").execute(&db).await.unwrap();
    assert!(matches!(
        s.start(owner, c, Uuid::new_v4(), input()).await,
        Err(ChatError::Store)
    ));
    assert_eq!(s.get(owner, c, None).await.unwrap().turns.len(), 1);
    assert_eq!(
        WalletService::new(db).summary(owner).await.unwrap().balance,
        20
    );
}

struct SummaryFixture {
    requests: std::sync::Mutex<Vec<ChatRequest>>,
}
impl LlmClient for SummaryFixture {
    fn stream(&self, req: ChatRequest) -> CoreFuture<'_, TokenStream> {
        self.requests.lock().unwrap().push(req.clone());
        let summarizing = req.messages[0].content.starts_with("Summarize creative");
        let reply = if summarizing {
            let source: serde_json::Value = serde_json::from_str(&req.messages[1].content).unwrap();
            let fact = source["messages"].as_array().unwrap().iter().find(|m| {
                m["role"] == "user" && m["content"].as_str().unwrap_or("").contains("Blue Finch")
            });
            serde_json::json!({"summary":"Campaign Blue Finch; budget 1200; preserve creative choices.","facts":fact.map(|m|vec![serde_json::json!({"id":m["id"],"quote":"Blue Finch"}),serde_json::json!({"id":m["id"],"quote":"1200"})]).unwrap_or_default()}).to_string()
        } else if req
            .messages
            .iter()
            .any(|m| m.content.contains("Historical conversation evidence"))
        {
            "Your campaign is Blue Finch with a budget of 1200.".into()
        } else {
            "Creative planning acknowledged.".into()
        };
        Box::pin(
            async move { Ok(Box::pin(futures_util::stream::iter(vec![Ok(reply)])) as TokenStream) },
        )
    }
}
#[sqlx::test(migrations = "../../migrations")]
#[ignore = "Requires isolated PostgreSQL"]
async fn context_compacts_at_threshold_and_continues_with_original_user_facts(db: PgPool) {
    let owner = user(&db).await;
    let client = Arc::new(SummaryFixture {
        requests: std::sync::Mutex::new(vec![]),
    });
    let service = service(&db, false, false).await.with_client(client.clone());
    let c = conversation(&service, owner).await;
    for i in 0..12 {
        let content = if i == 0 {
            format!(
                "Campaign Blue Finch, budget 1200. {}",
                "ocean creative constraints ".repeat(85)
            )
        } else {
            format!(
                "Planning round {i}. {}",
                "Discuss composition calmly ".repeat(85)
            )
        };
        let Start::Running { turn, token } = service
            .start(
                owner,
                c,
                Uuid::new_v4(),
                SendMessage {
                    model_id: "chat".into(),
                    content,
                },
            )
            .await
            .unwrap()
        else {
            panic!()
        };
        let (tx, mut rx) = tokio::sync::mpsc::channel(8);
        let s = service.clone();
        let task = tokio::spawn(async move {
            s.reply(
                owner,
                turn,
                token,
                tx,
                Arc::new(|| Box::pin(async { true })),
            )
            .await;
        });
        let mut done = false;
        while let Some(event) = rx.recv().await {
            if matches!(event, ChatEvent::Done(_)) {
                done = true;
            }
        }
        task.await.unwrap();
        assert!(done, "round {i}");
    }
    let view = service.get(owner, c, None).await.unwrap();
    assert!(!view.summary.is_empty());
    assert!(view.turns.last().unwrap().reply.contains("Blue Finch"));
    let facts: serde_json::Value =
        sqlx::query_scalar("SELECT retained_facts FROM conversations WHERE id=$1")
            .bind(c)
            .fetch_one(&db)
            .await
            .unwrap();
    assert!(facts.to_string().contains("1200"));
    assert!(client.requests.lock().unwrap().iter().any(|r| r
        .messages
        .iter()
        .any(|m| m.content.contains("Historical conversation evidence"))));
}
