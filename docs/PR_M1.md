# M1 认证与权限 · 身份基础切片（未完成）

M0 提交后继续认证里程碑，先落身份表迁移与策略测试，再实现纯规则和会话令牌工具。公开接口仍拒绝所有身份，尚无可用登录流程。

## 按完整 M1 验收逐条对照

| M1 验收 | 结果 | 本切片证据与缺口 |
| --- | --- | --- |
| 第 8 章身份各项自动化测试 | 未通过完整验收 | 纯策略覆盖 Gmail / 别名 / hd、会话期限、伪造与重复 Cookie；OIDC 签名、state/nonce/PKCE 重放的完整流程未实现 |
| 第 8 章注册各项自动化测试 | 未通过完整验收 | 注册模式、Bootstrap 和配额纯规则测试已通过；DB 唯一约束测试待实例，真实注册事务与 Redis 防刷未接通 |
| 第 8 章授权各项自动化测试 | 未通过完整验收 | 角色层级、禁用、MFA 时间窗口与 CSRF 纯规则已测试；Session 提取器、跨用户资源与真实 MFA 接口仍未实现 |
| 前端 /login、守卫、/settings | 未通过 | 保持 M0 页面，等待正式 API 接通后同步实现 |

迁移：`services/api/migrations/202610220100_m1_identity.sql`。
测试/实现：`services/api/crates/auth/{tests,src}`。
完整下一步与验证结果见 `docs/PROGRESS.md`；假设见 `docs/DECISIONS.md`。

不执行 auth 积分写入，不绕过 wallet。不增加密钥到前端。未推送、部署或创建远端 PR。

## 当前切片检查结果

- cargo fmt、严格 clippy、cargo test、cargo check：通过；15 项测试通过、2 项 PostgreSQL 测试因本机无实例跳过。
- npm run typecheck、npm run build：通过。
- 生产产物 2/2、Rust OpenAPI 与前端生成类型一致性：通过；无新公开认证 API。
- 本地 cargo audit / PostgreSQL / Redis / 正式 OIDC 集成：未验证。不能据此把完整 M1 标为通过。
