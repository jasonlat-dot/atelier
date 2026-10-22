# M1 认证与权限（进行中）：会话守卫、OIDC 状态与漏洞依赖替换

将数据库 Session、CSRF、角色/MFA 时效守卫接入 Axum，并提供真实 HTTP 账号设置页；OIDC 临时状态具备 S256 PKCE、nonce、浏览器绑定、原子一次性消费和登录滑动窗口。前端身份来自 GET /me，Google 登录入口仍禁用，等待完整 token 验证/注册/回调。

本次针对 RUSTSEC-2023-0071 消除两条依赖路径：SQLx 0.8.6 升至 0.9.0（MySQL RSA 功能独立可选，项目仍只使用 PostgreSQL）；授权材料准备从 openidconnect 切换到 oauth2 5.0.0。当前锁文件中 rsa/openidconnect 均不存在，完整 cargo audit 通过。新增锁文件回归测试阻止漏洞依赖回归；未使用公告豁免。

## 逐条验收

| 完整 M1 验收 | 结果 | 证据 / 缺口 |
| --- | --- | --- |
| 第 8 章身份自动化 | 未通过完整验收 | Cookie/伪造/过期/撤销、Gmail、PKCE/nonce/state 材料、100 并发 state 单次消费测试通过；JWKS/ID token/完整 Google 回调待实现 |
| 第 8 章注册自动化 | 未通过完整验收 | 注册三态/Bootstrap/IP 配额纯策略、身份 schema 已有；真实注册事务、即时设置、邀请码消费待实现 |
| 第 8 章授权自动化 | 未通过完整验收 | HTTP 角色/MFA 时效、用户状态重查、CSRF/Origin/Host、设备归属/并发撤销测试通过；真实 TOTP 与完整资源矩阵待补 |
| /settings 与路由守卫 | 通过合同验收 | 已有 HTTP 浏览器 3/3 证据；资料、设备撤销、退出均走服务端；真实实例登录仍待接通 |
| /login Google 登录 | 未通过 | 按钮禁用，不提供演示登录冒充正式功能 |
| 移除 RUSTSEC-2023-0071 依赖 | 通过 | 正常 Cargo 解析的完整锁文件无 rsa；cargo audit 0 漏洞/0 警告/退出码 0；锁文件防回归先失败后通过 |

## 验证

- cargo fmt（含 --check）、clippy（deny warnings）、test、check：通过；33 项 Rust 测试通过。
- PostgreSQL 5 项、Redis 1 项真实实例测试：本机无基础服务，显式跳过；已编译并配置 CI 隔离服务执行，不能认定本次远端结果通过。
- npm typecheck/build/lint/format:check/test:mock：通过；npm audit 0 漏洞。
- OpenAPI/生成 TypeScript 一致性：通过；生产隔离/迁移基线/漏洞依赖回归 3/3：通过。
- cargo audit：通过；官方 RustSec 本日公告库 1348 条，完整锁文件扫描 270 个依赖，0 漏洞、0 警告；详情见 SECURITY_AUDIT.md。

迁移先行的 M1 文件为 `202610220100_m1_identity.sql` 与 `202610220200_m1_session_management.sql`；本次依赖替换无 schema/公开 API 变化，沿用已有迁移和契约。SQLx 0.9 最低 Rust 1.94，本机 1.99、CI stable 满足。规格中 openidconnect 的替换依据与假设写入 DECISIONS.md。无积分写入、前端密钥、打包或部署。
