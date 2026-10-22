use axum::{extract::{Path,State},http::{header,HeaderMap,StatusCode},response::{IntoResponse,Response},routing::{get,post,put},Json,Router};
use chrono::{DateTime,Utc};
use serde::{Deserialize,Serialize};
use serde_json::{json,Value};
use sqlx::{PgPool,Row,postgres::PgPoolOptions};
use std::{collections::HashMap,env,net::SocketAddr,sync::Arc,time::Duration};
use tokio::sync::RwLock;
use uuid::Uuid;

#[derive(Clone)] struct AppState{db:PgPool,sessions:Arc<RwLock<HashMap<String,Uuid>>>,dev_auth:bool}
#[derive(Debug)] struct ApiError(StatusCode,String);
impl IntoResponse for ApiError{fn into_response(self)->Response{(self.0,Json(json!({"error":self.1}))).into_response()}}
impl From<sqlx::Error> for ApiError{fn from(e:sqlx::Error)->Self{tracing::error!(error=%e,"database failure");Self(StatusCode::INTERNAL_SERVER_ERROR,"database error".into())}}
type ApiResult<T>=Result<T,ApiError>;
fn bad(msg:&str)->ApiError{ApiError(StatusCode::BAD_REQUEST,msg.into())}
fn forbidden()->ApiError{ApiError(StatusCode::FORBIDDEN,"forbidden".into())}
fn not_found()->ApiError{ApiError(StatusCode::NOT_FOUND,"not found".into())}

#[tokio::main]async fn main()->Result<(),Box<dyn std::error::Error>>{
 tracing_subscriber::fmt().with_env_filter(tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_|"atelier_api=info".into())).init();
 let db_url=env::var("DATABASE_URL").expect("DATABASE_URL must be set");
 let bind=env::var("BIND_ADDRESS").unwrap_or_else(|_|"127.0.0.1:8080".to_string());
 let addr:SocketAddr=bind.parse()?;
 let dev_auth=env::var("DEV_AUTH").unwrap_or_default()=="true";
 if dev_auth&&!addr.ip().is_loopback(){return Err("DEV_AUTH is allowed only with loopback bind address".into());}
 let pool=PgPoolOptions::new().max_connections(12).connect(&db_url).await?;
 sqlx::migrate!("./migrations").run(&pool).await?;
 if dev_auth{seed_development_users(&pool).await?;}
 let state=Arc::new(AppState{db:pool,sessions:Arc::new(RwLock::new(HashMap::new())),dev_auth});
 let app=Router::new()
  .route("/api/v1/health",get(||async{Json(json!({"ok":true,"mode":"foundation"}))}))
  .route("/api/v1/dev/login",post(dev_login))
  .route("/api/v1/me",get(me))
  .route("/api/v1/projects",get(projects).post(create_project))
  .route("/api/v1/projects/{id}/graph",get(read_graph).put(save_graph))
  .route("/api/v1/generation/quotes",post(quote))
  .route("/api/v1/generation/jobs",post(create_job).get(list_jobs))
  .route("/api/v1/generation/jobs/{id}/cancel",post(cancel_job))
  .route("/api/v1/wallet",get(wallet))
  .route("/api/v1/assets",get(list_assets))
  .route("/api/v1/model-catalog",get(models))
  .with_state(state.clone());
 if dev_auth{tokio::spawn(mock_worker(state.db.clone()));}
 tracing::info!(%bind,dev_auth,"Atelier API listening");
 let listener=tokio::net::TcpListener::bind(addr).await?;
 axum::serve(listener,app).await?;Ok(())
}
async fn seed_development_users(db:&PgPool)->Result<(),sqlx::Error>{for (email,name,role,credits) in [
 ("mira@gmail.com","Mira Chen","USER",2680_i64),
 ("jordan@gmail.com","Jordan Lee","ADMIN",10000_i64),
 ("owner@gmail.com","Studio Owner","SUPER_ADMIN",25000_i64)]{
 sqlx::query("INSERT INTO users(email,display_name,role,credits) VALUES($1,$2,$3,$4) ON CONFLICT(email) DO NOTHING")
 .bind(email).bind(name).bind(role).bind(credits).execute(db).await?;
 }Ok(())}
