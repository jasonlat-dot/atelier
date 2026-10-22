# Atelier AI 创作平台 · 产品与工程开发规格书

版本 v1.0 · 2026-10-22 · 读者：AI 编码代理（Codex / Claude Code）与项目负责人

## 0. 给 AI 开发者的执行规则（先读）

1. 本文是唯一需求来源。与 Codex 旧文档（docs/03、docs/04）冲突时，以本文为准。
2. 严格按第 10 章里程碑顺序开发；每个里程碑通过「验收」后才能进入下一个。
3. 后端是唯一的安全边界：身份、角色、价格、积分、模型、上游地址只信服务端；前端校验仅为体验。
4. 凡涉及积分的写操作，必须在单个数据库事务内完成，并带幂等键；账本只追加，不改不删。
5. 上游密钥、上游 URL、真实上游模型名不得返回浏览器，也不得写入日志。
6. 遇到不确定处不要臆造：在 docs/DECISIONS.md 记录假设并按本文默认值实现。
7. 每个 PR 必须包含：迁移文件、测试、API 契约更新；cargo fmt/clippy、tsc、eslint 全绿。
8. 不实现 1.3 节中标为「不做」的功能。

## 1. 产品概述

### 1.1 一句话定义

Atelier 是多用户 Web 服务：用户用 Google（仅限 Gmail）账号登录，用积分使用 AI 对话，以及「以无限画布为工作台」的 AI 生图与 AI 视频生成。模型和上游账号全部由管理员在后端配置，用户不能自带 Key，也不能自选渠道。前端是同一个 SPA（apps/web），按角色显示用户端或管理端；后端是单个 Rust 服务（Axum），对外只暴露一个端口。

### 1.2 角色与权限

| 角色 | 能力 |
| --- | --- |
| USER | 对话、画布、生图、素材、积分/签到/订阅、个人用量 |
| ADMIN | USER 全部 + 用户管理（禁用、手动加减积分）、上游账号池、模型、套餐定价、任务监控、系统设置 |
| SUPER\_ADMIN | ADMIN 全部 + 修改角色、注册开关、审计日志、密钥与安全设置 |

角色只存数据库，只由服务端从 Session 解析。第一个 SUPER\_ADMIN 由环境变量 BOOTSTRAP\_ADMIN\_EMAILS 指定，仅在该邮箱首次登录时生效。

### 1.3 范围决策

| 功能 | 决策 | 说明 |
| --- | --- | --- |
| AI 对话（意图识别、上下文压缩） | P0 | 复用 SSH Agent 的 Rust crate，见 4.6 |
| 文生图、图生图（参考图）、多图参考 | P0 | 对标 chatgpt2api 的 generations/edits 形态 |
| 质量低/中/高、比例、分辨率档、张数 | P0 | 见 4.4 与 7.4 |
| 无限画布工作台 | P0 | 对标 infinite-canvas 全部可落地功能，见 7.3 |
| Google 登录、注册开关 | P0 | 见 4.1 |
| 积分账本、每日签到 | P0 | 见 4.2 |
| 上游账号池与自动路由 | P0 | 见 4.5 |
| 管理后台 | P0 | 见 6.3 与 7.5 |
| 订阅、积分包、在线支付 | P1 | P0 先做管理员充值 + 兑换码；支付渠道用 trait 抽象 |
| 提示词库、画布助手 | P1 | 见 7.3 |
| 视频生成 | P0 | 文生视频、图生视频（首帧、尾帧），与图片共用账本、调度器与画布；异步长任务，见 4.8 与 7.4.1 |
| 远程插件系统 | 不做 | 多用户环境下加载远程代码等于 XSS/RCE 风险；只允许内置节点类型 |
| 本机 Canvas Agent / MCP | 不做 | 多租户 Web 无本机环境 |
| 用户自配 Base URL/Key、自定义调用脚本 | 不做 | 需求明确禁止，并带来 SSRF 风险 |
| WebDAV 同步 | 不做 | 服务端存储已替代 |
| 可编辑 PPT/PSD | 不做 | P3 |

### 1.4 参考项目取舍

| 项目 | 取 | 不取 |
| --- | --- | --- |
| sub2api | 前端嵌入后端、单端口；handler/service/repo 分层；账号并发槽、冷却、健康的调度思路 | Go/Vue 技术栈；多协议转发 |
| chatgpt2api | 生图接口形态（generations/edits，n 为 1 到 4）；号池字段（额度、恢复时间、失效剔除、批量刷新、导入导出） | 逆向协议实现本身 |
| infinite-canvas（MIT） | 功能清单与交互：多画布、节点、连线、小地图、撤销重做、导入导出、拖文件、批量结果节点、生成参数留痕、画布助手、提示词库 | 浏览器直连上游、浏览器保存 Key、远程插件、本机 Agent |

注意：infinite-canvas 的 README 要求二次开发保留原作者信息与前端页面标识。本规格按「重新实现功能」处理；如直接拷贝其代码，必须保留 LICENSE 与署名。

### 1.5 合规与风险（必读）

- 推荐生产路线：上游使用 OpenAI 官方图片 API（如 gpt-image-2，按量计费）或合规的 OpenAI 兼容网关。
- 订阅网页账号路线：chatgpt2api 自述为对 ChatGPT 官网接口的逆向研究，声明禁止商业使用、批量调用与转售，并提示账号可能被限制或封禁。把这类账号用于收费积分服务，与该项目免责声明相冲突，通常也违反 OpenAI 服务条款（请自行核对最新条款），可能导致账号被封和法律风险。
- 本规格因此把它设计为可选适配器 session\_pool：默认关闭，由管理员自行承担风险；MVP 只实现 openai\_compatible（可指向官方 API 或自建兼容网关）。
- 公开收费还需要：隐私政策、服务条款、内容审核、退款政策。

## 2. 现有 Codex 工程审计

| 模块 | 现状 | 处置 |
| --- | --- | --- |
| 视觉风格（浅色、中性、细边框） | 方向正确 | 保留并按第 7 章完善 |
| App.tsx、CanvasPage.tsx 等 | 单文件过大、压缩成一行、含视频、与 Mock 强耦合 | 用 prettier 格式化后按 7.2 目录拆分；保留并完善视频入口 |
| lib/mockDb.ts | 前端 Mock 业务 | 仅作 VITE\_API\_MODE=mock 的开发层，生产构建不得包含 |
| services/api/src/main.rs（单文件） | dev 登录、内存 Session、项目/任务/钱包 | 按 3.3 拆分；删除 DEV\_AUTH 与内存 Session |
| migrations/202610210001\_init.sql | users.credits 直接加减，无冻结/结算 | 废弃，按第 5 章重写 |
| tests/verify\_source.cjs | Mock 语法与业务检查 | 保留；新增 Rust 集成测试与 Playwright E2E |
| infra/compose.yaml | 仅 PostgreSQL | 按第 9 章扩展 |
| 验证状态 | 从未运行 npm build 与 cargo check | M0 先让两者通过 |

## 3. 技术架构

### 3.1 技术栈

| 层 | 选择 |
| --- | --- |
| 前端 | React 18、TypeScript、Vite 6、React Router 6、@xyflow/react 12、Zustand（本地状态）、TanStack Query（服务端状态）、lucide-react、react-markdown + rehype-sanitize；样式沿用 CSS 变量设计令牌，不引入 Tailwind |
| 后端 | Rust stable、Axum、Tokio、SQLx（PostgreSQL 16）、redis crate、reqwest（rustls）、tower-http、tracing、serde、thiserror；OIDC 用 openidconnect crate；TOTP 用 totp-rs；密钥加密用 chacha20poly1305；图片处理用 image crate；视频转码、抽帧、封面用 ffmpeg 与 ffprobe（独立子进程，限时、限内存、限并发） |
| 契约 | utoipa 生成 OpenAPI，前端用 openapi-typescript 生成类型，避免前后端手写两份 |
| 存储 | PostgreSQL（权威数据）、Redis（限流、并发槽、SSE 广播）、媒体存储（本地磁盘或 S3 兼容，trait 抽象） |

版本以 cargo add / npm 最新稳定版为准，写入 lockfile。

### 3.2 运行拓扑

