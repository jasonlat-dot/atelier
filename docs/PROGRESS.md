# Atelier 里程碑进度

依据：根目录《Atelier AI 创作平台 · 产品与工程开发规格书（AI 开发版）》第 0、3、10 章。

- [x] 原始工程保全：c3384c5，未验证的原型快照，不是可上线版本。
- [x] M0：基线整理（功能验收通过，2026-10-22；本地依赖审计工具与基础设施验证边界见下）。
- [ ] M1：认证与权限（进行中；先完成身份表与策略测试，正式流程未接通）。
- [ ] M2：积分账本与签到。
- [ ] M3：素材与存储。
- [ ] M4：账号池与模型。
- [ ] M5：生成流水线。
- [ ] M6：画布工作台。
- [ ] M7：对话。
- [ ] M8：订阅与支付。
- [ ] M9：管理后台。
- [ ] M10：加固上线。

每项完成时记录代码位置、执行命令、验证结果和未覆盖边界。

## M0 · 基线整理

- [x] 测试/迁移先行：`services/api/migrations/202610220000_m0_baseline.sql`；原型迁移原文保存在 `docs/legacy/202610210001_init.sql`。新增 Rust `crates/app/tests/baseline.rs` 和 `tests/baseline.test.cjs`，生产产物测试实现前失败，完成后通过。
- [x] `services/api/crates/*` 建立第 3.3 章 11 个 crate 边界；app/config/routes、common 错误响应已实现；auth 仅拒绝所有身份。wallet 等模块只是边界，未实现账本、任务或登录功能。
- [x] 删除旧单文件 main、开发登录、内存 Session 和原型服务端扣款逻辑；不在钱包外写余额。
- [x] `apps/web` 用 Prettier 格式化，修复原型 ReactFlow 导入、引用素材 ID 类型及缺失 api 导入；入口按构建模式裁剪，`dist` 与 `dist-mock` 分开。
- [x] `.github/workflows/ci.yml` 配置 fmt、clippy、test、check、tsc、ESLint、Prettier、Mock/E2E、API 一致性与两种依赖审计；`infra/compose.yaml` 加带密码 Redis，仅回环端口。未实际运行远端 CI。
- [x] `docs/openapi.json` 从 utoipa 生成，`apps/web/src/lib/generated/api.d.ts` 从契约生成；`scripts/check_contract.py` 一致性通过。
- [x] 本地 Rust：fmt、clippy（-D warnings）、test（6 个测试，其中权限矩阵覆盖 105 组请求）、check 全通过。
- [x] 本地前端：typecheck、lint、format:check、test:mock、build、build:mock 全通过；Playwright 在 Edge 1/1 通过（生成回流、刷新保存、签到去重、角色切换）；生产产物测试 2/2 通过；npm audit 0 漏洞。
- [x] cargo audit：原先复现 rsa / RUSTSEC-2023-0071 失败；现按用户要求移除所有引入路径，本地审计 0 漏洞、0 警告。CI 保留硬门禁，当前证据见末尾记录。
- [ ] PostgreSQL/Redis 真实实例、迁移执行、Google OIDC 与正式业务回归：按用户要求待自行部署；M0 不宣称这些能力可用。

验收描述：`docs/PR_M0.md`。下一步严格按 M1，先迁移与测试。

## M1 · 认证与权限（进行中，未验收）

- [x] 先写 `migrations/202610220100_m1_identity.sql`、`auth/tests/policy.rs`、`auth/tests/session.rs`、`auth/tests/schema.rs`；测试先因缺实现失败，再补 `auth/src/policy.rs` 与 `session.rs`。
- [x] 身份基础源码：users、sessions、system_settings、invite_codes、audit_logs；默认 CLOSED；角色/禁用事务触发撤销会话。**迁移尚未在真实 PostgreSQL 执行，未认定可部署通过。**
- [x] 纯规则测试：Gmail 别名、已验证邮箱/hd 条件、注册三态/Bootstrap/IP 配额、禁用/空闲 7 天/绝对 30 天、管理员角色和 MFA 12 小时窗口、同源 CSRF、重复安全头、256 位令牌、重复/伪造 Cookie 和 Debug 脱敏。
- [ ] 五项 SQLx 真实数据库测试已编译但因无本机数据库显式跳过：身份唯一约束、角色/禁用撤销、设备 ID、repo/service 往返和审计失败回滚。CI identity-schema 配置运行；读取远端状态遭 GitHub API 出口限流，未确认结果。
- [ ] OIDC Authorization Code + PKCE、JWKS 签名/iss/aud/exp/nonce 校验、Redis state 一次性消费和限流。
- [ ] 注册事务、即时设置、邀请码消费、IP 并发限额、Bootstrap 仅首次登录。
- [x] 数据库 Session repo/service、AuthUser/RequireRole 提取器、逐请求状态/角色查询、登出和设备撤销、CSRF 中间件源码与 HTTP 合同回归；真实 PostgreSQL 回归仍待运行，尚无登录签发入口。
- [ ] TOTP 绑定/验证/重放防护与加密存储。
- [x] 前端 Session/角色路由守卫和 /settings 已接真实 API 契约；3 项浏览器合同测试通过。
- [ ] /login 的 Google 登录接入、管理员 MFA 绑定/验证页仍未接通，当前入口明确禁用。
- [ ] 第 8 章身份/注册/授权全链路矩阵，用户部署后的 PostgreSQL/Redis/OIDC 回归。

