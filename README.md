# Atelier

按根目录《Atelier AI 创作平台 · 产品与工程开发规格书（AI 开发版）》逐里程碑开发。
当前状态以 [docs/PROGRESS.md](docs/PROGRESS.md) 为准；假设见 [docs/DECISIONS.md](docs/DECISIONS.md)。
原始原型保存在提交 `c3384c5`，当前正在执行 M0 基线整理。

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

```powershell
cd apps/web
npm run build
cd ../../services/api
cargo check --workspace
cargo test --workspace
# 在配置 DATABASE_URL 并自行部署 PostgreSQL 后：
cargo run -p atelier-app
```

默认 `npm run build` 输出 `dist`，只包含 HTTP 入口；M0 登录页只显示服务状态，正式登录属于 M1。
`npm run build:mock` 单独输出 `dist-mock`，只能用于本地预览。生产构建显式设置 `VITE_API_MODE=mock` 会失败。
Rust 自动执行 `services/api/migrations`，并可托管 `WEB_DIR` 的 SPA。
配置样例见 `services/api/.env.example`。没有开发登录或内存 Session。
用户、积分、生成等业务 API 暂时拒绝所有请求，按后续里程碑替换。

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
cd ../..
node --test tests/baseline.test.cjs
python scripts/check_contract.py
```

CI 同时运行 `cargo audit` 与 `npm audit`，完整审计结果如实保留。
API 契约见 [docs/API.md](docs/API.md)，每个里程碑的验收与环境限制写入对应 PR 描述文档。
