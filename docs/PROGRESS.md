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
- [x] M7：对话，后端、原型接线、本地与远端验收完成；最终功能 4af169f。
- [x] M8：套餐、人工支付与订阅，2026-10-23 完成本地验收并接入现有工作台。
- [x] M9：管理后台与个人用量，2026-10-23 完成本地验收并接入现有工作台。
- [ ] M10：加固上线，未开始。

**M0–M9 已完成，本轮到 M9 停止，不进入 M10。S3 与视频尾帧扩展仍待定。** 管理入口、权限、统计与验收见 [PR_M9](PR_M9.md)，人工收付款与已付款订阅周期见 [PR_M8](PR_M8.md)。本地检查后提交推送，不等待或轮询 Actions；远端结果由负责人查看并反馈。此前里程碑的 Actions 记录保留在下方历史章节。

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
- [x] 最终完整功能 4af169f 的 [Actions #39907015646](https://github.com/jasonlat-dot/atelier/actions/runs/39907015646) 两作业 completed/success，M7 完成。


### M7 · 远端浏览器等待修正

完整功能 20a54b3 的 Actions #39905794003：baseline 成功，identity-schema 的 Rust/数据库/Redis/媒体/HTTP 均通过，最后真实浏览器失败。日志显示停止检查中的 view.turns 未定义；测试在“回复已保存”出现后立即从页面取 ID，尚未等待列表/钱包刷新后的路由跳转，快浏览器可能取到 /chat 而非 /chat/UUID。新增明确 UUID URL 等待，轮询同时检查 HTTP 成功；不放宽状态、余额或时限断言，不改生产逻辑。当时 M7 未标记完成；修复后的本地与远端结果见下方完成记录。


## M7 · 完成与停止

- 最终完整功能 `4af169f5925ad0839d5eeb208e20b641e303512a` 的 [Actions #39907015646](https://github.com/jasonlat-dot/atelier/actions/runs/39907015646) 已核对 completed/success，baseline 与 identity-schema 均成功，包含完整真实浏览器流程。先前 20a54b3 的远端失败如实保留，已经 UUID 跳转等待修复并通过最新运行。
- M6 与 M7 标记完成；README、API、DECISIONS、PR_M6/PR_M7 与本进度记录说明配置、能力、验收和限制。收尾仅提交文档，不变更功能，不进入 M8。
- S3 实服务、视频尾帧协议扩展继续待定；没有供应商付费效果或正式上线声明。后续续接先读 AGENTS、PROGRESS、DECISIONS 与 Git，再根据新阶段授权推进。


## 2026-10-23 · M6 画布交互复审（新授权，不进入 M8）

负责人要求认真研究 basketikun/infinite-canvas，并根据操作截图继续优化现有画布。M6/M7 原功能验收记录保留，本轮是 M6 体验修订。参考固定到 9f2bd9f1b27c45fd1b8f5323072b07243f9e0fac，已阅读画布、工具栏、节点工具栏、连线、快捷键与手册，并用独立 Chrome 上下文观察公开演示；具体审计见 PR_CANVAS_UX.md。

- 底层切片：拖动/缩放尺寸预览不再逐帧序列化全图；一次手势只产生一个撤销记录。保存队列等待手势结束，旧请求响应不覆盖新拖动；导航 flush 会先提交最终位置。新增 4 项状态/保存回归，500 节点 200 帧预览无 JSON 序列化；加入 CI。
- 上述单元回归 4/4 通过，前端 typecheck/lint/mock 检查通过。此切片提交后跟进远端结果，尚不声明整轮交互完成。
- 界面切片进行中：收起侧栏、节点工具栏、底部工具提示、拖线创建、局部参数面板、细化校验与浏览器回归。不得把未验证细节标为完成。


### 画布交互修订 · 界面切片验收

- 底层切片 `32ef21a` 的 [Actions #39915310864](https://github.com/jasonlat-dot/atelier/actions/runs/39915310864) baseline、identity-schema 均 completed/success。
- 界面已补默认平移、文字双击编辑、就近节点工具栏、可见工具提示、曲线选取/断开、拖线创建带来源菜单、局部参数与固定提交区、图层搜索、选择与快捷键、模型能力明确提示。详情与文件位置见 PR_CANVAS_UX，README 已更新使用方法。
- 最新画布 Chrome 11/11，真实 PG/Redis Chrome 2/2、Mock 浏览器 1/1；Rust fmt/clippy/workspace test、前端 typecheck/lint/format/mock/build 通过。1040px 与 1600px 已实际截图检查。
- 停改代码后的完整 HTTP 浏览器 45/45（1.3 分钟）通过，包含此前热更新期间等待失败的 MFA 用例；没有修改认证逻辑。最终完整远端验收待界面切片推送后记录。


### 画布交互修订 · 空格临时平移补丁

界面切片 `8889e63` 已推送。在最终手势复查中，新用例先复现：按住空格从图片节点本体拖动，视口不移动（节点独立 draggable 覆盖全局开关）。节点缓存和 draggable 同时纳入 space 状态，防止误移动素材；释放空格恢复普通拖动。修复后画布 11/11、typecheck/lint/build 通过。新断言同时验证视口变化与图片位置保持 50，未放宽断言。最终远端结果待此补丁推送后核对。


### 画布交互修订 · 远端与响应式加固

- `7679aa72d93a95e06f15b6370692827ac54fdc98` 的 [Actions #39918528864](https://github.com/jasonlat-dot/atelier/actions/runs/39918528864) 已核对 completed/success，两作业全绿。
- 更早 `8889e63` 的 identity-schema 成功，但 baseline 的 45 项 HTTP 浏览器中 1 项失败：窗口由 1600×1000 缩至 1040×720，测试在 ResizeObserver 更新前读取旧面板位置，底部为 926，超过 720。后续相同断言曾通过，仍按该证据补强响应式边界。
- 浮动面板使用 CSS min/calc 按当前容器宽度及实际顶部位置限制剩余高度，在观察器下一帧更新之前也避免溢出；测试显式等待布局稳定，保留完整 1040/720 边界与提交按钮可见性断言，无延时 sleep 或放宽尺寸。
- 加固后画布 11/11、typecheck/lint/build/format 通过；此次小补丁提交后继续核对完整远端结果，不推进 M8。


## 画布交互修订 · 完成（2026-10-23）

- 最终功能提交 `51ae28bde18d712f109cf2eb64e7a89273d4f138` 已与 GitHub main 核对一致；[Actions #39922507132](https://github.com/jasonlat-dot/atelier/actions/runs/39922507132) completed/success，baseline 与 identity-schema 均成功。包含严格 1040px 面板边界、空格从节点表面平移、完整 45 项 HTTP 浏览器、真实 PG/Redis 浏览器及依赖审计检查。
- 底层手势/保存、节点就近操作、拖线菜单、浮动参数与固定报价提交、工具提示、图层搜索和模型能力提示已完成；使用方式见 README，完整验证与限制见 PR_CANVAS_UX。早期远端失败和修复过程保留在前述记录中。
- 本轮体验修订完成，收尾仅记录文档；不进入 M8。S3 与视频尾帧协议扩展继续待定。后续根据负责人实际使用反馈继续细化当前工作台。


## 2026-10-23 · 图片质量入口与提交方式调整

- 负责人反馈图片生成质量入口难找：将“低 / 中 / 高”从折叠的生成参数中移到模型下方，直接可选；显示后台配置的起步积分，未开放的档位置灰并说明需管理员配置，不伪造模型能力。节点摘要同步显示当前质量。
- 质量变化沿用真实服务端报价与原有 graph 字段保存；新浏览器回归验证中/高档报价分别更新、刷新保留高档、仅开放低档时高档不可选，且不创建生成任务。画布 12/12、typecheck/lint/format/build 通过。
- 负责人明确修改协作方式：本地检查通过后自行提交推送即可，由负责人查看 Actions，有错误再告知；不再轮询或等待 Actions。AGENTS 最新规则已同步。

### 同时修复已返回的依赖审计错误

停止旧轮询时已经收到文档提交 `2e90c36` 的审计失败；45 项 HTTP 浏览器与真实服务作业均通过，失败原因为 2026-10-23 新发布的 RUSTSEC-2026-0385。ctutils 0.4.3 的常数时间掩码和 32 位目标 u128 比较有问题；官方修复为 0.4.4，见 https://github.com/RustCrypto/utils/pull/1569。

锁文件唯一 ctutils 版本升级至 0.4.4，覆盖 digest（含数据库认证和 TOTP）与 universal-hash（含凭据加密）全部引入路径，无审计忽略或降级。更新官方公告库后扫描 342 依赖，cargo audit 与官方 npm audit 均 0 漏洞。Rust fmt/clippy/workspace 普通测试通过；安全升级后真实 PG/Redis 浏览器 2/2（49.7 秒）通过，包含登录、TOTP、加密凭据、真实生成与保存。质量入口与安全补丁分别提交后一起推送，不等待新的远端检查。


## M8 · 后端切片（进行中）

- 新增迁移 202610230900：套餐、订单快照、已付款订阅周期及钱包 FIFO 份额；手工确认到账、比例退款、周期发放和到期回收均复用 wallet，审计失败回滚。
- 新增 billing_http 的用户/管理员接口及 OpenAPI 类型；管理员确认需 MFA、CSRF、真实金额/币种与唯一收款凭证。普通用户只可读取及取消自己的待付款订单。
- 生成报价/任务创建实时读取有效订阅，限制分辨率与并发；新素材保留期取当前权益，已有素材不追溯修改。后台每日维护与请求同步共同推进已付款周期，没有自动扣款续订。
- 本地：Rust check/clippy 全工作区通过；wallet/assets/generation 真实 PG/Redis 回归 29 项通过，billing HTTP 权限/幂等回归 1 项通过。前端类型检查通过；页面与浏览器验收仍在开发，M8 尚未完成。
- 按负责人最新要求提交推送后不等待或轮询 Actions。


## M8 · 完成与交接（2026-10-23）

- 后端基础切片 `cbef0cd` 已推送；完成现有工作台的套餐、订单、当前权益、取消、管理员发布/下架、到账确认与比例退款接线。新订单保存原套餐快照，数据库保护原价/凭证/状态；订单按创建时间分页。
- 完整真实 PostgreSQL/Redis/媒体回归 62 项通过；钱包、素材、生成、画布、对话和 billing 的真实 app HTTP 回归 7 项通过。M8 覆盖重复收款一次入账、原价快照、退款/付款审计失败回滚、排期及结转、预占到期回收、跨用户隔离、到期降级、4K/并发和素材保留期。
- Chrome HTTP 前端 48 项、Mock 浏览器 1 项、真实 PG/Redis 浏览器 2 项通过；最终套餐/钱包交互 4 项再验通过。真实浏览器覆盖套餐创建→下单→到账→权益生效→重复确认→退款→FREE，未调用真实付费支付渠道。页面截图已核对。
- Rust fmt/clippy/test 全工作区、前端 typecheck/lint/format/build、OpenAPI 契约一致性、生产隔离/画布状态 7 项及 Mock 状态验证均通过；cargo audit 342 依赖、官方 npm audit 均零已知漏洞。
- README、API、DECISIONS、PR_M8 与本文件已更新。重启根目录 `npm run dev` 自动应用新增迁移；管理员先创建并上架套餐。入口：用户「积分与订阅」，管理员「套餐与订单」。没有默认商品或自动扣费续订。
- 本轮到 M8 停止，不自动进入 M9；不等 Actions。下次先读取本段及 PR_M8，再按负责人授权推进管理后台。S3、在线支付网关与视频尾帧协议仍待定。

- 最终补齐维护延迟保护：可结转的已付款周期积分在服务恢复后补发一次，不恢复已到期的订阅权益；不结转的整周期过期积分不补发。新增真实数据库回归，最终受影响钱包/素材/生成 34 项通过；本轮真实业务测试累计 63 项。

## M9 · 后端切片（进行中）

- 新增管理用户、任务取消/积分补偿、设置、内容规则、邀请码、运营统计和脱敏审计接口；全部写操作重新核对账号权限，绑定版本和处理说明，普通用户访问管理接口统一拒绝。
- 禁用账号立即撤销会话、取消排队任务并通知运行任务；保留最后一个有效超级管理员。违规达到阈值自动处置并留下待复核通知。手工任务补偿只追加一次积分流水，不恢复原订单现金退款份额。
- 真实 PostgreSQL/Redis 回归 52 项通过（admin 7、auth 7、chat 5、generation 27、wallet 6）；新增 app 管理 HTTP 权限/CSRF/撤权验收与原钱包 HTTP 验收均通过。Rust fmt/clippy/workspace test 与 OpenAPI 导出通过。
- 当前接入工作台页面中，M9 尚未完成。分阶段推送后不等待 Actions，不进入 M10。

## M9 · 完成与交接（2026-10-23）

- 后端切片 `bc7fc67` 已推送。现有工作台已接运营总览、用户详情与处置、任务监控/取消/一次积分补偿、平台设置、内容规则、邀请码和脱敏审计；普通用户用量分析已接本人真实汇总接口。具体入口和权限见 PR_M9、README、API。
- 用户变更有版本校验、原因和前后审计，撤权前后额外记录未撤销会话数。ADMIN 只能修改 USER；保留最后有效 SUPER_ADMIN。积分变更与任务补偿只通过 wallet，同事务记账与审计；补偿不恢复订单现金可退款份额。邀请码明文仅创建时返回一次，创建结果不明时明确指引先核对撤销，禁止直接重复创建。
- 全量真实 PostgreSQL/Redis/媒体业务回归 73 项通过（其中 admin 8 项），app 真实 HTTP 9 项通过。最终审计会话计数完善后，受影响 admin 数据库 8 项及 admin HTTP 1 项再验通过。覆盖撤权、并发最后管理员保护、审计故障回滚、任务取消/补偿幂等、违规自动处置、邀请码撤销、脱敏和本人用量隔离。
- Chrome HTTP 完整 56 项通过；管理页面按路由拆分加载后，管理与工作台 11 项再验通过。真实服务 Chrome 2 项通过，覆盖原登录/TOTP/生成/画布/对话/订阅与新增管理闭环；Mock Chrome 1 项通过。桌面与 390px 移动端实际截图检查，生产工作台主 chunk 拆分后低于 500kB，无新增打包警告。
- Rust fmt/clippy/workspace test、前端 typecheck/lint/format/mock/build、OpenAPI 契约一致性通过；生产隔离/画布/代理 Node 回归 8 项，APT 镜像脚本 3 项通过。cargo audit 342 依赖与官方 npm audit 均未发现已知漏洞，无审计忽略。
- 新迁移由根目录 `npm run dev` 重启自动应用，无需新增服务或密钥。管理员按侧栏入口操作，SUPER_ADMIN 才可见全站设置和审计。成本为当前配置单价的估算，未定价单独显示，不代表真实供应商账单。所有新表格有搜索、分页、空态和加载态，金融与破坏性操作使用现有自定义对话框。
- 文档已更新 PR_M9、README、API、DECISIONS、AGENTS 和本文件。本轮到 M9 停止，不自动进入 M10；S3、在线支付网关、视频尾帧仍待定。按负责人要求本地检查后提交推送，不轮询或等待 Actions；由负责人反馈远端错误。保留用户未跟踪的两张原型图片，不纳入提交。

## 2026-10-23 · 按工作台 HTML 参考调整 UI

- 负责人提供 `apps/web/public/ui-register/工作台-html/`，已读取 Main.dc.html 并对照「工作台@2x.png」。将首页与工作台外壳调整为暖灰背景、黑色选中导航、橙色点缀、248px 侧栏、创意输入栏、三列最近项目和双列积分/签到。保留真实用户、画布、积分和权限数据，不接入导出工具自带的 React/runtime。
- 首页描述通过路由 state 带入生成页供用户确认参数，不放入 URL，也不自动创建收费任务。首页显示最近两张画布，修订号与更新时间取真实接口；项目管理操作仍在「查看全部画布」中。签到条取服务端连续天数。
- 管理导航保留总览、用户、套餐三个常用入口，其他入口收在「更多」内；直接访问子页面会自动展开对应菜单，SUPER_ADMIN 专属入口仍按权限过滤。900px 以下使用可开合导航与单列卡片。
- typecheck、lint、format、mock 状态检查和生产构建通过；已发起的真实 PG/Redis Chrome 2 项完成并通过。桌面/390px 截图用于结构核对。负责人随后明确交互自行测试、改完提交即可，因此停止余下完整浏览器轮次，不声明本轮全量浏览器通过，不再继续交互验收。
- ESLint 仅新增排除设计工具导出的 `public/ui-register/**` 外部 runtime，应用源码照常完整检查。参考目录和此前两张用户图片保持原状、未纳入提交。此轮是现有工作台 UI 修订，不进入 M10，不等待 Actions。

## 2026-10-23 · AI 智能对话参考 UI 接入

- 根据负责人提供的 `public/ui-register/AI 智能对话-html/Chat.dc.html` 和「AI 智能对话@2x.png」，将现有对话页调整为暖灰/橙色主题、248px 历史侧栏、居中欢迎与建议入口、独立输入卡片、288px 智能上下文侧栏。对话桌面视图移除重复的工作台顶栏，手机仍保留导航入口；窄屏历史与上下文按原开关展开。
- 历史日期分组取真实更新时间，模型名称/积分价格/上下文窗口仍取服务接口，用量百分比由真实估算值计算；不复制参考中的演示会话、模型和余额。已有空会话也显示欢迎区，原流式发送、停止、原请求核对、重命名/删除、Markdown 和画布草稿处理保持。
- typecheck、lint、format 和生产构建通过。按负责人最新方式不继续浏览器交互验收，由负责人自行测试；提交推送后不等待 Actions。设计导出的 runtime 和参考素材保持原状、不纳入提交，此轮不进入 M10。

## 2026-10-23 · AI 智能对话细节优化

- 继续对照同一 HTML/PNG 参考，修正旧版 1181–1279px 响应式规则残留的固定定位，避免上下文侧栏脱离当前三栏网格。消息正文与输入卡片统一 720px 阅读宽度，补齐表格、代码块、历史加载/空态、长标题提示与窄屏图标说明。
- 输入框按内容自动增高（上限 160px），聚焦以整张输入卡片描边反馈，显示字符计数；建议入口填入后聚焦输入框，输入法组字期间不触发快捷发送。上下文窗口未知时不使用演示容量计算进度。
- 流式更新只在用户靠近底部时跟随；向上阅读时保留位置，提供“回到最新消息”入口。滚动限定在消息容器内，不再反复调用页面级平滑滚动。发送仍为显式动作，原收费、幂等核对与服务接口保持。
- 前端 typecheck、lint、format:check、生产构建和 git diff --check 通过；按负责人要求不运行浏览器交互验收，由负责人自行测试。仅提交应用源码与本记录，不纳入用户设计导出素材，不进入 M10，推送后不等待 Actions。

## 2026-10-23 · 修复 Actions #55 的认证测试定位冲突

- 已读取失败运行 #39976384615 的 identity-schema 日志：auth-live.spec.ts:207 使用全页 `getByRole('status')`，在上游连接结果与请求处理提示短暂同时出现时触发 strict mode violation。日志中的连接本身已成功；Rust、构建与另一条认证测试均通过。
- 将真实服务测试与相同场景的 HTTP 测试定位到对应账号的“连接正常”状态，不使用首个元素、固定等待、重试或跳过断言掩盖问题。
- 使用独立 18081 端口、现有隔离 PostgreSQL/Redis 与 Chrome 复验真实认证套件，2/2 通过（57.1 秒），包括完整管理员 TOTP、上游、生成、画布 ZIP、对话、订阅和管理闭环。未改业务权限或服务端协议，不等待新的 Actions。

## 2026-10-23 · 按无限画布 HTML 参考调整项目列表

- 参考 `public/ui-register/无限画布html/html/` 的 index.html、styles.css 与交互说明，更新 `/canvas` 项目列表：1480px 限宽、260px 起自适应卡片、4:3 预览、统一暖灰配色，将 ZIP 导入与新建画布集中在页头。卡片操作带文字，悬停/键盘聚焦显示，触屏常驻。
- 提供名称筛选、最近更新/名称/修订号排序和网格/列表视图；通过真实游标追加加载更多并按 ID 去重，明确数量和筛选针对已加载画布，不假设接口提供全库总数。保留新建、导入原键重试、复制和带版本校验的重命名/删除；删除继续使用现有确认弹窗。
- 预览仅在卡片进入可视区域附近后读取本人画布，以实际节点位置、尺寸与连线绘制 SVG 缩略图；缓存按用户、项目与修订号隔离，最多显示前 60 个节点并标明总数。空画布、读取中、读取失败分别显示，不生成演示节点，不修改画布内容。首页保留原来的两张最近画布展示。
- typecheck、lint、format:check、Mock 状态检查、生产构建和 diff 检查通过；包含新列表的最终生产构建再验同一真实认证套件 2/2（38.8 秒），含列表新建及 ZIP 导入链路。按负责人要求画布交互由本人测试，不运行完整画布浏览器套件；只针对其反馈的 Actions 失败复验认证套件。参考目录、两张用户图片及负责人修改的 .gitignore 不纳入提交，不进入 M10，不等待 Actions。

## 2026-10-24 · 按图片与视频生成 HTML 参考调整 UI

- 对照 `public/ui-register/图片与视频生成-html/Generate.dc.html` 与 PNG，将 `/generate` 改为参数（304px）/预览/记录（256px）三个独立白色卡片，20px 间距、暖灰背景、橙色点缀；1180px 以下按参考切为单列。调整标题、表单字号、44px 选择框、描述区、报价层级与 48px 提交按钮。
- 预览区使用独立圆角媒体区域，按实际素材宽高保持图片/视频比例；下载和复用参数入口统一样式。预占、已结算、已退回分别展示，数值继续取任务记录；未知报价与余额仍显示未知。历史记录按实际成功/失败/部分完成/取消状态区分颜色，当前项橙色选中，长列表可独立滚动。
- 连接提示在真实 SSE 建立后才显示绿色；建议描述只填入并聚焦，不自动提交。现有模型能力、参考图、实时报价、幂等原键核对、进度/取消、钱包刷新、分页和素材预览功能保持，未接入参考导出的 runtime 或演示数据。
- typecheck、lint、format:check、Mock 状态检查、生产构建与 git diff --check 通过。沿用负责人“交互自行测试”的方式，本轮不运行浏览器交互套件，提交推送后不等待 Actions。保留未提交的 .gitignore 与用户原型素材，不进入 M10。

## 2026-10-24 · 修复生成页宽屏预览过大

- 负责人截图指出实际图片按中栏宽度无限增高，预览及下方操作无法在窗口内看全。工作区从 1760px 收到 1440px 居中，预览容器按窗口高度计算并限制为 180–480px；图片绝对定位在固定边界内并使用 object-fit: contain，取消按原始比例撑开容器。横图、方图和竖图完整缩放，点击仍可打开原有大图预览。
- 低于 950px 高度的桌面压缩参数区间距和输入框高度，使生成按钮仍在首屏；修正结算卡片被旧 flex 选择器覆盖的问题，三项金额恢复等宽网格。
- 针对此次实际反馈新增只读布局回归，使用合成接口数据与真实横/方/竖比例图片，在 2473×1138、1440×900、390×844 共九种组合检查预览边界、页面无横向溢出，桌面额外检查预览/下载/复用和生成按钮在窗口内；Chrome 回归 1/1 通过，截图已核对，无真实生成任务。此次只验证反馈的布局问题，不运行完整交互套件。
- typecheck、lint、format:check、生产构建与 diff 检查通过，提交推送后不等待 Actions。保留用户未提交内容，不进入 M10。

## 2026-10-24 · 生成记录右键管理（按要求不提交）

- 负责人要求生成记录右键支持删除并适配当前 UI，明确本轮不提交。新增暖白底、细边框、圆角和轻阴影菜单：查看结果、复用参数、删除记录；删除项暗红色，说明仅移除记录、保留素材。提供悬停/触屏“更多”按钮、Shift+F10、方向键、Esc/外点/滚动关闭及窗口边缘避让。
- 删除使用现有自定义 dialog 确认，展示原描述与保留范围，提交中禁重复点击，失败保留记录并允许重试；删除当前记录后切换到其他结果或空态。运行中的记录禁用删除，并由后端再次校验终态。
- 新增迁移 202610240100 和 DELETE /generation/jobs/{id}/history：持久记录历史展示删除，不触碰不可变任务、媒体、画布引用或钱包流水；项目范围列表和按 ID/幂等核对仍可读取。本人/CSRF、幂等与首次审计同事务，审计故障回滚。OpenAPI、生成类型、API 与 DECISIONS 已同步。
- 真实隔离 PG 数据库 2 项通过（归属/终态/幂等/审计回滚/原任务及账本不变；画布关联与幂等重放保留），app PG/Redis HTTP 回归 1 项通过（含删除的 CSRF/越权/409/重复 204）。Chrome 合成接口菜单/删除/错误恢复 2 项及预览布局 1 项通过；截图已核对，无真实用户记录删除或生成调用。
- typecheck、lint、format:check、生产构建、受影响 Rust Clippy/fmt、OpenAPI 契约与生产隔离基线 3 项通过。默认开发二进制被占用时使用独立测试构建目录，未停止用户服务。测试仅迁移隔离库；本地使用需重启根目录 npm run dev 自动应用业务迁移。所有修改留在工作区，未提交、未推送，不进入 M10。

## 2026-10-24 · 修复 Actions #59 并提交生成记录管理

- 负责人授权修复最新失败并与未提交代码一起提交，覆盖上一段暂不提交约定。已读取 [Actions #59](https://github.com/jasonlat-dot/atelier/actions/runs/39984741210) 的 baseline 日志：HTTP 浏览器套件 58/59 通过，唯一失败为 chat.spec.ts 手机用例仍查找旧名称“智能上下文”，现有按钮可访问名称已明确为“展开智能上下文”。identity-schema 作业成功。
- 修正测试定位，并新增展开前、展开后、关闭后的 aria-expanded 断言；保留实际移动端布局、历史列表与无写请求检查。未增加超时、重试或跳过检查。
- 独立 Chrome/15173 端口完整 HTTP 套件 61/61（2.2 分钟）通过，覆盖修复用例、新增记录右键/删除两项与既有生成/画布/管理流程。Rust 工作区 fmt、Clippy 全目标与常规测试通过；前端 typecheck/lint/format:check/Mock 状态检查通过。生成记录的真实隔离 PG 2 项、PG/Redis HTTP 1 项、生产构建、契约和隔离基线已在同一功能源码验证，详见上一段。
- 将右键菜单、持久删除接口、新迁移、契约/测试/文档及现有设计导出目录的 .gitignore 排除配置合并提交；两张用户原型图片不纳入提交。不进入 M10，推送后不等待 Actions。业务迁移仍由根目录 npm run dev 重启自动应用。

## 2026-10-24 · 按我的素材库参考调整 UI

- 对照 `public/ui-register/我的素材库/我的素材库.html`、styles.css 及负责人截图，将 `/assets` 调整为 1480px 限宽、暖灰背景、页头上传规则和上传按钮、统一方形缩略图及 200px 起的自适应卡片。文件名省略并保留完整标题，来源圆点与日期分列，视频时长放在缩略图左下角；悬停/键盘聚焦显示选择及删除，触屏常驻，选中素材有描边。
- 分类和网格/列表按钮使用不换字的固定最小宽度，来源/排序选择器独立网格分配空间，避免参考中的竖排文字；工具栏按实际内容宽度分行，窄屏取消吸顶以免遮挡列表。新增可用的网格/列表切换与最近添加/名称/文件大小排序；排序仅作用于已加载记录，尚有下一页时明确显示范围，保留真实全库筛选、数量与加载更多，不编造分类总数。
- 上传规则读取现有 limits 接口，不再固定显示 30 天保留期，具体期限在素材预览中查看。补充 `/` 聚焦搜索、Esc/外点关闭规则、取消选择及无结果清除筛选；保持原 multipart 上传、拖拽、刷新签名预览、项目引用提醒和自定义删除确认。未导入设计导出脚本或演示素材，不增加后端接口或迁移。
- typecheck、lint、format:check、Mock 状态检查（62 个 TS/TSX 文件）与生产构建通过。构建在沙箱内因源文件 realpath 的 EPERM 失败，使用已授权的沙箱外构建复验成功。遵循负责人交互自行测试的约定，未运行浏览器交互套件，也未宣称视觉/交互验收通过。仅提交应用源码及交接文档，保留两张用户原型图片，不进入 M10，推送后不等待 Actions。

## 2026-10-24 · 去除缩略图操作的白色底块

- 按负责人红框反馈，去除素材选择框外层和删除按钮的白色底块及删除按钮边框；缩略图上改为半透明深色控件、白色图标，选中时显示勾选，删除悬停显示浅红反馈。保留 30px 点击区域、键盘焦点和触屏常驻；列表视图删除按钮使用透明背景与灰色图标适应白底行。
- 仅改 CSS，保留原操作和删除确认；格式检查、typecheck、lint 和生产构建通过。交互仍由负责人测试，不运行浏览器套件，不等待 Actions。

## 2026-10-24 · 按积分与订阅参考调整 UI（本地未提交）

- 对照 `public/ui-register/积分与订阅/积分与订阅.html` 和 styles.css，将 `/wallet` 调整为 1120px 居中、暖灰背景、统一页头与下划线导航；左侧独立流水卡片，右侧 340px 余额/签到/兑换卡片，窄屏将右栏提前并取消吸顶。首页原有积分/签到组件继续使用原布局。
- 近 7 天消耗读取已有 `/me/usage?days=7`，按真实 UTC 日统计展示柱图和总消费，包含生成与对话；失败显示未读取，不用当前分页估算全周。流水按服务端钱包时区分组，展开查看余额/预占原始变动、时间、编号和原因；新增全部/获得/消耗筛选，明确仅针对已加载记录，继续使用原服务端分页。预占显示为零余额变动并另列预占数，解除预占不显示为奖励。
- 签到奖励、连续天数、时区和状态均读取原钱包接口，七格进度不编造后续奖励；兑换保留输入原文和原幂等键重试。套餐和订单仅统一样式，保留真实上架商品、人工确认到账、订单创建/取消确认和退款说明，不接入参考演示数据或自动付款。流水及套餐面板按需加载，最终生产工作台主 chunk 约 492.18kB，无新增构建警告。
- typecheck、lint、format:check、Mock 状态检查（63 个 TS/TSX 文件）、生产构建和 diff 检查通过；对应钱包/真实认证测试的旧表格 cell 定位更新为可展开流水入口，未放宽可见性断言。遵循负责人交互自行测试的约定，未运行浏览器交互套件，不宣称实际交互已验收。
- 按最新指令所有代码与文档只保留本地，未提交、未推送，不触发或等待 Actions。保留用户两张未跟踪原型图片与设计导出目录，不进入 M10。

## 2026-10-24 · 修复签到 503、同步 UI 回归并合并提交

- 负责人随后报告签到 `/wallet/checkin` 返回 SERVICE_UNAVAILABLE。现有 PostgreSQL 日志明确显示 `wallet_credit_lots` 外键检查对账本执行 `FOR KEY SHARE` 时权限不足；在隔离库先执行真实启动权限策略后，新增用例稳定复现旧实现失败。此前测试未调用启动的 `restrict_ledger`，只在默认拥有者权限下通过，已补齐该覆盖缺口。
- 启动策略改为同事务撤销表级 UPDATE/DELETE/TRUNCATE，再只保留 `UPDATE(id)` 以满足外键行锁；金额列仍无更新权限，不可变触发器仍拒绝 `SET id=id`，外键继续拒绝无效引用。钱包错误日志只记录 SQLSTATE。无需表结构迁移，权限语义见 DECISIONS。
- 真实隔离 PG 钱包 7/7、PG/Redis 钱包 HTTP 1/1、受影响 Rust 全目标 Clippy、fmt 与工作区常规测试通过。覆盖实际启动权限下的注册赠送、签到/100 并发幂等、兑换/入账、外键完整性与不可变限制。当前业务库已仅修正同一角色的 id 列行锁权限，核验金额列/删除/清空仍被拒绝及两项不可变触发器仍启用；只读行锁验证成功，未补写签到、改余额或停止用户服务，可直接重试签到。
- 负责人同时报告 Actions 视频素材用例仍查找旧的合并元数据文案，并授权修复后一起提交。改为在同一视频卡内分别验证尺寸/大小与时长；保留等待服务端完成、处理失败不可预览和可删除的断言。保留负责人手动去掉生成页大标题的改动，给生成页补充可访问名称，相应页面就绪与菜单外点定位同步调整，不恢复视觉标题、不增加超时或跳过测试。

## 2026-10-24 · 全局操作反馈改为统一遮罩弹窗

- 按负责人明确要求，将积分/签到/兑换、素材上传/删除、生成、画布、对话、账号设置、上游管理、订单和管理后台的成功/错误结果改用共享 Feedback；移除原生 alert/confirm，操作确认也使用同一套白色卡片和黑色按钮。遮罩统一为 45% 黑色，状态以圆形图标区分，卡片 24px 圆角并适配手机；已有 MFA 错误处理和版本冲突恢复弹窗保留专用动作。
- 提示串行出现，不堆叠遮罩；支持 Esc、外点、自动聚焦、Tab 焦点约束和关闭后恢复焦点。关闭时清理操作结果，切换标签或离开页面不重新弹旧提示；新一次相同错误仍正常提示。报价错误保持提交禁用且关闭后可重试，邀请码创建不确定说明合并进同一个错误弹窗。加载/连接进度、历史结果详情和字段说明仍为页面内容。
- 实际服务回归发现错误内容含“查看积分”链接时，反馈宿主位于 Router 外会导致上下文错误，已改为路由内统一挂载并增加真实链接跳转回归；测试直接核验未崩溃、无扣款和正常进入积分页。画布报价只在防抖参数与当前模型一致后发出，避免初始化拿空模型报价产生瞬时错误并打断编辑。未使用全局自动关闭提示的测试钩子，各用例先核验提示再明确确认，保留原权限、幂等和积分断言。文字节点测试通过实际“编辑文字”入口进入编辑态，未增加超时或放宽断言。
- 新增源代码契约避免重新引入原生提示和页面操作结果横条，并将长期偏好记入 AGENTS 与 DECISIONS。保留原型导出目录与用户两张图片，不进入 M10；完成本地验证后合并提交推送，不等待 Actions。
- 最终源码 typecheck、lint、format:check、Mock 状态/权限与反馈契约检查、生产构建通过；主工作台 chunk 约 491.36kB，无新增依赖或构建警告。Chrome HTTP 全量 65/65 通过，最后的报价时序调整后画布 12/12 再验通过；Mock 浏览器 1/1 通过。桌面成功弹窗与手机错误弹窗已截图核对，覆盖灰色遮罩、圆角、状态颜色、焦点、关闭与再次报错。
- 真实隔离 PG/Redis 的 Chrome 长流程最终 2/2 通过，覆盖 Google 回调会话、TOTP、防重放、素材视频、画布生成/导出/导入、对话成功/停止/失败、人工订单到账/退款、用户管理、邀请和审计。后台相同成功文案关闭后清理拥有者状态，连续创建/撤销邀请仍会分别提示；受影响后台 8/8 再验通过。上述结果与签到权限修复、素材旧定位及积分 UI 一起合并提交，远端 Actions 交由负责人查看。

## 2026-10-24 · 按用量分析设计包重构个人统计 UI

- 对照 `public/ui-register/usage-analytics-design/prototype.html`、DESIGN_SPEC 和 tokens，重构 `/usage` 为 1240px 限宽页头、四项指标、浅桃色消费卡、鼠尾草绿每日柱图、质量/类型进度条和最近任务表格。保留公共导航和 90 天选项，补充原型的 14 天；小屏指标双列、图表单列，任务表在卡片内横向滚动，长描述/模型名省略保留完整标题。每日指标切换只重绘图表，时段和刷新继续请求真实接口。
- 补齐加载骨架、无数据状态和前往生成页入口，错误复用统一遮罩弹窗；未读取数据使用“—”，不冒充零值。独立 UsagePage.css/UsageVisuals 不改运营总览原有共享图表或页面，不引入依赖和演示数据。
- 为实现原型中的新增统计，扩展本人只读用量接口的上期总数、退回预占积分、类型分布及最近 10 条可见任务；实际数据口径见 DECISIONS。查询保持用户隔离、一致快照、UTC 边界与历史隐藏语义，无迁移、不修改余额或现有业务记录。同步 Rust OpenAPI 和 TypeScript 类型。运行中的旧后端需要重启加载新字段；前端兼容旧返回，新增统计暂显示不可用。
- 真实隔离 PG 管理模块 9/9、PG/Redis 管理 HTTP 1/1 通过，新增用例覆盖上期边界、本人/他人隔离、实际释放金额、最近 10 条上限和历史隐藏；工作区常规 Rust 测试、全目标 Clippy、fmt，以及前端 typecheck、lint、format:check、Mock 状态/反馈契约和生产构建通过，OpenAPI 契约核对通过。遵循交互由负责人测试的约定，本轮未运行浏览器交互套件，不宣称视觉/交互已验收。文档与源码一并提交推送，不等待 Actions，用户原型图片和设计目录不提交，不进入 M10。

## 2026-10-24 · 修复 Actions #64 的测试角色与前端时序问题

- 按负责人要求只读查看最新 [Actions #64](https://github.com/jasonlat-dot/atelier/actions/runs/40006142191)（4ce6263）的两个失败作业日志。identity-schema 失败为 `ledger_foreign_keys_work_after_runtime_restriction` 的 `!broad_update`；baseline 失败为报价重试和上游账号恢复/分页两个 HTTP 用例。没有将 Vite 未启动后端的代理提示当作失败根因。
- CI 原容器初始化账号为 PostgreSQL 超级用户，绕过权限撤销；改为 bootstrap SQL 创建独立普通测试角色/库，DATABASE_URL 指向该角色。保留原权限断言并显式拒绝用超级用户执行该回归。相同 SQL 已在现有本地 PostgreSQL 创建独立 CI 测试角色/库，核验所有绕过权限为 false、拥有测试库且可隔离建库；未改变业务库或业务角色。
- 报价重试曾把请求重试计数当成反馈事件，网络未返回时重新弹出旧错误并随旧状态清除而消失。去掉该错误事件键，新失败响应仍单独提示；增强原用例，用受控挂起响应证明等待时无旧弹窗、仍禁用提交，恢复后可通过弹窗重试且无付费任务写入。
- 上游账号空搜索的初始化 300ms 计时器会覆盖快速选择的第二页，本地重复复现 1/5 失败，再通过受控浏览器时钟稳定复现。现在仅实际搜索内容变化才安排查询/分页重置，保留原搜索防抖和分页。新增确定性回归，未改业务超时、跳过用例或放宽断言。
- 3 项受影响用例连续 5 轮共 15/15 通过，全量 Chrome HTTP 66/66 通过。使用同一 CI 普通角色执行真实数据库/Redis/媒体 76/76 与 app HTTP 10/10 通过；fmt、工作区全目标 Clippy、前端 typecheck/lint/format、Mock 状态/反馈契约、生产构建和静态基线 3/3 通过。修改与文档一起提交推送，不等待或轮询新一轮 Actions，保留用户原型图片，不进入新功能阶段。

## 2026-10-24 · 按账号设置设计包调整 UI

- 对照 `public/ui-register/account-settings-design/`，将 `/settings` 调整为 1200px 限宽、暖灰背景、个人资料/账号安全双列卡片及整行登录设备；窄屏卡片单列、设备信息可换行。按追加截图将“保存资料”放在个人资料卡片右上角，移除底部操作区，收紧头像、内边距和字段间距，不设固定卡片高度。仅保留到登录设备，未增加偏好、通知、数据隐私或删除账号区域。
- 资料展示真实显示名、邮箱和角色，保留服务端 100 字符上限，仅有效改动可保存；同步既有测试中的按钮定位。安全卡读取真实 Google 登录方式及 MFA 状态，不照搬原型中的演示头像上传、密码修改、解绑或验证开关；当前认证没有这些管理接口。设备按 User-Agent 简化为浏览器/系统，完整信息保留悬停标题，未识别时保留原文字；显示真实 IP、最近活动和当前设备标记，其他设备可撤销，全设备退出保留原明确确认及当前浏览器也退出的说明。
- 原资料保存、会话撤销/退出的 API、CSRF、认证过期处理与统一遮罩弹窗保持；无后端、迁移或依赖变更。TypeScript 检查（生产构建前置）、lint、format:check、Mock 状态/权限与全局反馈契约、生产构建及 diff 检查通过。按约定交互由负责人测试，本轮未运行浏览器交互套件，不宣称视觉或交互已验收。源码和文档一并提交推送，不等待 Actions，保留两张用户未跟踪原型图片，不进入 M10。

## 2026-10-24 · 按运营总览设计包调整管理员首页

- 对照 `public/ui-register/ops-overview-design/prototype.html` 与 tokens，将 `/admin` 调整为 1280px 限宽、暖灰背景与 Operations 页头；复核状态置顶，四项 KPI 中积分消费使用桃色突出，本期任务内嵌成功/失败比例与成功率。保留通知列表、用户深链、真实管理员权限和统一错误遮罩弹窗。待复核按通知项数表述，避免把通知条数当成独立账号数。
- 每日趋势改用鼠尾草绿柱图，可切任务量/积分消耗，支持键盘聚焦与悬停读数；质量分布使用正常文档流和 18px 行间距避免重叠。账号池按服务端状态汇总，增加真实总数/正常/非正常胶囊及并发进度条；成本和订单突出各币种实际金额，未提供金额用“—”，未估算单位与实际账单口径保留。运营行不强制等高，小屏改为两列指标及单列卡片，表格只在卡片内部滚动。
- 保持原 `/admin/dashboard?days=` 接口及统计语义，增加已有接口支持的 14 天选项并保留 90 天；未采纳参考中的假接口、示例数据或卡片独立失败假设。当前接口没有每日活跃历史和模型分布，本轮不绘制这两项；全平台当前进行中任务单独标注，不作为本期成败条的分子。成功率仅以成功（含部分完成）与失败为分母，其余任务以灰色余量表示，无结束任务时显示“—”。无后端、迁移或依赖变更。
- TypeScript 检查（生产构建前置）、lint、format:check、Mock 状态/权限与反馈契约、生产构建及 diff 检查通过；本轮遵循交互由负责人测试的约定，未运行浏览器套件或声称视觉/交互已验收。源码和交接文档提交推送后不等待 Actions，保留两张用户原型图片与设计导出，不进入 M10。

## 2026-10-24 · 运营总览卡片重排（本地未提交）

- 按截图将生成分布抽为独立组件，放入顶部指标区；注册用户/今日活跃各压缩为数字靠右的短卡，纵向合占一列，与任务、积分和生成分布一起展示。质量次数与百分比合并一行，保留独立进度条与足够行距，减少重复标题和留白。
- 每日趋势和账号池在左列连续排列，成本与订单上移到右列顶部，不再等待趋势行结束；小屏保留两列指标组和单列正文。仅移动展示组件及调整样式，不改接口、统计口径、权限或反馈弹窗。
- TypeScript 检查（构建前置）、lint、format:check、Mock 状态/权限与反馈契约、生产构建通过，交互仍由负责人测试。按本轮明确要求保留本地修改，不提交、不推送、不触发 Actions；用户原型图片仍保留。

- 负责人随后要求顶部卡片高度对齐：指标网格改为同排拉伸，左侧两张短卡等分列高，内容在各自短卡内居中；积分消费和生成分布随同排最高内容自动等高，不使用固定高度或截断文字。仅改 CSS，格式检查与 TypeScript/生产构建通过，保留本地未提交状态，视觉由负责人核对。

## 2026-10-24 · 按用户管理设计包调整 UI（本地未提交）

- 对照 `public/ui-register/user-management-design/prototype.html` 与 tokens，将 `/admin/users` 调整为 1280px 限宽、暖灰背景、状态胶囊、搜索/角色/本页排序栏及白色用户表格卡片。真实状态仅正常/已禁用；不凭当前页伪造全库人数或待复核人数。表格使用首字母头像、角色/状态徽标、突出可用积分并分列总额/预占、真实违规次数和最近登录；长昵称保留完整标题，分页显示本页实际人数，窄屏仅表格内部横向滚动。
- 搜索输入 300ms 防抖，保留原搜索按钮与回车，提交/重置/卸载清理待执行计时器；仅实际输入变化安排查询，输入未生效时禁用翻页，避免延迟搜索覆盖分页。角色和状态仍由服务端筛选；排序仅针对已返回的当前页并在界面明确说明，保留注册时间游标顺序作为默认值。不引入原型的假分页、批量接口或审计明细。
- 用户详情抽屉调整为 480px、45% 黑色遮罩，手机全屏；重新组织头像/身份、三项真实钱包数值、基础信息、违规概况和管理操作。IP 仅取真实最近有效会话，标明对应口径；任务、设备与积分流水继续读取原接口。管理弹窗统一暖灰字段、黑色主按钮与圆角，保留必填说明、CSRF、版本冲突、积分二次核对/不确定结果原幂等键重试、会话撤销与后台最后超级管理员保护，不直接改余额或本地模拟审计。
- TypeScript 检查（构建前置）、lint、format:check、Mock 状态/权限与全局反馈契约、生产构建通过；无后端、迁移或依赖变更。本轮未运行浏览器交互套件，视觉和交互由负责人测试。用户管理与此前运营总览修改均留在本地，不提交、不推送、不触发 Actions，用户原型图片保持未跟踪。

## 2026-10-24 · 根据更新后的用户详情参考继续优化（本地未提交）

- 重新读取更新后的设计包，将“查看用户”重构为桌面 560px/窄屏全屏抽屉；标题、身份/积分、页签与底部管理操作均不收缩，只有中间内容 `min-height:0; overflow-y:auto`，区块按内容展开，避免挤压重叠。四页签为概览、积分流水、登录设备、违规与审计；支持方向键/Home/End、Esc/外点关闭及原焦点恢复。列表分页人数提示仍仅保留一个实际当前页值，不冒充全库总数。
- 概览用户 ID 缩写并提供完整值标题/复制，复制成功或失败走统一弹窗。管理操作固定在底部；只有真实待复核状态才显示复核按钮。自己角色变更和自己/超级管理员的禁用按钮置灰并解释，原单用户写入、金额限制、CSRF、版本及幂等二次确认代码拆入独立 UserActionDialog，未改变后端角色写策略或直接改余额。
- 积分流水按真实任务 ID 聚合，默认 8 组并可继续加载，分类仅针对已加载记录；状态和净变动区分预占、部分结算、结算、释放及人工补偿，原始账本明细在展开项中核对。账本只读返回补充 ref_type/ref_id；任务补偿与原任务合组，跨页重复记录不重复计数，旧后端缺少关联时保持逐条而不猜测。详情只读返回补充 pending_review；无迁移、无新增依赖、未修改账本或业务记录，需重启现有后端加载新字段，本轮未停止用户服务。
- 登录设备与账号设置复用同一浏览器/系统解析，完整 UA 保留标题；仅查看本人并从原会话 API 确认后才显示“当前会话”，不按 IP/UA 猜测。违规与审计复用真实违规次数与超级管理员审计接口，按目标 users/wallet 精确过滤，支持继续加载；普通管理员不请求受限审计。
- 根据追加截图，用户详情与独立审计页均改为中文操作描述为主、编码为辅，补齐 MFA 验证/绑定、登录/注册/改名、管理及钱包事件，未知编码保留并显示“其他操作”。未使用原型 Toast、演示账号、批量写入或假审计。
- 新增流水聚合回归覆盖预占不扣余额、部分结算/释放/补偿、跨页去重、不同任务隔离与旧响应不猜测合并；真实普通 CI 角色隔离 PG 钱包 7/7、管理模块 9/9 通过，补充真实关联、钱包用户隔离及复核前后状态断言。受影响 wallet/admin/app 全目标 Clippy、fmt、OpenAPI/生成类型契约、前端 typecheck/lint/format、Mock 状态/反馈/聚合契约及生产构建通过。本轮未运行浏览器交互套件或声称视觉已验收，交互仍由负责人核对；全部修改继续保留本地，未提交、未推送、不等待 Actions。

## 2026-10-24 · 全局提示统一为本地 Tooltip 组件（本地未提交）

- 按 `public/ui-register/tooltip-component/` 实现共享 Tooltip.tsx/Tooltip.css/tooltipPosition.ts，根入口只挂载一个 TooltipHost，正式/Mock 共用，无新增依赖。支持纯文本与可选标题、默认 300ms 延迟、上下翻转、8px 贴边夹紧与箭头；移出、失焦、Esc、点击、滚动、缩放、窗口失焦和来源隐藏/卸载时清理，保留其他 aria-describedby。提示通过原生手动 popover 进入顶层并在弹窗内保持正确来源，不抢焦点，画布缩放不改变说明文字大小；hover:none 不显示，减少动态效果偏好关闭动画。
- 按负责人纠正后的全局范围替换，覆盖管理、账号设置、素材、生成、对话、积分、工作台和画布的原生 title 提示；同时移除旧图表、画布工具栏和端口自制提示节点/样式，SVG 读数改为同一宿主并保留可访问名称。禁用按钮用组件外层接收鼠标和焦点，保留原禁用行为和必要的布局类；静态说明补齐键盘聚焦。页面/弹窗组件实际标题不改为 Tooltip，操作反馈继续使用统一 Feedback 遮罩弹窗。
- 文档 `docs/UI_COMPONENTS.md` 给出 React 与 DOM/图表适配用法，AGENTS 记录所有后续提示复用同一组件；静态契约扫描 45 个入口，拒绝新增原生 HTML 悬停 title、第二宿主、局部 role=tooltip 或 disabled 元素直接接 data-tip。定位回归覆盖上下翻转、左右视口夹紧及箭头边界。
- typecheck、lint、format:check、Mock 状态/权限、反馈/流水聚合/Tooltip 契约、生产构建和 diff 检查通过。本轮为前端组件替换，未改后端、依赖或业务动作；未运行浏览器交互套件或声称视觉交互验收通过，交互由负责人测试。此前运营总览、用户管理及其只读接口修改全部继续保留，未提交、未推送、不触发或等待 Actions，用户原型图片未纳入提交。

## 2026-10-24 · 按 workbench-design 收紧工作台（本地未提交）

- 欢迎标题调整为 30px，创作框单行起步、随输入增高至 140px；空白描述禁用提交，Enter 带入真实生成页草稿，Shift+Enter 换行，中文输入法组词时不提交。补充三个示例提示词按钮，点击填入并聚焦，不创建付费任务。
- 三个入口改为横向短卡；下半区最近项目与积分签到按 2:1 并列，窄屏单列。桌面最近项目为小型虚线创建卡与最多三个实际项目，复用画布列表的真实节点示意预览、节点总数、更新时间和版本，未知节点数不伪造为零；版本、完整名称和时间使用共享 Tooltip。移动端项目两列，空项目改为简短说明，加载使用可减少动态效果的骨架。
- 首页余额与签到合成一张卡，保持 CSRF、重复点击锁、服务端余额刷新与实际时区；七段签到进度循环显示。错误和签到结果继续使用共享 Feedback 遮罩弹窗，不采用原型 Toast 或假接口。独立积分页布局与领取按钮名称保留，现有工作台测试同步新按钮名称和四列布局断言。
- typecheck、lint、format:check、Mock 状态/权限及 Feedback/流水/Tooltip 契约、生产构建通过；沙箱内 Vite realpath 遇 Windows EPERM 后，在获准环境完成构建。未运行浏览器交互套件或声称视觉验收完成，仍由负责人实际体验。保留此前所有未提交修改与原型素材；不提交、不推送、不触发或等待 Actions。

## 2026-10-24 · 全局 Select 通用组件（本地未提交）

- 按 `public/ui-register/compoment/select-component/` 建立本地 Select.tsx/Select.css/selectBehavior.ts，替换 15 个页面中的 34 处单选下拉，覆盖正式生成、画布、对话、素材筛选、模型/用户/任务/设置/套餐管理、运营及用量时段与 Mock 画布。统一暖白圆角、橙棕色聚焦环和选中对勾，不新增依赖或演示业务数据。
- 组件支持 options 或已有动态 option/optgroup、说明、分组、搜索、占位/清空、禁用、错误描边和两种尺寸；保留隐藏原生字段的表单提交、required 与原 change 事件，新增 onValueChange 便于后续使用。明确区分“请选择”占位与“全部来源/角色/状态”的真实空值筛选；可见触发器关联原有标签，隐藏字段不重复进入辅助技术树或焦点顺序，fieldset 禁用继续生效。
- 菜单通过 body/所属 dialog 下的手动 popover 进入顶层，避免 overflow 和 transform 裁剪，支持底部向上展开、8px 视口夹紧和内部滚动；方向键/Home/End/前缀文字跳转跳过禁用项，Esc 优先关闭菜单，Tab 保持页面焦点顺序，中文组词不误提交。点外部、外部滚动、失焦、缩放或触发器隐藏/位置/禁用变化时清理，仅同时展开一个菜单；提示继续复用 Tooltip，操作反馈沿用 Feedback。
- 调整移动端素材筛选、紧凑对话/画布选择与页面布局选择器；现有浏览器测试从 native selectOption/option 后代定位改为实际可见菜单，仍验证原模型能力和选项数量。新增源码约束，禁止组件外再写原生 select 或独立 combobox/listbox，并覆盖清空/筛选空值、禁用导航、名称/说明/分组搜索、前缀跳转和 320/390/1024/1440 视口定位回归。使用方式与后续复用规则写入 UI_COMPONENTS、AGENTS。
- typecheck、lint、format:check、Mock 状态/权限及 Feedback/流水/Tooltip/Select 契约、生产构建和 diff 检查通过。未运行浏览器交互套件，视觉与交互由负责人验收；本轮未改后端或业务权限，保留此前全部未提交修改及用户文件，不提交、不推送、不触发或等待 Actions。

## 2026-10-24 · 侧栏全部展开并按职责、权限分组（本地未提交）

- 移除“更多 N 项”的 details/summary、自动展开逻辑及旧样式，所有当前角色可访问的入口直接列出。管理功能分为运营管理（运营总览、用户管理、任务管理、内容与邀请）、财务管理（套餐与订单、积分管理）、生成服务（模型与定价、上游账号池）、系统管理（平台设置、审计日志）；创作空间与账户资产原入口保留。
- 核对前端 AdminAccess 与后端 RequireRole：平台设置和审计日志要求超级管理员，系统组仅对此角色显示，组头增加暖桃色“超级管理员”标记；普通管理员保持其余八个管理入口，普通用户没有管理组。分组配置同时用于侧栏与面包屑，不新增或放宽业务权限。
- 导航区显式 min-height:0、独立纵向滚动与滚动隔离，缩短组间距；底部积分/身份和手机抽屉关闭逻辑保留。现有工作台、管理员和真实认证测试去掉旧展开操作，改为断言入口直接可见及普通管理员无系统分组。
- typecheck、lint、format:check、Mock 状态/权限及共享组件契约、生产构建通过；未运行浏览器交互套件，仍由负责人实际核对。全部改动留在本地，未提交、未推送、不等待 Actions；保留此前工作区和用户文件。

## 2026-10-24 · 画布创作参数取消自动收起（本地未提交）

- 修复点击画布空白即关闭创作参数的问题，同时去掉选普通节点、图层选择、开始连线、适应视图及其快捷键、查看节点信息和成功提交生成后的自动关闭。参数由关闭按钮、顶部开关或 Esc 主动收起，选生成节点仍能打开；空白点击的取消选择、退出文字编辑和清理菜单行为保留，不改图数据保存或付费生成请求。
- 同步现有画布用例：空白点击后保持可见与展开状态，点击连线端口也保持可见；手动关闭与窄屏只读断言保留。类型检查（构建前置）、lint、format:check、Mock/共享组件契约和生产构建通过，未运行浏览器交互套件，仍由负责人实际验收。本轮不提交、不推送、不触发或等待 Actions，保留此前工作区修改。

## 2026-10-24 · 侧栏补齐管理员专属标记（本地未提交）

- 管理分组使用显式 requiredRole：运营、财务、生成服务标“管理员专属”（淡绿色），系统管理标“超级管理员专属”（暖桃色）。管理员只看到管理员分组，超级管理员看到两类；普通用户不显示任何管理分组及标记，个人和创作入口保持原样。仍由原页面与服务端校验权限。
- 更新现有工作台/管理员测试的标记及角色可见性断言；lint、format:check、Mock/共享组件契约、类型检查与生产构建通过。未运行浏览器交互套件，继续留待负责人验收；未提交、未推送。

## 2026-10-24 · 套餐与订单积分入口改为页内切换（本地未提交）

- 原“兑换码与积分调整”实际为指向 `/admin/credits` 的 Link，视觉却与页内标签一致，且目标页只支持人工积分调整。现改为准确的“积分调整”按钮，在 `/admin/plans` 内显示共享 AdminCreditAdjustment 表单，标题、面包屑与侧栏选中项仍停留在套餐与订单；独立积分管理继续复用相同表单。没有新增或伪造兑换码管理。
- 表单切换时保持挂载，保留草稿、忙碌锁与不确定结果重试键；原非零整数/UUID/原因校验、二次确认、CSRF、幂等提交、认证失效处理与反馈弹窗均保留。积分标签不显示无关的账务刷新按钮/加载行，卡片适配现有暖白圆角样式。
- 现有账务测试补齐路由不变、标签与侧栏激活状态和跨标签草稿保留断言。typecheck、lint、format:check、Mock/共享组件契约与生产构建通过，未运行浏览器交互套件，仍由负责人验收；未提交、未推送，保留此前工作区修改。

## 2026-10-24 · 积分入口归位并补齐真实兑换码管理（本地未提交）

- 按负责人纠正，移除套餐与订单的临时积分调整标签、内嵌表单及样式，该页仅管理套餐/订单。独立 `/admin/credits` 统一提供“积分调整”和“兑换码管理”页内切换，保持原人工调整的权限、二次确认与幂等行为；首次点击兑换码标签才读取兑换码记录。
- 代码核对发现兑换码后端早已有 POST/GET `/api/v1/admin/redeem-codes`，用户端 `/wallet/redeem` 与数据库并发/容量/过期回归也已存在，之前缺的是管理 UI。纠正 PR_M8/PR_M9 中声称已有完整兑换码页面的描述；本轮只接原接口和已生成类型，不增加后端写能力或迁移。
- 新后台支持 1–100 个批量生成、正整数积分、每码 1–10000 次使用、可选未来有效期；同一用户只能兑换同一码一次，保留服务端原规则。历史显示真实编号、积分、已用/可用次数、有效期、状态及创建时间，支持原接口游标分页与刷新，不伪造明文、撤销或全库总数。用户仍从“积分与订阅 → 积分账本”兑换。
- 完整码只在成功响应的当前结果弹窗内展示，支持复制/下载，不进入查询缓存、localStorage 或 sessionStorage，关闭后清理；历史服务端仅存哈希，不能恢复明文。创建接口没有幂等契约，前端同步锁防双击且不自动重发；网络/5xx 不确定结果提示核对列表并禁止在当前弹窗直接重试。权限失效、生成/读取错误与复制结果仍使用共享 Feedback，表单校验也经同一弹窗。
- 补充浏览器测试覆盖真实可见表单的参数/CSRF、客户端拒绝无效积分、防重复生成、成功明文清理和未知结果不重发，并将账务测试更新为无积分标签；本轮仅静态检查这些测试，未运行浏览器交互套件。typecheck、lint、format:check、Mock/共享组件契约、生产构建与 diff 检查通过。未实际生成或兑换任何真实兑换码，交互由负责人验收；未提交、未推送，保留此前工作区和用户文件。

## 2026-10-24 · 日期控件统一为本地 DatePicker（本地未提交）

- 按 `public/ui-register/compoment/datepicker-component/` 实现共享 DatePicker、样式与日期行为模块，不引入依赖或直接执行参考脚本。全局四处原生日期时间入口已替换：邀请码过期、兑换码过期、上游账号新增和额度调整的重置时间。后续日期/日期时间表单复用规则与用法已写入 UI_COMPONENTS 和 AGENTS。
- 保留本地 YYYY-MM-DD / YYYY-MM-DDTHH:mm 值、原 change 回调与 FormData 提交；UTC 转换仍在业务表单进行，额度时间未修改时继续保留服务端原始秒数。支持日期/日期时间、手输三种分隔格式、非法或越界输入还原、必填/禁用/只读、按天 min/max、清除和今天/此刻；未来有效期业务校验保持原样。
- 统一暖白输入、10px 圆角、橙棕聚焦与 14px 圆角面板。日历周一起始、固定六周、月份/年份导航、今天/选中/游标状态；日期时间支持时分滚动列，窄屏列下移，分钟默认精确到 1 分钟。支持键盘按天/周/月/年移动、中文组词保护、Esc/Tab 清理；面板进入原生 popover 顶层并挂在 body/所属 dialog，避免裁剪，支持底部上翻、视口夹紧和内部滚动。
- 新增源码契约防止页面恢复原生日期控件，回归非法日期、闰年、低年份、本地值往返、跨月夹紧、周一起始、边界日和 320/390/1024/1440 视口定位。typecheck、lint、format:check、Mock/全部共享组件契约、生产构建与 diff 检查通过；构建保留既有大分块提示。未运行浏览器交互套件或宣称视觉验收，仍由负责人实际测试；本轮未改后端、未提交、未推送或触发 Actions，保留此前工作区修改与用户文件。

## 2026-10-24 · 收敛全局悬停反馈并修复状态覆盖（本地未提交）

- 截图中的日期确认按钮变浅来自 CSS 优先级冲突：通用 `button:hover:not(:disabled)` 高于确认按钮及选中日/时间的背景规则。通用规则改为低优先级 :where，主按钮和已选项只轻微调整深色背景，保持白字对比；禁用按钮不应用该变化。
- 全局检索 hover、缩放、位移与选中态后，同步修复积分余额深色卡内白字按钮被普通浅色 hover 覆盖、生成类型已选标签被通用 hover 覆盖、素材卡选中边框被 hover 冲掉的问题；素材筛选 hover 限定到分类/视图按钮，避免影响嵌入的共享 Select。
- 增加共享浅/深悬停色与 140ms 颜色过渡变量，降低登录、MFA、Feedback、用户管理、账号设置、积分、用量和画布列表主按钮的变色幅度；减少动态效果时共享过渡为 0。移除工作台快捷入口的 hover 上浮和新增阴影，尺寸、位置与选中态保持稳定；焦点和危险操作的语义色保留。UI_COMPONENTS 与 AGENTS 已记录后续规范。
- lint、format:check、Mock/共享组件契约、包含类型检查的生产构建和 diff 检查通过，保留既有大分块提示。未新增交互测试或宣称浏览器视觉验收，交互仍由负责人测试；本轮仅样式与文档，不提交、不推送，不触发 Actions，保留此前全部工作区修改。

## 2026-10-24 · 悬停强度回调到中间档（本地未提交）

- 负责人反馈上一版变化过轻，共享深色 hover 改为 #36373e、浅色改为 #eeece6，140ms 过渡不变；日期确认/选中项、Feedback 和引用共享值的页面同步生效，保持深浅层级及前次层叠修复。MFA 蓝灰按钮同步增强，工作台快捷入口增加浅暖背景和更清楚的边框变化，不恢复位移或缩放。
- format:check、包含类型检查的生产构建和 diff 检查通过，构建仅保留既有大分块提示。仅 CSS 与文档调整，未运行浏览器交互套件，留待负责人体验；未提交、未推送，保留此前修改。

## 2026-10-24 · 积分管理按设计重构，兑换码列表支持复制（本地未提交）

- 按 `public/ui-register/credits-admin-design/` 调整页头、右上返回按钮和橙棕下划线页签，`?tab=codes` 支持刷新/链接；两页签首次访问后保持挂载，不因切换丢失草稿或提交锁。调账区为两栏卡片：共享 Select 真实搜索昵称/邮箱/UUID（250ms 防抖，显示 5 个结果），选中后显示身份、可用及预占；增加/扣减方向、正整数数量与快捷金额、预计余额、原因分类及至少 5 字补充说明。扣减不能占用预占，提交仍走确认弹窗、原管理员角色限制、CSRF 与同内容幂等重试，成功后从服务端重读余额，不自行加减不可变旧收据。
- 右栏新增受限只读 `/admin/credits/adjustments`，查询既有 WALLET_ADJUST 最近 5 条真实记录，显示用户、原因、操作人和增减金额；不开放其他审计事件/快照，完整审计入口仍只对超级管理员显示。Select 增加可选 onSearchChange、searchPlaceholder 和 emptyMessage，远程结果由页面查询，其他控件保留原本地搜索；API 与用法写入 UI_COMPONENTS。
- 兑换码卡片增加已加载范围的三项统计、状态胶囊/编号搜索、使用进度和剩余有效期 Tooltip；金额乘积使用 BigInt，无法精确解释的输入不伪造统计。生成弹窗保留批量发行、原 DatePicker 和未知结果不重发，增加最多发放积分预览。参考中的演示数据、Toast、停用/启用与未持久化备注不接入；所有操作反馈沿用统一 Feedback。
- 用户要求列表复制，新增 `202610241200_redeem_code_recovery.sql`：code_enc 可空，旧哈希不回填；新码用现有 MASTER_KEY 的兑换码专用域派生密钥、随机 nonce、码 ID/版本 AAD 做 XChaCha20-Poly1305 加密，仍以原哈希兑换。列表只返回 copyable 和元数据，按创建时间/ID 倒序稳定分页，避免新码被随机 UUID 排到历史页。POST `.../redeem-codes/{id}/copy` 经管理员/MFA/CSRF/限流校验，解密与原哈希核对、审计成功后返回；日志和普通列表均无完整码。浏览器直接写剪贴板、不进入 Query 缓存或持久化存储；不可写时用临时弹窗手动复制，关闭清理。历史仅哈希码禁用复制并说明，不改变已发旧码的兑换能力。
- 验证：加密随机性/错码 ID/错密钥/篡改单元 1 项、真实 PG 钱包 7 项、真实 PG/Redis HTTP 2 项通过，覆盖旧码兼容、跨页无重复、新发行排序、幂等调整摘要、账本权限/并发、管理员与 CSRF 拒绝、复制审计与无明文列表。Rust fmt、clippy all-targets、前端 typecheck/lint/format、Mock/共享组件契约、生产构建、OpenAPI/TypeScript 一致性和 diff 检查通过；复用项目本地 cargo-audit 与漏洞库审计 342 个锁定依赖，无报告漏洞，未新增依赖版本。生产构建保留既有大分块提示。
- 初次 HTTP 构建因运行中后端占用 atelier-app.exe 被阻，改用 target/credits-validation 独立构建目录完成回归，没有停止负责人服务。仅测试库应用迁移；业务后端需由负责人重启加载新迁移、接口与密钥配置，不需新增环境变量，重启后新发行码才可恢复。同步更新现有浏览器用例的用户选择/原因/URL、复制 CSRF 和瞬时明文断言，本轮未运行浏览器交互套件或宣称视觉验收。保留此前全部工作区修改与用户文件，未提交、未推送、不触发 Actions。

## 2026-10-24 · 积分调整确认弹窗分区排版（本地未提交）

- 将原先通过换行拼接、最终挤成居中文字的确认说明改为结构化 React 内容：用户姓名/邮箱与完整 ID 左对齐，增减金额独立强调，可用积分前后变化用箭头并排展示；调整原因和补充说明分别成行，操作不可直接撤销与余额口径另设底部说明。长说明保留换行并在区域内滚动，支持键盘聚焦；沿用统一 Feedback 的遮罩、标题、焦点与按钮行为。
- 仅调整前端展示，原请求内容、确认后提交、CSRF 与幂等行为保持。格式、lint、Mock/组件契约、包含类型检查的生产构建及 diff 检查通过，保留既有构建分块提示；未运行浏览器交互套件。未提交、未推送，保留此前工作区修改。

## 2026-10-24 · 任务管理参考样式与列表层级（本地未提交）

- 按 `public/ui-register/task-management-design/` 调整 `/admin/jobs` 页头、紧凑统计、搜索/状态分段及表格内部 UI；保持 AdminFrame 原 max-width、外边距与页面横向 padding，不采用参考中更窄的 1180px 内容宽度。六列在原整体宽度内按 25/17/15/15/11/17 分配，分别容纳任务模型、用户、状态、结算、创建时间与处置；表头 12px、正文 13px、模型 14px、辅助信息 10–12px，长编号/邮箱/模型名使用省略与共享 Tooltip。
- 现有 API 只有具体状态和每页至多 25 条，没有全站计数；顶部四卡明确为当前查询页，已完成包含部分完成，不伪造全库数字或合并查询。状态筛选改为具体状态分段按钮，保留排队/分配/生成/保存/成功/部分完成/取消/失败八个真实阶段与原搜索、用户限定、游标分页。进行中蓝、成功绿、取消灰、失败红、部分完成琥珀；状态旁保留真实进度/尝试次数、终态时间和错误编码。
- 行内突出实际结算，预占总额/已释放/已补偿降为次级信息；日期与时刻分行，任务 ID 支持复制与统一弹窗反馈，剪贴板不可用时在弹窗中提供完整编号手动复制。取消与补偿保留原权限、终态/结算/已补偿判断、确认与幂等请求，禁用原因使用共享 Tooltip，不采纳参考中的原生 title、Toast 或部分补偿假表单。取消/补偿业务接口与后端均未修改。
- 独立 AdminJobsPage.css 通过 AdminFrame 可选 className 作用于当前页面；按实际内容宽度收紧单元格，窄区转卡片，避免侧栏占宽时仍挤压桌面表格。手机卡片保留真实表格标题语义，补齐清空筛选、当前页数量与空态；刷新动画遵守减少动态效果。
- typecheck（生产构建前置）、lint、format:check、Mock/共享组件契约、生产构建与 diff 检查通过，保留既有大分块提示。未新增业务测试、未运行浏览器交互套件或宣称视觉验收，交互由负责人测试；未提交、未推送、不触发 Actions，保留此前工作区与用户文件。


## 2026-10-24 · 用户调整积分弹窗复用表单、任务状态移至卡片（本地未提交）

- 按负责人截图纠正两处理解：用户管理“调整积分”弹窗复用新 `CreditAdjustmentFields` 和 `CreditAdjustmentSummary`，与独立积分管理页保持增加/扣减、正整数数量、快捷金额、余额前后预览、原因分类和至少 5 字补充说明一致；确认内容继续分区展示身份、金额和说明。保留用户详情服务端单次额度、不可扣预占、二次核对、CSRF、金融幂等键及未知结果按原内容重试。共享样式独立加载，弹窗使用独立字段 ID、初始聚焦、620px 上限和视口内滚动；其他用户管理操作保持原流程。
- 任务顶部改为“全部任务”及八个具体状态的可点击卡片，带图标、数量、选中边框和 aria-pressed；移除原四项只读统计与下方状态按钮。大屏一行，内容变窄后分行；不改 AdminFrame 原整体宽度、列表六列比例或取消/补偿流程，卡片点击重置原游标。
- 原接口无法提供不同状态的完整数量，为避免筛选/翻页后其他卡片错误归零，只扩展只读 AdminJobPage.counts：应用 q/user_id，不应用 status/before，固定返回 ALL 和八种状态的真实数量（含零），计数与列表同一只读可重复读快照。无数据库迁移；旧后端无字段显示“—”，需负责人重启后端加载新响应，未擅自停止服务。同步 OpenAPI、生成类型及 API 文档。
- 真实隔离 PostgreSQL 管理回归 10 项、PG/Redis HTTP 1 项通过；新增用例验证全部八种状态、超过 25 条分页无重复、状态筛选不改计数、大小写搜索、按用户隔离与空结果真实零。原角色权限、预占/补偿并发、审计和最后超级管理员保护均通过。Rust fmt/clippy all-targets、前端类型/lint/format、Mock/共享组件契约、生产构建、OpenAPI 契约和 diff 检查通过；构建保留既有大分块提示，没有新增依赖。
- 更新现有用户管理与真实服务浏览器用例的共享原因/说明字段及二次确认断言，增加任务卡片筛选与独立计数的浏览器回归；本轮仅静态检查这些用例，未运行浏览器交互套件或宣称视觉验收，交互由负责人测试。保留此前全部工作区修改与用户文件，未提交、未推送、不触发 Actions。


## 2026-10-24 · 复制及同类轻量反馈改为共享 Toast（本地未提交）

- 按负责人最新截图，将“任务 ID 已复制”及全局同类轻量结果从遮罩分离：任务/用户 ID、回复与代码、验证器密钥、邀请码、兑换码复制统一 useToast；生成参数复用、画布草稿填入/连接/参考提示/ZIP 导出、本地设置撤销及显示名保存也改为 Toast。业务通道由调用点明确选择，不按“成功”等文案全局自动判断；积分、删除、安全/权限变更、业务错误、未知提交结果和风险确认继续保留 Feedback/专用弹窗，需展示完整内容的手动复制弹窗保留。
- 新共享 Toast/Toast.css 在 main 挂载单一宿主，暖白圆角、状态图标和关闭按钮，无遮罩/主动聚焦；成功和信息 4 秒、剪贴板错误 6 秒后移除，悬停或键盘聚焦暂停，遵循减少动态效果。相同来源重复替换重置计时，最多 3 条；页面来源卸载清理，异步返回不会向已卸载来源发布提示。原生 dialog 内归入当前 modal 的可访问子树并以非模态 popover 顶层显示，避免叠加遮罩；不包含密钥/完整码正文、不持久化、不改业务请求和权限。
- 清理旧画布 Feedback 上遗留的 toast-message 类及孤立样式；全局反馈契约增加一个 ToastHost 和禁止页面自建 Toast 宿主约束，原生 alert/confirm/自制横条禁令继续有效。UI_COMPONENTS、DECISIONS、AGENTS 已记录最新通道规则，覆盖此前笼统“全部遮罩”的约定。
- typecheck、lint、format、Mock/共享组件源码契约、生产构建与 diff 检查通过；保留既有大分块提示，无新增依赖或后端改动。同步现有浏览器用例的轻量反馈断言，并新增任务 ID 复制不抢焦点、自动消失/重复替换、详情弹窗内复制不加遮罩的回归用例；本轮未运行浏览器交互套件或宣称视觉验收，仍由负责人测试。保留此前全部工作区与用户文件，未提交、未推送、不触发 Actions。


## 2026-10-24 · 任务状态排序与原地用户详情（本地未提交）

- 顶部卡片调整为全部任务、已完成、已取消、已失败、部分完成、排队中、正在分配、生成中、正在保存，保留原真实状态查询与统计范围；失败卡片改称“已失败”，行内状态仍按已有编码映射。
- 任务行邮箱由路由 Link 改为按钮，在当前任务页复用真实 UserDetailsDrawer；不改 URL 或挂载用户列表，关闭后保留原搜索、状态、用户限定、分页与任务列表，并恢复触发按钮焦点。详情组件自行加载原用户样式，作为任务 AdminFrame 的同级组件放在 user-management 样式域，保持列表宽度/列比例和抽屉视觉；原权限、四页签及操作弹窗不变。用户操作成功时增加 adminJobs 查询失效，以同步禁用账号导致的任务变化。
- 邮箱旁增加 26px 复制图标、独立 aria-label 和共享 Tooltip；复制不打开抽屉，成功仅 Toast，剪贴板不可用时复用完整文本手动复制弹窗。长邮箱继续省略、图标保留空间，不扩大用户列。
- typecheck、lint、format、Mock/共享组件源码契约、生产构建与 diff 检查通过，保留既有构建分块提示，无后端/接口或依赖变更。更新状态卡片排序用例，补充复制与详情相互独立、当前 URL 不变、不加载用户列表、关闭后搜索/状态与焦点保留的浏览器回归；本轮未运行浏览器交互套件或宣称视觉验收，交互由负责人测试。保留此前全部工作区与用户文件，未提交、未推送、不触发 Actions。


## 2026-10-24 · Toast 按提供组件替换为通用实现（本地未提交）

- 参考 `public/ui-register/compoment/toast-component` 的 demo/CSS/设计说明，将现有共享 Toast 改为原生 React/TypeScript 实现，继续由 main 的一个 ToastHost 服务所有已有调用点。使用顶部居中默认位置、380px/14px 卡片、32px 方块状态图标、14px 标题和 13px 描述、28px 关闭按钮及底部 3px 倒计时，颜色/尺寸/阴影集中为 --tt-*；入场 240ms/退场 180ms，减少动态效果关闭动画。亮色随现有项目，显式 data-theme=dark 可换暗色令牌，不单独按系统偏好改 Toast 颜色。
- useToast 保留旧短调用，新增 show/五类快捷方法及 description、action、六种位置、closable、duration:0、句柄 update/dismiss、同来源 dismissAll、默认配置和 Promise 跟踪。成功/信息/警告默认 3 秒、错误 5 秒，加载常驻；带操作未指定时长至少 6 秒。底部位置按屏幕边缘堆叠，各位置有数量上限；重复复制去重，相同来源 id 更新且重置进度，不同来源同名 id 隔离。悬停/焦点/操作处理中暂停剩余计时与进度，更新取消旧退场计时，来源卸载静默清理；并发同文案 Promise 保持独立，关闭/卸载后的旧结果不复活提示。
- 沿用无罩、不主动聚焦、原生 modal 可访问子树与非模态 popover 顶层；error 为 alert，其余为 status。长提示（参数复用、画布草稿/连接、导出及剪贴板失败）拆为短标题与补充描述。原金融/安全/删除/服务错误和风险确认的 Feedback 边界、手动复制完整内容的弹窗保持；不执行原型随机演示、不接入 window.Toast/innerHTML 或演示中的假撤销，也没有将现有金融请求改为 Toast.promise。
- 新 toastStore 与确定性计时回归接入 test:mock，覆盖暂停/剩余时间续跑、常驻/加载更新、重复替换与 ID 隔离、最大堆叠/淘汰清理、取消旧退场和 Promise 成功/失败/并发/卸载生命周期；同步现有复制浏览器用例的默认位置与进度条断言。本轮仅静态检查浏览器用例，未运行浏览器交互套件或宣称视觉验收，交互仍由负责人测试。
- typecheck、lint、format、Mock/全部共享组件契约（含 Toast 行为）、生产构建与 diff 检查通过；保留既有大分块提示，无新增依赖、后端或接口变更。更新 UI_COMPONENTS 和 AGENTS，后续同类轻量反馈复用本地通用组件。保留此前工作区与用户参考文件，未提交、未推送、不触发 Actions。


## 2026-10-24 · 任务失败原因中文优先，合并提交当前工作区

- 按截图将任务列表的 10px 等宽错误码改为 12px 中文原因，允许自然换行并保留原列宽；CONTENT_POLICY 直接展示“内容未通过审核，请修改描述后重新生成。”，共享 Tooltip 中同时保留描述和原编码。失败但没有编码、未识别的新编码均显示中文通用说明，原码仍可辅助排查，不直出上游原始异常。
- 复用 generationApi.failures，补充 ACCOUNT_DISABLED 描述与安全的 failureDescription 回退；超时、中断、存储/服务/本地异常的原因文案只说明原因与下一步，不在共享错误说明中凭错误码断言退款完成，金额仍由真实结算/释放字段展示。生成页和画布已有中文映射，继续共用同一来源。
- 负责人最新明确要求将此前全部未提交代码一起提交到 GitHub，覆盖此前暂不提交约定。已核对 main 与 origin/main 起点一致、目标仍为 jasonlat-dot/atelier、提交作者为固定公开账号；忽略的环境配置、工具缓存、用户原型目录和参考图片不纳入提交，.gitignore 的已有修改保留并一并提交。
- 最终本地验证通过：前端 typecheck、lint、format、Mock/全部共享组件契约（含 Toast 状态/计时）、生产构建；Rust fmt/clippy all-targets；兑换码加密单元 1 项、真实隔离 PG 钱包/管理数据库 17 项、真实 PG/Redis 钱包/管理 HTTP 3 项，累计 21 项；OpenAPI/生成类型一致性与 diff 检查通过。复用本地 cargo-audit/漏洞库扫描 342 个锁定依赖，无报告漏洞。保留既有前端大分块提示，没有新增依赖版本。
- 本轮未运行浏览器交互套件，仍由负责人验收；不停止正在运行的后端，沿用独立 Rust 构建目录。包含此前新增后端字段、兑换码恢复迁移与接口，部署/本地服务重启后生效；S3/在线网关/M10 等待定范围不变。按授权提交推送后不等待 Actions，由负责人反馈远端错误后再修复。


## 2026-10-24 · 兑换码复制稳定性与启停/删除（本地未提交）

- 修正复制导致的表格变化：保留“复制”文本和固定按钮尺寸，加载图标只在当前码原位切换；逐码锁定，其他行不一起置灰，不刷新列表、不缓存明文。共享 Tooltip 和复制成功 Toast 保留，剪贴板不允许时仍可临时手动复制。移除页面旧版哈希说明，无可恢复内容的测试码只保留通用不可复制提示，没有修改测试业务数据或伪造完整码。
- 列表新增紧凑的停用/启用与删除按钮、已停用筛选/标签，颜色沿用暖灰、柔绿及危险红；先共享 Feedback 确认，结果也使用原弹窗。停用禁止后续兑换且可恢复启用，启用不改变有效期/剩余次数；删除从列表移除且不能恢复，既有兑换积分、账本和幂等收据保留。成功只以真实响应更新查询元数据，隐藏删除行时保留原分页边界与游标，未知结果不自动重发。
- 新迁移 202610241300_redeem_code_lifecycle.sql 增加 disabled_at/deleted_at/revision；PATCH/DELETE 真实管理员接口沿用 MFA、CSRF/Origin 与限流，revision 拒绝过时操作。启停、删除、兑换共用码行锁，状态变更与前后快照审计同事务；已删除码不再列表/读取，旧兑换请求重放仍返回既有不可变收据。增加中文审计标签，OpenAPI、生成类型和 API 文档同步；没有新增依赖。
- 真实隔离 PostgreSQL 钱包数据库 9 项、PG/Redis 钱包 HTTP 3 项通过（累计 12 项），覆盖停用/启用/删除、钱包与收据保持、删除游标、过时版本、审计失败回滚、20 路兑换与停用竞争、ADMIN/MFA/CSRF。Rust fmt/clippy all-targets、前端 typecheck/lint/format、Mock/共享组件契约、生产构建、OpenAPI 契约与 diff 检查通过；生产构建保留既有分块大小提示。
- 浏览器回归新增延迟复制时 DOM/列宽稳定、其他行可复制且无额外列表读取、确认取消不写、启停/删除版本与元数据同步；本轮仅静态检查这些用例，未执行浏览器交互套件，交互由负责人测试。当前正在运行的后端未停止，重启后自动应用迁移并加载新接口，前端刷新后显示管理操作。负责人最新要求改完先别提交，全部保留本地，未提交、未推送、不触发 Actions，不进入 M10。


## 2026-10-24 · Actions #68 浏览器回归失败修复（本地未提交）

- 按负责人要求只读核对最新 Actions #68（40076358559，head 3d24f8c）：baseline 的 HTTP e2e 有 3 项失败，identity-schema 的 auth-live 管理员链路另有 1 项超时。已取得两个失败作业的完整日志；未重新运行或轮询远端工作流，也未提交/推送。
- 本地完整 HTTP e2e 初次实际复现远端的上游抽屉焦点、积分原因 Select 消失、工作台旧“用户 UUID”定位三项，并发现上一轮新增的复制 DOM 稳定断言失败。根因之一是 Tooltip 在 disabled/loading 或说明有无变化时切换“按钮本体/外包 span”树形结构，导致按钮重建、复制闪动和返回焦点失效；现原生交互控件始终使用同一外层 span，可用时 display:contents 保持布局，禁用说明时仅改变触发语义，按钮节点不重建。原焦点断言及复制节点身份/列宽/其他行可用断言均保留并通过。
- Select 对所有外部滚动立即关闭，浏览器将控件滚入视口或更新异步内容时可能在点击选项前移走菜单。现沿用同一个菜单，外部滚动/锚点可见位移时重新定位，0.5px 以下变化忽略，位置相同不重复发布状态；菜单内部滚动不关闭，点外部/Esc/失焦/隐藏/禁用/移出视口仍关闭。真实金融原因选择、二次确认和同键重试用例不放宽。工作台用例改为真实“用户”combobox 和积分字段，补齐只读用户/最近调整 fixture，增加没有错误遮罩断言。
- 真实 PG/Redis auth-live 实际复现拖线/视频预览被持续展开的画布参数栏遮挡。新用户约定是不自动收起，测试现明确断言展开、主动点击收起并断言 aria-expanded=false，再操作端口/视频；保留真实节点连接、生成、媒体播放和账本断言，不改产品自动收起行为，不使用 force。auth 单动作上限设 30 秒（原全局 120 秒内无单动作上限），避免超时缺乏具体动作信息，未提高测试超时。
- 最终验证：完整 HTTP e2e 72/72、隔离 PG/Redis 真实登录及完整 M4–M9 业务浏览器 2/2、Mock 浏览器基线 1/1，通过；工作台 fixture 最后修订另复验 4/4。前端 typecheck/lint/format、Mock/共享组件源码契约、生产构建与 diff 检查通过，构建仅保留既有分块提示。浏览器为本机 Chrome，使用独立 15173/18080/5176 端口和 Rust 构建目录，不停止当前业务服务。
- HTTP/auth Playwright 配置增加失败才保留 trace/截图，CI 两个作业增加失败诊断附件上传（7 天保留）；本地失败 trace 已能显示具体被遮挡元素。UI_COMPONENTS 和 AGENTS 更新稳定节点/锚点行为及以后共享组件改动必须实际跑受影响浏览器回归的要求。负责人最新“改完先别提交代码”继续有效：所有本轮与上一轮兑换码修改保留工作区，未提交、未推送、不触发 Actions。


## 2026-10-24 · 负责人授权提交当前修复

- 负责人明确要求提交，覆盖前面本地未提交状态。当前兑换码生命周期、复制稳定性、Tooltip/Select 及 Actions #68 修复一并提交；沿用已通过的真实数据库/HTTP、完整 72 项 HTTP 浏览器、2 项真实业务浏览器与 1 项 Mock 浏览器结果，没有新增业务代码修改。已核对 main、可信 GitHub origin 和固定公开作者，忽略配置/工具/原型文件不纳入提交。正常推送，不强推，不等待 Actions。


## 2026-10-24 · 内容与邀请参考 UI、复制按钮稳定和本地测试订单

- 按负责人 content-invites-design 调整 `/admin/policy`：暖色底、下划线页签和本页计数、带搜索图标的紧凑工具栏、规则类型分段、信息说明、等宽匹配内容/类型标签、状态开关、轻量行内编辑/删除操作及整合分页。两个页签保留各自搜索/类型/游标状态，支持方向键和 Home/End；隐藏页签不主动请求或弹出错误。邀请码展示真实使用进度、有效期/创建日期、可使用/已用尽/过期/撤销状态，弹窗使用共享 DatePicker、7/30/90 天和长期有效快捷值，以及一次性完整码保存区域。
- 规则状态开关打开专用确认表单，必须填写说明后才复用原带 revision、CSRF 和服务端审计的更新接口，取消不修改开关；沿用共享 Feedback 操作结果和 Toast 复制反馈。规则/邀请提交增加同步锁避免同帧重复提交。没有采纳参考的模拟命中次数、规则备注、浏览器 JS 正则测试或可恢复邀请码停用；当前 Rust 接口没有命中统计，邀请码撤销不可恢复，不能显示虚假指标或启用按钮。类型筛选与计数明确仅当前搜索本页，不伪造总页数/全库数量，不调整既有后台权限。
- 兑换码复制在原 DOM 稳定修复上，移除瞬间 disabled 置灰和 Copy/Loader 图标交换；原位保留 Copy、文字、尺寸和 hover，进行中用 aria-busy/aria-disabled 配合同一码请求锁，其他行不受影响。延迟请求回归明确断言按钮和 SVG 身份、颜色/透明度/列宽均保持，键盘重复触发不增加请求、列表不额外读取、明文不写查询缓存或存储。
- 实际验证：全部 HTTP e2e 74/74、真实隔离 PG/Redis 登录及完整业务浏览器 2/2 通过；前端 typecheck/lint/format、Mock/共享组件源码契约与生产构建通过，既有分块提示保留。已检查规则/邀请桌面、手机空状态和邀请码弹窗截图，手机表格独立横向滚动，空状态不因表格最小宽度被挤出可见区域；未改后端业务接口/迁移或依赖。
- 负责人追加要求在 UI 完成后插入一条本地测试订单：已只读核对当前业务库账号和既有“测试”套餐，再通过现有 BillingService.create_order 以固定请求键创建一条人民币 1 元 PENDING 待付款订单，复验同键返回同一订单、唯一 ORDER_CREATED 审计，钱包余额/预占/账本未变、未生成订阅或发放权益。没有手工插入虚假已付款状态或新增套餐，未停止业务服务；订单定位回执仅保存在 Git 忽略的 .tools，临时执行程序已移除，不将业务身份/订单数据或连接配置提交到 Git。
