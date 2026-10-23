# Atelier 里程碑进度

依据：根目录《Atelier AI 创作平台 · 产品与工程开发规格书（AI 开发版）》第 0、3、8、10 章。

- [x] 原始工程保全：`c3384c5`，仅为原型快照。
- [x] M0：基线整理，`b3cc451`；历史验收见 `PR_M0.md`。
- [x] M1：认证与权限，2026-10-22 完成代码与自动化验收；功能提交 `d8872b9`，浏览器夹具修正 `1683788`。
- [x] M2：积分账本与签到，`19d3ef2`，2026-10-22 完成本地与远端 Actions 验收。
- [x] M3：素材与本地存储，2026-10-23 完成图片/视频接入与高分辨率修复；S3 按负责人决定待定。
- [x] M4：账号池与模型，2026-10-23 完成后端、原型接线、本地与远端验收；功能提交 9fa4b8b，历史停止点已被后续 M5 授权覆盖。
- [x] M5：生成流水线，2026-10-23 完成后端、原型接线、本地与远端验收；最终功能提交 00ccdf7，历史停止点已由后续授权覆盖。
- [x] M6：画布工作台，2026-10-23 完成本地与远端验收；最终功能 5c7257d。
- [ ] M7：对话，已开始核心模块、真实会话与 SSE 及计费，页面和最终验收进行中。
- [ ] M8：订阅与支付，未开始。
- [ ] M9：管理后台，未开始。
- [ ] M10：加固上线，未开始。

**M6 已完成；按负责人最新授权继续完成 M7，再停止，不进入 M8。S3 仍待定。** M6 最终功能 `5c7257d` 的 Actions #39901276711 与 M7 后端切片 `a12699d` 的 Actions #39903985055 两作业均 completed/success。实际域名和付费供应商效果仍由部署者按配置核对，自动化通过不代表已上线。

## M0 · 基线整理

- [x] `services/api/migrations/202610220000_m0_baseline.sql` 建立新基线，原型迁移归档于 `docs/legacy`；既有旧库不能直接套用新迁移。
- [x] `services/api/crates/*` 建立规格 3.3 的 11 个 crate 边界；删除原型 DEV_AUTH、内存 Session 和钱包外扣款逻辑。业务空模块不标为可用。
- [x] `apps/web` 完成格式化、类型修正与 Mock/HTTP 构建隔离；`dist` 不包含演示身份、种子数据或本地积分逻辑。
- [x] `.github/workflows/ci.yml` 提供 Rust/前端/契约/浏览器/依赖审计门禁；`infra/compose.yaml` 提供回环开发基础服务，本机未安装或启动。
- [x] `docs/openapi.json`、`apps/web/src/lib/generated/api.d.ts` 与 `scripts/check_contract.py` 保持契约一致。

M0 首次交付的历史限制和结果见 `PR_M0.md`；以下记录为当前 M1 源码的最终验证，替代此前分阶段“未接通/待 CI”状态。

## M1 · 完成项与代码位置

- [x] **迁移与测试先行**：身份迁移 `202610220100_m1_identity.sql`、独立设备 ID 迁移 `202610220200_m1_session_management.sql`、MFA 迁移 `202610220300_m1_login_mfa.sql`；先补会失败的策略、HTTP、注册、MFA 与前端测试，再实现；不修改已提交迁移。
- [x] **Google OIDC**：`auth/src/{oidc_attempt,oidc_provider,login}.rs`，Authorization Code + S256 PKCE、独立 state/nonce、浏览器绑定、Redis TTL/NX/原子单次消费；固定 Google HTTPS token/JWKS、限时/限大小、禁重定向，ring 验证 RS256 与 iss/aud/exp/nonce 等声明。身份仅由后端验签产生。
- [x] **注册事务**：`auth/src/{policy,identity}.rs`，Gmail 规范化唯一、拒绝非 Gmail 与所有 hd 声明、默认 CLOSED/OPEN/INVITE_ONLY、即时读取设置、邀请码原子消费、IP 并发额度、Bootstrap 仅首次；用户/会话/邀请码/审计同事务，审计失败回滚。不改积分。
- [x] **会话与权限**：`auth/src/{repository,postgres,service,session,views}.rs`、`app/src/auth_http.rs`；256 位令牌只存哈希、登录轮换、逐请求读取状态/角色、空闲 7 天/绝对 30 天、角色变化或禁用撤销、设备归属、全会话退出；AuthUser/RequireRole、Origin/Host/CSRF、管理员写限流。
- [x] **管理员 TOTP**：`auth/src/mfa.rs`；随机 nonce 的 ChaCha20Poly1305 加密、用户 AAD、10 分钟待绑定并绑定发起会话、六位 TOTP、数据库原子时间步防重放、12 小时会话验证、5 次/5 分钟限流、成功审计同事务。
- [x] **HTTP 接线**：`app/src/{config,main,routes,login_http}.rs`；必填凭据启动检查、迁移与真实 PG/Redis 接线、Google start/callback、public/config、MFA、资料和设备接口；默认只信 TCP IP，显式可信代理才接收单值 X-Real-IP。
- [x] **前端**：`features/auth/LoginPage.tsx`、`MfaPage.tsx`、`sessionApi.ts`、`features/settings/SettingsPage.tsx`、`ProductionApp.tsx`；真实 Google 导航、注册三态、MFA 绑定/验证、服务端身份路由守卫、显示名、设备撤销与全设备退出。Google Client Secret 与 MASTER_KEY 不进入前端。
- [x] **接口文档**：`docs/API.md`、OpenAPI 与生成 TypeScript 已同步；假设与规格偏离见 `DECISIONS.md`。
- [x] **漏洞依赖移除**：`71f138f` 移除 rsa 的 SQLx/openidconnect 引入路径；SQLx 0.9、oauth2 5 与 ring 保留实际 RSA 公钥验签；`tests/baseline.test.cjs` 阻止 rsa 回流，未设置审计豁免。

上文 Rust 路径相对 `services/api/crates`，前端路径相对 `apps/web/src`；详细逐项验收见 `PR_M1.md`。

## M1 · 最终验证（2026-10-22）