```
浏览器 --HTTPS--> Caddy(TLS) --> app:8080 (Axum)
                                  ├─ /api/*     业务接口
                                  ├─ /media/*   签名媒体
                                  └─ /*         SPA 静态资源（带回退）
app --> PostgreSQL / Redis / 媒体存储 / 上游（仅出站）
```

对外只开放反向代理的 443 与（可选）app 的 8080；PostgreSQL、Redis 只在 Docker 内网。

### 3.3 后端模块

```
services/api/
  crates/
    app/         启动、配置、路由、AppState、优雅退出
    auth/        oidc、session、csrf、rbac、mfa
    wallet/      账本、定价、签到、兑换码、订单
    assets/      存储 trait、上传校验、缩略图、签名 URL
    upstream/    账号池、调度器、供应商适配器、密钥加密
    generation/  任务、worker、状态机、SSE 事件
    canvas/      项目、图校验、快照
    chat/        会话、SSE、对接 agent-core
    admin/       用户、模型、套餐、设置、审计、看板
    agent-core/  从 SSH Agent 复用的 crate（意图识别、上下文压缩）
    common/      错误、ID、时间、分页
  migrations/
```

分层规则：handler 只做解析与返回；service 写业务并依赖 trait；repo 只访问 SQL。跨模块只能调用对方 service。wallet 是唯一允许修改余额的模块。

### 3.4 生图主数据流

```
1. POST /api/v1/generation/jobs（Idempotency-Key）
   鉴权 → CSRF → 限流 → 校验模型能力与参考图归属 → 服务端定价
   → 事务{ 建 job + HOLD 积分 } → NOTIFY
2. worker 用 FOR UPDATE SKIP LOCKED 领取 → 调度器选账号并占并发槽
   → 适配器调用上游 → 写媒体存储与缩略图
   → 事务{ 建 assets + 逐张 SETTLE 或 RELEASE + job 终态 + job_event }
3. SSE 推送 job_event → 前端把结果图插入画布并连线
```

## 4. 核心业务规则

### 4.1 认证、注册与防伪造

| 项 | 规则 |
| --- | --- |
| 登录方式 | 只支持 Google OIDC Authorization Code + PKCE，由后端作为机密客户端完成；前端既不接收也不上传任何 id\_token |
| 发起登录 | GET /api/v1/auth/google/start：生成 state、nonce、code\_verifier，存 Redis（TTL 10 分钟，一次性），302 到 Google |
| 回调校验 | GET /api/v1/auth/google/callback：校验 state → 换取 token → 校验 id\_token：签名（JWKS）、iss 为 https://accounts.google.com 或 accounts.google.com、aud 等于 GOOGLE\_CLIENT\_ID、exp、nonce、email\_verified=true |
| 仅限 Gmail | 邮箱域必须是 gmail.com（大小写不敏感）；若 id\_token 含 hd 声明（Workspace 域账号）一律拒绝 |
| 身份主键 | google\_sub 唯一；邮箱只用于展示和去重，不作为身份 |
| 规范化邮箱 | 转小写；googlemail.com 视为 gmail.com；本地部分去掉点号和 + 之后的内容；canonical\_email 加唯一约束，防止用 a.b+1@gmail.com 这类别名反复注册领积分 |
| 注册开关 | system\_settings.registration\_mode 取 OPEN、INVITE\_ONLY、CLOSED。CLOSED：已有用户可登录，新用户返回 403 REGISTRATION\_CLOSED；INVITE\_ONLY：需要有效邀请码或邮箱在白名单。每次回调都读取最新设置 |
| 注册防刷 | 同一 IP 24 小时内最多新注册 3 个（可配）；注册赠送积分每个用户只发一次（账本幂等键保证） |
| Session | 256 位随机不透明令牌，Cookie 名 \_\_Host-sid（HttpOnly、Secure、SameSite=Lax、Path=/）；数据库只存 sha256(token)；空闲 7 天、绝对 30 天；登录时轮换；禁用、登出、改角色时撤销该用户全部 Session |
| 每个请求 | 读 Session → 查 users 的 status 与 role → 才放行。永远不信请求体里的 userId、role、credits、price |
| CSRF | 所有非 GET 请求：Origin 必须与 Host 一致，且带头 X-CSRF-Token（与 Session 绑定，由 GET /me 返回） |
| 管理员 | /api/admin/\* 要求角色满足且 12 小时内完成过 TOTP；未绑定 MFA 的管理员只能访问绑定页面 |
| 限流 | Redis 滑动窗口：登录起点 20 次/10 分钟/IP；创建生图任务 30 次/分钟/用户；签到 10 次/分钟；管理员写操作 60 次/分钟 |
| 封禁 | status=DISABLED：立即撤销 Session，所有接口返回 403 ACCOUNT\_DISABLED，进行中的任务取消并释放积分 |

### 4.2 积分账本与每日签到

钱包有两个数：balance（总额）与 held（冻结）。可用积分 = balance − held。余额只能通过 wallet 模块下表的操作改变；每个操作 = 一个事务 = 追加一条账本 + 更新钱包。

| 账本类型 | 影响 | 幂等键 |
| --- | --- | --- |
| SIGNUP\_BONUS | balance 增加 | signup:{user\_id} |
| CHECKIN | balance 增加 | checkin:{user\_id}:{local\_date} |
| PURCHASE | balance 增加 | order:{order\_id} |
| REDEEM | balance 增加 | redeem:{code\_id}:{user\_id} |
| ADMIN\_ADJUST | balance 增减 | admin:{request\_id}，必填原因与操作者 |
| HOLD | held 增加 | job:{job\_id}:hold |
| RELEASE | held 减少 | job:{job\_id}:release |
| SETTLE | balance 与 held 同时减少 | job:{job\_id}:settle:{idx} |
| REFUND | balance 增加 | job:{job\_id}:refund，仅管理员，用于已结算后的补偿 |

- 预占 SQL：UPDATE wallets SET held = held + :c WHERE user\_id = :u AND balance − held >= :c；影响行数为 0 返回 402 INSUFFICIENT\_CREDITS。
- 结算按张：n 张里成功 k 张，则对成功的每一张 SETTLE 单价，对其余张 RELEASE。
- 钱包 CHECK：balance >= 0 AND held >= 0 AND held <= balance。
- 账本不可改：数据库触发器禁止对 credit\_ledger 执行 UPDATE 与 DELETE；应用数据库账号不授予 DELETE 权限。
- 每日对账任务：wallets.balance 必须等于 SUM(ledger.balance\_delta)，不一致立即告警。
- 签到：每自然日一次，日界按 checkin\_tz（默认 Asia/Shanghai）；唯一键 (user\_id, local\_date)，用 INSERT … ON CONFLICT DO NOTHING 判断是否已签；基础 10 分，连续签到每多一天 +1，最多额外 +10，断签重置（均可在后台修改）。
- 积分暂不设有效期；账本预留 expires\_at 字段给以后使用。

### 4.3 定价、套餐与订阅

- 价格公式（服务端计算）：单张积分 = base\[model, quality\] × size\_multiplier\[resolution\]；总价 = 单张 × n；参考图编辑可加 edit\_surcharge（默认 0）。前端的报价接口只用于展示，不具授权效力；创建任务时服务端必须重算。视频按秒计价，见 4.8。
- 默认值（后台可改）：1K 档 base 为 low 4、medium 12、high 40 积分；分辨率倍率 1K=1、2K=2、4K=4；4K 仅订阅用户可用。
- 校准方法：积分单价 = 上游单张成本 ÷ 单个积分的售价 × 毛利系数。gpt-image-2 的成本随质量和尺寸变化；第三方公开价目示例（1024×1024）约为低 0.006 美元、中 0.053 美元、高 0.211 美元，仅供量级参考，必须以实际上游账单重新校准。
- 用户层级由是否有有效订阅派生：FREE 与 SUBSCRIBER。层级影响并发上限、最高分辨率、素材保留天数。积分本身不区分来源，签到、赠送、购买进入同一余额。
- 套餐 plans：PACK（一次性积分包）与 MONTHLY（订阅，每期发放 credits；rollover 决定是否累积）。字段：price\_cents、currency、credits、period\_days、concurrency\_limit、max\_resolution、retention\_days。
- 订单状态：PENDING → PAID → FULFILLED，另有 CANCELLED、REFUNDED。provider\_trade\_no 加唯一约束。
- 支付回调：必须验签、幂等（同一 trade\_no 重复到达只入账一次）、核对金额与订单；入账 = 一条 PURCHASE 账本 + 订阅周期更新，同一事务。
- PaymentProvider trait：create\_checkout、verify\_webhook、refund。MVP 只实现 ManualProvider（管理员确认收款后入账）与兑换码；在线支付渠道放 P1。
- 退款：订单退款时按未消耗比例回收积分，余额不足时需管理员确认，允许记为负向 ADMIN\_ADJUST。

