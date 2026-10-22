# M1：Google 登录、注册控制、会话权限与管理员 TOTP

用户经 Google Authorization Code + PKCE 登录，后端通过 ring 验证 JWKS/RS256 与身份声明，再在 PostgreSQL 事务内处理注册模式、Gmail 别名唯一、邀请码、IP 配额和 Bootstrap 首次角色。登录轮换 Session，权限与禁用状态逐请求读取；非 GET 请求校验同源 CSRF，管理员绑定并验证加密存储、防重放的 TOTP。

前端 /login、身份路由守卫、/settings 与 MFA 页面已接真实 API。资料修改、设备撤销和全设备退出均持久化；Google token、客户端密钥与主密钥不返回前端。M1 不写积分，不进入 M2。

## 对照规格 M1 验收

以下对应第 8 章「身份、注册、授权」及 M1 后端/前端要求，验收源码为 `16837884926d2316b5c5ac7c427398f42efa5647`。

| 验收项 | 结果 | 自动化证据 |
| --- | --- | --- |
| 无 Cookie、伪造或过期 Cookie 返回 401 | 通过 | `auth/tests/session.rs`、`app/tests/session_http.rs`；真实浏览器退出后原 Cookie 401 |
| 修改请求体/前端身份不能提权，id_token 仅后端验证 | 通过 | 服务端 Session/RBAC HTTP 矩阵、生产产物隔离；`oidc_token.rs` 拒绝错误签名、alg/kid 与声明，handler 不接收前端 id_token |
| state、nonce、PKCE 缺失、伪造或重放拒绝 | 通过 | `oidc_attempt.rs`、`oidc_token.rs`、`redis_transient.rs`；绑定 Cookie、nonce、PKCE 与 100 并发单次消费 |
| 非 gmail.com 或携带 hd 的身份拒绝 | 通过 | `policy.rs`、`oidc_token.rs`；包括 hd 为 null 的情况 |
| Gmail 点号/+ 后缀无法重复注册 | 通过 | `policy.rs` 规范化，`login_database.rs` / `schema.rs` 验证 canonical 唯一与并发冲突 |
| CLOSED 拒新用户、允许老用户，注册设置即时生效 | 通过 | `login_database.rs` 实库切换 CLOSED/OPEN/INVITE_ONLY、白名单/邀请码及 Bootstrap 仅首次 |
| 同 IP 注册频率受限 | 通过 | `login_database.rs` 并发注册配额；Redis 登录滑动窗口及 IP 规范化回归 |
| 普通用户访问 /admin 返回 403 | 通过 | `app/tests/session_http.rs` 路径/角色矩阵，含未实现管理路径的权限前置检查 |
| 跨用户资源返回 404 | 通过（M1 会话资源） | 设备撤销归属与真实 Session repo 测试；项目/素材/任务尚无业务实现，资源隔离在对应后续里程碑验收 |
| 禁用用户拒绝且会话立即失效 | 通过 | `schema.rs` 禁用/改角色触发撤销、`login_database.rs` 禁用拒绝、HTTP 并发撤销与条件 touch |
| 管理员写操作要求 TOTP | 通过 | HTTP 权限与 12 小时时效矩阵；`mfa_crypto.rs` / `mfa_database.rs` 加密、绑定过期、跨会话与 100 并发防重放、审计回滚 |
| 迁移、Session/CSRF、AuthUser/RequireRole、Redis 限流 | 通过 | PostgreSQL 真实迁移与 11 项基础设施测试；HTTP Origin/Host/CSRF、重复安全头、管理员写限流/后端故障回归 |
| /login、路由守卫、/settings、管理员 MFA 页面 | 通过 | HTTP 合同浏览器 5/5，真实认证浏览器 2/2，含登录/资料持久化/退出失效/MFA 绑定与重放 |
| 依赖安全与契约一致 | 通过 | cargo audit / npm audit 均 0 漏洞，无豁免；锁文件无 rsa；OpenAPI/生成类型一致 |

## 验证结果

[CI #6 全部通过](https://github.com/jasonlat-dot/atelier/actions/runs/39759708282)，`baseline` 与 `identity-schema` 均 success。fmt、严格 clippy、cargo test/check、前端 typecheck/build/lint/format/mock、依赖审计均通过。

- Rust 普通测试 44 项通过；11 项 PostgreSQL/Redis 测试在隔离实例中另行执行并全部通过。浏览器服务夹具单独由 Playwright 启动，不作为跳过的功能测试计数。
- Playwright 共 8 项通过：Mock 1 项、HTTP 合同 5 项、真实 PG/Redis 与合成 Google 提供方 2 项。
- 根目录基线测试 3/3、API 一致性通过；cargo audit 与 npm audit 均 0 漏洞，本地 Rust 审计 0 警告。
- Windows 本地测试使用进程局部 `CARGO_PROFILE_TEST_DEBUG=0` 避开 LNK1104；CI 标准配置已通过，不修改断言或源码 profile。

迁移与测试先行：`202610220100_m1_identity.sql`、`202610220200_m1_session_management.sql`、`202610220300_m1_login_mfa.sql`；相关测试先因缺实现失败，再完成实现。旧迁移未改写。

## 部署边界

实际域名与 Google 实账号仍需负责人部署后回归，见 `M1_VALIDATION.md`；本机未安装或启动 PostgreSQL/Redis，未打包或部署。配置、假设与依赖选型见 `DECISIONS.md`，接口见 `API.md`。管理员绑定时只临时展示当前用户的一次性验证器配置，不向前端提供服务端密钥。

服务条款为开发占位，正式法律文案与完整公网上线验收属于 M10。按用户要求完成 M1 后停止，不进入 M2；注册赠送积分留待 M2 通过 wallet 接入。
