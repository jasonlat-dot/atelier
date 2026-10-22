# Atelier

按根目录《Atelier AI 创作平台 · 产品与工程开发规格书（AI 开发版）》逐里程碑开发。
当前状态以 [docs/PROGRESS.md](docs/PROGRESS.md) 为准；假设见 [docs/DECISIONS.md](docs/DECISIONS.md)。
原始原型保存在提交 `c3384c5`。M0 基线与 M1 认证权限已完成自动化验收；Google 登录、注册控制、会话/权限守卫、账号设置与管理员 TOTP 的 [CI 全部通过](https://github.com/jasonlat-dot/atelier/actions/runs/39759708282)。按要求停在 M1，不进入 M2；实际部署与 Google 实账号回归见 [docs/M1_VALIDATION.md](docs/M1_VALIDATION.md)。

## 本地 Mock UI

需要 Node 22.13+、npm 10+。不需要 PostgreSQL / Redis。

```powershell
cd apps/web
npm ci
Copy-Item .env.example .env
npm run dev
```

访问 http://127.0.0.1:5173 。Mock 保留画布、图片/视频演示、任务回流、积分签到、演示角色切换与本地保存。
这些均为开发演示，不是服务端权限或财务能力。

## Rust 与生产前端基线

需要 Rust stable >=1.94（SQLx 0.9 的最低要求）；本机验证版本为 1.99。

```powershell
cd apps/web
npm run build
cd ../../services/api
cargo check --workspace
cargo test --workspace
# 在配置 DATABASE_URL 并自行部署 PostgreSQL 后：
cargo run -p atelier-app
```

默认 `npm run build` 输出 `dist`，只包含 HTTP 入口；登录入口导航到服务端 Google OIDC；有效会话进入账号设置，管理员先完成 TOTP 绑定/验证。
`npm run build:mock` 单独输出 `dist-mock`，只能用于本地预览。生产构建显式设置 `VITE_API_MODE=mock` 会失败。
Rust 自动执行 `services/api/migrations`，并可托管 `WEB_DIR` 的 SPA。
配置样例见 `services/api/.env.example`。启动进程必须注入 DATABASE_URL、REDIS_URL、PUBLIC_BASE_URL、GOOGLE_CLIENT_ID、GOOGLE_CLIENT_SECRET、MASTER_KEY、BOOTSTRAP_ADMIN_EMAILS。认证凭据和主密钥没有默认值，缺失会拒绝启动；不要把任何服务端凭据写入 VITE_* 或前端文件。Google OAuth Web 客户端的回调为 PUBLIC_BASE_URL + /api/v1/auth/google/callback。MASTER_KEY 为持久保存的随机 32 字节 base64。没有开发登录或内存 Session。
账号资料、设备列表/撤销、全设备注销已接服务端会话；积分/生成等业务按后续里程碑接入。

开发基础设施：`infra/compose.yaml` 提供 PostgreSQL 16 与带密码 Redis 7，仅绑定 127.0.0.1；本轮不安装或启动这些服务。
旧原型迁移已归档到 `docs/legacy`；已有旧版数据库不要直接执行新迁移，需要专门迁移方案。

## 检查

```powershell
cd services/api
cargo fmt --all --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
cargo check --workspace
cd ../../apps/web
npm run typecheck
npm run lint
npm run format:check
npm run test:mock
npm run build
npx playwright install chromium
npm run test:e2e
npm run test:e2e:http
cd ../..
node --test tests/baseline.test.cjs
python scripts/check_contract.py
```

CI 同时运行 `cargo audit` 与 `npm audit`，完整审计结果如实保留。
API 契约见 [docs/API.md](docs/API.md)，每个里程碑的验收与环境限制写入对应 PR 描述文档。

M1 部署回归注意：首次注册默认 CLOSED，BOOTSTRAP_ADMIN_EMAILS 指定的 Gmail 首次登录可成为 SUPER_ADMIN；已有账号不因修改环境变量重新提权。注册模式/白名单/单 IP 配额来自 system_settings，M9 再提供管理页面。反向代理需要覆盖 X-Real-IP，并把实际代理 IP 加到 TRUSTED_PROXY_IPS；未配置时只使用 TCP 对端 IP，忽略转发头。

真实基础设施测试在隔离测试数据库中执行（数据库账号需创建测试数据库权限）：

```powershell
cd services/api
cargo test --locked -p atelier-auth --tests -- --ignored
```

需先设置 DATABASE_URL 与 TEST_REDIS_URL 指向专用测试实例；不要对生产数据库执行。CI 另运行 `npm run test:e2e:auth`，用 tests/browser_harness.rs 的合成 Google 签名提供方、真实 PostgreSQL/Redis 和浏览器验证登录/设置/退出/MFA。该夹具不被生产 main 引用，无测试登录开关。真实 Google 凭据与实际部署回归由项目负责人后续完成。