核对源码 `16837884926d2316b5c5ac7c427398f42efa5647` 的 [CI #6](https://github.com/jasonlat-dot/atelier/actions/runs/39759708282)：`baseline` 与 `identity-schema` 均为 completed / success。

| 验证 | 结果 |
| --- | --- |
| cargo fmt --all 与 --check | 通过 |
| cargo clippy --locked --workspace --all-targets -- -D warnings | 通过 |
| cargo test --locked --workspace | 本地与 CI 均通过，44 项；基础设施 11 项和浏览器服务夹具 1 项在普通 test 中显式跳过 |
| CI：cargo test --locked -p atelier-auth --tests -- --ignored | 11/11 通过，真实 PostgreSQL 16 / Redis 7 |
| cargo check --locked --workspace | 通过 |
| npm run typecheck、build、lint、format:check、test:mock | 通过 |
| Playwright Mock / HTTP 合同 / 真实认证链路 | 分别 1/1、5/5、2/2 通过；真实认证链路在 CI 使用 PG/Redis 与合成 Google 提供方 |
| node --test tests/baseline.test.cjs | 3/3 通过，含产物隔离与锁文件无 rsa |
| python scripts/check_contract.py | 通过，OpenAPI 与生成类型一致 |
| cargo audit / npm audit | 均为 0 漏洞；本地 Rust 审计 0 警告，282 个锁文件依赖 |

11 项真实基础设施测试位置：`auth/tests/login_database.rs` 4 项、`mfa_database.rs` 1 项、`redis_transient.rs` 1 项、`schema.rs` 5 项。覆盖即时注册设置、唯一与并发、邀请码/审计回滚、禁用/角色撤销、MFA 加密/过期/100 并发防重放，以及 Redis 单次消费/NX/TTL/限流。完整浏览器测试为 `apps/web/tests/auth-live.spec.ts`，通过真实 HTTP、数据库和 Redis 验证登录、资料持久化、退出失效及管理员 TOTP。

Windows 本地测试使用进程局部 `CARGO_PROFILE_TEST_DEBUG=0` 避开调试产物 LNK1104；不改断言或源码 profile，CI 标准配置已通过。首次收尾 CI `39758306218` 的浏览器重定向拦截夹具失败，在 `1683788` 修正后全绿；未放宽生产认证或测试断言。

## 尚待负责人部署后验证

- [ ] 实际 HTTPS 域名、代理、Google OAuth 凭据与实账号回归，操作清单见 `M1_VALIDATION.md`。
- [x] 负责人 WSL PostgreSQL 16 / Redis 7 连接与迁移回归于 M2 补齐，复用现有服务，没有安装或启动新实例。

M1 历史交付未打包、未部署。条款仍是开发占位，正式法律文案与公网上线完整安全清单属 M10；项目/素材/任务的资源权限随后续里程碑验收。积分、赠送和钱包已由下述 M2 实现，余额只经 wallet 模块修改。

## M2 · 积分账本与签到（2026-10-22）

- [x] **基础设施**：用户 WSL PG 16（15432）和 Redis 7（16380）已连接。新建 atelier / atelier_test 独立数据库、独立角色；测试角色有 CREATEDB。凭据仅在忽略文件 services/api/.env / .env.test.local。业务库 M0–M2 迁移、Redis 原子脚本与对账通过。
- [x] **迁移**：202610220400_m2_wallet.sql，钱包、账本、签到、兑换码、请求收据与默认设置。禁止账本 UPDATE/DELETE/TRUNCATE；启动撤销运行角色对应权限。既有 M1 用户补空钱包，不追溯发奖励。
- [x] **钱包**：wallet/src/{service,postgres,views}.rs；grant/hold/release/settle/adjust、行锁、幂等参数核对、job 预占隔离、余额不足/溢出拒绝、共享事务入口、游标流水、启动及每日 balance/held 对账与错误日志。
- [x] **赠送与签到**：auth/src/identity.rs 在身份事务中调用 wallet，默认注册 20；签到默认 10、连续加 1、最多额外 10。PostgreSQL 时区决定日界，Redis 每用户 10 次/分钟；故障拒绝。
- [x] **兑换与调账**：兑换码随机 256 位、只存哈希、容量/过期/唯一领取；兑换与调账要求 UUID Idempotency-Key，异参 422。管理员 MFA、非零金额和原因、审计同事务。
- [x] **接口与页面**：app/src/wallet_http.rs、apps/web/src/features/wallet/*；工作台签到、/wallet、/admin/credits。前端失败重试保留请求键。API/OpenAPI/TypeScript 已同步。
- [x] **本地验证**：fmt/clippy/workspace test/check 通过，普通测试 44 项；真实基础设施 18/18（M1 11、钱包 6、HTTP 1）单独执行通过；前端 typecheck/lint/format:check/test:mock/build、契约检查与 baseline 3/3 通过。
- [x] **浏览器**：HTTP 7/7、Mock 1/1、真实认证与钱包 2/2，合计 10/10，使用已安装 Chrome。真实测试含新注册赠送、签到及刷新持久化、退出失效、管理员 TOTP；夹具使用 SQLx 隔离库。
- [x] **审计**：cargo-audit 0.22.2 扫描 282 依赖、1349 条当日官方公告，退出码 0；npm 官方 registry audit 0 漏洞。无漏洞豁免或降阈值。
- [x] **远端 Actions**：功能源码 `19d3ef279b54dbb691163e397b796639c0c00f59` 的 [运行 #39772855488](https://github.com/jasonlat-dot/atelier/actions/runs/39772855488) 已确认 completed/success；`baseline` 与 `identity-schema` 均成功，包含完整 Rust/前端/契约/浏览器/安全审计、18 项真实基础设施回归与认证签到浏览器验收。

详见 PR_M2.md。Google 实账号、生产打包部署、M3 素材和 M8 支付不在本次完成声明中。

## M2 · 本地真实开发启动入口

- 用户希望一个终端启动两端：根目录新增 package.json / package-lock.json 和 scripts/dev.mjs，`npm run dev` 启动真实 API + Vite，`dev:api` / `dev:web` 可单独运行。不新增第三方依赖。
- 后端单独读取 services/api/.env；前端强制 HTTP 模式，不接收从后端文件加载的密钥。端口已占用时拒绝启动，不结束旧服务；Ctrl+C 和子进程失败时清理本次启动的进程树。
- 本机 Windows 真实冒烟通过：登录页、健康检查、PG public/config、匿名 401；Vite runtime __MOCK__=false；重复启动拒绝；Ctrl+C 后 8080/5173 释放；缺少 Cargo 时清理前端。Node 语法与 Prettier、Rust fmt/clippy/workspace test、前端 typecheck/build 均通过。README 已补一条命令启动说明，CI 增加入口语法检查。

## M2 · Google 实账号回调修复

- 用户实账号返回标准 iss，旧回调结构将其当未知参数拒绝；app/src/login_http.rs 补充必填 issuer 和严格 Google HTTPS 匹配，错误响应不消费 state。未修改数据库、Cookie 策略或令牌验签。
- app/tests/login_http.rs 真实响应参数回归先失败后通过，合计 5/5；覆盖错误/缺失/重复 issuer、未知参数和重放。Playwright 的 Google 模拟回调同步带 iss，避免再次漏测。
- 本地 fmt/clippy/workspace test/check（45 项普通测试）、前端 typecheck/lint/format:check/build、契约与 baseline 3/3 通过。使用独立构建目录避开用户运行中的 exe；未在占用中的 8080 启动第二份浏览器夹具，完整真实 PG/Redis 浏览器链路交由本次 Actions 再验收。
- 另验证 Google JWKS 直连失败、本机 7890 代理可达；后端本地 .env 已补现有代理地址（未提交）。用户随后确认真实 Google 验证成功并进入管理员 MFA 页面；此确认仅覆盖本机 Google 登录，不代表 MFA 或生产部署验收已完成。

## M2 · 登录页参考图调整

- `apps/web/src/features/auth/LoginPage.tsx` / `LoginPage.css` 按用户截图调整品牌、配色、卡片尺寸、衬线标题、注册提示、Google 按钮和条款区域；独立样式不改变 MFA 等其他认证页面。
- 保留服务端注册三态、邀请码提交、加载禁用、配置重试、账号禁用提示和真实 Google 导航。无新依赖、迁移或 API 变化。
- 前端 typecheck/lint/format:check/build、Mock 源码回归通过；现有 HTTP 浏览器 7/7 通过，测试使用独立 5174 端口，未停止用户开发服务。Rust fmt/clippy/workspace test 通过，45 项普通测试；基础设施测试按现有规则忽略，本次未重跑真实 PG/Redis。
- 隔离浏览器检查 CLOSED/OPEN/INVITE_ONLY、配置加载/失败重试、禁用账号、条款导航及键盘焦点通过，无页面脚本错误；已检查 1280×800 桌面、390×844 手机与 320×480 小屏截图，小屏可滚动访问条款。检查截图保留于忽略目录 `.tools/`，不作为产品静态资源发布。

## M2 · 开发代理与管理员 MFA 绑定

- 用户已确认登录页视觉效果及真实 Google 登录成功，随后 MFA setup 返回 FORBIDDEN / Request origin or CSRF token rejected。定位到 Vite 的字符串代理隐式 changeOrigin=true，将 Host 改成内部 8080，与 PUBLIC_BASE_URL 的 5173 不符。
- `apps/web/vite.config.ts` 改为显式 target / changeOrigin=false，保持原始 Host、Origin 和 CSRF 请求头。后端来源、Host、CSRF、管理员权限及 TOTP 检查保持严格，不修改用户数据库或绑定状态。
- 新增 `tests/dev-proxy.test.mjs`，加载实际 Vite 配置、使用随机隔离端口验证 POST MFA setup 的请求头转发；修复前明确在 Host 断言失败，修复后通过，并断言外部 Origin 不会被改成可信来源。CI 已增加此检查。
- 前端 typecheck/lint/format:check/build、代理回归、基线 3/3、OpenAPI 契约检查均通过。需用户刷新或重启开发服务后再次绑定验证器；尚未替用户完成真实 MFA 绑定。

## M2 · 管理员验证器扫码与页面指引

- 用户确认代理修复后已能获取绑定材料；指出页面缺少下一步指引，并明确要求默认二维码、可切换手动密钥。`MfaPage.tsx` / `MfaPage.css` 补充准备手机验证器、扫码添加、填写六位验证码三步引导及安装说明。
- 点击绑定后默认展示本地生成的 SVG 二维码；“无法扫码？使用密钥”展示账号名称、基于时间类型及可复制密钥，可返回二维码，切换不重新请求 setup。已绑定账号仅显示验证码验证；补充 10 分钟绑定期限、验证码来源、过期及接口失败提示。
- 新增固定版本 qrcode.react 4.2.0（React peer，无其他运行依赖），仅在浏览器编码后端已有 otpauth_uri，不调用第三方二维码服务，不修改后端鉴权、数据库或 API 契约。
- 前端 typecheck/lint/format:check/build、HTTP 浏览器 7/7、Mock 回归、代理/基线 4/4、契约检查通过；Rust fmt/clippy/workspace test 通过，45 项普通测试。更新真实认证浏览器夹具的二维码/密钥切换，真实 PG/Redis 全链路交由本次 Actions 验证。
- 隔离浏览器使用合成绑定材料验证默认 QR、手动切换、复制、单次 setup、错误及已绑定状态；1280 桌面与 320 小屏检查通过。独立 jsQR 解码实际截图，与原始测试 otpauth URI 完整一致；截图及临时解码工具仅在忽略目录 .tools。没有使用或保存用户真实绑定密钥。
- 新增依赖后 npm 官方 registry audit 为 0 漏洞；cargo-audit 使用当日最新官方公告库（HEAD 与 fetch 结果一致），1349 条公告 / 282 个 Rust 依赖，退出码 0。

## M2 · 管理员验证页参考图调整

- 按用户新增参考图调整 `MfaPage.tsx` / `MfaPage.css`：暖灰背景、居中白卡、Google 登录完成标记、三步连线、带图标的绑定按钮、六格验证码及横向底部操作区。二维码/密钥切换、复制、错误提示、已绑定验证流程继续保留。
- 六格外观使用一个原生文本输入与六个装饰格，保留读屏标签、数字键盘、one-time-code 自动填充、整段粘贴、退格与方向键；不保存验证码。未生成绑定材料时显示空格但禁用输入与提交，已绑定账号可直接验证。
- 前端 typecheck/lint/format:check/build、HTTP 浏览器 7/7、Mock、代理/基线 4/4、契约检查及 Rust fmt/clippy/workspace test（45 项普通测试）通过。浏览器回归新增非法字符过滤、六格显示、方向键/退格后修正与按钮状态断言。
- 隔离浏览器以合成材料检查 1280×993 桌面和 390/320 小屏、二维码/密钥切换、复制及系统剪贴板粘贴“123 456”还原六位数字，无脚本错误；截图仅保留在忽略目录 .tools。未修改依赖、数据库或 API，未操作用户真实 MFA 绑定。

## M2 · 首次绑定与退出确认交互

- 按用户要求删除 MFA 首次绑定的 window.confirm，点击直接生成二维码；请求期间显示“正在生成二维码…”并禁用按钮，使用同步请求锁防止重复触发。生成后自动聚焦验证码输入，preventScroll 保留二维码查看位置。
- MFA 页“退出所有设备”使用与页面配色一致的 HTML dialog，说明全部设备登录会失效，确认按钮为“退出所有设备并返回登录”。支持确认按钮初始焦点、Tab/Shift+Tab 循环、Esc/取消/遮罩关闭及关闭后焦点恢复；未确认不发退出请求。
- 新增浏览器回归覆盖双击只请求一次、加载态、二维码与输入焦点、无 JS 原生弹窗、模态框关闭方式和确认后退出。HTTP 浏览器 8/8、前端 typecheck/lint/format:check/build、Mock、代理/基线 4/4、契约与 Rust fmt/clippy/workspace test（45 项普通测试）通过；合成材料桌面/手机截图检查通过。
- 无依赖、迁移或 API 变化。用户提出是否需要重新绑定入口，建议后续放在账号安全设置；需先实现验证当前身份、新验证器确认后替换旧密钥及独立恢复流程，本次没有提供仅前端重绑或修改真实绑定状态。

## M2 · MFA 错误与过期反馈弹窗

- 按用户两种提示参考图，新增 `MfaFeedback.tsx`，替换 MFA 页内错误横条：验证码错误为红色图标、说明及“重新输入”；绑定过期为黄色图标、“取消”及“重新绑定”。其他接口错误采用同一弹窗风格；支持键盘焦点、Esc 和遮罩关闭。
- 重新输入清空验证码并聚焦；过期后清除页面旧二维码/密钥及验证码，取消不请求新材料，点击重新绑定才调用既有 setup。新材料生成后恢复默认二维码并聚焦输入；已启用验证器的账号不提供覆盖绑定入口。
- 后端新增 409 MFA_ENROLLMENT_EXPIRED，基于 PostgreSQL clock_timestamp 判断当前会话待绑定的 10 分钟期限；读取材料与最终提交均校验，错误/其他会话/被替换材料仍按原逻辑拒绝。无新表或迁移、无依赖变化。API.md / OpenAPI / TypeScript 同步。
- 先在隔离 PostgreSQL 运行过期回归确认旧实现返回 Mfa、无法区分；修复后 1/1 通过，覆盖真实过期、提交时过期、会话不匹配、重新生成、旧材料拒绝、错误验证码、100 并发单次接受与审计失败回滚。未触碰业务库绑定状态。
- Rust fmt/clippy/workspace test/check 通过（46 项普通测试）；前端 typecheck/lint/format:check/build、HTTP 浏览器 10/10、Mock、代理/基线 4/4、契约检查通过。浏览器覆盖错误重试、过期取消/重新生成、生成失败反馈及已绑定账号；1280 桌面/320 手机弹窗截图检查通过，使用合成材料、无脚本错误。
- 本次后端有变更，用户需 Ctrl+C 后重新运行 npm run dev。真实 Google/MFA 账号端到端验证未代替用户执行。

## M2 · 正式工作台恢复原型布局与站点图标

- 用户指出正式登录后的简化页面与原型不同。原因是原始 App.tsx 的侧边栏、顶栏与 Dashboard 仅在 Mock 构建使用；真实路由此前直接渲染账号/钱包功能页。新增 `features/workspace/WorkspaceShell.tsx`、`HomePage.tsx`、`WorkspaceShell.css`，沿用原型样式和菜单结构，工作台、积分、账号设置及积分管理共用布局。
- 普通登录回调改为 303 `/`；管理员完成 MFA 后进入工作台。API 文档、OpenAPI、生成类型与登录测试同步。账号设置仍可从侧栏访问，服务端身份、MFA 与 CSRF 检查保持原有行为。
- 侧栏身份和余额来自真实会话/钱包；工作台复用既有签到组件，签到/兑换后重新读取服务器快照，同步侧栏余额，防止较早的初始请求覆盖新余额。原型中的演示身份切换、项目、素材和任务假数据不进入生产。M3+ 创作与运营入口明确标记待开放并禁用，不宣称完成。
- 按用户追加要求，`index.html` 引用用户提供的 `/assets/favicon.svg`；核对 SVG 可解析、生产资源与原文件逐字节一致。未改动用户的两张未跟踪参考截图。
- 本地前端 typecheck/lint/format:check/test:mock/build、代理/基线 4/4、OpenAPI 契约通过；Mock 浏览器 1/1、HTTP 浏览器 13/13（含工作台、服务端余额同步、角色导航、320px 手机滚动与收起边栏）。真实 PG/Redis + 合成 Google 提供方浏览器 2/2 通过，覆盖登录落点、资料持久化、签到、登出失效、管理员绑定与防重放；使用测试配置和 SQLx 隔离库，不修改业务账号。
- Rust fmt/clippy/workspace test/check 通过，46 项普通测试。桌面工作台/钱包与手机导航截图检查通过、无页面脚本错误，检查资源仅存忽略目录 `.tools/`。没有新增依赖或数据库迁移，不进入 M3，不打包部署。
- 前一阶段 MFA 错误弹窗提交 `1371417` 的 [Actions #39797815237](https://github.com/jasonlat-dot/atelier/actions/runs/39797815237) 已核实 completed/success；此前首次绑定与验证页样式切片也均通过远端检查。本次提交后继续跟进 Actions。

## M3 · 图片素材库接入原型（2026-10-23，里程碑进行中）

- 用户明确授权继续下一功能，按规格推进 M3。202610220500_m3_assets.sql 建立 owner 归属、状态/大小/键约束、索引、保留期和清理字段；先运行隔离库测试确认旧代码因缺 assets 表失败，补迁移后通过，不修改已发布迁移。
- `crates/assets`：真实本地存储、S3 兼容存储接口、20 MiB 图片魔数/MIME/解码/尺寸/像素/内存检查，方向校正、重新编码去元数据、JPEG 缩略图。签名绑定 owner/asset/variant/到期时间，媒体读取还查当前用户和数据库删除/过期状态；原始存储键不返回浏览器。
- `app/assets_http.rs`：上传、搜索/类型/来源筛选、游标分页、详情、单个/批量删除和签名媒体 Range。上传 Redis 限流、有限并发；批量归属/删除/审计原子操作；后台每分钟回收删除/到期/中断文件。默认配置不用增加密钥，媒体签名从现有 MASTER_KEY 以独立域派生。
- `apps/web/features/assets` 接入现有素材库的标题、tabs、网格与全局侧栏/顶栏；增加真实上传/拖文件、筛选、搜索、分页、选择/批删、预览/下载、失败重试及原生 dialog 样式确认。工作台素材卡片、侧栏入口可用，生产不导入 Mock 数据。视频能力仍关闭并明确提示，画布与生成业务未接入。
- 本地：Rust fmt/clippy/check/普通测试通过（50 项）；真实 PG/Redis 基础设施 22/22；Mock 浏览器 1/1、HTTP 页面 16/16、真实认证/钱包/上传/刷新持久化/签名图片显示/删除浏览器 2/2；前端 typecheck/lint/format:check/test:mock/build、契约、实际媒体/API 代理通过。桌面和 320px 手机素材库/预览/删除截图已核对，合成素材无脚本错误。
- 安全审计：官方 RustSec 当日公告 1349 条、锁文件 339 依赖，cargo audit 退出 0。新媒体存储统一 ring，避免多 TLS provider；npm 官方审计 0 漏洞，无漏洞忽略。S3 实服务和视频处理尚未验收，M3 不能标完成。当前测试不停止用户 8080；真实浏览器夹具改用可配置 loopback 端口，本地使用 8082。
- 上阶段 `f4f918e` 工作台恢复的 [Actions #39804929413](https://github.com/jasonlat-dot/atelier/actions/runs/39804929413) 已确认 completed/success。

## M3 · 视频素材接入原型（2026-10-23，里程碑进行中）

- 新迁移 `202610230100_m3_video.sql` 增加原始大小、空间预占、任务租约令牌和全部存储对象登记，不改已发布迁移。`assets/src/video.rs`、`video_service.rs` 接入真实 FFmpeg/ffprobe，上传校验后返回 PROCESSING；后台转成 H.264/AAC MP4、生成 JPEG 封面后才开放签名链接。支持 MP4/WebM、200 MiB、60 秒；源文件不提供给浏览器，成功后回收。
- PostgreSQL 持久队列、SKIP LOCKED 领取、独立输出键和租约令牌防止重复领取/过期进程发布；最多三次重试，处理失败和删除/到期均可回收。READY 与审计原子提交，丢失提交响应不删除已发布输出。预占转码空间，媒体 Range 改为流式响应并持有并发槽至响应结束。
- 只通过 stdin 传上传体，禁止 file/concat/网络输入；FFmpeg 独立 Linux timeout/prlimit 限制 1 GiB、转码 120 秒、探测/封面 20 秒和有限线程/并发。Windows 开发经 WSL，Linux 直接调用；工具缺失时禁用视频，页面明确提示。没有把工具二进制或本机路径写进仓库；本机已忽略 .env 配置工具目录，重启 npm run dev 后生效。
- 素材库继续沿用原型，新增视频时长、处理中/失败状态、完成轮询和自适应播放器，支持预览、进度跳转、下载、筛选和删除。首次视觉检查发现低分辨率视频的原生控件过小，已扩大视频显示区；桌面和 320px 手机截图检查通过，无脚本错误。
- Rust fmt/clippy/workspace test/check 通过，普通测试 51 项；真实基础设施与视频处理合计 25 项通过。视频回归包括 MP4、含音轨 WebM、恰好 60 秒、61 秒拒绝、伪装/截断拒绝、重编码去元数据、可解码封面、并发单次领取、Range、跨用户拒绝、删除、损坏失败、审计回滚重试与重试耗尽回收。针对 AAC 编码填充，仅自产转码输出允许最多 100 毫秒容器延迟，上传始终严格 <=60 秒；展示/记录最大 60 秒。
- 前端 typecheck/lint/format:check/test:mock/build、API 契约与代理/基线 4/4 通过；HTTP 浏览器既有 16 项及新增视频状态测试通过，Mock 1/1、真实 PG/Redis/合成 Google + 图片/视频播放/删除浏览器 2/2 通过；真实浏览器使用隔离 8082，不停止用户 8080/5173。
- cargo audit：当日官方公告 1349 条、339 个依赖，0 漏洞；npm 官方 audit 0 漏洞。CI 加入 FFmpeg/util-linux 安装，执行相同真实视频与浏览器验证。图片阶段 `a8554f2` 的 [Actions #39812886454](https://github.com/jasonlat-dot/atelier/actions/runs/39812886454) 已确认 completed/success。本次提交后跟进远端检查。
- 当时 S3 实服务尚未验收，M3 保持进行中；负责人随后调整范围，以下最新决定覆盖该停止点。

## M3 · 完成（本地存储，2026-10-23）

- 负责人明确将 S3 改为待定，不纳入当前 M3 完成范围；保留已有适配代码，不声明实服务验收。当前采用本地磁盘，图片和视频素材接入现有原型，上传、校验、缩略图/封面、转码、私有签名、Range 播放、筛选/搜索、批删和保留期清理均已通过本地验证。
- 图片/视频功能源码 `6b4ce6a34a46b5bf48fa8f7ee37bf00022e16a36` 的远端 [Actions #39819264110](https://github.com/jasonlat-dot/atelier/actions/runs/39819264110) 已确认 completed/success，baseline 与 identity-schema 均通过。
- 用户实测 3196×1844 视频后台失败，已用同尺寸合成视频复现 x264 前瞻缓存导致的内存分配失败；保持 1 GiB、限时与线程上限，改用 zerolatency 编码限制缓存，不以扩大资源限额绕过问题。新增合成 `high-resolution.mp4` 回归；用户明确提供的实际视频经完整 VideoProcessor 探测、转码、二次探测和封面解码通过（3196×1844、约 12 秒），原文件哈希前后一致。实际用户媒体仅在忽略目录验证，不提交仓库。
- 修复后 Rust fmt/clippy/普通测试 51 项/workspace check、视频处理 4/4、真实认证与图片/视频浏览器 2/2、前端 typecheck/lint/format:check/build 通过；加上此前基础设施回归共 26 项。失败素材改为显示“未生成可用文件”，不再误显示 1 KB。旧失败源文件已按清理流程回收，用户重启开发服务后需重新上传；未改写业务素材或绑定数据。
- 实际视频的转码输出另经本机 Chrome 真实解码和第 10 秒 Range 跳转通过，无播放器错误。本次修复和 S3 范围调整随本次提交上传，继续跟进新 Actions；本地图片/视频交付范围已完成，不将未验收的 S3 算作已完成。
- 不自动进入 M4；不打包部署。

### 本轮停止与下次续接

- 负责人再次确认：本轮只做到 M3，整理文档后停止，下次再继续；当前不开发 M4。
- 最新功能修复提交 `38527476ba12fe4c4ee00998d71d1d1c9e139b6e` 已正常推送。其 [Actions #39821826331](https://github.com/jasonlat-dot/atelier/actions/runs/39821826331) 已触发，最后查询为 baseline 进行中、identity-schema 排队，尚未取得最终结论；不要将它写成已通过。上一功能提交的 Actions 已通过，见上。
- 下次先读取本文件、DECISIONS 与 Git 记录，核对以上远端检查，若失败先修复；再按负责人续接指令推进 M4 账号池与模型，继续沿用现有原型。S3 保持待定。

## M4 · 管理基础与出站安全（进行中）

- 负责人已授权完成 M4 后停止，不进入 M5。M3 修复提交 `3852747` 的 Actions #39821826331 已核对 completed/success。
- 新迁移 `202610230200_m4_upstream.sql`：账号池、模型、价格与倍率、账号绑定、路由租约、24 小时统计源。迁移约束测试先因缺列失败，补迁移后在隔离 PostgreSQL 通过。
- `crates/upstream/{crypto,egress,service,types,validation}.rs` 实现 XChaCha20-Poly1305 独立域密钥、账号 ID/版本绑定、全新随机 nonce；服务视图和审计不包含原密钥、地址或真实上游模型标识。配置事务带版本冲突检查，导入与审计整体回滚；启用模型须先配置价格与账号绑定。
- 出站每次解析 DNS 并固定已检查地址，拒绝私网/特殊地址、凭据 URL、重定向和环境代理；限制请求并发、响应体和时间，关闭传输层隐式重试。开发白名单仅为明确 loopback origin，无默认放行。
- 当前测试覆盖加密篡改/跨账号拒绝、IP/地址绕过、真实 HTTP 禁重定向/大小/时间上限、导入回滚、审计失败回滚、版本冲突、模型启用前置检查与价格原子性。HTTP 管理接口、原型页面、Provider 适配和 Redis 调度仍在后续切片，不标为已完成。
- 此基础切片本地 fmt/clippy/workspace test/check 通过（普通测试 55 项），真实 PG/Redis/视频与 M4 数据库合计 29 项通过；前端 typecheck/build 通过。cargo audit 扫描 339 依赖、1349 公告为 0 漏洞，npm audit 0 漏洞；没有豁免。尚无 HTTP 契约变化，现有 OpenAPI 保持不变。CI 已纳入 M4 隔离库回归。

## M4 · Provider、路由与管理 HTTP（进行中）

- `provider.rs` 实现图片 JSON generations、multipart edits、异步视频 JSON 提交/轮询/内容下载；图片 b64/受限 URL 下载，外部下载不携带密钥，结果仅为内部字节。仅固定错误分类进入统计，原始上游响应不回显或写日志。收到产出/视频 ID 后不重复提交，部分图片成功不换号。
- `slots.rs`/`runtime.rs` 实现 Redis 原子容量、PG 额度预占、优先级/权重调度、令牌栅栏、60 秒租约/20 秒续期、取消与 panic 释放、最多三次换号、固定错误状态与冷却恢复。到期重置只使用管理员明确的 quota_reset_at 并先探测，避免用连通性伪造余额。
- `app/upstream_http.rs` 与 main/config 接线账号 CRUD/JSON 导入/测试/手动额度/统计、模型/绑定/价格和普通用户脱敏目录；角色/MFA/同源/CSRF/限流与审计保持原规则。API/OpenAPI/TypeScript 同步；开发 loopback 白名单默认关闭，公开绑定或公开域名下拒绝启用。
- 真实假上游 HTTP + PG/Redis 回归通过：401/429/额度耗尽/5xx/超时/内容拒绝/参数错误、错误切换/停止、冷却和额度重置、部分结果、编辑图片、视频提交/轮询/下载、危险返回地址拒绝、下载不带密钥、100 并发槽限制、过期令牌、取消/panic、21 秒实际续期与三次尝试上限。管理 HTTP 验证权限、CSRF、MFA 过期、写入/读取脱敏、绑定/价格前置、版本冲突和公开目录通过。
- 原型管理页面尚未接通，M4 仍进行中，不进入 M5。

- 此后端切片 fmt/clippy/workspace test/check 通过（58 项普通测试）；M4 隔离回归 9 项通过（3 项数据库、5 项真实 HTTP/Redis 路由、1 项管理 HTTP）。cargo audit：1349 公告、339 依赖，0 漏洞；代理更新公告库后退出码 0。前端页面接线在下一切片验收。


## M4 · 原型管理页面与本地验收（2026-10-23）

- `apps/web/src/features/upstream/*` 接入既有工作台/表格/按钮风格；侧栏开放 `/admin/accounts` 与 `/admin/models`，旧 `/admin/providers` 跳转账号池。普通用户不能请求管理数据，MFA 过期走现有验证流程。
- 账号页提供搜索、50 条游标分页、每 15 秒可见页刷新、状态/冷却/并发/额度/24 小时概览，新增/编辑、JSON 整体导入、连通性测试、手动额度、详细统计、启停和软删。密钥、地址和真实模型标识不回填，关闭抽屉清除输入；风险操作采用自定义原生 dialog 样式，无 window.confirm。
- 模型页提供 image/video/chat 能力配置、明确账号/分组并集绑定、全局倍率和分档积分、价格矩阵、版本冲突提示、启停与配置顺序引导。新建默认关闭；切换目录/价格标签保留草稿，保存价格采用完整全局版本。用户目录仅返回公开别名与能力/价格。
- Rust fmt/clippy/workspace test/check 通过（58 项普通测试），全部真实隔离基础设施/转码回归 35/35；前端 typecheck/lint/format:check/test:mock/build、契约与代理/基线 4/4、Mock 浏览器 1/1、HTTP 页面 23/23、真实 PG/Redis + 合成 Google/MFA 浏览器 2/2 通过。
- 真实管理员浏览器覆盖账号新增/连接测试/刷新持久化/编辑不回填密钥、模型新增/分组绑定/价格/启用/刷新持久化、公开目录脱敏与钱包余额不变；实际 HTTP Provider 回归覆盖图片/编辑/异步视频、故障分类与容量释放。没有使用真实供应商凭据或发起付费生成。
- 1440 桌面与 320 手机截图人工核对，修正搜索框和小屏抽屉对齐；合成截图只存 Git 忽略的测试目录。依赖审计：cargo audit 1349 公告/339 依赖，npm audit，均 0 漏洞，无豁免。`scripts/api.ps1 -Action test-infrastructure` 已纳入素材及上游全部回归。
- 后端切片 `ddb984b` 的 [Actions #39831744042](https://github.com/jasonlat-dot/atelier/actions/runs/39831744042) 已核对 completed/success，两个 job 均通过；页面切片 `7f78f18` 的 [Actions #39833889184](https://github.com/jasonlat-dot/atelier/actions/runs/39833889184) 已核对 completed/success。详细配置、验收与停止点见 `PR_M4.md`。


### M4 收尾回归：本地错误不计入上游健康

- 复核发现无效参考图在 Provider 本地校验失败时，会被路由层误转为 UPSTREAM_ERROR；连续三次会把正常账号标为 COOLDOWN。先新增真实隔离库回归，确认旧实现实际返回 COOLDOWN 而非 ACTIVE。
- 路由仅对真正的 ProviderFailure 写健康/失败统计；本地参数、全局传输容量或存储异常直接返回原错误，由 RAII 释放账号/额度租约，不换号、不触发账号冷却。图片、视频和连接测试共用该边界。修复不新增 API、迁移或依赖，不进入 M5。

- 修复后完整 Rust fmt/clippy/workspace test/check、M4 隔离回归 9 项及真实 Google/MFA/配置浏览器 2/2 再次通过；仍使用合成身份和假上游，不操作业务账号。修复随独立提交推送，继续核对 Actions 后完成里程碑记录。


## M4 · 完成与本轮停止（2026-10-23）

- 最终功能修复提交 `9fa4b8b3485b50daace051f8860f67f214c3c4aa` 的 [Actions #39834923711](https://github.com/jasonlat-dot/atelier/actions/runs/39834923711) 已核对：baseline 与 identity-schema 均 completed/success。包含完整 Rust/前端/契约/Mock 与 HTTP 浏览器/真实 PG、Redis、媒体与认证管理浏览器/安全审计。页面切片 7f78f18 与后端切片 ddb984b 的 Actions 也已全部通过。
- M4 账号池、模型能力/绑定/价格、Provider 内部适配、Redis 租约路由、错误分类和恢复及原型管理页面均已完成。验收范围与配置顺序见 `PR_M4.md`，启动仍为根目录 `npm run dev`，本次需重启 API 应用 M4 迁移。
- 负责人要求的停止点已执行：本轮不继续 M5；S3 维持待定，无实服务验收声明。没有用户生成任务/报价/SSE/积分结算的生产入口，不把 Mock 功能算作真实可用功能。
- 收尾提交仅更新完成与续接记录，不再改功能。下次先读取本文件、DECISIONS 与 Git；如需继续，应取得新的阶段授权再按规格开发 M5。当前无已知失败检查或待补 M4 代码项。


## M5 · 报价、任务事务与取消基础（进行中）

- 负责人已要求继续 M5，覆盖 M4 停止点；沿用现有原型，S3 仍待定。M4 文档收尾 c67bc82 的 Actions #39837111921 已核实 completed/success。
- 新迁移 202610230300_m5_generation.sql：不可变任务输入/价格快照、终态保护、租约令牌、输出和只追加事件、内容规则/违规记录、待发布素材隔离。迁移测试先确认缺列失败，再补迁移通过。
- generation/service.rs、types.rs：服务端按质量/分辨率/编辑/视频秒数重算；目前订阅尚未实现，全部 FREE，遵守免费分辨率与并发设置。任务与 HOLD/事件同事务；同用户行锁串行幂等/并发上限，QUEUED/ROUTING 取消原子 RELEASE，运行中取消写标记。
- app/generation_http.rs 接线 quote、创建、列表/详情和取消；使用真实会话/MFA/同源/CSRF/Redis 限流，UUID 请求键，严格拒绝客户端价格和未知字段。引用必须为本人已发布且 READY 的图片；跨用户隐藏为 404。API/OpenAPI/生成 TS 同步。
- 新增隔离库回归包含 100 并发重复创建/取消、报价后价格变更重算、免费 4K 拒绝、活跃上限、余额不足回滚、终态/事件不可变、引用归属、黑名单/有资源限制的正则、事件失败连同预占回滚，以及 HTTP 权限和 MFA 过期。
- 本切片 worker、媒体结果发布、最终结算、SSE 和真实生成界面尚未接通，不标为 M5 完成。后续切片继续完成，不在当前阶段开放前端任务提交入口。
- fmt/clippy/workspace test/check 通过（59 项普通测试），M5 基础隔离测试 4 项通过；前端 typecheck/build、OpenAPI 契约通过。新增 regex 1.13.1 后 cargo audit 扫描 340 依赖/1349 公告，0 漏洞，无豁免。

- 基础切片全部隔离 PG/Redis/媒体回归共 39/39 通过（既有 35 + M5 数据库/迁移 3 + HTTP 1）；CI 与本地 infrastructure 入口均已纳入新模块。


## M5 · 持久 worker、媒体发布与结算（进行中）

- `generation/worker.rs` 实现 SKIP LOCKED 领取、四个有限 worker、60 秒任务租约/20 秒续约、30 秒回收、令牌栅栏、2 秒无容量重试/5 分钟上限、120/300 秒运行期限、持久三次尝试预算与取消优先终态事务。已接入 main 启动/退出，不依赖浏览器保持连接。
- 新迁移 `202610230400_m5_worker.sql` 保存派发身份、恢复尝试标记及上游额度使用收据；视频 ID 持久化后只查询原任务，取回重试按派发身份去重上游额度。提交期间崩溃且尚未保存视频 ID 时安全失败/释放，不冒险重复付费提交。
- `assets/generated.rs` 校验并重新编码生成图片/视频、登记全部存储对象；待发布素材不进入素材列表/详情/签名/删除。输出检查点可被新 worker 接管；最终发布、逐输出 SETTLE、余量 RELEASE、终态及事件在同一事务提交，发布审计失败整体回滚。
- 新增 6 项真实 PG/Redis/假上游回归已通过：重复投递单次执行与按张/部分结算，取消完成竞争，过期 worker 栅栏，发布失败后复用检查点，401 换号/策略拒绝/无容量/超时/坏媒体释放，视频接收后崩溃续取且额度只扣一次，21 秒实际续约及运行中取消释放。
- 基础切片 e7d7eaf 的 Actions #39881534276 两个作业均 completed/success。当前 worker 全量检查进行中；SSE 和原型生成/任务界面仍待后续切片，M5 不标完成。

- worker 切片 fmt/clippy/workspace test/check 通过（普通测试仍 59 项），完整隔离 PG/Redis/媒体/M5 回归 45/45 通过。无新版本依赖、无 API 契约变化；仍未开放生成前端，下一切片接 SSE 与原型任务界面。


## M5 · SSE 与连接边界（进行中）

- `generation/events.rs` 使用 PostgreSQL 只追加事件重放，LISTEN/NOTIFY 在提交后经 Redis Pub/Sub 跨实例唤醒；数据库仍为事实来源，丢失唤醒时每秒补查。每用户最多三个连接、实例最多 128 个，槽位租约随连接续期/关闭释放。
- `/events` 支持 Last-Event-ID 和 after 游标、只查询本人事件；流持续复核会话/账号/MFA，失效立即关闭。事件输出链接重新按本人素材授权签名，不公开上游信息。`/generation/limits` 提供当前等级/分辨率/活跃上限/视频能力。
- SSE HTTP 隔离回归（归属、重放、连接上限、未来游标、撤销会话断流）与真实 PG→Redis→实例唤醒回归均通过。fmt/clippy/workspace test/check（59 项普通测试）、前端 typecheck/build、OpenAPI/TS 契约通过。原型生成页面仍在下一切片，不标 M5 完成。


### CI 视频工具安装等待优化

负责人发现旧的无条件 apt-get update/install 等待超过 11 分钟。工作流改为先检查 ffmpeg、ffprobe、timeout、prlimit，已有工具直接运行真实测试；缺失才安装。软件源连接设 20 秒超时、一次重试，更新和安装各限三分钟，步骤限六分钟；工具缺失仍失败，不跳过视频回归。旧运行仍等待其实际结果，新工作流由后续推送验收。


- 025d572 的 Actions #39886802753 在 Azure Ubuntu 镜像下载阶段达到三分钟时限，退出 124，尚未进入代码测试。安装时限已修正为五分钟、步骤八分钟；换至 Ubuntu 官方 archive 镜像并强制 IPv4，保留签名校验/工具检查/全部视频测试，继续推送验证。此前 305383b、e062360 的 baseline 均成功，旧 identity-schema 仍未通过，不能记为全绿。


## M5 · 现有原型生成界面与完整本地验收

- `features/generation/*` 在现有工作台开放 `/generate`，首页和侧栏可进入；沿用现有字体、边栏、按钮、弹窗和面板风格。文字/参考图图片与视频生成、本人素材选择/上传、模型能力驱动参数、服务端防越级限额和报价、余额预占提示、部分/失败/取消状态、输出预览/下载/刷新、任务游标分页与复用参数均接真实接口。复用只填表，不自动付费提交。
- 模糊提交错误冻结草稿、保留 UUID 和原参数重试，双击只有一次提交。EventSource 订阅 job.updated，断线自动重连并每五秒查询，在线每十五秒刷新；任务/钱包查询是事实来源，签名链接可更新。账号/MFA 失效沿用已有登录验证流程。
- 真实浏览器夹具加入持久 worker、Redis/SSE 及假上游图片/视频接口，管理员通过 Google/MFA 和 M4 配置后实际生成图片、刷新持久化、查看素材，再创建视频模型并生成可播放 MP4，钱包 20→10→6，无真实付费调用。
- 新增 worker 回归验证：不同 worker 实例共享三次换号上限，第四个账号不被调用，释放只一次；视频提交已发出但返回 ID 前崩溃，回收后失败释放且不重新提交。
- 本地结果：Rust fmt/clippy/workspace test/check 通过（59 普通测试）；全部真实 PG/Redis/媒体回归 49/49；前端 typecheck/lint/format:check/test:mock/build、基线/代理 4/4、Mock 浏览器 1/1、HTTP 浏览器 29/29、真实认证与生成浏览器 2/2、OpenAPI/TS 契约均通过。桌面 1440 与手机 320 截图已核对，截图仅在忽略目录。cargo audit 1349 公告/340 依赖与 npm 官方 audit 均为零漏洞，无豁免；本地 npm 镜像无审计接口，显式改用官方审计服务。
- 用户已取消旧 305383b/e062360 的长时间安装运行，记录为取消，非成功。025d572 安装时限失败已被 178caee 官方换源修正；178caee 的工具安装、基础设施测试已通过，整体仍待最终状态。此页面切片继续推送与跟进远端，不提前标记 M5 完成。


## M5 · 完成与本轮停止（2026-10-23）

- 最终功能提交 `00ccdf7b1f897252add6b8b2ad45cca001d63bb8` 的 [Actions #39888171556](https://github.com/jasonlat-dot/atelier/actions/runs/39888171556) 已核对 completed/success，baseline 与 identity-schema 均成功。包含全部 M5 后端、界面、契约、基础设施/媒体/真实生成浏览器和安全审计。Azure 镜像下载卡点由 Ubuntu 官方换源修正，最新运行安装步骤通过。
- 旧运行按负责人指示取消，仅跟进最新代码，不重跑或把旧取消状态记为成功。最终提交包含此前基础、worker、SSE、CI 换源及原型生成页全部变更，因此以最终完整验收为准。
- M5 标记完成；当前真实入口 `/generate`，支持图片/参考图/视频生成、后台任务、事件/轮询、取消、按结果结算/释放、素材预览下载。重启根目录 npm run dev 应用迁移；供应商账号/模型配置顺序、限额与验收见 README 和 PR_M5.md。
- 收尾仅更新文档，不再变更功能；本轮停在 M5，不自动进入 M6。S3 仍待定，没有真实付费供应商/公网上线验收声明。下次先读 AGENTS、PROGRESS、DECISIONS 与 Git，再根据新的阶段授权继续。


## M5 收尾 · CI 镜像列表修复（2026-10-23）

- 文档提交 70833b0 的 Actions #39889215774：baseline 成功，identity-schema 在视频工具安装时退出 124。下载日志明确显示 `Get:1 file:/etc/apt/apt-mirrors.txt Mirrorlist`，随后仍从 azure.archive.ubuntu.com 下载；前一次只改 sources.list/ubuntu.sources，漏掉 GitHub runner 的镜像列表入口，单次通过未证明换源完整。该失败发生在业务测试之前，未回滚已通过验收的 M5 功能。
- `scripts/ci/prepare_apt_sources.py` 统一覆盖 sources.list、sources.list.d 的有效 list/sources 和 apt-mirrors*.txt，保留 Signed-By/包签名验证；残留未知 Azure 地址即失败。新增三项回归覆盖 mirror+file 入口、传统/其他源、幂等及未知地址失败。
- identity-schema 固定 Ubuntu 24.04，缓存下载的 .deb（不缓存 apt 索引和运行中 partial 目录），安装仍通过 apt 校验、运行完整视频/数据库回归。准备步骤检查所有实际镜像列表后才下载；不靠延长超时或跳过测试处理问题。
- 本切片仅 CI、准备脚本和相关测试/文档，M6 仍未开始。三项本地回归通过；最终以推送后最新 Actions 的完整结果为准。


### 上游账号支持 HTTP（负责人新要求）

- `upstream/egress.rs` 允许公网 HTTP/HTTPS 及端口，保存、导入和 Provider 共用该策略；FTP/file/gopher/WS 等仍拒绝，HTTP 与 HTTPS 均执行私网/元数据/凭据 URL/DNS/重定向边界校验。开发 loopback 精确白名单保持原样，无需新增开关。
- 管理表单明确提示两种协议，地址拒绝使用专门提示；一般参数错误不再误提示“必须 HTTPS”。README/API/环境样例与 DECISIONS 同步，本轮不涉及站点入口、OIDC、S3 或 M6。
- 新测试先确认公网 HTTP 被旧实现拒绝，再修改通过；数据库管理用例改用 HTTP 地址，浏览器实际输入 http://8.8.8.8:8080/v1 并断言发送值。Rust fmt/clippy/workspace test/check（普通测试新增一项，共 60）、上游隔离 PG/Redis 8 项和管理 HTTP 1 项、管理浏览器 6 项（HTTP 输入用例修改后单独再次通过）、前端 typecheck/lint/format:check/build 通过，无新依赖或迁移。
- CI 镜像列表修复 6178fa4 的视频工具准备在 36 秒内通过（之前 5 分钟超时），继续跟进最终提交的完整远端结果。


### 上游账号取消 IP 范围限制（负责人最终澄清）

- 最新要求为“localhost 也支持”“不要有 IP 限制”“合格 HTTP 地址即可”，覆盖上一条仅允许公网的范围。保存/导入只检查 HTTP/HTTPS 基础 URL 格式，不提前解析 DNS，不按 IP 范围过滤，不需要白名单。
- EgressPolicy::for_endpoint / SafeHttp::for_endpoint 为管理员配置的准确 origin 建立请求上下文；Provider 的连接测试、图片/编辑、视频提交/轮询/内容和同源结果下载均使用该上下文。其他临时结果 URL 不获得跨来源的内网访问权限。
- 新的管理 HTTP 测试去掉本地例外并使用 localhost，先确认旧代码 422（预期 201），修改后保存和连接通过。新增单元/数据库回归包含 localhost、IPv4/IPv6、内网、其他地址段和未解析域名；表单回归明确输入 http://localhost:3000/v1。
- 真实浏览器夹具同样去掉白名单并改用 localhost，上游账号配置、Google/MFA、图片生成、视频生成与钱包结算 2/2 通过。上游/生成隔离 PG、Redis、媒体回归通过（上游新增一项数据库测试）；Rust fmt/clippy/workspace test/check 与前端 typecheck/lint/format:check/build、账号页面 6/6 通过。普通 Rust 测试现为 61 项，完整基础设施总数现为 50。无新依赖、迁移或 M6 功能。
- CI 修复 6178fa4 的 Actions #39891890729 已全部通过；完整下载日志确认实际主机 archive.ubuntu.com、无 Azure 下载，并成功保存包缓存。后续以包含最终地址范围调整的新提交继续验收，不再把 f2e0ecd 的公网范围作为最终行为。


## M6 · 进行中（2026-10-23）

- [x] 新迁移 `202610230500_m6_canvas.sql`：项目、50 版历史、素材引用、创建幂等记录和任务所属项目/节点；不修改已发布迁移。
- [x] `canvas/src/{graph,service}.rs`：项目创建/列表/重命名/复制/软删除、If-Match 保存及历史恢复；500 节点/1000 连线/2 MiB、白名单节点数据、语义连线和 DAG 校验、素材归属、审计同事务。
- [x] `app/src/canvas_http.rs`：真实受保护 API 与 OpenAPI/生成类型；任务创建在钱包冻结前核对项目与生成节点，任务可按项目查询。
- [x] 第一切片本地真实 PostgreSQL：项目服务 3 项、项目 HTTP 1 项、生成服务 3 项、原生成 HTTP/SSE 2 项通过；包含并发版本冲突、归属拒绝、历史恢复、审计回滚与扣款前关联校验。全工作区普通测试、Rust clippy、前端 typecheck/lint/format/mock/build 通过。
- [ ] 现有画布三栏原型接真实项目、编辑/撤销/连线、自动保存/冲突处理、生成结果回流、导入导出及端到端验收。本阶段尚不能标记 M6 完成。


### M6 · 完整功能本地验收

- [x] `/canvas` 项目列表与首页最近项目：新建、重命名、复制、软删除、ZIP 导入；`/canvas/:id` 采用现有三栏原型。首次项目基础提交 `0bc3f86` 的 Actions #39898214495 两作业 completed/success。
- [x] 文字/图片/视频/生成节点、连线 DAG、上传/粘贴图片/素材库添加与拖拽、选择/锁定/复制剪贴/删除、50 步撤销重做、缩放平移/适应/100%/小地图、背景与视口持久化；小于 1024px 只读，中间宽度属性抽屉。
- [x] 模型能力驱动生成参数和服务端报价，生成前保存关联节点，沿用 M5 幂等/积分；任务 SSE + 轮询、结果网格连回、失败重试/取消、素材预览播放/下载/替换/继续生成及生成参数记录。
- [x] 自动保存、串行写、导航 flush、断网重试、409 载入/另存副本、跨标签通知、历史恢复；素材删除提示引用项目，失效素材保留节点占位。
- [x] ZIP 数据与真实媒体导入导出、安全上限、素材重新归属、重试幂等；限制与失败保留素材规则见 DECISIONS。支持当前协议首帧，尾帧协议扩展仍待定。
- [x] 本地 HTTP 浏览器 34/34，含画布 5 项与 500 节点可见区域渲染/帧率；Mock 浏览器 1/1。真实 PG/Redis 浏览器 2/2，管理员流程覆盖实际拖拽连接图片/文字、生成结果回流、视频播放、刷新、撤销重做、下载 ZIP 再导入及导入不扣费。
- [x] 全 Rust 普通测试、完整基础设施回归、全部 app HTTP 回归、clippy、接口契约、前端 typecheck/lint/format/mock/build 与基线隔离检查通过；新依赖 cargo audit（342 crates）与 npm audit 均 0 漏洞。
- [x] 最终功能 5c7257df78884ff1bd916da86b9472aaceb79888 的 Actions #39901276711 两作业 completed/success，M6 完成；按最新授权进入 M7。


## M7 · 后端基础进行中

- [x] `agent-core` 抽取 ShellPilot 的 UTF-8 预算、证据摘要校验与事实保留原则，三个无 SSH/文件/工具依赖的 trait；创意意图分类与基准 >=30 条，摘要保留原话事实。
- [x] 新迁移 `202610230700_m7_chat.sql`：本人会话、用户/助手消息、幂等回复、持久化状态与租约。真实 SSE 上游与接口，事件 delta/intent/action/done/error；失败/断连/取消释放预留，完成及消息/动作/审计/结算同事务。
- [x] 隔离数据库 4 项和 HTTP SSE 1 项通过，含重复结算、免费对话、跨账号隔离、断连与过期租约、12 轮压缩后继续保留名称与预算、动作卡不创建 generation job。
- [x] 后端切片 a12699d 的 Actions #39903985055 两作业 completed/success。前端已接真实接口，最终完整验收见下。


### M7 · 对话原型接线与最终验收进行中

- [x] `/chat/:id?` 真实历史/回复/上下文三栏，chat 模型选择、流式显示、复制代码/回复、显式重新生成、停止、列表/历史分页、重命名/删除、小屏抽屉。无模型显示配置指引，不提供假回复。
- [x] Markdown 清理及禁原始 HTML，外链 noopener，远程图片不自动请求；图像动作卡仅填入 M6 草稿，不创建任务、不扣生成积分。模糊提交保留请求键与正文核对，双击不重复发出，路由离开明确停止。
- [x] 新增终态及正文不可修改保护；删除后禁止旧键重放；登录撤销与完成审计失败释放、已完成取消不改写。隔离 Chat 数据库 5 项通过，37 条意图基准全部正确；12 轮压缩后继续保留 Blue Finch/1200 事实。
- [x] HTTP 浏览器 39/39（新增对话 5 项）、Mock 浏览器 1/1；Rust workspace fmt/clippy/test/check、接口契约、构建隔离/代理及 CI 换源测试通过；cargo audit（342 crates）与官方 npm audit 0 漏洞、无豁免。
- [x] 完整 PG/Redis/媒体及 app HTTP 均通过；真实 PG/Redis 浏览器 2/2，覆盖 chat 模型配置、SSE 回复保存扣 1、刷新、画布草稿不创建任务、停止、502 和无 DONE 截断均不扣费。没有实际付费供应商调用。
- [ ] 最终完整功能推送后等待 Actions；未核对前不标 M7 完成。


### M7 · 远端浏览器等待修正

完整功能 20a54b3 的 Actions #39905794003：baseline 成功，identity-schema 的 Rust/数据库/Redis/媒体/HTTP 均通过，最后真实浏览器失败。日志显示停止检查中的 view.turns 未定义；测试在“回复已保存”出现后立即从页面取 ID，尚未等待列表/钱包刷新后的路由跳转，快浏览器可能取到 /chat 而非 /chat/UUID。新增明确 UUID URL 等待，轮询同时检查 HTTP 成功；不放宽状态、余额或时限断言，不改生产逻辑。修复后重新本地与远端验收，M7 尚未标记完成。