### 4.4 图片生成参数与任务状态机（视频见 4.8）

| 参数 | 取值 | 规则 |
| --- | --- | --- |
| model\_id | 目录里已启用的 image 模型 | 只接受目录 ID，不接受上游真实模型名 |
| quality | low、medium、high | 必须在模型 capabilities.qualities 内 |
| ratio | 1:1、4:3、3:4、3:2、2:3、16:9、9:16、21:9 | 由模型 capabilities.ratios 过滤 |
| resolution | 1K、2K、4K | 4K 受层级与模型限制 |
| n | 1 到 4 |  |
| prompt | 1 到 4000 字符 | 先过黑名单 |
| references | 0 到 4 个 asset\_id | 必须属于当前用户且状态 READY；有参考图即视为图生图；上限可配 |

- 尺寸换算：服务端函数 size\_for(ratio, resolution, caps)。长边 1K=1024、2K=2048、4K=3840，短边按比例，并向 16 的倍数对齐；若模型 size\_mode 为 enum，则取枚举里最接近的一项，并把实际尺寸返回给用户。gpt-image-2 对尺寸有约束（边长需为 16 的倍数、长短边比不超过 3:1 等，具体以上游文档为准），适配器发请求前必须校验，不合法就降级，不能抛 500。
- 超时：low 与 medium 为 120 秒，high 或 2K 以上为 300 秒（可配）；上游 HTTP 超时 = 任务超时 + 10 秒。

```
QUEUED → ROUTING → RUNNING → STORING → SUCCEEDED
                      │           └──→ PARTIAL（成功张数 k < n）
QUEUED / ROUTING / RUNNING → CANCELLED（用户取消，全额释放）
ROUTING / RUNNING → FAILED（不可重试错误或重试耗尽，全额释放）
RUNNING 超时 → FAILED（error_code=TIMEOUT）
```

- 终态不可再转移。所有转移都用 UPDATE … WHERE status IN (…) 条件更新，影响行数为 0 视为竞争失败，直接放弃。
- 失败一律 RELEASE；PARTIAL 只对成功的张数 SETTLE。
- 重试：仅当尚未产出任何结果，且错误类别为 RATE\_LIMITED、UPSTREAM\_ERROR、ACCOUNT\_INVALID 时才换账号重试，最多重试 2 次（attempts 不超过 3）。CONTENT\_POLICY 不重试，释放积分并记录违规。
- worker 租约：领取时写 locked\_by 与 lease\_until = now() + 60 秒，运行中每 20 秒续约；回收器每 30 秒把租约过期的非终态任务重置为 QUEUED（attempts 加 1），超过上限转 FAILED。
- 取消：QUEUED 与 ROUTING 直接 CANCELLED；RUNNING 置 cancel\_requested，worker 中止上游请求后转 CANCELLED。上游已产生的成本由平台承担，用户积分全额释放。
- 事件：每次状态变化写 job\_events（seq 单调递增）。SSE 用 Last-Event-ID 续传，并提供轮询兜底接口 GET /generation/jobs/{id}。
- 并发配额：FREE 同时 1 个活跃任务，SUBSCRIBER 同时 3 个（可配），超出返回 429 TOO\_MANY\_ACTIVE\_JOBS。

### 4.5 上游账号池与自动路由

账号抽象 UpstreamAccount，kind 取值：openai\_compatible（MVP，指向官方 API 或自建兼容网关）、session\_pool（可选，默认关闭，风险见 1.5，MVP 不实现）。调度器只关心：能力、额度、健康、并发、冷却，不关心协议细节。

调度算法：

1. 候选 = status 为 ACTIVE 且 cooldown\_until 已过，且支持该模型与所需能力（质量、尺寸、是否编辑），且额度剩余大于 0，且当前并发小于 concurrency\_limit。
2. 按 priority 升序分组，取最先出现的非空组。
3. 组内打分 score = weight × (1 − in\_flight / concurrency\_limit) × (0.5 + 0.5 × quota\_remaining / quota\_total)，取最大者，平分随机。
4. 在 Redis 取并发槽：SET slot:{account}:{job} NX EX lease；失败换下一个候选；全部失败则任务停留在 ROUTING，2 秒后重试；排队超过 5 分钟转 FAILED（NO\_CAPACITY）并释放积分。
5. 调用结束必须释放并发槽，包括取消与 panic 路径（用 RAII guard 实现）。

| 上游结果 | 分类 | 账号动作 | 任务动作 |
| --- | --- | --- | --- |
| 401 / 403 凭据无效 | ACCOUNT\_INVALID | status=INVALID，通知管理员 | 换号重试 |
| 429 或额度耗尽 | RATE\_LIMITED | COOLDOWN 到 Retry-After 或 quota\_reset\_at（缺省 1 小时）；额度耗尽置 QUOTA\_EXHAUSTED | 换号重试 |
| 5xx、超时、网络错误 | UPSTREAM\_ERROR | consecutive\_failures 加 1；连续 3 次则 COOLDOWN 5 分钟，指数退避，上限 1 小时 | 换号重试 |
| 内容策略拒绝 | CONTENT\_POLICY | 不动 | 不重试，释放积分 |
| 其他 4xx 参数错误 | BAD\_REQUEST | 不动 | 失败并释放，同时告警（说明本地校验有漏洞） |
| 成功 | — | consecutive\_failures 清零，quota\_remaining 减 n | 正常结算 |

- 额度：quota\_total、quota\_remaining、quota\_reset\_at 由管理员配置，或由定时探测刷新；定时任务每 5 分钟把到期的 COOLDOWN 与 QUOTA\_EXHAUSTED 账号探测后恢复为 ACTIVE。
- 安全：base\_url 只有管理员能设；必须 https（本地开发可用白名单放行 localhost）；解析 DNS 后拒绝回环、私网、链路本地、云元数据地址；禁止跟随重定向；出站请求统一经 reqwest 客户端工厂。密钥用 XChaCha20-Poly1305 加密入库（MASTER\_KEY 取自环境变量并记录 key\_version），接口只返回 secret\_last4。
- 管理端能力：新增、编辑、停用、删除；连通性测试（最小请求或 /models）；手动刷新额度；批量导入（CSV 或 JSON，导入后密钥立即加密）；按分组绑定模型；查看 24 小时成功率、平均耗时、错误分布。

### 4.6 对话、意图识别与上下文压缩

- 复用方式：把 SSH Agent 里的意图识别与上下文压缩抽成独立 crate agent-core，对外只暴露三个 trait；agent-core 不得依赖 SSH、终端或本地文件工具，SSH 专属能力留在原项目。

```rust
trait LlmClient { async fn stream(&self, req: ChatRequest) -> Result<TokenStream>; }
trait IntentClassifier { async fn classify(&self, ctx: &ConversationView) -> Intent; }
trait ContextCompressor { async fn compress(&self, msgs: &[Message], budget: usize) -> Compressed; }
```

- Intent 枚举：CHAT、IMAGE\_GENERATE、IMAGE\_EDIT、PROMPT\_REFINE、CANVAS\_ASSIST、UNSAFE。命中 IMAGE\_\* 时，助手回复末尾附结构化动作卡 {type: open\_canvas, draft: {prompt, quality, ratio, resolution, n}}，前端渲染「在画布中生成」按钮。任何会扣积分的动作都必须由用户点击确认，不得自动执行。
- 上下文压缩：历史 token 超过窗口的 70% 时，把最早的消息压成摘要写入 conversations.summary，并保留最近若干轮原文；每次请求 = system + summary + 最近消息。
- 模型：chat 类模型同样由管理员在 models 表配置并绑定上游账号分组，用户不能选择上游。
- 计费：每条助手回复完成后按 chat\_credits\_per\_message（默认 1，可设为 0）结算；失败或中途中断不扣。
- 接口：POST /chat/conversations/{id}/messages 返回 text/event-stream，事件为 delta、intent、action、done、error。
- 安全：Markdown 一律经 sanitize 渲染，禁止原始 HTML；对话内容只有本人可读，管理员默认不可读，排查需 SUPER\_ADMIN 并写审计。

