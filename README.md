# Atelier

按根目录《Atelier AI 创作平台 · 产品与工程开发规格书（AI 开发版）》逐里程碑开发。
当前状态以 [docs/PROGRESS.md](docs/PROGRESS.md) 为准；假设见 [docs/DECISIONS.md](docs/DECISIONS.md)。
原始原型保存在提交 `c3384c5`。M0/M1/M2 已完成验收；M2 积分账本与签到的本地真实 PG/Redis、浏览器测试和 [远端 Actions](https://github.com/jasonlat-dot/atelier/actions/runs/39772855488) 全部通过，详见 [M2 验收记录](docs/PR_M2.md)。当前停在 M2，不进入 M3；实际部署与 Google 实账号回归见 [M1 部署清单](docs/M1_VALIDATION.md)。

## 已部署 WSL 数据库

已接入 PostgreSQL 16（127.0.0.1:15432）、Redis 7（127.0.0.1:16380）。独立业务库 atelier 已应用 M0–M2 迁移；测试库 atelier_test 及 CREATEDB 测试角色独立。连接配置在 Git 忽略的 services/api/.env 与 .env.test.local，禁止提交凭据。

真实开发模式可在仓库根目录用一个终端启动前后端：

```powershell
cd E:\project\AIShellTerminal\atelier
npm run dev
```

打开 http://127.0.0.1:5173 。脚本自动加载后端 `.env`，前端强制 HTTP 模式；Ctrl+C 同时停止两端。首次需先运行 `npm --prefix apps/web ci` 安装前端依赖，并配置后端凭据。若之前已分别启动服务，先在原终端 Ctrl+C 退出。需要单独启动时，根目录提供 `npm run dev:api` / `npm run dev:web`。该入口不需要在根目录安装额外依赖。

```powershell
./scripts/api.ps1 -Action infrastructure
./scripts/api.ps1 -Action test-infrastructure
$env:PLAYWRIGHT_CHANNEL = 'chrome' # 已装 Chrome；CI 使用 Playwright Chromium
./scripts/api.ps1 -Action test-browser
# 补齐服务端 Google/MASTER_KEY/Bootstrap 后启动：
./scripts/api.ps1 -Action run
```

登录后 `/` 为签到工作台，`/assets` 使用原型布局管理真实图片上传/筛选/预览/删除，`/wallet` 查看真实余额/兑换/流水，`/settings` 管理账号，`/admin/credits` 提供有审计的 MFA 管理员调账。

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

默认 `npm run build` 输出 `dist`，只包含 HTTP 入口；登录入口导航到服务端 Google OIDC；有效会话进入沿用原型布局的工作台，管理员先完成 TOTP 绑定/验证；从侧栏访问积分、账号设置和已实现的管理功能。
`npm run build:mock` 单独输出 `dist-mock`，只能用于本地预览。生产构建显式设置 `VITE_API_MODE=mock` 会失败。
Rust 自动执行 `services/api/migrations`，并可托管 `WEB_DIR` 的 SPA。
配置样例见 `services/api/.env.example`。启动进程必须注入 DATABASE_URL、REDIS_URL、PUBLIC_BASE_URL、GOOGLE_CLIENT_ID、GOOGLE_CLIENT_SECRET、MASTER_KEY、BOOTSTRAP_ADMIN_EMAILS。认证凭据和主密钥没有默认值，缺失会拒绝启动；不要把任何服务端凭据写入 VITE_* 或前端文件。Google OAuth Web 客户端的回调为 PUBLIC_BASE_URL + /api/v1/auth/google/callback。MASTER_KEY 为持久保存的随机 32 字节 base64。没有开发登录或内存 Session。
账号资料、设备列表/撤销、全设备注销已接服务端会话；M2 已接积分、签到、兑换和管理员调账，生成等业务随后续里程碑接入。

开发基础设施：`infra/compose.yaml` 提供 PostgreSQL 16 与带密码 Redis 7，仅绑定 127.0.0.1；当前复用已部署 WSL 服务，无需另启动 compose。
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

素材文件默认写入 API 工作目录的 `data/media`（Git 忽略且不在网页静态目录），沿用现有 MASTER_KEY 生成私有签名链接。图片支持 PNG/JPEG/WebP、20 MiB、默认保留 30 天；视频处理为 M3 后续切片，当前明确禁用。S3 配置见 services/api/.env.example，真实服务尚未验收。
