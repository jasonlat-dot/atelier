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

## M3 素材接口 · 图片与视频

路径以 `/api/v1` 为前缀，媒体读取路径除外。所有接口经过真实 Session/账号状态检查，管理员要求最近 MFA；非 GET 要求同源和 CSRF。

| 方法与路径 | 行为 |
| --- | --- |
| GET /assets/limits | 图片/视频大小上限、视频能力开关和最大时长；video_enabled 取决于服务启动时的工具检查 |
| POST /assets/uploads | multipart，且只能包含一个 file 字段；PNG/JPEG/WebP 最多 20 MiB，校验后重新编码为 PNG、JPEG 缩略图；MP4/WebM 最多 200 MiB、60 秒，校验后返回 PROCESSING，后台转码后为 READY；201 AssetView |
| GET /assets?kind=image&source=upload&search=名称&before=UUID&limit=24 | 当前用户素材按 created_at/id 倒序，kind/source 可省略，search 按名称字面子串匹配、最多 100 字符；limit 1–100；items、total、next_cursor |
| GET /assets/{id} | 当前用户单个未删除/未过期素材及新签名链接；跨用户、不存在、删除或到期统一 404 |
| DELETE /assets/{id} | 本人素材软删，立即撤销所有签名链接；204 |
| DELETE /assets | JSON `{ids:[UUID]}`，1–100 个；全部归属校验和审计同事务，存在跨用户/无效 ID 时整体不删；204 |
| GET /media/{id}/{variant}?expires=…&signature=… | variant=original/thumbnail；要求当前账号 Session 与签名归属一致，HMAC 链接最多 5 分钟，且不超过素材到期时间；支持单段 bytes Range；图片重新编码后才可访问，no-store/no-referrer/nosniff，不公开存储键或 S3 地址 |

默认 FREE 素材保留 30 天；预留订阅保留设置 180 天，订阅业务尚未实现。当前每用户最多 500 个未到期素材、合计 2 GiB，上传 10 次/分钟/用户；全局并发与流式读取限额约束内存。INVALID_MEDIA 422、MEDIA_TOO_LARGE 413、ASSET_QUOTA_EXCEEDED 409、繁忙/限流 429、存储故障 503。删除/到期后台每分钟重试清理文件；中断上传可回收。未实现画布引用，未提供拖到画布的假操作。

视频只接受单视频流的 H.264/HEVC/VP8/VP9/AV1、最大 4096 边长和 900 万像素。FFmpeg 以管道输入，协议白名单仅 pipe/cache，禁用输入 file/concat/网络协议；单进程内存上限 1 GiB、探测/封面 20 秒、转码 120 秒，共用有限处理并发。重新编码为 H.264/AAC MP4 后才生成可读链接，原始上传体从不对外提供，成功后删除。任务在 PostgreSQL 持久化，以租约和唯一令牌领取，最多三次尝试；FAILED 可删除并重新上传，签名读取与断点 Range 使用流式响应。待处理视频按 400 MiB 预占用户空间，避免转码膨胀绕过 2 GiB 配额；源文件回收后释放预占。VIDEO_UNAVAILABLE 为 503。

媒体默认 MEDIA_STORAGE=local、MEDIA_DIR=data/media，拒绝与现有 WEB_DIR 重叠；文件路径从服务器 UUID 生成，不使用原始文件名。当前交付和验收使用本地存储与真实视频转码。S3 按负责人最新指令改为待定；已有 HTTPS S3 兼容适配与服务端配置保留，实服务未验收，不作为本次 M3 完成条件。

## M4 账号池、模型与定价

管理路径均为 `/api/v1/admin` 前缀，要求 ADMIN/SUPER_ADMIN、最近 MFA；写操作另要求同源、CSRF、管理员限流及同事务脱敏审计。输入严格拒绝未知字段。密钥、base_url、upstream_model 仅写入，任何视图/审计/错误均不回显；编辑时 null/空字符串保留旧值。