async fn actor(headers:&HeaderMap,state:&AppState)->ApiResult<Uuid>{
 let cookie=headers.get(header::COOKIE).and_then(|v|v.to_str().ok()).ok_or(ApiError(StatusCode::UNAUTHORIZED,"missing session".into()))?;
 let sid=cookie.split(';').map(str::trim).find_map(|s|s.strip_prefix("atelier_sid=")).ok_or(ApiError(StatusCode::UNAUTHORIZED,"missing session".into()))?;
 let id=state.sessions.read().await.get(sid).copied().ok_or(ApiError(StatusCode::UNAUTHORIZED,"expired session".into()))?;
 let status:Option<(String,)> =sqlx::query_as("SELECT status FROM users WHERE id=$1").bind(id).fetch_optional(&state.db).await?;
 if status.map(|s|s.0)==Some("ACTIVE".to_string()){Ok(id)}else{Err(forbidden())}
}
#[derive(Deserialize)]#[serde(rename_all="camelCase")]struct LoginBody{user_id:String}
async fn dev_login(State(state):State<Arc<AppState>>,Json(body):Json<LoginBody>)->ApiResult<Response>{
 if !state.dev_auth{return Err(not_found());}
 let email=match body.user_id.as_str(){"user-demo"=>"mira@gmail.com","admin-demo"=>"jordan@gmail.com","root-demo"=>"owner@gmail.com",_=>return Err(bad("unknown dev identity"))};
 let id:Uuid=sqlx::query_scalar("SELECT id FROM users WHERE email=$1").bind(email).fetch_one(&state.db).await?;
 let sid=Uuid::new_v4().to_string();state.sessions.write().await.insert(sid.clone(),id);
 let cookie=format!("atelier_sid={sid}; Path=/; HttpOnly; SameSite=Strict; Max-Age=43200");
 Ok(([(header::SET_COOKIE,cookie)],Json(json!({"ok":true,"developmentOnly":true}))).into_response())
}
async fn me(State(state):State<Arc<AppState>>,headers:HeaderMap)->ApiResult<Json<Value>>{
 let id=actor(&headers,&state).await?;let r=sqlx::query("SELECT email,display_name,role,credits,status FROM users WHERE id=$1").bind(id).fetch_one(&state.db).await?;
 Ok(Json(json!({"id":id,"email":r.get::<String,_>("email"),"name":r.get::<String,_>("display_name"),"role":r.get::<String,_>("role"),"credits":r.get::<i64,_>("credits"),"avatar":"AC","disabled":r.get::<String,_>("status")!="ACTIVE"})))
}
fn project_json(r:&sqlx::postgres::PgRow)->Value{json!({"id":r.get::<Uuid,_>("id"),"ownerId":r.get::<Uuid,_>("owner_id"),"name":r.get::<String,_>("name"),"revision":r.get::<i64,_>("revision"),"updatedAt":r.get::<DateTime<Utc>,_>("updated_at"),"graph":r.get::<Value,_>("graph")})}
async fn projects(State(state):State<Arc<AppState>>,headers:HeaderMap)->ApiResult<Json<Value>>{let id=actor(&headers,&state).await?;let rows=sqlx::query("SELECT * FROM projects WHERE owner_id=$1 ORDER BY updated_at DESC LIMIT 100").bind(id).fetch_all(&state.db).await?;Ok(Json(Value::Array(rows.iter().map(project_json).collect())))}
#[derive(Deserialize)]struct NewProject{name:String}
async fn create_project(State(state):State<Arc<AppState>>,headers:HeaderMap,Json(body):Json<NewProject>)->ApiResult<Json<Value>>{let id=actor(&headers,&state).await?;if body.name.trim().is_empty()||body.name.len()>200{return Err(bad("project name length invalid"));}
 let row=sqlx::query("INSERT INTO projects(owner_id,name) VALUES($1,$2) RETURNING *").bind(id).bind(body.name.trim()).fetch_one(&state.db).await?;Ok(Json(project_json(&row)))}
