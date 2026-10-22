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
