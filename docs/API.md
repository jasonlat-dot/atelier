# M1 / M2 API 契约

结构化契约：`openapi.json`（utoipa）；前端类型：`apps/web/src/lib/generated/api.d.ts`。一致性检查：`python scripts/check_contract.py`。

## M2 钱包接口

下表路径均以 `/api/v1` 为前缀；只读取当前会话所属钱包。非 GET 必须通过同源、CSRF 校验；管理员还要求有效 MFA 与写限流。请求体不接受客户端价格或余额。

| 方法与路径 | 行为 |
| --- | --- |
| GET /wallet | balance、held、available、local_date、timezone、checked_in_today、streak、next_reward |
| GET /wallet/ledger?before=ID&limit=25 | 当前用户账本按 ID 倒序；limit 1–100；返回 items、next_cursor |
| POST /wallet/checkin | Redis 10 次/分钟/用户；自然日一次。返回 local_date、streak、credits、already_checked_in，重复签到不发积分 |
| POST /wallet/redeem | body: code；必填 UUID Idempotency-Key；返回首次 CreditReceipt；同键异码 422 |
| POST /admin/users/{id}/credits | ADMIN：amount 非零整数、reason 必填且最多 500 字符；UUID Idempotency-Key；审计与调账同事务 |
| POST /admin/redeem-codes | ADMIN：count 1–100、credits 正数、max_uses 1–10000、expires_at 可选；随机明文仅本次返回，不自动重试 |
| GET /admin/redeem-codes?before=UUID | ADMIN：按 UUID 倒序，最多 50 条；before 为末项 ID。仅元数据，不返回明文或哈希 |

余额不足为 402 INSUFFICIENT_CREDITS；请求键异参为 422 IDEMPOTENCY_CONFLICT；无效/已用/过期兑换码统一为 422 INVALID_REDEEM_CODE；存储故障为 503，限流 429。认证响应均 no-store。资金请求返回的是不可变首次收据，余额应重新 GET /wallet。注册默认赠送 20，只针对 M2 之后成功创建的新身份。

## M1 身份接口

| 方法与路径 | 行为 |
| --- | --- |
| GET /api/v1/health | 进程存活检查，不替代基础设施就绪检查 |
| GET /api/v1/public/config | 最新 registration_mode 与版本；不返回白名单/凭据；no-store |
| GET /api/v1/auth/google/start?invite=… | 20 次/10 分钟/IP；state/nonce/S256 PKCE，Redis TTL 600 秒，浏览器绑定 Cookie，302 Google；邀请码只绑定在服务端 state 中 |
| GET /api/v1/auth/google/callback | 回调 iss 必填且严格等于 https://accounts.google.com → 原子消费 state → 后端换 code → ring 验 RS256/JWKS/iss/aud/exp/nonce/Gmail/hd → 事务注册/登录与会话轮换 → 303 /settings；缺失/重复/错误回调 issuer 拒绝且不消费 state；前端不上传 id_token |
| GET /api/v1/me | 服务端 user、csrf_token、mfa_required；不返回 token_hash、Google sub/token、MFA 密钥或虚构积分 |
| PATCH /api/v1/me | 仅 display_name，trim 后 1..100 字符，修改与审计同事务 |
| GET /api/v1/me/sessions | 当前用户有效设备列表，独立 UUID、时间、IP、UA、当前设备标志 |
| DELETE /api/v1/me/sessions/{id} | 只撤销当前用户设备；跨用户/不存在 404；撤销当前设备清 Cookie |
| POST /api/v1/auth/logout | 撤销当前用户全部 Session 并清 Cookie，与审计同事务 |
| POST /api/v1/admin/mfa/setup | 管理员绑定；创建 10 分钟、当前会话绑定的加密待确认 secret；返回本人的一次性 otpauth_uri。已绑定不可覆盖 |
| POST /api/v1/admin/mfa/verify | 只接受 `{code}` 六位数字；确认绑定或验证，单用户时间步原子防重放，成功后当前 Session MFA 有效 12 小时 |
| /api/v1/admin/*、/api/admin/* | 普通用户 403；管理员需最近 MFA（绑定/验证入口例外）；写操作限流 60 次/分钟/用户；后续里程碑未实现业务 404 |
| /api/v1/dev/login、/media/* | 404；无开发登录，媒体由 M3 实现 |

受保护请求逐次查 PostgreSQL 最新角色/状态。所有非 GET 的已认证请求必须匹配配置 PUBLIC_BASE_URL 的 Origin/Host，并带 Session 绑定 X-CSRF-Token；重复安全头拒绝。Google start/callback 仅 GET，HEAD 不创建/消费状态。认证响应 no-store、no-referrer。

会话 Cookie 为 __Host-sid（Secure/HttpOnly/SameSite=Lax/Path=/），数据库仅存哈希；空闲 7 天、绝对 30 天。登录轮换本浏览器旧 Cookie，不撤销其他设备；退出所有设备撤销全部会话。

错误体：`{error:{code,message,request_id}}`。401 UNAUTHENTICATED / MFA_INVALID；403 ACCOUNT_DISABLED / FORBIDDEN / MFA_REQUIRED / REGISTRATION_CLOSED / INVITE_REQUIRED；409 IDENTITY_CONFLICT；422 VALIDATION；429 TOO_MANY_REQUESTS（Retry-After）；503 SERVICE_UNAVAILABLE。服务端不回显内部错误、连接串或凭据。

MFA 验证额外限制 5 次/5 分钟/用户。角色改变/禁用通过触发器撤销会话；管理员 MFA 操作在事务内再次校验账号/会话，成功写审计。M2 积分接口见上表；生成任务属 M5，尚未实现。

默认只信真实 TCP 对端 IP，忽略 X-Forwarded-For。只有显式配置 TRUSTED_PROXY_IPS 的对端可提供单值 X-Real-IP；代理必须覆盖该头，禁止透传客户端伪造值。Google Client Secret 和 MASTER_KEY 仅后端环境变量必填，无默认值。