async fn read_graph(State(state):State<Arc<AppState>>,headers:HeaderMap,Path(id):Path<Uuid>)->ApiResult<Json<Value>>{let owner=actor(&headers,&state).await?;let row=sqlx::query("SELECT * FROM projects WHERE id=$1 AND owner_id=$2").bind(id).bind(owner).fetch_optional(&state.db).await?.ok_or_else(not_found)?;Ok(Json(project_json(&row)))}
#[derive(Deserialize)]struct GraphBody{graph:Value,revision:i64}
async fn save_graph(State(state):State<Arc<AppState>>,headers:HeaderMap,Path(id):Path<Uuid>,Json(body):Json<GraphBody>)->ApiResult<Json<Value>>{
 let owner=actor(&headers,&state).await?;
 let etag=headers.get(header::IF_MATCH).and_then(|s|s.to_str().ok()).and_then(|v|v.parse::<i64>().ok()).ok_or_else(||bad("If-Match revision is required"))?;
 if etag!=body.revision{return Err(ApiError(StatusCode::CONFLICT,"revision mismatch".into()));}
 let nodes=body.graph.get("nodes").and_then(Value::as_array).ok_or_else(||bad("graph.nodes must be array"))?;
 let edges=body.graph.get("edges").and_then(Value::as_array).ok_or_else(||bad("graph.edges must be array"))?;
 if nodes.len()>800||edges.len()>1600||body.graph.to_string().len()>1_500_000{return Err(bad("graph exceeds size limits"));}
 let row=sqlx::query("UPDATE projects SET graph=$1,revision=revision+1,updated_at=now() WHERE id=$2 AND owner_id=$3 AND revision=$4 RETURNING *")
 .bind(body.graph).bind(id).bind(owner).bind(etag).fetch_optional(&state.db).await?;
 match row{Some(r)=>Ok(Json(project_json(&r))),None=>Err(ApiError(StatusCode::CONFLICT,"project missing or stale revision".into()))}
}
#[derive(Deserialize)]#[serde(rename_all="camelCase")]struct QuoteBody{kind:String,quality:String,count:i32,duration:i32}
fn price(q:&QuoteBody)->ApiResult<i64>{if q.count<1||q.count>4||q.duration<1||q.duration>16{return Err(bad("count or duration invalid"));}let base=match q.kind.as_str(){"image"=>12.0,"video"=>18.0,_=>return Err(bad("kind invalid"))};let quality=match q.quality.as_str(){"low"|"480p"=>1.0,"medium"|"720p"=>1.5,"high"|"1080p"=>2.0,_=>return Err(bad("quality invalid"))};Ok((base*quality*f64::from(q.count)*(if q.kind=="video"{f64::from(q.duration)}else{1.0})).ceil() as i64)}
async fn quote(State(state):State<Arc<AppState>>,headers:HeaderMap,Json(q):Json<QuoteBody>)->ApiResult<Json<Value>>{actor(&headers,&state).await?;Ok(Json(json!({"credits":price(&q)?})))}
#[derive(Deserialize)]#[serde(rename_all="camelCase")]struct NewJob{project_id:Uuid,node_id:String,kind:String,prompt:String,quality:String,ratio:String,model:String,duration:Option<i32>,count:i32,reference_asset_ids:Option<Vec<Uuid>>}
fn job_json(row:&sqlx::postgres::PgRow)->Value{json!({"id":row.get::<Uuid,_>("id"),"ownerId":row.get::<Uuid,_>("owner_id"),"projectId":row.get::<Uuid,_>("project_id"),"nodeId":row.get::<String,_>("node_id"),"kind":row.get::<String,_>("kind"),"prompt":row.get::<String,_>("prompt"),"quality":row.get::<String,_>("quality"),"ratio":row.get::<String,_>("ratio"),"model":row.get::<String,_>("model"),"duration":row.get::<i32,_>("duration"),"count":row.get::<i32,_>("count"),"cost":row.get::<i64,_>("cost"),"status":row.get::<String,_>("status"),"progress":row.get::<i32,_>("progress"),"resultAssetIds":row.get::<Value,_>("result_asset_ids"),"referenceAssetIds":row.get::<Value,_>("reference_asset_ids"),"charged":row.get::<String,_>("status")=="completed","idempotencyKey":row.get::<String,_>("idempotency_key"),"createdAt":row.get::<DateTime<Utc>,_>("created_at"),"updatedAt":row.get::<DateTime<Utc>,_>("updated_at")})}
async fn create_job(State(state):State<Arc<AppState>>,headers:HeaderMap,Json(req):Json<NewJob>)->ApiResult<Json<Value>>{
 let owner=actor(&headers,&state).await?;
 let key=headers.get("idempotency-key").and_then(|h|h.to_str().ok()).ok_or_else(||bad("Idempotency-Key required"))?;
 if key.is_empty()||key.len()>128{return Err(bad("invalid idempotency key"));}
 if req.prompt.trim().is_empty()||req.prompt.len()>8000||req.node_id.len()>160{return Err(bad("invalid prompt or node id"));}
 if !["16:9","9:16","1:1","4:3"].contains(&req.ratio.as_str()){return Err(bad("invalid aspect ratio"));}
 if (req.kind=="video"&&req.model!="motion-demo")||(req.kind=="image"&&req.model!="image-demo"){return Err(bad("model capability mismatch"));}
 let duration=req.duration.unwrap_or(6);let cost=price(&QuoteBody{kind:req.kind.clone(),quality:req.quality.clone(),count:req.count,duration})?;
 let mut tx=state.db.begin().await?;
 // Serialize one user's money-related operations so a repeated request cannot double-spend.
 let balance:Option<(i64,)>=sqlx::query_as("SELECT credits FROM users WHERE id=$1 FOR UPDATE").bind(owner).fetch_optional(&mut *tx).await?;
 let balance=balance.ok_or_else(forbidden)?.0;
 let existing=sqlx::query("SELECT * FROM generation_jobs WHERE owner_id=$1 AND idempotency_key=$2").bind(owner).bind(key).fetch_optional(&mut *tx).await?;
 if let Some(r)=existing{
  let prev_project:Uuid=r.get("project_id");let prev_model:String=r.get("model");let prev_prompt:String=r.get("prompt");
  if prev_project!=req.project_id||prev_model!=req.model||prev_prompt!=req.prompt{
   return Err(ApiError(StatusCode::CONFLICT,"idempotency key reused with different request".into()));
  }
  tx.commit().await?;return Ok(Json(job_json(&r)));
 }
 let owns:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM projects WHERE id=$1 AND owner_id=$2)").bind(req.project_id).bind(owner).fetch_one(&mut *tx).await?;
 if !owns{return Err(not_found());}
 let references=req.reference_asset_ids.unwrap_or_default();
 if references.len()>4{return Err(bad("too many reference assets"));}
 for asset_id in &references{
  let allowed:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM assets WHERE id=$1 AND owner_id=$2 AND state='READY')").bind(asset_id).bind(owner).fetch_one(&mut *tx).await?;
  if !allowed{return Err(forbidden());}
 }
 if balance<cost{return Err(ApiError(StatusCode::PAYMENT_REQUIRED,"insufficient credits".into()));}
 sqlx::query("UPDATE users SET credits=credits-$1 WHERE id=$2").bind(cost).bind(owner).execute(&mut *tx).await?;
 let row=sqlx::query("INSERT INTO generation_jobs(owner_id,project_id,node_id,kind,model,prompt,quality,ratio,duration,count,cost,idempotency_key,reference_asset_ids) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *")
 .bind(owner).bind(req.project_id).bind(req.node_id).bind(&req.kind).bind(&req.model).bind(&req.prompt).bind(&req.quality).bind(&req.ratio).bind(duration).bind(req.count).bind(cost).bind(key).bind(json!(references)).fetch_one(&mut *tx).await?;
 let job_id:Uuid=row.get("id");
 sqlx::query("INSERT INTO wallet_ledger(user_id,job_id,amount,reason) VALUES($1,$2,$3,'hold')").bind(owner).bind(job_id).bind(-cost).execute(&mut *tx).await?;
 tx.commit().await?;Ok(Json(job_json(&row)))
}
async fn list_jobs(State(state):State<Arc<AppState>>,headers:HeaderMap)->ApiResult<Json<Value>>{let owner=actor(&headers,&state).await?;let rows=sqlx::query("SELECT * FROM generation_jobs WHERE owner_id=$1 ORDER BY created_at DESC LIMIT 100").bind(owner).fetch_all(&state.db).await?;Ok(Json(Value::Array(rows.iter().map(job_json).collect())))}
async fn cancel_job(State(state):State<Arc<AppState>>,headers:HeaderMap,Path(id):Path<Uuid>)->ApiResult<Json<Value>>{
 let owner=actor(&headers,&state).await?;let mut tx=state.db.begin().await?;
 // Lock user first; worker also locks user before job, preventing refund/completion races.
 sqlx::query("SELECT id FROM users WHERE id=$1 FOR UPDATE").bind(owner).fetch_one(&mut *tx).await?;
 let row=sqlx::query("SELECT * FROM generation_jobs WHERE id=$1 AND owner_id=$2 FOR UPDATE").bind(id).bind(owner).fetch_optional(&mut *tx).await?.ok_or_else(not_found)?;
 let status:String=row.get("status");if ["completed","failed","cancelled"].contains(&status.as_str()){tx.commit().await?;return Ok(Json(job_json(&row)));}
 let cost:i64=row.get("cost");
 sqlx::query("UPDATE generation_jobs SET status='cancelled',updated_at=now() WHERE id=$1").bind(id).execute(&mut *tx).await?;
 sqlx::query("UPDATE users SET credits=credits+$1 WHERE id=$2").bind(cost).bind(owner).execute(&mut *tx).await?;
 sqlx::query("INSERT INTO wallet_ledger(user_id,job_id,amount,reason) VALUES($1,$2,$3,'cancel_refund') ON CONFLICT(job_id,reason) DO NOTHING").bind(owner).bind(id).bind(cost).execute(&mut *tx).await?;
 tx.commit().await?;Ok(Json(json!({"id":id,"status":"cancelled","refundedCredits":cost})))
}
async fn wallet(State(state):State<Arc<AppState>>,headers:HeaderMap)->ApiResult<Json<Value>>{
 let owner=actor(&headers,&state).await?;
 let credits:i64=sqlx::query_scalar("SELECT credits FROM users WHERE id=$1").bind(owner).fetch_one(&state.db).await?;
 let rows=sqlx::query("SELECT id,job_id,amount,reason,created_at FROM wallet_ledger WHERE user_id=$1 ORDER BY created_at DESC LIMIT 40").bind(owner).fetch_all(&state.db).await?;
 let ledger:Vec<Value>=rows.iter().map(|r|json!({"id":r.get::<Uuid,_>("id"),"jobId":r.get::<Option<Uuid>,_>("job_id"),"amount":r.get::<i64,_>("amount"),"reason":r.get::<String,_>("reason"),"at":r.get::<DateTime<Utc>,_>("created_at")})).collect();
 Ok(Json(json!({"available":credits,"ledger":ledger})))
}