| 方法与路径 | 行为 |
| --- | --- |
| GET /upstream-accounts?search=…&before=UUID | 名称/分组字面子串搜索；50 条游标分页；含状态、额度、在用数和近 24 小时成功/请求数与平均耗时 |
| POST /upstream-accounts | AccountInput，创建且必须提供地址与密钥；201 脱敏 AccountView |
| GET、PATCH /upstream-accounts/{id} | 读取/完整编辑脱敏配置；编辑必带 revision，过期 409 CONFIG_CONFLICT；额度变更使用专门动作，使用中不能替换地址/密钥 |
| DELETE /upstream-accounts/{id}?revision=N | 软删；在用或版本冲突 409；成功 204 |
| POST /upstream-accounts/import | JSON 数组 1–100 个 AccountInput、最多 1 MiB，整体成功或回滚；201 脱敏数组；本轮采用规格允许的 JSON 格式，不额外支持 CSV |
| POST /upstream-accounts/{id}/test | 受限 GET /models，不生成付费内容；返回 ok/code/elapsed_ms，记录审计与统计；失败仅返回固定错误分类 |
| POST /upstream-accounts/{id}/refresh-quota | QuotaInput：revision、quota_total、quota_remaining、quota_reset_at；管理员手动更新，不伪报供应商实时余额 |
| GET /upstream-accounts/{id}/stats | 24 小时请求数、成功数、平均耗时和固定错误分类分布，包含连通性测试 |
| GET、POST、PATCH /models | 模型目录/创建/完整编辑；image/video/chat；新建先禁用，配置能力、价格和账号绑定后方可启用；上游模型标识仅写 |
| PUT /models/{id}/accounts | BindingInput：revision、account_ids、group_tags；明确绑定与分组动态绑定取并集，整体校验并写审计 |
| GET、PUT /pricing | Pricing：全局 revision、rules 和全部六种分辨率倍率；版本冲突 409，原子替换且不能使已启用模型缺价格。图片按质量基价×分辨率倍率；视频基价按秒；参考图附加费用单独保存 |
| GET /api/v1/models | 普通已登录用户可读的启用目录，仅公开 ID、展示名、能力及价格；无账号 ID、分组、上游地址/标识或密钥信息 |

账号最多 500 个，模型最多 200 个。凭据独立域派生并以 XChaCha20-Poly1305 加密，关联账号和版本。管理员配置的上游账号接受合法 HTTP/HTTPS 地址，不按 IP 范围过滤；localhost、IPv4/IPv6、内网/公网和域名均支持，无需白名单。保存不做 DNS/连通性检查，实际请求时解析并固定 DNS，限制并发/响应体/时长，禁止重定向和环境代理。上游返回的下载地址仅继承已配置账号的同源访问权限，其他下载地址继续执行现有策略。

Provider 和调度为内部 service：图片 generations/edits；视频 /videos 提交、查询、内容下载，返回内部字节而非上游地址。Redis 原子槽与 PG 额度预占防并发超额，60 秒租约/20 秒续期，取消/panic 释放；按优先级、权重、空闲并发和剩余额度选账号。401/403 凭据失效、429 冷却/额度耗尽，5xx/超时连续三次冷却并指数退避；内容拒绝/参数错误不换号。最多三次尝试，已产出图片或已接受视频任务后不重复提交。每五分钟探测到期账号，额度重置只在显式 quota_reset_at 到期且探测成功时执行，未知余额不自动补满。

M4 不开放用户生成/任务/quote/SSE 接口，不修改钱包余额；这些属于 M5。HTTP 后端与现有原型管理页面已接通：`/admin/accounts`、`/admin/models`；历史 `/admin/providers` 导航至账号池。


## M5 生成任务

所有路径以 `/api/v1` 为前缀，要求登录，管理员要求最近 MFA；写请求要求同源与 CSRF。客户端价格不被接受。quote/create 各按用户 30 次/分钟，JSON 最多 32 KiB。

| 方法与路径 | 行为 |
| --- | --- |
| POST /generation/quote | QuoteInput：model_id、quality、ratio、resolution、n、ref_count、可选 seconds；返回 kind、cost/cost_per_output、实际 size 和版本。仅展示，无授权效力 |
| POST /generation/jobs | JobInput：模型/提示词/参数、本人 READY 图片 references；UUID Idempotency-Key 必填；服务端重算并原子 HOLD/建任务/事件，202 JobReceipt。支持成对 project_id/node_id，冻结前校验项目与节点归属 |
| GET /generation/jobs?before=UUID&status=…&limit=25 | 本人的任务游标列表，limit 1–100，返回 JobPage |
| GET /generation/jobs/{id} | 本人任务详情和新签名输出链接；跨用户/不存在 404 |
| POST /generation/jobs/{id}/cancel | 排队/路由中直接原子取消与全额释放；运行/存储中写取消标记，由 worker 停止并释放；终态重复调用只返回当前结果，不重复扣款/释放 |

