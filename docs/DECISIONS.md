# Atelier 开发决策

## 2026-10-22 · Google 实账号回调 issuer 修复

- 用户实账号回调包含 `iss=https://accounts.google.com`，旧 Callback 使用 deny_unknown_fields 却未声明 iss，导致合法响应在 Query 解析阶段直接返回 401。旧自动化提供方未附带该标准字段，因此此前 CI 未覆盖真实响应形态。
- 按 [Google 官方参考](https://developers.google.com/identity/openid-connect/reference) 与 [RFC 9207](https://www.rfc-editor.org/rfc/rfc9207.html) 声明必填 iss，严格匹配 HTTPS Google issuer，在消费 state 和兑换 code 前校验。缺失、空、重复、HTTP、其他域名、尾斜杠或附带伪造 id_token 均拒绝。保留未知字段拒绝、浏览器绑定、PKCE、一次性 state 与 JWT 签名/声明校验，不放宽认证。
- 先将真实 issuer 加入 HTTP/浏览器夹具并新增回归，确认旧实现 2 项失败，再修复到 login_http 5/5 通过。浏览器模拟 Google 的重定向现在也包含 issuer；OpenAPI 与 TypeScript 同步更新。
- 用户正在运行后端，Windows 锁住默认目录的 exe；本机验证使用忽略的独立 CARGO_TARGET_DIR，未停止用户服务。应用新修复需 Ctrl+C 后重新 npm run dev，再从登录页发起新的授权流程，不能刷新旧回调 URL。
- 本机读取公开 Google JWKS 的检查：直连失败，现有本机 7890 代理返回有效公钥。仅在后端忽略配置中补 HTTPS_PROXY（如已有则保留），不写前端或提交到仓库。实际 Google 账号完成登录仍需用户重试验证。

## 2026-10-22 · 一条命令启动真实前后端

- 用户明确希望像 npm run 一样启动，不要求手动开启两个终端。根目录提供 npm run dev、dev:api、dev:web，由 Node 原生子进程启动 Cargo 与现有 Vite；无新第三方依赖，也不改为 npm workspace，保留 apps/web 独立锁文件。
- Node 解析后端本地配置，仅交给 API 子进程；Vite 强制 VITE_API_MODE=http，避免已有 Mock 配置导致误入演示。检查端口冲突，不强杀用户旧进程。Windows 清理当前子进程树，Unix 使用独立进程组；任一服务退出会停止另一端。
- 此变更属于 M2 本地运行体验，不进入 M3，不增加开发登录或更改认证策略。已验证真实接口启动和进程清理；Google 实账号交互仍由用户在浏览器完成。

## 2026-10-22 · M2 与现有 WSL 基础设施

- 用户新要求覆盖 M1 停止约定：先补部署好的 PG/Redis，再完成 M2。阶段切片完成后自行提交上传，让 GitHub Actions 验收；本轮停在 M2。
- 复用 WSL PG 16 / Redis 7（15432 / 16380），不安装启动服务。新建独立业务库与测试库、不同角色；测试角色有 CREATEDB。随机凭据不输出，仅在 services/api/.env 和 .env.test.local。Redis 测试逻辑库 15，不执行 FLUSHDB。
- scripts/api.ps1 只解析 KEY=VALUE，不执行配置文本；提供 run/infrastructure/test-infrastructure/test-browser。BAT 复用入口，不再覆盖地址。Google/MASTER_KEY/Bootstrap 仍由负责人配置，没有生产默认凭据。
- 既有 M1 账号建空钱包，不追溯赠送；仅新身份在注册事务内调用 wallet 写默认 20 分 SIGNUP_BONUS，审计失败整体回滚。
- 钱包行锁和账本参数核对防止重复操作；结算/释放核对该 job 剩余 held，不能占其他任务额度。apply_in_transaction 供未来生成/订单共享事务，当前不实现生成任务。
- 签到时区取数据库设置并用 PostgreSQL AT TIME ZONE 计算日界，避免新增时区依赖。时区回拨到上次签到日期之前拒绝发奖；连续、断签、上限与奖励在同一锁内计算。
- 兑换请求作用域为用户，调账为操作者；保存首次收据、哈希参数，不存兑换码明文。兑换码生成 API 仅返回一次明文，不自动重试；全量后台 UI 属 M9。
- 规格未指定调账路径，补 POST /admin/users/{id}/credits，要求 MFA、原因、UUID 幂等键；扣减不得低于 held。/me 保持身份响应，钱包独立 GET /wallet。
- 对账在启动及每 24 小时运行，单条 SQL 在同一 MVCC 快照核对 balance/held。异常 tracing error 明确报告；外部监控通知属 M10。
- 触发器禁止账本 UPDATE/DELETE，额外禁止 TRUNCATE；启动及基础设施检查撤销当前角色这些权限。当前本地角色仍有迁移能力，生产独立迁移/运行角色最小权限留给 M10。
- 测试迁移和断言先加入再实现；本地真实基础设施 18 项、浏览器 10 项通过。浏览器夹具改为 SQLx 随机隔离库，生产无测试提供方或开发登录。
- npm 镜像不支持 audit，改官方 registry；Rust 下载经本机已有代理。Cargo.lock 仅新增本地 workspace 模块的依赖边，无第三方版本变动；两种审计均 0 漏洞，无豁免。
- 阶段提交已按用户要求推送为 19d3ef2；对应 Actions 39772855488 的 baseline / identity-schema 均 completed/success。本次仅追加真实验收记录，不修改功能代码或绕过 CI。

## 2026-10-22 · M0 基线整理

- 当前提示词中的 M{n} 未替换，仓库没有历史提交或里程碑进度；按规格第 0、10 章从 M0 开始。原始原型先提交为 c3384c5。
- 仅操作 Atelier，ShellPilot SSH Agent 与客户端不属于本轮范围。
- M0 只建立 workspace 边界，不把空模块标成可用功能。认证由 M1 实现；在此之前受保护 API 一律拒绝，不继续提供不安全的原型余额、任务及开发登录。
- 旧迁移从活动 migrations 移到 docs/legacy，保留原文件便于审计；本机尚无数据库，M0 使用无业务表的基线迁移。已有旧版数据库不得直接套用新迁移，需要独立的数据迁移方案。
- Mock 保留为明确选择的开发模式。默认生产构建使用独立 HTTP 入口，不导入演示身份、本地积分与种子数据；Mock 构建只可输出 dist-mock。
- PostgreSQL / Redis 未安装，不安装或启动基础服务。纯测试与编译正常运行，真实实例回归单独标为待验证。
- 用户要求本地提交，未要求推送或创建远端 PR；在 docs/PR_M0.md 保存逐条验收描述，保持远端不变。

- 实机系统 Node 18.12 不满足当前检查工具要求；本轮仅在忽略目录 `.tools/node` 安装 Node 22/npm 10，未更改全局环境。项目 engines 与 CI 固定 Node 22。
- 规格 3.1 的版本规则要求稳定版本。原 Router 6 的 npm audit 报告两项 moderate，且修复只在新主版本发布；升级为 React Router DOM 7.18.4，保留声明式路由 API，不新增路由功能。类型检查及完整 Mock 浏览器回归通过，更新后 npm audit 为 0。这是技术表中 Router 6 的显式兼容性偏离，便于后续审阅。
- cargo-audit 未全局安装；尝试项目内源码安装时索引长时间阻塞，终止本次安装释放缓存锁，离线重试缺 addr2line；官方发布 API 又被出口限流。CI 保留真实 cargo audit 门禁，本机审计未通过验证，不把未运行的检查写成通过。

## 2026-10-22 · M1 身份基础切片

- M0 代码提交后按用户要求继续 M1。本切片仅实现身份迁移、纯策略和会话材料工具，正式 API 继续拒绝所有身份；不能把它认定为已实现 Google 登录、Session 或 MFA。
- 规格同时写“仅 gmail.com”和“googlemail.com 视为 gmail.com”。保守处理：规范化函数支持 googlemail.com 以用于去重；实际已验证 Google 身份的邮箱域仍严格要求 gmail.com（大小写不敏感），任何 hd 声明均拒绝。
- Bootstrap 管理员仅绕过注册模式，仍受新注册 IP 数量上限约束；已有身份登录不计新注册额度。数据库并发计数、邀请码消费和首次授予角色由后续 service/repo 在事务内实现。
- 会话 Cookie 按 __Host- 要求始终 Secure，令牌和 CSRF 各用系统 CSPRNG 生成独立 32 字节；数据库只接收令牌 SHA-256。摘要对传输的 Base64url 字符串计算；Debug 输出脱敏。
- 非 GET（包括 HEAD / OPTIONS）严格按规格检查 Origin 和 CSRF，重复安全头直接拒绝。Origin 应来自服务端规范化配置；不接受请求 Host 自动成为信任来源。
- 数据库绝对期限采用 720 小时，避免会话数据库时区有夏令时时 interval '30 days' 与 UTC 策略产生偏差。
- 无本地数据库时，真实迁移测试显式 ignore，不能报告通过；CI 新增隔离 PostgreSQL 16 作业专门运行 ignored schema 测试。本轮未推送或运行远端 CI。
- 未实现注册赠送积分；M2 通过 wallet service 接入，禁止 auth 直接改余额。

## 2026-10-22 · 会话服务与推送约定

- 用户已明确授权当前及后续正常推送至 https://github.com/jasonlat-dot/atelier.git 的 main；覆盖上文“仅本地提交”的历史范围，不创建/强推历史。
- GitHub 公开账号信息确认 jasonlat-dot ID=223874649，提交身份只在本仓库设置为 jasonlat-dot / 223874649+jasonlat-dot@users.noreply.github.com；此前三个提交沿用的全局身份不重写。
- 规格要求“设备及撤销”但未列 URL，补 GET /api/v1/me/sessions 和 DELETE /api/v1/me/sessions/{id}。设备 ID 为独立随机 UUID，绝不把 token_hash 当设备 ID 返回。
- 数据库不可用返回 503 SERVICE_UNAVAILABLE，不能伪装成 401 导致前端错误退出；SQL 错误、连接串和原始 Cookie 不回显。
- PUBLIC_BASE_URL 为必填，以规范化可信配置比对 Origin 和 Host；不信 Forwarded/X-Forwarded-Host，HTTP/2 authority 也必须匹配。生产只允 HTTPS，回环 HTTP 仅开发白名单。
- 按规格对所有非 GET（含 HEAD/OPTIONS）做 CSRF；GET /me 和注销允许未完成 MFA 的管理员进入，用于取得身份/CSRF和安全退出，其他业务要求最近 12 小时 MFA。
- Session last_seen_at 使用 GREATEST 更新，避免并发请求覆盖为更早时间；条件更新拒绝查询后发生的会话撤销和角色变化。不是会话缓存，不在内存保存生产 Session。
- /me 暂不返回虚构钱包/订阅摘要，待 M2/M8 按模块接入。没有 OIDC 前不提供任何开发或测试登录给用户，Google 按钮暂禁用。
- 前端浏览器测试使用 HTTP 响应合同替身，Rust HTTP 测试使用测试仓库替身；它们不替代真实 PostgreSQL/Redis/OIDC 回归。远端 CI 状态读取遭 API 限流，结果仍按未确认记录。

## 2026-10-22 · OIDC 临时状态与依赖审计

- 本切片仍属 M1，只提供 OIDC 发起材料与 Redis 原子存储，不新增 HTTP 入口，不签发 Session；消费 state 不代表用户已认证。前端继续禁用 Google 登录，直到 token 校验、注册事务和回调完整接通。
- 继续沿用 M1 身份及设备迁移；state 与限流仅存 Redis，不新增空 SQL 迁移。公开 API 无变化，OpenAPI/前端生成类型不变。
- state、PKCE verifier 和浏览器绑定值各自独立；state 使用 32 字节随机值，避免 oauth2 默认 16 字节 state 与严格回调格式不一致。nonce/verifier 保留服务端，浏览器绑定 Cookie 使用 __Host-oidc、Secure、HttpOnly、SameSite=Lax、10 分钟。
- Redis SET NX EX 保存 10 分钟 state；Lua 仅在浏览器绑定摘要匹配时原子消费，错误浏览器不能销毁合法登录。服务端额外检查时间，Redis 故障返回不可用，生产不降级到内存。
- 登录限流用 Redis TIME 与原子滑动窗口；IPv4-mapped IPv6 归并同一 IP。当前只是 service，尚未接入中间件；其他限流常量也未代表对应业务已可用。IP 后续取可信连接来源，不直接信任客户端转发头。
- 本机不安装/启动 PostgreSQL 和 Redis；新增 Redis 真实实例测试显式 ignore，CI 使用独占 runner 的回环 Redis 7（数据库 15、临时数据），验证 100 并发 state 单次消费、NX/TTL 和滑动窗口。CI 临时 Redis 不对公网开放，不作为生产无密码配置示例。
- 已在项目忽略目录安装 cargo-audit；其直接拉取公告库失败，改用现有本机代理进行普通 Git clone 后对该新鲜公告库 --no-fetch 审计，未禁用漏洞匹配。实际发现 rsa 0.9.10 / RUSTSEC-2023-0071；详见 SECURITY_AUDIT.md。保留 CI cargo audit 硬门禁，不加 ignore 或 continue-on-error。
- npm audit 改为即使前序步骤失败仍执行，使 Rust 告警不会遮蔽 JavaScript 审计结果；失败仍会使整个作业失败。

## 2026-10-22 · 移除 RSA 漏洞依赖

- 用户明确要求“有漏洞不能保留”。优先消除依赖来源，覆盖此前暂时保留审计失败的处理；不接受 ignore、降阈值或 continue-on-error。
- 官方 openidconnect 4.0.1 将 rsa 列为必需依赖，无法通过关闭默认 feature 去除；SQLx 0.8 的锁文件也会保留 MySQL 引入路径。所有现有 rsa 版本均无公告修复版本，不做无依据降级。
- SQLx 升到稳定 0.9.0。其 MySQL RSA 已拆为独立可选功能，项目只启 PostgreSQL、Tokio 和 rustls/ring，显式启用已有审计 JSON 字段所需 json feature；Cargo 正常解析生成锁文件，未手删传递依赖。SQLx 0.9 要求 Rust >=1.94，本机 1.99、CI stable 满足。
- 规格 3.1 原指定 openidconnect；根据用户本次安全要求，当前授权材料准备改用同上游维护者的 oauth2 5.0.0（openidconnect 原来已经依赖它）生成授权 URL/state/S256 PKCE，独立 32 字节 CSPRNG nonce，保留原来的 openid/email/profile、回调 URL 与一次性 Redis 浏览器绑定。
- 该切片尚未实现 ID token 校验，替换后仍不开放登录。后续签名验证须选择通过审计的实现，不能跳过 JWKS/iss/aud/exp/nonce 验证，也不能自己实现密码学原语。
- 本次无 schema/公开 API 变化，沿用已有 M1 迁移和 OpenAPI。先增加会失败的锁文件回归测试，再替换依赖；现有会话、权限、PKCE/nonce、重放测试继续验证行为。CI 已运行 tests/baseline.test.cjs，新断言阻止 rsa 重新进入锁文件。
- 依据：[openidconnect 必需 rsa 依赖](https://docs.rs/crate/openidconnect/4.0.1/source/Cargo.toml)、[SQLx 0.9 mysql-rsa 可选功能](https://github.com/launchbadge/sqlx/blob/v0.9.0/Cargo.toml)、[oauth2 文档](https://docs.rs/oauth2/5.0.0/oauth2/)。

## 2026-10-22 · M1 登录、注册事务与 TOTP 收尾

- 用户最新范围是完成 M1 后停止，覆盖此前自动继续下一里程碑的约定；本轮不进入 M2。
- Google 只使用固定 HTTPS token/JWKS 地址，reqwest 禁止重定向、连接/整体超时、响应大小上限；每次回调重新读取 JWKS，暂不引入缓存和后台刷新。ring 验证 RS256（RSA >=2048 位），严格校验两种 Google issuer、aud、exp、nonce、可选 azp/nbf/iat、email_verified 与 Gmail；任何 hd 声明包括 null 均拒绝。没有手写密码学原语。
- VerifiedIdentity 只能由验签函数构造；handler 不接受 id_token。state 成功消费后即使 code/注册失败也不复用。邀请码随 state 存 Redis，与回调参数无关；空邀请码视为未填写。
- 注册事务按固定顺序取得 IP/sub/canonical-email advisory locks，再读最新并锁住注册设置；已有用户按 sub 登录，绝不按邮箱合并账号；首次 canonical 冲突拒绝。邀请码行锁消费、建用户、Session、last_login、审计同事务，审计失败整体回滚。首次 Bootstrap 绕过注册模式但不绕过 IP 配额，之后不因环境变量重新提升角色。
- 登录轮换本浏览器旧会话；其他设备保持，退出仍是全设备退出，符合已有设置页文案。M1 无钱包写入，注册赠送由 M2 的 wallet 幂等接口实现。
- 管理员 TOTP 为 SHA1/六位/30 秒/±1 步；待绑定 secret 10 分钟并绑定用户和发起 Session。ChaCha20Poly1305 使用 CSPRNG nonce 与用户 UUID AAD；MASTER_KEY 为环境提供的 32 字节 base64，无生产默认值。确认时才启用；时间步在 PostgreSQL 用户行锁中原子单次接受，跨设备不能重放；当前会话获得 12 小时验证时效。已绑定不可用 setup 覆盖，不额外引入恢复/重置功能。
- 绑定流程必须把当前用户自己的 TOTP 配置交给验证器，因此仅已认证管理员、CSRF 通过、未绑定时返回一次性 otpauth_uri。前端仅在内存临时展示该用户的验证器密钥，不存 localStorage；MASTER_KEY、Google Client Secret、上游密钥不返回前端，也不写日志。这与禁止前端存放服务端密钥的要求区分。
- MFA 额外限流选择 5 次/5 分钟/用户；管理员写操作仍按规格 60 次/分钟。Redis 故障拒绝，不降级到内存。
- IP 来源默认 TCP 对端，绝不直接相信转发头；部署反向代理时仅允许显式 TRUSTED_PROXY_IPS 提供单值 X-Real-IP，代理需覆盖该头。避免共享代理 IP 导致用户共用配额，也避免客户端改头绕过。
- 所有 OAuth/Redis/Bootstrap/MASTER_KEY 生产配置必填。自动审批曾因把测试固定值判为生产默认值拒绝配置接线；改为生产无默认凭据，独立 tests/config.rs 使用临时随机密钥的纯测试夹具，安全替代后审批通过，未请求放宽安全要求。
- /login 的服务条款链接提供开发阶段占位说明；正式法律文案属 M10，上线前必须替换，不把占位当作已完成法律条款。
- 新迁移 202610220300_m1_login_mfa.sql 添加待绑定状态与防重放时间步，不修改已提交迁移。OpenAPI 与生成类型同步；Google 真凭据/部署回归仍由用户后续自行完成。
- 测试签名私钥仅为本轮本机生成的合成夹具，在 tests/fixtures 下；真实浏览器夹具也只在 tests/browser_harness.rs 中，需 TEST_AUTH_HARNESS=1 和隔离数据库/Redis，生产 main 没有该模式或测试提供方。
- Windows 本机 session_http 的默认调试产物反复遇到 LNK1104，检查无对应运行进程、无 Defender 检测事件；清理该包构建缓存后仍出现。仅对本机测试设置 CARGO_PROFILE_TEST_DEBUG=0（不改断言、优化级别或安全逻辑）后 14 项权限 HTTP 测试通过；CI 保留标准配置运行。

- CI 完整浏览器夹具需拦截 start 的首跳：Playwright 不对重定向链后续 URL 再调用 route。夹具用 route.fetch(maxRedirects=0) 取得真实后端 302/绑定 Cookie，断言原 Google URL 和全部安全参数，再模拟提供方回调；保留 PKCE/nonce 签名验证与全部权限断言，不访问真实 Google。

## 2026-10-22 · M1 验收与停止点

- GitHub API 与用户截图确认源码 `16837884926d2316b5c5ac7c427398f42efa5647` 的 CI `39759708282` 全部成功，含真实 PostgreSQL/Redis 11 项与认证浏览器 2 项；据此更新 M1 为代码与自动化验收完成，替代本文件早期切片“未接通/待验证”的历史状态。
- M1 的资源归属验收针对已实现的会话资源；项目、素材、任务尚未接入，归属验证随各自里程碑完成，不把通用 404 当成这些业务已实现。
- 本机仍不安装/启动数据库与 Redis。CI 使用隔离实例与合成 Google 提供方；真实域名、凭据、代理和目标环境由负责人部署后按 M1_VALIDATION.md 回归，不宣称已经上线。
- 按用户“做完 M1 就停止”执行：收尾文档正常提交并推送至既定 origin/main 后停止，不自动进入 M2，不打包或部署。后续新指令才能开启下一里程碑。

## 2026-10-22 · 登录页参考图调整

- 按用户提供的登录页参考图，在既有 React/CSS 栈内实现暖灰背景、独立品牌标识、白色卡片、衬线标题、注册提示、Google 图标按钮及条款分隔线。样式限定于 LoginPage.css，不影响共用 signin 样式的 MFA、服务故障及条款页面。
- 注册模式继续读取服务端：CLOSED 显示关闭提示；INVITE_ONLY 保留邀请码输入；OPEN 不显示关闭提示。加载、配置失败重试、禁用账号提示及后端 GET 登录入口沿用原行为，不将截图中的 CLOSED 状态硬编码为业务规则。
- 不增加依赖、字体下载、数据库迁移或 API 契约变更。参考图用作布局依据，不把整张截图作为页面背景；新增图形由文本、现有 lucide 图标及内联 Google SVG 构成。

## 2026-10-22 · 开发代理 Host 与 CSRF

- 开发模式 PUBLIC_BASE_URL 保持浏览器来源 http://127.0.0.1:5173。Vite 的字符串 proxy 配置会隐式启用 changeOrigin，导致写请求 Host 变成内部 8080 并被严格来源检查拒绝；改成显式 changeOrigin=false，保留原始 Host 与 Origin，不信任或自行补写任何转发来源头。
- 既有 HTTP 浏览器替身不经过真实代理，真实认证夹具又直接访问 8080，因此之前未覆盖此开发拓扑。新增加载实际 Vite 配置的真实 HTTP 代理回归并接入 CI，分别验证可信与不可信 Origin 原样转发；不放宽后端校验，不新增依赖、迁移或 API。
- 用户已确认本机真实 Google 验证成功；管理员 MFA 为独立的 TOTP 绑定步骤，绑定与验证码由用户在验证器中完成，不通过调库跳过。

## 2026-10-22 · MFA 默认二维码与手动密钥

- 根据用户明确要求，绑定材料优先以二维码展示，手动密钥为可切换后备方式。保留显式点击绑定后请求 setup，避免组件挂载/StrictMode 重复生成绑定材料与消耗限流；显示方式切换只改本地视图，不重新生成密钥。
- 使用 qrcode.react 4.2.0 将现有后端 otpauth_uri 在浏览器本地编码为 SVG，保留四模块留白，不使用外部二维码 API、外部图片 URL 或自动复制。密钥复制仅由用户点击触发，失败时保留手动全选复制路径。
- 指引说明手机 App 入口、账号名称、基于时间类型、六位验证码来源及绑定时限；不改变 TOTP、MFA 最近验证时效或任何权限规则。无迁移/API 变化；已绑定账号只需输入验证码。

## 2026-10-22 · 六格验证码与参考图布局

- 用户提供管理员验证页新参考图，本次仅调整该页面布局与验证码输入体验。使用单一原生输入呈现六个装饰格，避免拆为六个字段后破坏粘贴、编辑与系统验证码填充；装饰格 aria-hidden，输入保留显式标签及帮助说明，焦点在对应格可见。
- 保留显式生成绑定材料，未生成前禁用验证码及提交；界面显示 Google 已登录，仅表示 Google 会话已建立，管理员 MFA 仍以服务端验证成功为准。无 schema/API 或依赖变化。

## 2026-10-22 · 取消首次绑定确认与风险操作弹窗

- 首次生成绑定材料无需二次确认，移除该处 window.confirm，保留显式点击和防重入加载态。成功后仅移动焦点到验证码，避免自动滚动将二维码移出当前视区。
- 退出全部设备仍需确认；使用带自定义样式的 HTML dialog 提供模态语义、背景隔离与 Esc，显式处理按钮聚焦及 Tab 循环，确认后才调用既有 CSRF 保护的 logout API。本次范围限 MFA 页面，其他页面的确认交互不混入修改。
- 当前已启用 MFA 的账号不能经 setup 覆盖绑定。重新绑定属于后续独立后端流程：验证当前身份，确认新验证器后再使旧验证器失效；丢失手机需独立恢复方案。本次不增加只展示按钮而缺少后端保障的入口。

## 2026-10-22 · 区分 MFA 验证码错误与待绑定过期

- 用户要求分别提供“验证码不正确”和“绑定已过期”弹窗。现有 MFA_INVALID 同时覆盖两者，前端不能依靠浏览器计时或猜测错误原因；新增服务端 409 MFA_ENROLLMENT_EXPIRED，仅在已认证管理员当前会话的待绑定材料实际过期时返回，验证码无效/失效/重放仍为 401 MFA_INVALID。
- 使用数据库 clock_timestamp，避免应用与数据库时差及事务等待期间固定 now() 引起期限误判。原子接受阶段再次检查期限和材料/会话匹配，保留原有 MFA、CSRF、权限、限流及审计规则。沿用既有列，无迁移；同步公开 API 响应契约。
- 过期弹窗中的“重新绑定”仅为重新生成尚未启用的待绑定材料，与前文建议的已启用验证器更换功能不同。取消不重新请求；新生成成功前不恢复验证码提交，重新生成失败继续显示错误反馈；不允许覆盖已启用密钥。

## 2026-10-22 · 原型布局用于真实工作台

- 用户要求正式登录后的界面与现有原型一致。恢复 App.tsx 中的导航、顶栏与首页结构，生产组件独立实现并复用视觉 CSS，避免导入 Mock App、种子身份或本地钱包。
- 正式首页为 `/`，登录与 MFA 完成后进入首页；`/settings` 保持独立账号设置路由。现有真实积分、签到、设备与资料功能保留；尚未实现的 M3+ 功能只保留明确禁用的入口和空态，不生成虚构项目或统计。
- 原型侧栏的固定额度进度条没有对应服务端配额，不在正式界面展示；可用余额使用真实钱包快照并随签到和兑换刷新。新增账号设置与已实现积分管理入口，按服务端角色显示运营菜单。
- 用户提供的 favicon.svg 作为浏览器标签页图标，原文件保留。所有改动属于 M2 交付体验修正，不扩大到画布、素材或对话业务。

## 2026-10-23 · 素材库按原型接真实存储

- 用户新指令覆盖旧 M2 停止点，当前推进 M3，先交付可独立验收的图片素材库，再补视频与 S3 实服务验证，不开启 M4。
- 沿用当前 React/CSS/原型素材卡和导航；生产页面独立接生成类型与真实 API，不直接导入 Mock App。上传、删除和签名读取分别在后端校验归属，不能依赖页面筛选。
- 使用官方 [image 0.25.10](https://docs.rs/image/0.25.10/image/) 解码/方向校正/重编码，限定 PNG/JPEG/WebP 和资源预算；用 Apache [object_store](https://docs.rs/object_store/0.14.2/object_store/) trait 统一 local/S3。S3 强制 HTTPS，存储配置/密钥仅在服务端，实际 S3 未验证前不声明验收。
- 保留原始业务文件的含义是重新编码后的素材，不保留未经校验的图片上传体；签名由 ring HMAC 实现，独立域派生密钥，过期 5 分钟，仍要求当前 Session，避免跨用户共享链接泄露。物理清理失败重试，不恢复已经撤销的访问。
- 现有 subscriptions 尚未建表，全部当前用户为 FREE，默认保留 30 天；180 天设置留待订阅业务应用。临时保护上限每人 500 个/2 GiB、上传 10 次/分钟、图片处理并发 2，避免未接配额业务前无界占用资源。
- 真实认证测试支持 TEST_AUTH_BASE_URL/TEST_AUTH_PORT，仅 loopback；本地独立 8082，不依赖或停止用户运行中的 8080。页面替身测试拦截钱包读取，避免偷偷访问真实开发 API。

## 2026-10-23 · 视频持久处理与运行边界

- M3 视频直接复用 assets 状态和 PostgreSQL 持久队列，不提前引入 M5 生成任务。上传体只供受限 FFmpeg 管道读取，处理输出统一 MP4；每次尝试使用独立对象键和租约令牌，READY 与审计同事务。全部对象先登记后写入，进程中断后也能回收。
- Windows 的进程限额借助现有 WSL 的 timeout/prlimit；Linux 本机使用相同命令，避免仅杀 WSL 桥接进程却遗留编码进程。VIDEO_MODE 支持 native/wsl/disabled，FFMPEG_DIR 仅为服务端路径。工具版本/路径不可用时不虚报视频能力，图片继续工作。
- 上传严格限制 60 秒。真实 60 秒带音轨夹具表明 AAC 编码填充会让 MP4 容器多出约 23 毫秒；依 [FFmpeg 格式文档](https://ffmpeg.org/ffmpeg-formats.html) 的分片输出机制保留流式 MP4，只对自产输出允许最多 100 毫秒编码/帧填充，并限制记录/展示时长至 60 秒；不放宽上传时长。添加真实 60/61 秒和含音轨 WebM 回归。
- 此切片完成视频本地链路；S3 兼容后端尚待实服务验收，继续保留 M3 进行中，不能进入上游账号/模型业务。

## 2026-10-23 · M3 完成范围调整

- 负责人明确要求“S3 先不做，改成待定；如果没有其他问题了，M3 先标记完成”，覆盖规格中本轮 S3 实服务验收的要求。当前采用本地磁盘，不要求另开对象存储服务。
- M3 完成范围为已接原型的本地图片/视频上传、校验、重编码、封面、私有签名读取、Range 播放、搜索筛选、删除和保留期清理。S3 适配代码保留，状态待定且未验收，不将其描述为生产可用；它不再阻塞 M3。
- 检查通过后记录 M3 完成；本轮不自动启动 M4。

- 高分辨率用户视频复现 x264 前瞻缓存内存分配失败；采用 zerolatency 限制缓存，保留原有进程内存、时间和并发限制。以同尺寸合成夹具做持续回归，用户原文件仅用于本机只读验证，不提交其媒体内容。

## 2026-10-23 · M4 范围与适配边界

- 负责人要求完成 M4 后停止，不继续 M5；覆盖 M3 停止点，S3 保持待定。M3 修复提交 3852747 的 Actions #39821826331 已确认 success。
- 管理页沿用现有原型。按规格的严格保密规则，地址、密钥和真实上游模型标识均只写不读；编辑留空表示保留，视图与审计仅含脱敏配置。MASTER_KEY 以独立域派生 XChaCha20-Poly1305 密钥，关联账号 ID 与版本，避免与 MFA 密文混用。
- 规格引用视频 4.8 但正文没有该章节：M4 采用官方兼容 /videos 提交、查询、内容下载协议；视频模型能力显式包含可选秒数和尺寸，价格按秒配置。现有核心 SQL 的 models.kind 示例补入 video。图片采用 /images/generations 和 multipart /images/edits。参考：[Images](https://developers.openai.com/api/reference/resources/images/methods/generate)、[Videos](https://developers.openai.com/api/reference/resources/videos/methods/create)。
- 兼容供应商没有统一额度查询协议，因此提供真实连通性测试和管理员手动额度更新，不伪造供应商实时余额。M4 提供可测试的适配与调度 service；生成任务队列、用户生成接口、报价授权、钱包预占/结算与 SSE 均留在 M5。
- 出站请求每次校验并固定 DNS 解析结果，拒绝私网/元数据/特殊用途地址、重定向和环境代理。开发白名单仅允许明确 loopback origin，且只有服务绑定与 PUBLIC_BASE_URL 都为 loopback 时可配置；无默认放行。


- M4 原型管理页复用生产工作台与既有表格样式，不加载 Mock 数据。账号敏感字段采用空输入/留空保留；风险操作使用可访问的 dialog，支持 Esc/遮罩/焦点恢复及请求锁。价格按公开模型和质量维护，倍率全局带版本；本轮只保存配置，不提前实现用户报价或扣款。
- 连通性测试纳入 24 小时统计，UI 明确说明；真实供应商连通性和付费内容验证需部署者使用自己的配置执行，本轮通过可控 HTTP 假上游、真实隔离 PG/Redis 和真实浏览器完成 M4 验收。浏览器测试的动态 loopback 上游和地址文件仅存在测试夹具，生产无对应接口或登录开关。


## 2026-10-23 · M5 生成任务边界

- 最新授权为继续 M5；S3 仍待定，不自动推进 M6。M5 接入真实生成面板、结果与任务，保持现有原型样式；项目图、连线编辑与图持久化由 M6 完成，当前 project_id/node_id 非空请求明确拒绝，不接受未经校验的资源引用。
- M8 订阅尚不存在，当前全部用户按 FREE 设置校验（免费最多 2K、默认一个活跃任务，可由现有 system_settings 调整）。视频按模型支持的秒数计价；没有凭空创建订阅或支付能力。
- 报价只展示；创建再次读取同一事务中锁定的模型能力/价格并冻结快照。编辑附加费按张加在分辨率倍率之后，视频按秒形成每片输出成本。模型配置在排队期间发生变化时失败释放，避免按新能力执行旧报价。
- 事件以 PostgreSQL 为权威，按 owner 序列读取；所有带事件的状态事务均先锁用户，再锁任务，确保同一用户事件提交顺序。新结果在钱包结算和终态提交前不对素材读取/删除/签名开放。
- 内容规则支持大小受限的 Rust regex 与普通子串，坏规则或服务不可用时拒绝创建，不绕过拦截；不在日志记录提示词或上游原始响应。


- M5 将视频上游任务 ID 和派发身份持久化；已知 ID 后仅在原账号/原配置继续查询和下载。派发开始后崩溃但没有 ID 时无法确认上游是否已收费，安全失败并全额释放用户积分，平台承担潜在成本，禁止自动重新提交。凭据/模型版本变更时也不把原任务转交给新接口。
- 图片生成崩溃可在三次预算内恢复；已有任何可用媒体检查点时只发布/结算现有结果，按 PARTIAL 处理，不重复调用上游补张。生成素材与输出的完整性由 assets service 管理，只有最终事务发布后才允许用户读取。
- 取消在 STORING 阶段也可请求，提交终态前以行锁决定先后：取消标记先提交则全额释放且不发布，成功终态先提交则返回已完成，不另外释放已结算积分。所有路径仍只通过 wallet service 改余额。


### M5 事件重放与连接授权

SSE 使用 PostgreSQL 持久事件及 Redis 唤醒，不把 Pub/Sub 当消息持久层。客户端重连游标由 Last-Event-ID/after 传递；服务端按用户隔离、限制连接并持续复核会话/MFA。事件中的媒体链接即时重新授权签名，客户端仍以任务/钱包查询为准。Redis 不可用时不放宽容量限制。


### M5 原型入口与提交交互

在既有工作台新增图片与视频生成入口 `/generate`，复用创作面板、结果和任务布局；生产页面不引用演示数据库。M6 的画布/项目仍保持待开放。生成前展示服务端报价，最终创建重新定价；HTTP 5xx/网络不明保留原 UUID 和冻结参数供用户重试，明确不自动重新提交。已结束任务的“复用参数”仅填表和重新报价。SSE 断开时五秒轮询、在线十五秒刷新，任务和钱包返回值决定结果与积分，不做前端扣分。


### 2026-10-23 · 上游地址允许 HTTP

负责人明确要求解除新增上游账号的 HTTPS 限制。EgressPolicy 允许公网 http:// 与 https://（包括显式端口），作用于账号保存/导入和实际 Provider 传输；不增加额外开关。协议仅限这两种，DNS 固定、全解析结果公网校验、禁凭据 URL/重定向/环境代理与请求边界保持原规则。私网/loopback 仍按现有精确开发白名单处理，不把“允许 HTTP”解释为开放全部网络地址。Google OIDC、站点公网入口和 S3 的协议要求不受本次上游配置变更影响。