async fn models(State(state):State<Arc<AppState>>,headers:HeaderMap)->ApiResult<Json<Value>>{
 actor(&headers,&state).await?;
 Ok(Json(json!([
  {"id":"image-demo","label":"Atelier Image","kind":"image","enabled":true,"cost":30,"provider":"Mock provider"},
  {"id":"motion-demo","label":"Atelier Motion","kind":"video","enabled":true,"cost":150,"provider":"Mock provider"}
 ])))
}
async fn list_assets(State(state):State<Arc<AppState>>,headers:HeaderMap)->ApiResult<Json<Value>>{
 let owner=actor(&headers,&state).await?;
 let rows=sqlx::query("SELECT id,owner_id,kind,display_name,object_key,poster_key,created_at FROM assets WHERE owner_id=$1 AND state='READY' ORDER BY created_at DESC LIMIT 200").bind(owner).fetch_all(&state.db).await?;
 let assets:Vec<Value>=rows.iter().map(|r|json!({
  "id":r.get::<Uuid,_>("id"),"ownerId":r.get::<Uuid,_>("owner_id"),
  "kind":r.get::<String,_>("kind"),"name":r.get::<String,_>("display_name"),
  "src":r.get::<String,_>("object_key"),"poster":r.get::<Option<String>,_>("poster_key"),
  "createdAt":r.get::<DateTime<Utc>,_>("created_at")
 })).collect();
 Ok(Json(Value::Array(assets)))
}
async fn mock_worker(pool:PgPool){let mut tick=tokio::time::interval(Duration::from_millis(800));loop{tick.tick().await;let rows=sqlx::query("SELECT id,owner_id,progress FROM generation_jobs WHERE status IN ('queued','routing','generating') ORDER BY created_at LIMIT 30").fetch_all(&pool).await;let Ok(rows)=rows else{continue};for r in rows{let id:Uuid=r.get("id");let owner:Uuid=r.get("owner_id");let mut tx=match pool.begin().await{Ok(t)=>t,Err(_)=>continue};if sqlx::query("SELECT id FROM users WHERE id=$1 FOR UPDATE").bind(owner).fetch_one(&mut *tx).await.is_err(){continue;}let row=sqlx::query("SELECT progress,status FROM generation_jobs WHERE id=$1 FOR UPDATE").bind(id).fetch_optional(&mut *tx).await;let Ok(Some(row))=row else{continue};let status:String=row.get("status");if !["queued","routing","generating"].contains(&status.as_str()){continue;}
 let progress:i32=row.get("progress");let next=(progress+9).min(100);let next_status=if next==100{"completed"}else if next>24{"generating"}else if next>10{"routing"}else{"queued"};
 if next==100{
  let jr=sqlx::query("SELECT kind,prompt FROM generation_jobs WHERE id=$1").bind(id).fetch_one(&mut *tx).await;
  if let Ok(jr)=jr{
   let kind:String=jr.get("kind");let prompt:String=jr.get("prompt");
   let object_key=if kind=="video"{"/assets/sample-motion.mp4"}else{"/assets/art-dusk.svg"};
   let poster=if kind=="video"{Some("/assets/video-frame.png")}else{None};
   if let Ok(asset_id)=sqlx::query_scalar::<_,Uuid>("INSERT INTO assets(owner_id,kind,display_name,object_key,poster_key) VALUES($1,$2,$3,$4,$5) RETURNING id")
    .bind(owner).bind(&kind).bind(format!("生成结果 · {}",prompt.chars().take(15).collect::<String>())).bind(object_key).bind(poster).fetch_one(&mut *tx).await{
    let _=sqlx::query("UPDATE generation_jobs SET result_asset_ids=$1 WHERE id=$2").bind(json!([asset_id.to_string()])).bind(id).execute(&mut *tx).await;
   }
  }
 }
 if sqlx::query("UPDATE generation_jobs SET progress=$1,status=$2,updated_at=now() WHERE id=$3").bind(next).bind(next_status).bind(id).execute(&mut *tx).await.is_ok(){let _=tx.commit().await;}
 }}}