### 4.7 内容安全

- 提示词过滤：管理员可维护关键词与正则黑名单，命中直接拒绝且不扣费。
- 上游审核：请求上游时启用其 moderation 选项，被拒绝按 CONTENT\_POLICY 处理。
- 违规计数：30 天内 CONTENT\_POLICY 达到阈值（默认 5 次）自动禁用账号并通知管理员复核。
- 站点必须展示服务条款与使用规范，明确禁止违法内容与涉及未成年人的不当内容。

## 5. 数据库模型（PostgreSQL 16，SQLx 迁移）

以下为核心表，AI 开发时按此建迁移文件（一个里程碑一个迁移，禁止修改已发布的迁移）。

```sql
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  google_sub text NOT NULL UNIQUE,
  email text NOT NULL,
  canonical_email text NOT NULL UNIQUE,
  display_name text NOT NULL, avatar_url text,
  role text NOT NULL DEFAULT 'USER' CHECK (role IN ('USER','ADMIN','SUPER_ADMIN')),
  status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','DISABLED')),
  disabled_reason text, mfa_secret_enc bytea, mfa_enabled boolean NOT NULL DEFAULT false,
  signup_ip inet, created_at timestamptz NOT NULL DEFAULT now(), last_login_at timestamptz
);
CREATE TABLE sessions (
  token_hash bytea PRIMARY KEY, user_id uuid NOT NULL REFERENCES users(id),
  csrf_token text NOT NULL, mfa_verified_at timestamptz, ip inet, user_agent text,
  created_at timestamptz NOT NULL DEFAULT now(), last_seen_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL, revoked_at timestamptz
);
CREATE TABLE system_settings (
  key text PRIMARY KEY, value jsonb NOT NULL, updated_by uuid, updated_at timestamptz NOT NULL DEFAULT now()
);
-- keys: registration_mode, signup_bonus, checkin_base, checkin_streak_cap, checkin_tz,
-- free_max_resolution, max_active_jobs_free, max_active_jobs_sub, chat_credits_per_message, maintenance_mode
CREATE TABLE invite_codes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), code_hash bytea NOT NULL UNIQUE,
  max_uses int NOT NULL DEFAULT 1, used_count int NOT NULL DEFAULT 0, expires_at timestamptz
);
CREATE TABLE wallets (
  user_id uuid PRIMARY KEY REFERENCES users(id),
  balance bigint NOT NULL DEFAULT 0, held bigint NOT NULL DEFAULT 0,
  CHECK (balance >= 0 AND held >= 0 AND held <= balance)
);
CREATE TABLE credit_ledger (
  id bigserial PRIMARY KEY, user_id uuid NOT NULL REFERENCES users(id),
  type text NOT NULL, balance_delta bigint NOT NULL DEFAULT 0, held_delta bigint NOT NULL DEFAULT 0,
  idempotency_key text NOT NULL UNIQUE, ref_type text, ref_id text, reason text,
  actor_id uuid, created_at timestamptz NOT NULL DEFAULT now()
);
-- 触发器：BEFORE UPDATE OR DELETE ON credit_ledger → RAISE EXCEPTION
CREATE TABLE checkins (
  user_id uuid NOT NULL REFERENCES users(id), local_date date NOT NULL,
  streak int NOT NULL, credits int NOT NULL, PRIMARY KEY (user_id, local_date)
);
CREATE TABLE plans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text NOT NULL,
  type text NOT NULL CHECK (type IN ('PACK','MONTHLY')),
  price_cents int NOT NULL, currency text NOT NULL, credits bigint NOT NULL, period_days int,
  rollover boolean NOT NULL DEFAULT false, concurrency_limit int NOT NULL DEFAULT 3,
  max_resolution text NOT NULL DEFAULT '2K', retention_days int NOT NULL DEFAULT 180,
  active boolean NOT NULL DEFAULT true
);
CREATE TABLE subscriptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL REFERENCES users(id),
  plan_id uuid NOT NULL REFERENCES plans(id), status text NOT NULL,
  current_period_end timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL REFERENCES users(id),
  plan_id uuid NOT NULL REFERENCES plans(id), amount_cents int NOT NULL, currency text NOT NULL,
  provider text NOT NULL, provider_trade_no text, status text NOT NULL DEFAULT 'PENDING',
  created_at timestamptz NOT NULL DEFAULT now(), paid_at timestamptz,
  UNIQUE (provider, provider_trade_no)
);
CREATE TABLE redeem_codes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), code_hash bytea NOT NULL UNIQUE,
  credits bigint NOT NULL, max_uses int NOT NULL DEFAULT 1, used_count int NOT NULL DEFAULT 0,
  expires_at timestamptz, created_by uuid
);
CREATE TABLE models (
  id text PRIMARY KEY, kind text NOT NULL CHECK (kind IN ('chat','image')),
  display_name text NOT NULL, upstream_model text NOT NULL, enabled boolean NOT NULL DEFAULT false,
  capabilities jsonb NOT NULL, sort_order int NOT NULL DEFAULT 0
);
-- capabilities 示例(image): {qualities:['low','medium','high'], ratios:[...], resolutions:['1K','2K'],
--   max_n:4, max_refs:4, size_mode:'flex'|'enum', sizes:[...]}
CREATE TABLE pricing_rules (
  model_id text REFERENCES models(id), quality text NOT NULL, base_credits int NOT NULL,
  PRIMARY KEY (model_id, quality)
);
CREATE TABLE upstream_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text NOT NULL,
  kind text NOT NULL DEFAULT 'openai_compatible', base_url text NOT NULL,
  secret_enc bytea NOT NULL, secret_last4 text, key_version int NOT NULL DEFAULT 1,
  group_tag text NOT NULL DEFAULT 'default', priority int NOT NULL DEFAULT 10, weight int NOT NULL DEFAULT 1,
  concurrency_limit int NOT NULL DEFAULT 2,
  quota_total int, quota_remaining int, quota_reset_at timestamptz,
  status text NOT NULL DEFAULT 'ACTIVE'
    CHECK (status IN ('ACTIVE','COOLDOWN','QUOTA_EXHAUSTED','INVALID','DISABLED')),
  cooldown_until timestamptz, consecutive_failures int NOT NULL DEFAULT 0,
  last_error text, last_used_at timestamptz, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE account_models (
  account_id uuid REFERENCES upstream_accounts(id) ON DELETE CASCADE,
  model_id text REFERENCES models(id), PRIMARY KEY (account_id, model_id)
);
CREATE TABLE projects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), owner_id uuid NOT NULL REFERENCES users(id),
  name text NOT NULL, revision bigint NOT NULL DEFAULT 0, graph jsonb NOT NULL,
  thumb_asset_id uuid, deleted_at timestamptz, updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE project_snapshots (
  id bigserial PRIMARY KEY, project_id uuid NOT NULL REFERENCES projects(id),
  revision bigint NOT NULL, graph jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE assets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), owner_id uuid NOT NULL REFERENCES users(id),
  kind text NOT NULL DEFAULT 'image', source text NOT NULL CHECK (source IN ('upload','generated')),
  object_key text NOT NULL, thumb_key text, mime text NOT NULL, bytes bigint NOT NULL,
  width int, height int, sha256 bytea, state text NOT NULL DEFAULT 'READY',
  expires_at timestamptz, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE generation_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), owner_id uuid NOT NULL REFERENCES users(id),
  project_id uuid REFERENCES projects(id), node_id text, kind text NOT NULL DEFAULT 'image',
  model_id text NOT NULL REFERENCES models(id), prompt text NOT NULL,
  params jsonb NOT NULL,  -- quality, ratio, resolution, size, references[{asset_id,role}]
  cost_per_image int NOT NULL, n int NOT NULL,
  status text NOT NULL DEFAULT 'QUEUED', error_code text, attempts int NOT NULL DEFAULT 0,
  account_id uuid REFERENCES upstream_accounts(id),
  locked_by text, lease_until timestamptz, cancel_requested boolean NOT NULL DEFAULT false,
  idempotency_key text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), finished_at timestamptz,
  UNIQUE (owner_id, idempotency_key)
);
CREATE INDEX idx_jobs_pick ON generation_jobs (created_at) WHERE status IN ('QUEUED','ROUTING');
CREATE TABLE generation_outputs (
  job_id uuid REFERENCES generation_jobs(id), idx int NOT NULL,
  asset_id uuid REFERENCES assets(id), status text NOT NULL, PRIMARY KEY (job_id, idx)
);
CREATE TABLE job_events (
  seq bigserial PRIMARY KEY, user_id uuid NOT NULL, job_id uuid NOT NULL,
  type text NOT NULL, payload jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE conversations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), owner_id uuid NOT NULL REFERENCES users(id),
  title text NOT NULL, summary text, updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE messages (
  id bigserial PRIMARY KEY, conversation_id uuid NOT NULL REFERENCES conversations(id),
  role text NOT NULL, content text NOT NULL, intent text, action jsonb, tokens int,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE audit_logs (
  id bigserial PRIMARY KEY, actor_id uuid NOT NULL, action text NOT NULL,
  target_type text, target_id text, before jsonb, after jsonb, ip inet,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE moderation_rules (
  id serial PRIMARY KEY, pattern text NOT NULL, is_regex boolean NOT NULL DEFAULT false,
  enabled boolean NOT NULL DEFAULT true
);
```

