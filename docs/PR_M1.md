# M1：Google 登录、注册控制、会话权限与管理员 TOTP

接通服务端 Google Authorization Code + PKCE，使用 ring 验证 Google JWKS/RS256 和身份声明；注册模式、别名去重、邀请码、IP 配额与 Bootstrap 首次授予角色在 PostgreSQL 事务内执行。登录轮换 Session，用户状态/角色逐请求查询，所有已认证非 GET 请求做同源 CSRF；管理员使用加密存储与防重放 TOTP。

前端 /login 导航至服务端登录入口并展示注册三态，/settings 提供资料、设备撤销和全设备退出；管理员先绑定/验证 MFA。不返回 Google token、客户端密钥或主密钥，不修改积分；后续业务继续留在对应里程碑。

| M1 验收 | 当前结果 | 证据 / 待确认 |
| --- | --- | --- |
| 身份自动化 | 本地通过；完整 CI 待确认 | 伪造 Cookie/JWT、错误签名/alg/kid、iss/aud/exp/nonce、Gmail/hd、state 重放、PKCE/浏览器绑定；Google 真配置由部署回归 |
| 注册自动化 | 代码与测试齐备；CI 真库待确认 | CLOSED 老用户/新用户、即时切换、别名唯一、邀请码消费、IP 并发、Bootstrap 仅首次、审计失败回滚 |
| 授权自动化 | 本地通过；CI 真库待确认 | 角色/MFA 时效、禁用/并发撤销、跨用户设备 404、Origin/Host/CSRF、管理员写限流、TOTP 重放/加密/待确认过期 |
| /login、路由守卫、/settings | 浏览器合同通过 | HTTP 合同 5/5；真实 DB/Redis/假 OIDC 浏览器 2 项已加入 CI，结果待确认 |
| 依赖安全 | 通过 | cargo audit 与 npm audit 均 0 漏洞；锁文件不含 rsa；无公告豁免 |

迁移先行：`202610220100_m1_identity.sql`、`202610220200_m1_session_management.sql`、本次 `202610220300_m1_login_mfa.sql`；测试先因缺实现失败，再补实现。OpenAPI 与前端生成类型已同步。

本地 cargo fmt、严格 clippy、test（44 项通过；真实 PostgreSQL/Redis 11 项与浏览器夹具 1 项跳过）、check；npm typecheck/build/lint/format:check/test:mock 与 HTTP 浏览器 5/5。Windows 测试因默认调试产物 LNK1104 使用进程局部 CARGO_PROFILE_TEST_DEBUG=0；CI 保留标准配置。完整验收不提前标记，待当前提交 CI 真库/Redis/浏览器结果更新。

配置和假设见 DECISIONS.md；接口见 API.md。服务条款是开发占位，正式法律文案属 M10。依用户最新要求，M1 完成后停止，不进入 M2；不安装本机 PostgreSQL/Redis，不打包或部署。
