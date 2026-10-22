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
- [ ] cargo audit：工具安装受网络/缓存限制，本机未运行；CI 仍配置为硬门禁。
- [ ] PostgreSQL/Redis 真实实例、迁移执行、Google OIDC 与正式业务回归：按用户要求待自行部署；M0 不宣称这些能力可用。

验收描述：`docs/PR_M0.md`。下一步严格按 M1，先迁移与测试。

## M1 · 认证与权限（进行中，未验收）

- [x] 先写 `migrations/202610220100_m1_identity.sql`、`auth/tests/policy.rs`、`auth/tests/session.rs`、`auth/tests/schema.rs`；测试先因缺实现失败，再补 `auth/src/policy.rs` 与 `session.rs`。
- [x] 身份基础源码：users、sessions、system_settings、invite_codes、audit_logs；默认 CLOSED；角色/禁用事务触发撤销会话。**迁移尚未在真实 PostgreSQL 执行，未认定可部署通过。**
- [x] 纯规则测试：Gmail 别名、已验证邮箱/hd 条件、注册三态/Bootstrap/IP 配额、禁用/空闲 7 天/绝对 30 天、管理员角色和 MFA 12 小时窗口、同源 CSRF、重复安全头、256 位令牌、重复/伪造 Cookie 和 Debug 脱敏。
- [ ] 两项 SQLx 真实数据库测试：身份唯一约束/默认注册关闭、角色变更与禁用撤销会话；已编译，因无数据库显式跳过。CI identity-schema 作业配置执行，远端未运行。
- [ ] OIDC Authorization Code + PKCE、JWKS 签名/iss/aud/exp/nonce 校验、Redis state 一次性消费和限流。
- [ ] 注册事务、即时设置、邀请码消费、IP 并发限额、Bootstrap 仅首次登录。
- [ ] 数据库 Session repo/service、AuthUser/RequireRole 提取器、逐请求状态/角色查询、登出和撤销、CSRF 中间件。
- [ ] TOTP 绑定/验证/重放防护与加密存储。
- [ ] 前端 /login、路由守卫、/settings（在真实契约接通时同步实现，不提供假登录）。
- [ ] 第 8 章身份/注册/授权全链路矩阵，用户部署后的 PostgreSQL/Redis/OIDC 回归。

当前公开 API 和 OpenAPI 无新增；纯策略与迁移不是用户已可使用功能。M1 未完成，不进入 M2。

M1 当前切片验证（2026-10-22）：`cargo fmt --all`、`cargo clippy --locked --offline --workspace --all-targets -- -D warnings`、`cargo test --locked --offline --workspace`、`cargo check --locked --offline --workspace` 均通过；总计 15 个测试通过、2 个 PostgreSQL 测试显式跳过。`npm run typecheck` / `npm run build` 重新通过；生产产物 2/2 与 API 一致性再次通过。M0 UI、lint、Mock/E2E 与 npm audit 的通过结果见上一节，前端在本切片没有改动。cargo audit 与真实数据库/Redis 仍未验证。
