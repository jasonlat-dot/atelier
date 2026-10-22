# M2 · 积分账本与签到

M1 登录后的用户现在能查看真实积分、每日签到、兑换积分和分页读取账本；管理员完成 MFA 后可按原因加减积分。注册赠送与身份、会话、审计在同一事务提交；重试不会重复赠送、兑换或调账。

## 范围与实现

- 迁移 `202610220400_m2_wallet.sql`：钱包约束、不可修改账本、签到、哈希兑换码与幂等收据。旧 M1 用户补空钱包，注册奖励不追溯。
- `wallet/src/service.rs` 是余额修改的唯一入口；`postgres.rs` 访问 SQL。行锁保护余额，job 引用保护预占归属，账本核对幂等参数；提供与未来业务共享事务的接口。
- 签到日界按数据库设置时区计算，默认上海；奖励 10 + min(连续天数 - 1, 10)。Redis 限流 10 次/分钟/用户，故障不发奖励。
- 管理员调账要求 MFA、CSRF、原因和 UUID 请求键。调账与审计原子提交；负数不能扣减已预占额度。
- 兑换码 CSPRNG 256 位，仅存哈希；行锁保证 max_uses，用户唯一领取。同请求键重放返回首次收据，内容不同返回 422。
- `/` 工作台签到、`/wallet` 余额/兑换/流水、`/admin/credits` 调账，沿用现有账号页样式。断线重试保留幂等键。
- 启动和每 24 小时对账 balance / held 与账本总和，不一致输出明确错误事件；完整外部监控属 M10。

## 真实环境与使用

用户现有 WSL PostgreSQL 16（15432）、Redis 7（16380）均已连接。`atelier` 业务库已完成 M0–M2 迁移；`atelier_test` 使用独立有 CREATEDB 权限的测试角色，Redis 测试逻辑库为 15，不清空实例数据。连接凭据仅在本机忽略文件 `.env` / `.env.test.local`，不进入提交。

从仓库根目录运行：

```powershell
./scripts/api.ps1 -Action infrastructure
./scripts/api.ps1 -Action test-infrastructure
# 已安装 Chrome 时可指定；CI 安装 Playwright Chromium。
$env:PLAYWRIGHT_CHANNEL = 'chrome'
./scripts/api.ps1 -Action test-browser
# 在 services/api/.env 或当前进程补齐 Google 与 MASTER_KEY 后启动：
./scripts/api.ps1 -Action run
```

Google 实账号仍需真实 OAuth 配置、持久保存的随机 MASTER_KEY、Bootstrap 邮箱与实际域名回归。自动化使用独立合成签名提供方，没有开发登录开关。浏览器夹具使用 SQLx 随机测试库，不修改业务库。

## 本地验证（2026-10-22）

| 检查 | 结果 |
| --- | --- |
| Rust fmt / clippy -D warnings / check | 通过 |
| cargo test --locked --workspace | 44 项通过；18 项基础设施及 1 个浏览器服务夹具显式忽略，另行执行 |
| 真实 PG/Redis 身份回归 | 11/11 通过 |
| 钱包数据库回归 | 6/6 通过：100 并发同键预占和结算；100 并发签到与兑换；兑换容量/过期；时区/连续/断签；审计回滚；账本不可改；预占竞争；共享事务回滚；分页和对账 |
| 真实 HTTP 权限与钱包回归 | 1/1 通过：CSRF、角色权限、请求键、Redis 限流/故障、只读本人钱包 |
| typecheck / lint / format:check / test:mock / build | 通过 |
| Playwright HTTP / Mock / 真实认证与钱包 | 7/7、1/1、2/2 通过 |
| OpenAPI + 生成 TypeScript、baseline | 通过；baseline 3/3 |
| cargo audit / npm 官方 registry audit | 均通过，0 漏洞；Rust 282 个依赖、1349 条官方公告，无豁免 |

Windows 使用进程局部 CARGO_PROFILE_TEST_DEBUG=0；没有修改 CI profile。远端 Actions 在本次推送后确认并记录。

M3 素材、生成任务、套餐支付与正式上线不在此次范围；未打包或部署 Web 服务。后续生成/订单写入必须使用 wallet 共享事务入口。
