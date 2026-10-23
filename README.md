# Atelier

按根目录《Atelier AI 创作平台 · 产品与工程开发规格书（AI 开发版）》逐里程碑开发。
当前状态以 [docs/PROGRESS.md](docs/PROGRESS.md) 为准；假设见 [docs/DECISIONS.md](docs/DECISIONS.md)。
原始原型保存在提交 `c3384c5`。M0–M5 已完成；M4 账号池与模型的后端和原型管理页面、本地回归与 [远端 Actions](https://github.com/jasonlat-dot/atelier/actions/runs/39834923711) 均已通过，详见 [进度记录](docs/PROGRESS.md)。本轮停在 M5，不进入 M6；S3 继续待定。实际部署与 Google 实账号回归见 [M1 部署清单](docs/M1_VALIDATION.md)。

## 已部署 WSL 数据库

已接入 PostgreSQL 16（127.0.0.1:15432）、Redis 7（127.0.0.1:16380）。API 启动时自动应用 M0–M4 的版本化迁移；独立业务库 atelier 与测试库分离；测试库 atelier_test 及 CREATEDB 测试角色独立。连接配置在 Git 忽略的 services/api/.env 与 .env.test.local，禁止提交凭据。

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

登录后 `/` 为签到工作台，`/assets` 使用原型布局管理真实图片/视频上传、筛选、预览与删除，`/wallet` 查看真实余额/兑换/流水，`/settings` 管理账号，`/admin/credits` 提供有审计的 MFA 管理员调账。

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
账号资料、设备列表/撤销、全设备注销已接服务端会话；M2 已接积分、签到、兑换和管理员调账，M5 已接图片与视频生成、任务与积分结算。

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

素材文件默认写入 API 工作目录的 `data/media`（Git 忽略且不在网页静态目录），沿用现有 MASTER_KEY 生成私有签名链接。素材库沿用原型，支持图片 PNG/JPEG/WebP（20 MiB）和视频 MP4/WebM（200 MiB、60 秒）。视频先显示处理中，后台重新转码为 MP4、生成封面后可播放、拖动进度和下载；默认保留 30 天。

视频依赖 FFmpeg/ffprobe、timeout 和 prlimit。Linux 使用本机 PATH；Windows 默认经 WSL 调用，可在后端 `.env` 配置 `FFMPEG_DIR=/绝对/Linux/目录`。本机已配置工作区内的工具，重启 `npm run dev` 即可启用。换机器时需安装工具或重新配置路径；设置 `VIDEO_MODE=disabled` 可只启用图片，工具缺失时页面明确提示视频不可用。当前使用本地磁盘存储；S3 按负责人决定改为待定，不纳入本次 M3 完成范围，也不声明已通过实服务验收。


## M4 管理入口

管理员完成 MFA 后，从侧栏进入 **上游账号池**（`/admin/accounts`）和 **模型与定价**（`/admin/models`）。

1. 新增账号，填写兼容接口的完整基础地址（通常以 `/v1` 结尾）、API 密钥、分组、并发与额度，然后测试连接。
2. 新建公开模型，填写展示名、内部上游模型标识以及实际支持的质量、比例、分辨率、参考图和视频时长。新模型默认不启用。
3. 为模型绑定指定账号或分组；两者取并集。
4. 在“积分定价”填写各档基础积分、全局倍率，保存后回到目录启用模型。

地址、API 密钥和内部模型标识只写不读，编辑时留空保留。账号池沿用后端 `MASTER_KEY` 加密凭据，不新增前端密钥；该主密钥需持久保存，不能随意更换。连接测试只请求模型列表；额度目前由管理员在上游核对后手动更新，不代表自动查询上游余额。

上游账号支持合法的 HTTP 和 HTTPS 地址，localhost、本机 IP、内网和公网均可，不按 IP 范围过滤，也不需要配置地址白名单。保存时检查地址格式，实际可用性通过“测试连接”确认。localhost 指 API 后端运行的机器或容器；接口地址填写上游的基础路径（通常以 `/v1` 结尾）。实际供应商协议或模型能力需要用供应商真实配置核对，本轮使用受控假上游验收，未发起付费生成。

重启仓库根目录的 `npm run dev` 后，新迁移会自动执行。M4 账号、模型、价格和内部路由适配验收见 [M4 记录](docs/PR_M4.md)。


## M5 图片与视频生成

重启根目录 `npm run dev` 应用迁移后，从侧栏“图片与视频生成”或首页“开始生成”进入 `/generate`。需要管理员先按上面的 M4 顺序配置可用账号、绑定、模型能力和价格并启用；没有可用模型时页面会明确提示。视频还需要启用 FFmpeg/ffprobe。

1. 选择图片或视频、模型，填写画面描述。参考图模式可从自己的素材库选择或上传图片。
2. 选择模型支持的参数，检查服务端实际尺寸与预计积分；当前 FREE 默认最高 2K、同时一个活跃任务。
3. 点击生成后预占积分，可查看实时进度或离开页面稍后返回。取消、失败或部分成功时，未产出的积分自动释放；仅保存并发布的结果结算。
4. 在生成记录查看/切换任务，预览和下载图片或视频；结果同时进入素材库。复用参数不会自动提交，需要再次确认报价并点击生成。

网络提交结果不明时请使用页面的“重试确认提交”，它保留相同请求编号，避免重复扣分。SSE 断线会自动查询任务；代理应关闭 `/api/v1/events` 的响应缓冲并允许长连接。

M6 画布与 M7 对话已按负责人后续授权推进；S3 继续待定。真实供应商的兼容性和付费效果需部署者使用自己的配置核对；验收记录见 [M5 记录](docs/PR_M5.md)。


### M6 画布工作台

登录后从「无限创作画布」或首页「新建画布」进入。添加文字与参考图，把右侧端口拖到生成节点左侧；选中生成节点后在左栏选择模型与参数，点击生成。视频模型当前支持首帧参考，尾帧协议待扩展。节点和视口自动保存，遇到版本冲突按提示载入最新或另存副本。

项目列表可重命名/复制/删除及导入 ZIP，画布顶部下载按钮导出图数据和真实媒体。ZIP 上限 256 MB；素材删除/过期后需替换再导出。导入失败前已成功上传的媒体会保留到本人素材库；导入不会自动生成或扣费。1024px 以下只读。验收记录见 `docs/PR_M6.md`。


### M7 AI 智能对话

登录后从侧栏「AI 智能对话」进入 `/chat`。选择模型后发送消息，可实时阅读回复、停止、复制代码/回复、重新生成、重命名或删除历史会话。重新生成会创建新回复，完整完成才按页面显示价格结算；中断、失败和取消不扣积分。断线结果不明时用「核对上次回复」，不要另发重复请求。

管理员先在「模型与定价」创建 **chat/对话** 模型（质量 message、分辨率 text、单次 1 条），填写供应商实际模型标识，绑定账号或分组，添加 message 定价规则后启用。兼容上游须支持 `POST /chat/completions` 的 SSE，正常结束包含 `finish_reason: stop` 和 `[DONE]`。新迁移随根目录 `npm run dev` 重启自动应用，无需新增密钥。

实际对话收费使用全站 `system_settings.chat_credits_per_message`，默认 1，可设 0；模型定价规则目前用于启用校验，不覆盖这项统一收费。窗口 `chat_context_window` 默认 8192，输出预留 `chat_output_tokens` 默认 2048，需适配供应商模型；暂由数据库维护，管理设置页属于后续管理阶段。上下文使用估算，超过 70% 自动整理早期内容，保留近期原文及带原话校验的事实。

图像意图会出现「在画布中生成」动作卡，只填入草稿；需要在画布选择模型、检查积分并再次点击生成。Markdown 禁止原始 HTML，不自动加载回复里的远程图片。历史及摘要仅本人可读，无管理员查看他人对话入口。验收与限制见 [M7 记录](docs/PR_M7.md)。本轮到 M7 停止，不进入 M8。
