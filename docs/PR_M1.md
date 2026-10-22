# M1 认证与权限 · 会话管理和账号设置（里程碑未完成）

在已落地身份表/纯策略基础上，将 PostgreSQL Session、CSRF、角色/MFA 时效守卫接入 Axum，配合真实 HTTP 账号设置页。前端身份只来自 GET /me，修改显示名、设备撤销与全设备注销均走服务端；跨用户设备返回 404，未知管理业务通过权限检查后仍返回 404。

| 完整 M1 验收 | 结果 | 证据 / 缺口 |
| --- | --- | --- |
| 第 8 章身份自动化 | 未通过完整验收 | Cookie/过期/撤销、别名、会话期限测试通过；OIDC/JWKS/state/nonce/PKCE 完整流程仍未实现 |
| 第 8 章注册自动化 | 未通过完整验收 | 注册纯策略与 schema 已有；真实注册事务/限流未接通，数据库回归未运行 |
| 第 8 章授权自动化 | 部分通过 | HTTP 覆盖用户/管理员/超管、MFA 过期、禁用重查、伪造字段、Host/Origin/CSRF、设备归属、查询后撤销；真实 TOTP 与未来资源矩阵待补 |
| /settings 与 Session 路由守卫 | 通过合同测试，真实实例待验证 | 浏览器 HTTP 3/3：保存、CSRF、确认/取消撤销、注销、401/503 区分、权限/MFA 页面拦截 |
| /login Google 登录 | 未通过 | 入口明确禁用，等待正式 OIDC 接通 |

先写迁移 `202610220200_m1_session_management.sql` 和测试，再实现。Rust fmt/clippy（-D warnings）/test/check 通过；28 项通过、5 项 PostgreSQL 测试显式跳过。前端 typecheck/build/lint/format、Mock 业务、Mock 浏览器 1/1 与 HTTP 浏览器 3/3 通过，产物隔离 2/2、OpenAPI 一致性通过。

数据库 repo 另备真实往返及审计失败回滚测试；本机无 PostgreSQL/Redis，未运行。cargo audit 尚未运行，远端 CI 结果读取受出口限流。未宣称全 CI 绿或完整登录可用。

变更位置：`auth/src/{postgres,repository,service,views}.rs`、`app/src/{auth_http,routes}.rs`、`app/tests/session_http.rs`、`web/src/features/{auth,settings}`。假设见 DECISIONS.md，后续见 PROGRESS.md。不修改积分，不放前端密钥，不打包、不部署。


本次增量：OIDC state/nonce/S256 PKCE 与 Redis 临时存储、登录滑动窗口；5 项组件测试，另有真实 Redis 并发测试由 CI 执行。仍未接通 Google 登录回调，因此上表完整验收仍不通过。沿用既有 M1 迁移，公开 API 未改变；无空迁移或虚构 API 更新。

新增验收对照：

| 检查 | 结果 | 证据 / 缺口 |
| --- | --- | --- |
| state 一次性 / 重放拒绝 | 通过组件测试；真实 Redis 待验证 | 100 并发单次成功，错误浏览器不销毁合法 state；Lua/NX/TTL 集成测试已加 CI |
| PKCE / nonce 材料 | 通过材料测试；完整校验未通过 | S256、nonce、独立浏览器绑定；换 token 与 ID token 验证仍待实现 |
| 登录起点限流 | 通过 service 替身测试；中间件未接入 | 20 次/10 分钟，IPv4 映射归一；真实滑动窗口测试待 CI |
| 依赖审计 | 未通过 | 已本机复现 rsa / RUSTSEC-2023-0071，暂无修复版本；未豁免，见 SECURITY_AUDIT.md |

本切片最终验证：`cargo fmt --all` / `cargo fmt --all --check`、`cargo clippy --locked --offline --workspace --all-targets -- -D warnings`、`cargo test --locked --offline --workspace` 通过（33 项测试通过，5 项 PostgreSQL + 1 项 Redis 测试按环境要求跳过）；`npm run typecheck`、`npm run build` 通过，`npm audit` 为 0 漏洞。cargo audit 失败（1 项 rsa 公告），如实保留，不宣称全部检查通过。

补充检查：OpenAPI/生成 TypeScript 一致性、生产产物隔离测试 2/2、`git diff --check` 均通过。
