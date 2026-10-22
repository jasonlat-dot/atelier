# M1 / M2 / M3 API 契约

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
| GET /api/v1/auth/google/callback | 回调 iss 必填且严格等于 https://accounts.google.com → 原子消费 state → 后端换 code → ring 验 RS256/JWKS/iss/aud/exp/nonce/Gmail/hd → 事务注册/登录与会话轮换 → 303 /（工作台）；缺失/重复/错误回调 issuer 拒绝且不消费 state；前端不上传 id_token |
| GET /api/v1/me | 服务端 user、csrf_token、mfa_required；不返回 token_hash、Google sub/token、MFA 密钥或虚构积分 |
| PATCH /api/v1/me | 仅 display_name，trim 后 1..100 字符，修改与审计同事务 |
| GET /api/v1/me/sessions | 当前用户有效设备列表，独立 UUID、时间、IP、UA、当前设备标志 |
| DELETE /api/v1/me/sessions/{id} | 只撤销当前用户设备；跨用户/不存在 404；撤销当前设备清 Cookie |
| POST /api/v1/auth/logout | 撤销当前用户全部 Session 并清 Cookie，与审计同事务 |
| POST /api/v1/admin/mfa/setup | 管理员绑定；创建 10 分钟、当前会话绑定的加密待确认 secret；返回本人的一次性 otpauth_uri。已绑定不可覆盖 |
| POST /api/v1/admin/mfa/verify | 只接受 `{code}` 六位数字；确认绑定或验证，单用户时间步原子防重放，成功后当前 Session MFA 有效 12 小时。验证码错误/失效/重放为 401 MFA_INVALID；当前会话的待绑定材料过期为 409 MFA_ENROLLMENT_EXPIRED，可重新调用 setup 生成新材料；不覆盖已启用的验证器 |
| /api/v1/admin/*、/api/admin/* | 普通用户 403；管理员需最近 MFA（绑定/验证入口例外）；写操作限流 60 次/分钟/用户；后续里程碑未实现业务 404 |
| /api/v1/dev/login | 404；无开发登录；媒体接口见 M3 |

受保护请求逐次查 PostgreSQL 最新角色/状态。所有非 GET 的已认证请求必须匹配配置 PUBLIC_BASE_URL 的 Origin/Host，并带 Session 绑定 X-CSRF-Token；重复安全头拒绝。Google start/callback 仅 GET，HEAD 不创建/消费状态。认证响应 no-store、no-referrer。

会话 Cookie 为 __Host-sid（Secure/HttpOnly/SameSite=Lax/Path=/），数据库仅存哈希；空闲 7 天、绝对 30 天。登录轮换本浏览器旧 Cookie，不撤销其他设备；退出所有设备撤销全部会话。

错误体：`{error:{code,message,request_id}}`。401 UNAUTHENTICATED / MFA_INVALID；403 ACCOUNT_DISABLED / FORBIDDEN / MFA_REQUIRED / REGISTRATION_CLOSED / INVITE_REQUIRED；409 IDENTITY_CONFLICT / MFA_ENROLLMENT_EXPIRED；422 VALIDATION；429 TOO_MANY_REQUESTS（Retry-After）；503 SERVICE_UNAVAILABLE。服务端不回显内部错误、连接串或凭据。

MFA 验证额外限制 5 次/5 分钟/用户。角色改变/禁用通过触发器撤销会话；管理员 MFA 操作在事务内再次校验账号/会话，成功写审计。M2 积分接口见上表；生成任务属 M5，尚未实现。

默认只信真实 TCP 对端 IP，忽略 X-Forwarded-For。只有显式配置 TRUSTED_PROXY_IPS 的对端可提供单值 X-Real-IP；代理必须覆盖该头，禁止透传客户端伪造值。Google Client Secret 和 MASTER_KEY 仅后端环境变量必填，无默认值。

## M3 素材接口 · 图片接入切片

路径以 `/api/v1` 为前缀，媒体读取路径除外。所有接口经过真实 Session/账号状态检查，管理员要求最近 MFA；非 GET 要求同源和 CSRF。

| 方法与路径 | 行为 |
| --- | --- |
| GET /assets/limits | 图片/视频大小上限、视频能力开关和最大时长；此切片 video_enabled=false |
| POST /assets/uploads | multipart，且只能包含一个 file 字段；PNG/JPEG/WebP，单张最多 20 MiB；魔数与声明 MIME 一致，解码与尺寸/像素/内存校验，方向校正、重新编码为 PNG、JPEG 缩略图；201 AssetView |
| GET /assets?kind=image&source=upload&search=名称&before=UUID&limit=24 | 当前用户素材按 created_at/id 倒序，kind/source 可省略，search 按名称字面子串匹配、最多 100 字符；limit 1–100；items、total、next_cursor |
| GET /assets/{id} | 当前用户单个未删除/未过期素材及新签名链接；跨用户、不存在、删除或到期统一 404 |
| DELETE /assets/{id} | 本人素材软删，立即撤销所有签名链接；204 |
| DELETE /assets | JSON `{ids:[UUID]}`，1–100 个；全部归属校验和审计同事务，存在跨用户/无效 ID 时整体不删；204 |
| GET /media/{id}/{variant}?expires=…&signature=… | variant=original/thumbnail；要求当前账号 Session 与签名归属一致，HMAC 链接最多 5 分钟，且不超过素材到期时间；支持单段 bytes Range；图片重新编码后才可访问，no-store/no-referrer/nosniff，不公开存储键或 S3 地址 |

默认 FREE 素材保留 30 天；预留订阅保留设置 180 天，订阅业务尚未实现。当前每用户最多 500 个未到期素材、合计 2 GiB，上传 10 次/分钟/用户；全局并发与流式读取限额约束内存。INVALID_MEDIA 422、MEDIA_TOO_LARGE 413、ASSET_QUOTA_EXCEEDED 409、繁忙/限流 429、存储故障 503。删除/到期后台每分钟重试清理文件；中断上传可回收。未实现画布引用，未提供拖到画布的假操作。

媒体默认 MEDIA_STORAGE=local、MEDIA_DIR=data/media，拒绝与现有 WEB_DIR 重叠；文件路径从服务器 UUID 生成，不使用原始文件名。可配置 HTTPS S3 兼容后端（服务端 S3_ENDPOINT/BUCKET/REGION/ACCESS_KEY_ID/SECRET_ACCESS_KEY）；未提供实 S3 凭据，当前验收覆盖本地存储，S3 实服务及视频转码仍待后续切片验证。