所有以 owner\_id 或 user\_id 为条件的查询都必须带上当前登录用户的 ID；跨用户访问一律返回 404，不返回 403，避免泄露资源是否存在。

## 6. API 契约

### 6.1 通用约定

- 前缀 /api/v1；JSON；时间为 ISO 8601 UTC；积分为整数；金额为最小货币单位的整数。
- 错误体：{error: {code, message, request\_id}}。code 取值：UNAUTHENTICATED（401）、ACCOUNT\_DISABLED（403）、FORBIDDEN（403）、REGISTRATION\_CLOSED（403）、INSUFFICIENT\_CREDITS（402）、VALIDATION（422）、NOT\_FOUND（404）、CONFLICT（409，画布版本冲突）、TOO\_MANY\_REQUESTS（429）、TOO\_MANY\_ACTIVE\_JOBS（429）、MODEL\_UNAVAILABLE（503）。
- 幂等：POST /generation/jobs、/wallet/redeem、/orders 必须带 Idempotency-Key（UUID）。同键同参数返回首次结果；同键不同参数返回 422。
- 分页：游标式，?limit=50&cursor=…。
- OpenAPI：由 utoipa 生成，路径 /api/openapi.json，仅开发环境与管理员可访问；前端类型由它生成，CI 检查生成物与提交一致。

### 6.2 用户端接口

| 方法与路径 | 说明 |
| --- | --- |
| GET /public/config | 登录页配置：registration\_mode 的公开摘要、版本，无需登录 |
| GET /auth/google/start、GET /auth/google/callback | 登录流程，见 4.1 |
| POST /auth/logout | 撤销当前 Session |
| GET /me | 用户、角色、层级、钱包摘要、csrf\_token |
| PATCH /me | 修改显示名 |
| GET /wallet | balance、held、available、今日是否已签到、连续天数 |
| GET /wallet/ledger | 流水（游标分页） |
| POST /wallet/checkin | 每日签到，返回获得积分与连续天数 |
| POST /wallet/redeem | 兑换码入账 |
| GET /plans、POST /orders、GET /orders | 套餐列表、下单、我的订单 |
| GET /models | 已启用模型：id、display\_name、capabilities、价格摘要；不含任何上游信息 |
| POST /generation/quote | 入参 model\_id、quality、ratio、resolution、n、ref\_count；返回 cost 与实际 size |
| POST /generation/jobs | 创建任务，返回 202 |
| GET /generation/jobs、GET /generation/jobs/{id} | 列表与详情 |
| POST /generation/jobs/{id}/cancel | 取消 |
| GET /events | SSE，当前用户的任务事件，支持 Last-Event-ID |
| POST /assets/uploads | multipart 上传参考图或视频素材（视频异步转码，state 先为 PROCESSING），返回 asset |
| GET /assets、GET /assets/{id}、DELETE /assets/{id} | 素材库；被画布引用的素材删除时提示并软删 |
| GET /media/{signed} | 不在 /api 下；HMAC 签名 + 过期时间的媒体地址，签发时校验归属 |
| GET、POST /projects | 画布项目列表与新建 |
| GET、PATCH、DELETE /projects/{id} | 读取、重命名、删除（软删） |
| PUT /projects/{id}/graph | 保存画布，If-Match 带 revision，冲突返回 409 |
| POST /projects/{id}/duplicate | 复制画布 |
| GET /projects/{id}/snapshots、POST /projects/{id}/snapshots/{sid}/restore | 历史版本与恢复 |
| GET /projects/{id}/export、POST /projects/import | 导出 zip（含图片）与导入 |
| GET、POST /chat/conversations | 会话列表、新建 |
| PATCH、DELETE /chat/conversations/{id} | 重命名、删除 |
| GET /chat/conversations/{id}/messages | 历史消息 |
| POST /chat/conversations/{id}/messages | 发送消息，SSE 流式返回，见 4.6 |
| GET /me/usage | 个人用量统计（按日、按质量） |
| GET /prompts | P1：提示词库搜索，参数 q、tag |

创建任务示例：

```json
POST /api/v1/generation/jobs
Idempotency-Key: 0b6f0c1e-5d52-4c0e-9a55-1d3f1c2b7e11
{"project_id":"uuid","node_id":"n_12","model_id":"image-pro","prompt":"黄昏海边公路，电影感",
 "quality":"medium","ratio":"16:9","resolution":"2K","n":2,
 "references":[{"asset_id":"uuid","role":"reference"}]}
→ 202 {"job":{"id":"uuid","status":"QUEUED","cost":48,"size":"2048x1152"}}
```

SSE 事件：event: job.updated，data 为 {job\_id, status, outputs: \[{idx, asset\_id, url, width, height}\], error\_code}；每条事件带 id（job\_events.seq）。

### 6.3 管理端接口（/api/v1/admin，均需角色与 MFA，且写操作必写 audit\_logs 的 before 与 after）

| 方法与路径 | 权限 | 说明 |
| --- | --- | --- |
| GET /admin/dashboard | ADMIN | 日活、任务量、成功率、积分发放与消耗、上游成本估算、号池健康 |
| GET /admin/users、GET /admin/users/{id} | ADMIN | 搜索、筛选、详情（钱包、流水、任务、Session） |
| POST /admin/users/{id}/disable、/enable | ADMIN | 禁用需填写原因，立即撤销 Session 并取消进行中的任务 |
| POST /admin/users/{id}/credits | ADMIN | 手动充值或扣减：delta、reason、request\_id；单次上限可配 |
| POST /admin/users/{id}/role | SUPER\_ADMIN | 修改角色 |
| POST /admin/users/{id}/revoke-sessions | ADMIN | 强制下线 |
| GET、POST /admin/upstream-accounts | ADMIN | 号池列表与新增；密钥只写不读，返回 secret\_last4 |
| PATCH、DELETE /admin/upstream-accounts/{id} | ADMIN | 编辑、停用、删除 |
| POST /admin/upstream-accounts/{id}/test、/refresh-quota | ADMIN | 连通性测试、刷新额度 |
| POST /admin/upstream-accounts/import | ADMIN | CSV 或 JSON 批量导入 |
| GET /admin/upstream-accounts/{id}/stats | ADMIN | 24 小时成功率、耗时、错误分布 |
| GET、POST、PATCH /admin/models | ADMIN | 模型目录与能力配置 |
| PUT /admin/models/{id}/accounts | ADMIN | 模型与账号绑定 |
| PUT /admin/pricing | ADMIN | 价格规则与分辨率倍率 |
| CRUD /admin/plans | ADMIN | 套餐 |
| GET /admin/orders、POST /admin/orders/{id}/mark-paid、/refund | ADMIN | 订单与手动入账、退款 |
| POST /admin/redeem-codes、GET /admin/redeem-codes | ADMIN | 批量生成兑换码，明文只返回一次 |
| GET /admin/jobs、POST /admin/jobs/{id}/cancel、/refund | ADMIN | 任务监控与人工处理 |
| GET、PUT /admin/settings | SUPER\_ADMIN | 注册开关、赠送与签到参数、并发与分辨率限制、维护模式 |
| CRUD /admin/moderation-rules、/admin/invite-codes | ADMIN | 内容规则与邀请码 |
| GET /admin/audit | SUPER\_ADMIN | 审计日志查询 |
| POST /admin/mfa/setup、/admin/mfa/verify | ADMIN | 绑定与验证 TOTP |

