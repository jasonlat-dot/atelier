# 依赖审计记录 · 2026-10-22

M2 本地复验：cargo-audit 0.22.2 使用本日新克隆的官方 RustSec 库（1349 条公告）扫描完整 282 依赖，退出码 0，无漏洞。npm 官方 registry audit 0 漏洞。Cargo.lock 只增加本地 wallet 模块依赖边，没有新增/升级第三方版本；没有豁免。M2 本地真实 PG/Redis 18 项、浏览器 10 项通过，远端结果见 PROGRESS.md。

当前结论：项目已移除触发 RUSTSEC-2023-0071 的 rsa 依赖，当前完整锁文件没有 rsa 或 openidconnect。M1 最终源码 `1683788` 的 [CI #6](https://github.com/jasonlat-dot/atelier/actions/runs/39759708282) 全部通过，cargo audit 与 npm audit 均为 0 漏洞，未设置公告豁免。M1 认证自动化验收已完成；实际 Google 部署回归和 M10 全量上线安全验收尚待完成。

## 原因与处理历史

旧提交 `32691c3` 的路径为 rsa ← sqlx-mysql ← sqlx/sqlx-macros-core；`e788463` 又通过 openidconnect 4.0.1 引入 rsa。两者均命中 [RUSTSEC-2023-0071](https://rustsec.org/advisories/RUSTSEC-2023-0071.html)，CVSS 5.9。处理时没有可升级修复的 rsa 版本，因此消除全部依赖路径，不降级或豁免。

1. `71f138f` 将 SQLx 0.8.6 升为 0.9.0，只启用项目所需 PostgreSQL/Tokio/rustls-ring 等功能。新版 MySQL RSA 功能拆为可选，正常生成的锁文件不再包含 rsa。
2. 移除 openidconnect，使用 oauth2 5.0.0 构造授权 URL/state/S256 PKCE，nonce 独立随机生成。当时尚未接通登录；随后 M1 完成了 ring 的 Google RS256 公钥验签、声明校验、注册事务和 Session 签发。
3. `tests/baseline.test.cjs` 先增加锁文件无 rsa 的失败断言，依赖替换后通过，阻止漏洞库回流。

移除的是有漏洞的 Rust rsa 库，RSA 签名算法仍由 ring 实现的 RS256 公钥验证使用；没有省略 Google 签名验证。这不是修复 rsa 上游，也不改写旧提交历史。

## 审计证据

本地工具位于忽略目录 `.tools/cargo/bin`；官方 RustSec 公告库经现有本机代理克隆到 `.tools/advisory-db`。直接拉取曾网络失败，改为对本日新鲜的官方库执行审计，未禁用漏洞匹配：

```powershell
.tools/cargo/bin/cargo-audit.exe audit --file services/api/Cargo.lock --db .tools/advisory-db --no-fetch --json
```

- 旧 `e788463`：扫描 346 个依赖，1 个 rsa 漏洞，退出码 1。
- 移除漏洞路径后 `71f138f`：扫描 270 个依赖，0 漏洞、0 警告，退出码 0。
- M1 登录/TOTP 完成后：扫描 282 个依赖、1348 条官方公告，`vulnerabilities.count = 0`、`warnings = {}`、退出码 0；npm audit 为 0 漏洞。新增 ring、totp-rs 6、chacha20poly1305 0.11、reqwest 未重新引入 rsa。
- 最终 CI #6 同时通过完整 cargo audit 与 npm audit；Rust 审计失败不会阻止 JavaScript 审计执行，任一失败仍使作业失败。

Cargo 正常解析生成锁文件，未手删传递依赖；没有 ignore、continue-on-error 或降低审计阈值。

## 验证边界

CI 的 11 项真实 PostgreSQL/Redis 回归与 2 项认证浏览器测试均通过，详见 `PROGRESS.md`。本机按要求不安装/启动基础服务。实际 Google 实账号与负责人目标环境见 `M1_VALIDATION.md`；依赖审计通过不代表 M10 全量生产安全清单已完成。
