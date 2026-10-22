# Atelier 里程碑进度

依据：根目录《Atelier AI 创作平台 · 产品与工程开发规格书（AI 开发版）》第 0、3、8、10 章。

- [x] 原始工程保全：`c3384c5`，仅为原型快照。
- [x] M0：基线整理，`b3cc451`；历史验收见 `PR_M0.md`。
- [x] M1：认证与权限，2026-10-22 完成代码与自动化验收；功能提交 `d8872b9`，浏览器夹具修正 `1683788`。
- [x] M2：积分账本与签到，`19d3ef2`，2026-10-22 完成本地与远端 Actions 验收。
- [ ] M3：素材与存储，未开始。
- [ ] M4：账号池与模型，未开始。
- [ ] M5：生成流水线，未开始。
- [ ] M6：画布工作台，未开始。
- [ ] M7：对话，未开始。
- [ ] M8：订阅与支付，未开始。
- [ ] M9：管理后台，未开始。
- [ ] M10：加固上线，未开始。

**用户最新要求继续 M2，完成后停在 M2，不进入 M3。** 已部署的 WSL PG/Redis 迁移与真实回归已补齐；实际域名和 Google 实账号仍待部署回归，自动化通过不代表已上线。

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