身份基础切片交付时未新增公开 API；后续接口变化见以下会话管理记录。M1 未完成，不进入 M2。

M1 当前切片验证（2026-10-22）：`cargo fmt --all`、`cargo clippy --locked --offline --workspace --all-targets -- -D warnings`、`cargo test --locked --offline --workspace`、`cargo check --locked --offline --workspace` 均通过；总计 15 个测试通过、2 个 PostgreSQL 测试显式跳过。`npm run typecheck` / `npm run build` 重新通过；生产产物 2/2 与 API 一致性再次通过。M0 UI、lint、Mock/E2E 与 npm audit 的通过结果见上一节，前端在本切片没有改动。cargo audit 与真实数据库/Redis 仍未验证。

## M1 · 会话管理、权限守卫与账号设置（2026-10-22）

- [x] 先写 `202610220200_m1_session_management.sql` 与 `app/tests/session_http.rs`、`web/tests/session-settings.spec.ts`；新增测试先失败，再实现。Host 尾斜杠混淆由测试实际发现并修复。
- [x] `auth/src/{repository,postgres,service,views}.rs`：数据库哈希查会话、最新状态/角色、空闲/绝对过期、条件 touch 拒绝并发撤销/改角色、显示名修改、设备列表、按归属撤销、全会话注销；修改/撤销与审计在同事务内，无积分写入。
- [x] `app/src/auth_http.rs`：AuthUser 与 RequireRole、非 GET Origin/Host/CSRF、重复安全头拒绝、HTTP/2 authority 校验、无 MFA 管理员只允许身份信息/安全退出和后续 MFA 入口；受保护响应 no-store。
- [x] `app/src/routes.rs` 接通 GET/PATCH /me、GET /me/sessions、DELETE /me/sessions/{id}、POST /auth/logout。未知管理接口经过权限检查再 404，不把待实现后台当作可用。
- [x] `features/auth/sessionApi.ts`、`features/settings/SettingsPage.tsx` 与 `ProductionApp.tsx`：只从 GET /me 建立前端状态，显示名、设备、二次确认撤销/退出、401 跳登录、临时故障保留错误状态、MFA 拦截；没有演示登录、localStorage 身份或密钥。
- [x] Rust fmt、严格 clippy、test、check 通过：28 项测试通过，5 项数据库测试显式跳过。前端 typecheck、build、lint、format:check、Mock 业务与 Mock 浏览器 1/1、HTTP 浏览器 3/3 通过；产物隔离 2/2、OpenAPI/生成类型一致性通过。
- [ ] 本机 PostgreSQL/Redis、Google 登录、TOTP、cargo audit、远端 CI 结果仍未验证。本项接口依赖后续 OIDC 签发有效 Session，不能作为完整登录可用的声明。
- 后续提交使用 jasonlat-dot 的已核对 noreply 邮箱；用户已授权检查/文档完成后自动推送到 origin/main，旧三个提交不重写。

下一项：M1 OIDC state/PKCE/nonce、Redis 一次性状态与限流，再接注册事务和 Google 回调。完整 M1 仍未验收。

## M1 · OIDC state / PKCE 与 Redis 基础（2026-10-22，尚未接通登录）

- [x] 测试先行：`auth/tests/oidc_attempt.rs` 先因缺实现失败；再写 `auth/src/oidc_attempt.rs` 与 `transient.rs`。无 SQL schema 变化，沿用 M1 迁移；无公开接口变化。
- [x] 授权 URL 具备独立 state/nonce、S256 PKCE，Redis TTL 10 分钟、NX 防覆盖、浏览器 Cookie 绑定、原子一次性消费、故障拒绝；内存实现仅存在测试文件。
- [x] 登录滑动窗口 20 次/10 分钟/IP；IPv4-mapped IPv6 不能换格式绕过。100 并发回调仅一次成功；缺失/伪造/过期、错误绑定、后端故障、非法配置均有自动化测试。
- [ ] `auth/tests/redis_transient.rs` 真实 Redis 的 100 并发/NX/TTL/滑动窗口测试本机显式跳过；CI identity-schema 已加 Redis 7 与专门执行命令，本次远端结果尚未确认。按用户要求不启动本机基础服务。
- [ ] 该组件尚未接 app 路由/启动，未交换 code、未验证 ID token、未创建用户/Session；Google 登录和完整 M1 验收仍未通过。下一项为 Google token 验证及注册事务。
- [ ] cargo audit 已真实运行，1 个 rsa 0.9.10 / RUSTSEC-2023-0071，退出码 1；没有可升级修复版本，详见 SECURITY_AUDIT.md。保留门禁，npm audit 改为前序失败仍执行。
- 用户截图显示此前 identity-schema 作业成功；仅记录这张截图证据，不等同本机 PostgreSQL 或当前新 Redis 测试已经执行。

