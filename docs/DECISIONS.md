# Atelier 开发决策

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