## 7. 前端规格

### 7.1 设计原则与令牌

风格沿用 Codex 已确认的方向：浅色、中性灰、细边框、高信息密度；不使用霓虹色和大面积紫色。主按钮为深色，强调色只用于选中、焦点与链接。

| 令牌 | 值 | 用途 |
| --- | --- | --- |
| --bg | #fafaf9 | 页面背景 |
| --surface | #ffffff | 卡片、面板 |
| --border | #e7e5e4 | 1px 细边框 |
| --text / --muted | #1c1917 / #78716c | 正文 / 次要文字 |
| --primary | #1c1917 | 主按钮（深色） |
| --accent | #2f6fed | 选中、焦点环、链接 |
| --success / --warn / --danger | #16a34a / #d97706 / #dc2626 | 状态 |
| --radius | 8px / 12px | 控件 / 卡片 |
| 字体 | Inter、PingFang SC、Microsoft YaHei、system-ui | 4px 栅格间距 |

深色模式用同一套令牌在 prefers-color-scheme: dark 下重定义，放 P1。

### 7.2 目录与状态管理

```
apps/web/src/
  app/         路由、布局、守卫、Provider
  api/         生成的客户端、带 CSRF 的 fetcher、错误映射、SSE 封装、mock 切换
  features/    auth  chat  canvas(editor/ nodes/ panels/ model/)  assets  wallet  usage
               admin(users accounts models plans orders jobs settings audit)
  components/  Button Dialog Table Drawer Toast EmptyState Skeleton CreditBadge ...
  styles/      tokens.css  global.css
```

- 服务端状态用 TanStack Query；画布编辑状态（nodes、edges、viewport、选择、历史）用 Zustand store。
- mock 数据只在 api 层按 VITE\_API\_MODE 切换，组件内不得出现 mock 判断；生产构建不得包含 mockDb。
- 路由守卫先调 GET /me：401 跳 /login；管理路由按角色放行。这只是体验层，真正的权限在后端。
- 每个页面必须覆盖 loading（骨架屏）、empty、error（带重试）、disabled、无权限五种状态。
- 响应式：1280 以上三栏；1024 到 1279 右栏变抽屉；1024 以下画布只读并提示使用桌面端（移动适配放 P1）。
- 可访问性：图标按钮必须有 aria-label；全部功能键盘可达；文字对比度不低于 4.5。

### 7.3 无限画布规格（对标 infinite-canvas，须完整实现 P0 项）

| # | 功能 | 要求 | 优先级 |
| --- | --- | --- | --- |
| 1 | 多画布项目 | 新建、重命名、复制、删除（软删）、导入、导出 | P0 |
| 2 | 视口 | 空格或 H 键拖动平移；滚轮缩放 0.1 到 4；适应视图；回到 100%；小地图 | P0 |
| 3 | 背景 | 点阵、网格线、空白三选一，随项目保存 | P0 |
| 4 | 选择 | 单选、框选、Shift 多选、全选 | P0 |
| 5 | 编辑 | 复制、剪切、粘贴、重复、删除、锁定、撤销与重做（50 步） | P0 |
| 6 | 节点类型 | text（文本或提示词）、image（图片）、video（视频）、generate（生成节点，输出图片或视频）；note 与 group 放 P1 | P0 |
| 7 | 连线 | 文本连到生成节点作提示词；图片连到生成节点作参考图（视频生成节点上可在边上指定为首帧或尾帧）；生成节点连到结果图；禁止自环、重复边与环 | P0 |
| 8 | 导入素材 | 拖入文件、粘贴剪贴板图片、从素材库拖入；上传后按类型生成 image 或 video 节点，默认保持原图比例 | P0 |
| 9 | 生成节点 | 模型、质量、比例、分辨率、张数；运行、重试、取消；状态与进度；记录 prompt、模型、尺寸、质量、参考图以便复现；n 大于 1 时结果自动网格排布并连线 | P0 |
| 10 | 图片节点操作 | 灯箱预览、下载原图、设为参考、基于此图继续生成、替换、存入素材库、查看生成参数 | P0 |
| 11 | 导出 | 项目 zip（JSON + 图片）；整画布或选中元素导出 PNG 放 P1 | P0 / P1 |
| 12 | 自动保存 | 防抖 800ms；PUT graph 带 If-Match；显示已保存、保存中、失败重试；409 时弹窗选择「加载最新」或「另存为副本」；离开页面前 flush；多标签页用 BroadcastChannel 提示 | P0 |
| 13 | 性能 | onlyRenderVisibleElements；画布只加载缩略图，点击才加载原图；500 个节点保持 30fps 以上 | P0 |
| 14 | 画布助手 | 侧栏对话，围绕选中节点及其上游节点润色提示词、给变体建议；结果可插入 text 节点或创建 generate 节点（扣费需确认） | P1 |
| 15 | 提示词库 | 来源由后台白名单配置，服务端定时拉取并缓存；支持搜索、标签、详情、复制、插入画布 | P1 |

画布数据模型（projects.graph）：

```ts
type Graph = { version: 1; nodes: Node[]; edges: Edge[];
  viewport: { x: number; y: number; zoom: number }; background: 'dots' | 'lines' | 'none' };
type Node =
  | { id: string; type: 'text'; position: XY; size: WH; locked?: boolean; data: { text: string } }
  | { id: string; type: 'image'; position: XY; size: WH; locked?: boolean;
      data: { assetId: string; naturalW: number; naturalH: number; label?: string; gen?: GenMeta } }
  | { id: string; type: 'generate'; position: XY; size: WH; locked?: boolean;
      data: { modelId: string; prompt?: string; quality: 'low'|'medium'|'high'; ratio: string;
              resolution: '1K'|'2K'|'4K'; n: number; status: string; jobId?: string; error?: string } };
type GenMeta = { jobId: string; modelId: string; prompt: string; quality: string;
                 ratio: string; resolution: string; size: string; n: number; references: string[] };
```

服务端保存时必须校验：节点数不超过 500、边不超过 1000、JSON 不超过 2MB；节点与边类型走白名单，丢弃未知字段；所有 assetId 属于当前用户；文本长度不超过 20000；图中只存 asset\_id，不存 URL、base64 或任何上游信息；检测环并拒绝。

| 快捷键 | 作用 |
| --- | --- |
| V / H（或按住空格） | 选择 / 平移 |
| T / G / I | 新建文本节点 / 生成节点 / 上传图片 |
| Ctrl 或 Cmd + Z、Shift + Z | 撤销、重做 |
| Ctrl + C、X、V、D | 复制、剪切、粘贴、重复 |
| Delete / Backspace | 删除选中 |
| Ctrl + A | 全选 |
| Ctrl + Enter | 运行选中的生成节点 |
| Ctrl + S | 立即保存 |
| + / − | 放大 / 缩小 |
| Shift + 1 / Shift + 0 | 适应视图 / 100% |
| F | 聚焦选中节点 |
| Esc | 取消选择、关闭面板 |

### 7.4 画布工作台布局（生图就是画布）