任务视图不返回账号 ID、租约令牌、真实模型名、上游任务 ID 或地址。价格和参数快照不可修改，终态不可再更新；同请求键异参 422 IDEMPOTENCY_CONFLICT，余额不足 402，活跃任务超限 429 TOO_MANY_ACTIVE_JOBS，免费层越级 403 RESOLUTION_NOT_ALLOWED，黑名单 422 CONTENT_POLICY。

任务由 API 内持久 worker 执行：60 秒租约/20 秒续期，过期回收带令牌栅栏，三次尝试预算；无账号容量每两秒重试，五分钟失败释放。生成媒体先暂存，发布/按张结算/余量释放/终态/事件同事务；视频 ID 已持久化后不重复提交。SSE 与真实生成页面 `/generate` 已接入，M8 起按当前有效订阅快照决定并发和分辨率，未订阅/已到期为 FREE。


`GET /generation/limits` 返回 tier、max_resolution、max_active_jobs、video_enabled。`GET /events?after=SEQ` 返回 SSE `job.updated`，id 为数据库 seq，JSON 为 GenerationEvent；Last-Event-ID 优先于 after。只重放本人记录，输出链接重新签名；未来游标收敛到本人最新事件。每用户最多三个 SSE 连接（超出 429 SSE_CONNECTION_LIMIT），10 秒心跳，持续复核会话及 MFA；失效断流。客户端应在 SSE 不可用时轮询任务接口，重连携带最后成功处理的游标。


### M6 项目与画布（已接通）

`GET/POST /api/v1/projects` 列表/创建（创建要求 UUID `Idempotency-Key`）；`GET/PATCH/DELETE /api/v1/projects/{id}` 读取/重命名/软删除；`PUT /api/v1/projects/{id}/graph` 保存图。所有写请求复用会话、Origin、CSRF；重命名/删除/保存要求 `If-Match: "<revision>"`，缺少返回 428，旧版本 409 `REVISION_CONFLICT`。跨账号统一 404。

`POST /projects/{id}/duplicate` 同样要求创建幂等键；`GET /projects/{id}/snapshots` 最近 50 版；`POST /projects/{id}/snapshots/{snapshot}/restore` 带当前 `If-Match`，恢复为新版本。项目读取中的 `assets` 为最新可用素材视图，失效素材不返回 URL；图中只保留素材 ID。`GET /assets/{id}/projects` 返回当前用户引用此素材的项目。

生成输入现支持成对 `project_id/node_id`；服务端核对本人有效项目中的 generate 节点后才冻结积分。`GET /generation/jobs?project_id=<uuid>` 查询该项目的本人任务，`JobView` 返回关联字段；独立生成兼容空关联。


### M7 本人会话与 SSE

均以 `/api/v1` 为前缀，要求登录；管理员需要最近 MFA，写操作检查同源/CSRF，Redis 每用户每分钟最多 30 次。没有管理员绕过本人归属的接口。

| 方法与路径 | 行为 |
| --- | --- |
| GET /chat/config | 公开 chat 模型 ID/名称、统一每条积分、窗口/输出预算；不返回账号、原始模型名或密钥 |
| GET/POST /chat/conversations | 本人列表（25 条，before 游标）/创建；创建 UUID Idempotency-Key 必填，最多 1000 个未删除会话 |
| GET/PATCH/DELETE /chat/conversations/{id} | 本人会话和最近 50 轮/改名/软删除；before 为轮 UUID，删除停止活动回复，跨用户/已删除 404 |
| POST /chat/conversations/{id}/messages | SendMessage: model_id、content（1–4000 字符）；UUID Idempotency-Key 必填，返回 SSE |
| POST /chat/turns/{id}/cancel | 标记本人活动回复取消，已结束重复调用不改写结果 |