本切片最终验证：`cargo fmt --all` / `cargo fmt --all --check`、`cargo clippy --locked --offline --workspace --all-targets -- -D warnings`、`cargo test --locked --offline --workspace` 通过（33 项测试通过，5 项 PostgreSQL + 1 项 Redis 测试按环境要求跳过）；`npm run typecheck`、`npm run build` 通过，`npm audit` 为 0 漏洞。cargo audit 失败（1 项 rsa 公告），如实保留，不宣称全部检查通过。

补充检查：OpenAPI/生成 TypeScript 一致性、生产产物隔离测试 2/2、`git diff --check` 均通过。

## M1 · 移除 RSA 漏洞依赖（2026-10-22）

- [x] 先在 `tests/baseline.test.cjs` 添加锁文件无 rsa 断言，修改前实际失败；再修改依赖与授权准备。OIDC 测试补充回调 URL、state 长度、nonce 长度和独立性断言。
- [x] `services/api/Cargo.toml`：SQLx 0.9.0，仅启用 PostgreSQL/Tokio/rustls-ring 与现有功能；SQLx 新版把 MySQL RSA 独立为可选，锁文件移除旧路径。
- [x] `auth/Cargo.toml` 与 `auth/src/oidc_attempt.rs`：替换 openidconnect 为 oauth2 5.0.0，保留 S256 PKCE、nonce/state 与 Redis 一次性浏览器绑定。未接通 ID token 校验或登录入口。
- [x] Cargo 正常生成的完整锁文件中 rsa、openidconnect 均不存在；本机 cargo audit 0 漏洞、0 警告、退出码 0，扫描 270 个依赖。无漏洞豁免或门禁放宽，详见 SECURITY_AUDIT.md。
- [ ] PostgreSQL/Redis 真机测试仍由 CI 执行；本机不安装/启动。当前依赖替换不新增迁移或改变公开 API，完整 M1 仍未验收。

本次验证结果：cargo fmt（含 --check）、clippy（--workspace --all-targets -- -D warnings）、test、check 全通过；33 项 Rust 测试通过，5 项 PostgreSQL + 1 项 Redis 测试按本机条件显式跳过。前端 typecheck/build/lint/format:check/test:mock 全通过，npm audit 0 漏洞。OpenAPI/生成 TypeScript 一致性通过，生产隔离/迁移基线/依赖锁定回归 3/3 通过。cargo audit 0 漏洞、0 警告。

## M1 · 登录与 MFA 功能收尾（进行最终验证）

- [x] 先新增迁移 `202610220300_m1_login_mfa.sql` 与 ID token/MFA/注册测试，确认缺实现失败后补代码；新增 HTTP/前端测试也先失败后接线。
- [x] `auth/src/oidc_provider.rs`：固定 Google token/JWKS 出站、无重定向、限时/限大小、ring RS256 与声明校验，受信 VerifiedIdentity；`login.rs` 组合 Redis state 与后端交换、注册事务。
- [x] `auth/src/identity.rs`：最新注册设置、canonical 唯一、IP 并发锁、邀请码原子消费、Bootstrap 仅首次、Session 轮换及同事务审计；不写余额。
- [x] `auth/src/mfa.rs`：ChaCha20Poly1305 加密、用户/会话绑定待确认、TOTP 与时间步原子防重放、MFA 成功审计及验证时效；5 次/5 分钟防爆破。
- [x] `app/src/login_http.rs`、配置/启动/路由/限流：Google start/callback、public/config、管理员 MFA 入口、管理员写限流，严格凭据启动自检和可信代理 IP。
- [x] 前端 LoginPage/MfaPage 与会话路由：真实后端导航、注册三态、邀请码、服务条款占位链接、验证器绑定/验证与退出；浏览器合同 5/5 通过。
- [x] 新增依赖 cargo audit 0 漏洞，完整锁文件 282 个依赖，无 rsa；严格 clippy 通过。
- [ ] PostgreSQL/Redis 注册/MFA并发与审计回滚回归及完整浏览器链路：已配置 CI，尚待本次推送结果，不能提前标记完整 M1 通过。
- 用户要求完成 M1 即停止，不进入 M2。本机不安装/启动 PostgreSQL 或 Redis；真实 Google 凭据由部署时配置。

本地最终源码回归：Rust 44 项通过、12 项按环境跳过（11 项真实基础设施断言 + 1 个浏览器服务夹具）；fmt、严格 clippy 通过。前端 typecheck/lint/format/test:mock/build、npm audit（0）通过；HTTP 浏览器 5/5。CI 真库/Redis/浏览器待当前源码推送后确认。

首次收尾 CI：d8872b9 / run 39758306218 的 baseline 通过，11 项 PostgreSQL/Redis 回归全部通过；完整浏览器因 Playwright 重定向链拦截方式失败，已修正测试夹具，等待重跑。未提前标记 M1 完整验收通过。