- 三栏：左为「创作面板」，中为画布，右为「属性、图层、任务」三个标签页。
- 左栏内容自上而下：顶层「图片 / 视频」切换，其下是模式分段控件（图片：文生图 / 图生图；视频：文生视频 / 图生视频，视频模式字段见 7.4.1）；模型下拉（只列管理员开放的模型，无任何上游信息）；提示词；参考图槽（可拖入、从素材库选、或把画布选中图片「设为参考」，最多 4 张）；质量 低 / 中 / 高，每档标注积分；比例 chips；分辨率 1K / 2K / 4K；张数 1 到 4；实时预估积分（调 quote 接口）；主按钮「生成并加入画布」；余额与不足提示。
- 中栏：顶部工具条（选择、平移、文本、图片、生成 | 撤销、重做 | 项目选择器、保存状态、导出）；底部缩放控件与快捷键提示；右下角小地图。
- 右栏：选中节点属性；图层列表；任务列表（进度、取消、重试）。
- 左栏「生成」与画布内 generate 节点是同一能力的两个入口：面板是快速模式，自动创建 generate 节点和结果图；节点用于多输入连线的图形化编排。
- 状态规则：余额不足时主按钮变为「去充值」；模型被停用时提示并禁用；任务失败时节点内红色提示、提供「重试」，并说明积分已退还。
- 对话页的「在画布中生成」跳转到 /canvas/:id?draft=…，只把草稿填入左栏，用户确认后才提交；服务端不信任草稿内容。

### 7.5 页面清单与对 Codex 初始 UI 的完善要求

| 路由 | 页面 | 必备内容 | 相对 Codex 初始 UI 的完善点 |
| --- | --- | --- | --- |
| /login | 登录 | Google 登录按钮；注册关闭时的提示；服务条款链接 | 新增 |
| / | 工作台 | 最近画布、快捷入口、余额与签到入口、最近生成 | 补签到卡片与余额预警 |
| /chat | 对话 | 会话列表、流式回复、意图动作卡、上下文用量条、重新生成 | 接真实 SSE，去掉写死的假回复 |
| /canvas/:id | 画布工作台 | 7.3 与 7.4 | 保留并完善视频；图片参数改为 低/中/高 + 比例 + 分辨率，视频增加时长、分辨率、首帧与尾帧；加参考图槽；接真实任务 |
| /assets | 素材库 | 上传与生成两类、筛选、搜索、批量删除、拖到画布 | 补上传与批量操作 |
| /wallet | 积分与订阅 | 余额、签到、套餐、兑换码、流水 | 签到真实可用；兑换码输入 |
| /usage | 用量 | 按日图表、按质量占比 | 接真实数据 |
| /settings | 账号设置 | 显示名、退出登录、登录设备及撤销 | 新增 |
| /admin | 运营总览 | 见 6.3 的 dashboard | 补号池健康与成本估算 |
| /admin/users | 用户管理 | 搜索与筛选、详情抽屉、禁用（填原因）、加减积分（原因必填 + 二次确认）、强制下线 | 抽屉与确认对话框 |
| /admin/accounts | 上游账号池 | 表格含名称、分组、状态徽标、并发占用、额度条、冷却倒计时、24 小时成功率；新增与编辑抽屉（密钥只写）；测试、刷新、导入 | 新增，Codex 仅有静态示意 |
| /admin/models | 模型与定价 | 目录、能力、启用开关、账号绑定、图片价格矩阵（质量 × 分辨率）与视频价格（每秒 × 分辨率） | 新增 |
| /admin/plans | 套餐、订单、兑换码 | 套餐 CRUD、订单列表与手动入账、批量生成兑换码 | 新增 |
| /admin/jobs | 任务监控 | 状态筛选、取消、人工退款 | 新增 |
| /admin/settings | 系统设置 | 注册模式三态单选（切换时二次确认）、赠送与签到参数、限额、维护模式、内容规则 | 新增 |
| /admin/audit | 审计日志 | 操作者、动作、对象、前后值、时间 | 新增 |

通用要求：所有破坏性操作二次确认；所有表格具备搜索、分页、空态、骨架屏；积分统一用 CreditBadge 组件显示并带千分位。

## 8. 安全清单（全部通过才允许公网上线）

| 类别 | 检查项 |
| --- | --- |
| 身份 | 无 Cookie、伪造 Cookie、过期 Cookie 一律 401；前端无法通过修改请求体或本地变量提升角色；id\_token 只在后端验证；state、nonce、PKCE 缺失或重放必被拒绝；非 gmail.com 邮箱与带 hd 声明的账号被拒绝；Gmail 别名（点号、+ 后缀）无法重复注册 |
| 注册 | 注册 CLOSED 时新 Google 账号无法进入，老用户仍可登录；切换开关即时生效；同 IP 注册频率受限 |
| 授权 | 普通用户访问任何 /admin 接口返回 403；跨用户读取项目、素材、任务、会话一律 404；禁用用户的所有请求被拒且 Session 立即失效；管理员写操作要求 TOTP |
| 积分 | 并发 100 次相同幂等键只产生一次扣费；余额不足时事务整体回滚且无孤立任务；取消与完成竞争时不会错扣或错退；账本无法 UPDATE 或 DELETE；对账任务通过；前端传入的任何价格字段被忽略 |
| 签到与赠送 | 并发多次签到只得一次；同一 canonical\_email 或 google\_sub 不能重复领取赠送 |
| 上游与 SSRF | base\_url 仅管理员可设；私网、回环、云元数据地址被拒；不跟随重定向；密钥加密落库、接口不回显、日志不出现；用户无法通过任何参数指定上游或真实模型名；上游返回的视频结果地址只允许经同一出站客户端下载（同样的 SSRF 规则，并限制大小与时长），不得直接转发给用户 |
| 输入与上传 | 参考图校验魔数、解码、尺寸、大小（单张不超过 20MB），重新编码并剥离 EXIF；视频上传校验容器与编码、时长不超过 60 秒、大小不超过 200MB，一律经 ffmpeg 重新转码后才可播放，ffmpeg 在限时限内存的子进程中运行，禁止 file、concat 与网络类协议输入；画布 JSON 做体积、数量、类型校验；Markdown 渲染不允许原始 HTML |
| Web 层 | 非 GET 请求校验 Origin 与 X-CSRF-Token；Cookie 使用 \_\_Host- 前缀；CSP 禁止内联脚本、frame-ancestors none；不开 CORS（同源）；HSTS；错误信息不泄露内部细节 |
| 媒体 | /media 签名 URL 带过期时间，签发时校验归属；不可枚举对象路径 |
| 运维 | 数据库账号最小权限；每日备份并演练恢复；cargo audit 与 npm audit 进入 CI；/metrics 只在内网开放；日志脱敏；所有管理操作可在审计日志中查到 |

## 9. 部署与配置

- Dockerfile 三阶段：Node 构建 apps/web 得到 dist；Rust 构建 release 二进制；运行镜像用精简基础镜像（内置 ffmpeg 与 ffprobe）、非 root 用户，把 dist 复制到 /app/web。后端用 tower-http 的 ServeDir 托管，并对不以 /api 或 /media 开头的 GET 请求回退到 index.html。
- 生产 compose：caddy（80 与 443，自动 TLS）→ app（只在内网监听 8080）、postgres:16（数据卷，不映射端口）、redis:7（设密码，不映射端口）、可选 minio。本地开发 compose 的端口只绑定 127.0.0.1。
- Google Cloud：创建 Web 类型 OAuth 客户端，回调地址为 PUBLIC\_BASE\_URL + /api/v1/auth/google/callback；发布状态必须改为「正式」，否则测试状态下只允许 100 个测试用户登录。
- 数据库迁移在启动时用 sqlx::migrate! 自动执行；备份用每日 pg\_dump 并定期演练恢复；日志为 JSON 格式并带 request\_id。

