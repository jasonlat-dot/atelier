# Atelier — React + Rust 正式工程起点（第 1 次迭代）

> 基于你已确认的 **Codex 风格 Atelier UI**，推进为可维护的工程，而不是继续叠加单文件原型。
> **单前端应用**：用户端、管理员端共用 `apps/web`，只按登录角色和后端权限开放不同功能。

## 本次交付到哪里

| 子系统 | 目前状态 | 说明 |
|---|---|---|
| Vite + React + TypeScript | ✅ 已写入工程 | 由多个组件与模块构成，不是嵌套旧版 HTML |
| Codex 风格浅色布局 | ✅ 已实现代码 | 中性颜色、无霓虹 / 大面积紫色，保留原型布局 |
| React Flow 无限画布 | ✅ 已实现代码 | 拖动、缩放、平移、连线、MiniMap、节点尺寸、文本编辑、图 / 视频节点 |
| 生成参数 | ✅ 已实现代码 | 图片 / 视频、质量、比例、时长、张数、参考素材选择 |
| 本地 Mock 任务 + 结果 | ✅ **通过业务逻辑测试** | 排队、路由、生成、完成素材回流、取消退还积分 |
| 多个用户隔离的画布 | ✅ **通过业务逻辑测试** | 基于本地演示账号模拟；生产隔离仅由后端保障 |
| 本地项目自动保存 / 乐观版本 | ✅ **通过业务逻辑测试** | revision 冲突保护，localStorage；另可导出 JSON |
| 同项目按角色展示管理菜单 | ✅ 已实现代码 | USER / ADMIN / SUPER_ADMIN |
| Rust Axum API + PostgreSQL | 🟡 **源码骨架** | 项目读写、钱包、Mock 任务、服务端事务和 session；未在本环境编译验证 |
| HTTP 模式前端 / Rust 同步 | 🟡 **基础连通代码** | 使用 cookie、接口轮询同步项目与任务；需要本机集成测试 |
| Google OAuth、真实支付、真实供应商 | ⬜ **没有实现** | 禁止把开发登录 / Mock 余额作为上线能力 |
| 媒体 S3 上传 / 多端同步 | ⬜ 待实现 | 当前上传用浏览器 Blob URL，刷新后无法保证保留 |

**验证说明：** `tests/verify_source.cjs` 已在本环境运行，通过 TypeScript/TSX 转译语法测试（11 个文件），以及幂等、扣费/退费、版本冲突、跨用户作用域和管理员模拟校验。由于当前环境没有 Cargo，npm 也无法联网拉取依赖，**没有宣称完成 Rust 构建、React 实际浏览器渲染或全链路联调**。

## 项目结构

```text
Atelier_React_Rust_Starter/
├── apps/web/                # 唯一的前端项目：用户 / 管理员共用
│   ├── src/App.tsx          # 主布局、导航、RBAC 路由
│   ├── src/features/canvas/ # 无限画布和图片/视频/文本/任务节点
│   ├── src/features/chat/   # 对话页（Mock 意图识别）
│   ├── src/features/admin/  # 管理页面
│   ├── src/lib/api.ts       # mock/http 两种数据源适配
│   ├── src/lib/mockDb.ts    # Mock 状态、隔离、幂等和积分演示
│   ├── src/lib/types.ts     # 共享前端类型
│   └── public/assets/      # 示例图片 + 演示 MP4
├── services/api/            # Rust Axum + SQLx 服务（仅开发基础）
│   ├── src/main.rs
│   └── migrations/
├── infra/compose.yaml       # 本地 PostgreSQL，不对外公开服务数据库
├── tests/verify_source.cjs  # 源码语法与 Mock 核心业务验证
├── docs/                    # 功能、接线说明、风险和验收
├── previews/                # 上一版视觉基准截图（非这版 React 截图）
└── Atelier_上一版离线预览.html # 你已确认的旧版交互原型（可双击）
```

## 方式 A：先单独启动新 React UI（推荐）

要求 Node.js 20.19+ 或 22.12+，可访问 npm registry。

```bash
cd apps/web
cp .env.example .env
# 保持 VITE_API_MODE=mock
npm install
npm run dev
```

访问 **http://127.0.0.1:5173**。

Mock 模式无需 Rust 或 PostgreSQL。按左侧菜单操作画布、AI 对话、积分、素材与管理页；点左下角演示用户可以切换权限。新前端遵循同一套 Codex 风格，但它是重新编写的组件化代码，不是对旧原型逐行复制。

Windows PowerShell：

```powershell
cd apps\web
Copy-Item .env.example .env
npm install
npm run dev
```

## 方式 B：联通 Rust API 基础版

**仅供本机开发，不能公网部署。** 需要 Rust stable/Cargo、Docker Engine / Docker Desktop 和 npm。

```bash
# 项目根目录
# 1) 本地数据库（仅监听 127.0.0.1:5432）
docker compose -f infra/compose.yaml up -d

# 2) 启动服务端
cd services/api
export DATABASE_URL='postgres://atelier:atelier_local_only@127.0.0.1:5432/atelier'
export DEV_AUTH=true
export BIND_ADDRESS='127.0.0.1:8080'
cargo run
```

Windows PowerShell 环境变量：

```powershell
$env:DATABASE_URL='postgres://atelier:atelier_local_only@127.0.0.1:5432/atelier'
$env:DEV_AUTH='true'
$env:BIND_ADDRESS='127.0.0.1:8080'
cargo run
```

另一个终端：

```bash
cd apps/web
# 将 .env 的 VITE_API_MODE 设为 http，或下面直接写入：
echo 'VITE_API_MODE=http' > .env
npm run dev
```

在 `http://127.0.0.1:5173` 会出现开发登录页，选择演示身份后，前端使用 Vite 反向代理请求 `127.0.0.1:8080/api/v1`。

该服务端**仍是 Mock Worker**，不会真正向 AI 供应商发送请求。生成结果是项目 `public/assets` 中的演示媒体。

## 快速验证

```bash
node tests/verify_source.cjs
# 前端依赖安装后：
cd apps/web
npm run typecheck
npm run build
# 后端装有 Rust 后：
cd ../../services/api
cargo test
cargo check
```

## 必须在公开部署前完成

1. Google OIDC Code + PKCE / nonce / state、只允许验证的 `@gmail.com` 邮箱、服务器 Session、注销和撤销。
2. 写接口 CSRF、Origin 验证、严格 Cookie、速率限制、管理员 MFA；移除 `DEV_AUTH`。
3. 生产钱包改成**不可变账本 + 预占 + 结算 + 退款 + 幂等**，禁止使用 Mock 钱包余额。
4. 真实媒体 S3 预签名上传、MIME / 魔数 / 文件大小验证、视频转码、短时授权播放地址。
5. 正式 Worker / Redis 队列、模型供应商授权 API、取消 / 重试 / 计费状态机及成本核算。
6. 真正的前后端集成、并发、越权、压力和端到端浏览器测试。

阅读 `docs/03_本轮工程实现与迁移说明.md` 和 `docs/04_API与安全验收清单.md` 获取逐项说明。