SSE `delta` 为 `{turn_id,text}`，`intent` 为六类枚举字符串，`action` 为 `{type:"open_canvas",draft:{prompt,quality,ratio,resolution,n}}`，`done` 为持久 ChatTurn，`error` 为 `{turn_id,code}`。没有 SSE id 重连重放；网络不明需保留原键和正文重新 POST，成功历史重放不再请求上游或扣款。相同键异参 409，进行中 CHAT_BUSY，已失败键不能重用。可读取会话核对持久状态。

每人最多一条 RUNNING 回复，创建与 HOLD 同事务；完整结束后消息/动作/审计/SETTLE 同事务，失败或断流 RELEASE。默认每条 1 积分，可配置 0。终态和输入不可改写，原始消息/摘要只存本人数据库。回复每两秒复核登录/MFA、账号状态、取消和租约，240 秒总时限，过期租约后台恢复，绝不自动重发不明供应商请求。对话不执行 SSH、工具、文件或生成任务。

代理需关闭该 POST SSE 响应缓冲，支持至少 240 秒长连接；10 秒 keepalive，前端通过 fetch 流读取。输出最大 64 KiB、上游整个 SSE 2 MiB；缺少 stop/DONE、工具调用和截断视为失败，不按完成收费。上下文压缩保存早期摘要并保留最近六条原文，窗口与输出使用保守估算，预算不足返回 CONTEXT_LIMIT，保留原始消息供核对。


### M8 套餐、订单与已付款周期

| 方法 | 路径（前缀 /api/v1） | 行为 |
| --- | --- | --- |
| GET | /plans | 登录用户读取已上架套餐 |
| GET | /subscription | 当前权益、周期结束时间、排期数量；同步已付款周期 |
| POST | /orders | plan_id + plan_revision，UUID Idempotency-Key；返回订单与人工付款说明 |
| GET | /orders?before=UUID | 本人订单，创建时间倒序，每页 30 条 |
| GET | /orders/{id} | 本人订单及付款说明，跨用户 404 |
| POST | /orders/{id}/cancel | 只取消本人 PENDING，重复取消幂等 |
| GET / POST | /admin/plans | 管理员读取全部套餐 / 创建 |
| PATCH | /admin/plans/{id} | revision + details；下架用 active=false，不删除历史 |
| GET | /admin/orders?before=UUID | 管理员查看订单，时间倒序分页 |
| POST | /admin/orders/{id}/mark-paid | 原 amount_cents、currency、trade_no、reason；UUID Idempotency-Key |
| GET | /admin/orders/{id}/refund-quote | 未用积分对应可退金额及用户预占数 |
| POST | /admin/orders/{id}/refund | expected_credits、confirm_external_refund=true、reason；UUID Idempotency-Key |

所有业务接口需真实会话；写请求需 CSRF/可信 Origin，管理员接口还需有效 MFA。金额全为整数分。ManualProvider 不提供匿名回调；服务端确认支付的金额/币种须与冻结快照一致，人工凭证全局唯一。订单 PENDING→PAID→FULFILLED 为同事务，CANCELLED 和 REFUNDED 不可回退；数据库保护订单价格、归属、快照与支付凭证不可改写。

409 BILLING_CONFLICT 表示套餐修订、状态或退款份额已变化，需要重新读取确认；409 DUPLICATE_TRADE 为凭证重复；422 PAYMENT_MISMATCH 为金额/币种不符；409 ORDER_CREDITS_HELD 为存在任务预占。相同幂等键必须保留相同正文；重复收款确认只返回已有结果，不再次发积分。

订阅一次购买一个已付款周期，随后购买的周期排队；每日后台扫描及钱包/订阅/生成/素材请求同步推进。完全错过的已结束周期中，不结转的过期积分不补发，可结转的已付款积分补发一次，不自动扣费。生成 limits/quote/create 使用实时权益；新素材到期时间取当时 retention_days。退款先由管理员线下完成再登记，按 FIFO 记录的本订单未消费积分比例计算并回收，预占存在时阻止；退款登记、余额、周期状态、审计同事务。退款不会自动转账，兑换码继续使用 M2 接口。