| 环境变量 | 必填 | 说明 |
| --- | --- | --- |
| DATABASE\_URL、REDIS\_URL | 是 | 内网地址 |
| BIND\_ADDRESS | 是 | 默认 0.0.0.0:8080（容器内） |
| PUBLIC\_BASE\_URL | 是 | 外网访问地址，必须 https，用于回调与 Cookie |
| GOOGLE\_CLIENT\_ID、GOOGLE\_CLIENT\_SECRET | 是 | OAuth 客户端 |
| MASTER\_KEY | 是 | 32 字节随机值的 base64，用于加密上游密钥与 MFA 密钥；长度不对拒绝启动 |
| MEDIA\_SIGNING\_KEY | 是 | 媒体 URL 签名密钥 |
| BOOTSTRAP\_ADMIN\_EMAILS | 是 | 初始超级管理员邮箱（逗号分隔）；即使注册 CLOSED 也允许其首次登录 |
| MEDIA\_BACKEND、MEDIA\_DIR、S3\_\* | 是 | local 或 s3 |
| CHECKIN\_TZ、RUST\_LOG | 否 | 默认 Asia/Shanghai、info |

启动自检：缺少必填项、MASTER\_KEY 长度错误、PUBLIC\_BASE\_URL 非 https（本地开发白名单除外）时拒绝启动。生产构建中不存在 DEV\_AUTH 与任何演示登录路径。

## 10. 开发步骤（按顺序执行，每步验收通过再继续）

粗估：一人配合 AI，约 8 到 10 周。M6（画布前端）可在 M4、M5 期间用 mock 接口并行推进。

### M0 基线整理

- 任务：在本机跑通 npm install、npm run build、cargo check；用 prettier 格式化现有前端；把 main.rs 拆成 3.3 的 workspace；删除 DEV\_AUTH 与内存 Session；建立 CI（fmt、clippy、test、tsc、eslint、cargo audit、npm audit）；compose 加入 redis。
- 验收：cargo test 与 npm run build 通过；mock 模式 UI 行为与现在一致。

### M1 认证与权限

- 后端：迁移 users、sessions、system\_settings、invite\_codes、audit\_logs；OIDC 登录；Session 与 CSRF；RBAC 提取器（AuthUser、RequireRole）；registration\_mode；Redis 限流中间件；管理员 TOTP。
- 前端：/login、路由守卫、/settings。
- 验收：第 8 章「身份、注册、授权」各项都有自动化测试，包括伪造 token、重放 state、非 gmail 邮箱、Gmail 别名、注册关闭、禁用用户。

### M2 积分账本与签到

- 后端：wallets、credit\_ledger（含不可改触发器）、checkins、redeem\_codes；wallet 模块提供 hold、release、settle、grant、adjust；对账任务；管理员加减积分。
- 前端：/wallet、工作台签到卡片。
- 验收：100 并发同幂等键只扣一次；并发签到只得一次；余额不足整体回滚；对账通过。

### M3 素材与存储

- 后端：assets；上传校验（魔数、解码、尺寸、大小、重新编码、剥离 EXIF）；缩略图；视频上传转码、抽取封面与时长（ffmpeg、ffprobe）；local 与 S3 两种后端；签名 URL；保留期清理任务。
- 前端：素材库上传、筛选、删除。
- 验收：伪装成 png 的其他文件被拒；跨用户拿不到签名 URL；过期 URL 失效。

### M4 上游账号池与模型

- 后端：upstream\_accounts、models、pricing\_rules、account\_models；密钥加密；带 SSRF 防护的 HTTP 客户端；Provider trait 与 openai\_compatible 适配器（generations 与 edits）与异步视频适配器（提交、轮询、取回）；调度器与 Redis 并发槽；错误分类与冷却恢复；测试用假上游服务。
- 前端：/admin/accounts、/admin/models。
- 验收：假上游分别返回 429、401、5xx、超时、内容拒绝时，路由与恢复行为符合 4.5；私网地址被拒。

### M5 生图任务流水线

- 后端：generation\_jobs、generation\_outputs、job\_events；创建任务（预占）；worker（SKIP LOCKED、租约、回收）；状态机；取消；结算与释放；SSE；quote 接口。
- 前端：接入真实任务接口、任务列表、事件订阅。
- 验收：取消与完成竞争不错账；worker 崩溃后任务恢复；重复投递不重复扣费；n 张中部分失败时按 PARTIAL 结算。

### M6 画布工作台

- 前端：按 7.2 拆分重构；实现 7.3 全部 P0 项；7.4 布局；自动保存与 409 处理。
- 后端：projects 接口、快照、导入导出、图校验。
- 验收：Playwright 端到端——新建画布 → 拖入图片 → 连线 → 生成（假上游）→ 结果回流 → 刷新不丢 → 撤销重做 → 导出再导入；视频生成后可在画布播放；500 节点性能达标。

### M7 对话与意图识别

- 后端：抽出 agent-core；chat 接口与 SSE；意图动作卡；上下文压缩；计费。
- 前端：重做 /chat。
- 验收：准备不少于 30 条意图用例，准确率不低于 90%；压缩后继续对话不丢关键信息；动作卡不会自动扣费。

### M8 订阅与支付

- 后端：plans、subscriptions、orders；ManualProvider；订阅周期发放任务（每日扫描）；层级派生；P1 再接在线支付与 webhook（验签、幂等）。
- 前端：套餐、订单、兑换码。
- 验收：回调重放只入账一次；订阅到期自动降级。

### M9 管理后台全量

- 实现 7.5 中全部 admin 页面、dashboard、审计查看、内容规则、邀请码、任务人工处理。
- 验收：每个写操作都有审计记录；普通用户访问全部管理接口返回 403。

### M10 加固与上线

- 逐条验证第 8 章；50 并发任务压测；备份恢复演练；监控告警；服务条款与隐私政策页面；Google OAuth 改为正式发布；灰度上线。
- 验收：安全清单全部通过。

### P1 追加

画布助手、提示词库、在线支付渠道、PNG 导出、深色模式、移动端适配。

## 11. 测试策略

| 层 | 范围 | 工具 |
| --- | --- | --- |
| 单元 | 定价、尺寸换算、邮箱规范化、状态机转移、图校验 | cargo test、vitest |
| 集成 | 数据库与 Redis 真实实例、假上游 | sqlx + testcontainers |
| 并发与竞态 | 幂等、签到、取消与完成、并发槽 | tokio 多任务测试 |
| 越权矩阵 | 对每个 API 路由，分别以匿名、USER、ADMIN、跨用户身份请求并断言结果 | 自动生成的测试表 |
| 端到端 | 登录（测试用假 OIDC 提供方）、画布、生成、钱包、后台 | Playwright |
| 负载 | 50 并发生成任务、SSE 长连接 | k6 |

CI 门禁：fmt、clippy（deny warnings）、全部测试、tsc、eslint、OpenAPI 生成物一致、cargo audit、npm audit。

## 12. 待决策项（已给默认值，可随时调整）

| 问题 | 默认值 | 影响 |
| --- | --- | --- |
| 上游路线 | openai\_compatible（官方 API 或自建兼容网关）；session\_pool 默认关闭 | 成本与合规，见 1.5 |
| 支付渠道 | 先做手动入账 + 兑换码 | 决定 M8 工作量 |
| 首次部署注册模式 | CLOSED，由超级管理员开启 OPEN | 防止上线初期被刷 |
| 赠送与签到 | 注册赠送 20；签到 10，连续每天 +1，最多额外 +10 | 成本控制 |
| 素材保留 | FREE 30 天，订阅 180 天 | 存储成本 |
| 积分规则 | 不过期、不可兑现金 | 财务与合规 |
| 对话是否收费 | 每条 1 积分，可设为 0 | 引流与成本 |
| 内容审核强度 | 关键词 + 上游审核 + 违规 5 次自动禁用 | 平台责任 |
| 数据与隐私 | 需提供隐私政策；注意服务器所在地的个人信息保护法规 | 上线前置条件 |

## 附录 A：给 AI 的开工提示词模板

```
你是本项目的开发代理。请先完整阅读《Atelier 规格书》第 0、3 章与本里程碑对应章节。
当前任务：实现 M{n}「{名称}」。
要求：
1. 只改本里程碑范围内的代码。
2. 先写迁移与测试，再写实现。
3. 所有积分与权限相关逻辑必须有测试。
4. 完成后运行 cargo fmt、clippy、test 与 npm run typecheck、build，并贴出结果。
5. 把你的假设写入 docs/DECISIONS.md。
6. 在 PR 描述中逐条对照本里程碑的验收，标注通过或未通过。
禁止：引入规格外功能；在前端放任何密钥；绕过 wallet 模块直接修改余额。
```
