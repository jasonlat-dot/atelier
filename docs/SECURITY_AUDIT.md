# 依赖审计记录 · 2026-10-22

当前结论：RUSTSEC-2023-0071 对项目的影响已通过移除漏洞依赖解决。当前锁文件没有 rsa 或 openidconnect；本地 cargo audit 0 漏洞、0 警告、退出码 0，npm audit 0 漏洞。未使用任何公告豁免。完整 M1 登录功能与第 8 章安全清单仍未完成。

## 原因与处理

旧提交 32691c3 的路径为 rsa ← sqlx-mysql ← sqlx/sqlx-macros-core；e788463 又通过 openidconnect 4.0.1 引入 rsa。旧版本均命中 [RUSTSEC-2023-0071](https://rustsec.org/advisories/RUSTSEC-2023-0071.html)，CVSS 5.9。官方无已修复的 rsa 版本，故不采用降级或审计豁免。

本次变更：

1. SQLx 0.8.6 → 0.9.0，使用 PostgreSQL/Tokio/rustls-ring；新版本 MySQL 的 RSA 功能已拆分为可选，当前锁文件中的 sqlx-mysql 不再依赖 rsa。
2. 移除 openidconnect，现有授权准备改用 oauth2 5.0.0 处理 URL/state/PKCE；nonce 为独立 32 字节随机值。该组件尚未实现 token 验证或发放 Session，仍未开放登录。
3. `tests/baseline.test.cjs` 增加锁文件回归检查，修改前实际失败，完成替换后通过，阻止 rsa 重新进入依赖。

这是移除有漏洞的库，不是宣称修复了 rsa 上游实现。正常提交保留历史，历史锁文件中的告警记录不改写。

## 本地审计证据

工具位于忽略目录 `.tools/cargo/bin`；公告库从官方 RustSec 仓库经现有本机代理克隆至 `.tools/advisory-db`。cargo-audit 直接拉取曾因网络失败，对本日新鲜官方库执行：

```powershell
.tools/cargo/bin/cargo-audit.exe audit --file services/api/Cargo.lock --db .tools/advisory-db --no-fetch --json
```

实际报告：1348 条公告，270 个锁文件依赖，`vulnerabilities.count = 0`、`warnings = {}`、退出码 0。此前 e788463 的同一命令扫描 346 个依赖，1 个 rsa 漏洞，退出码 1。两次使用同一官方公告库，检查规则未放宽。

锁文件使用 Cargo 正常解析生成；对其结构化解析确认 rsa/openidconnect 包不存在，sqlx=0.9.0、oauth2=5.0.0。CI 仍运行完整 cargo audit 与 npm audit。

## 验证边界

真实 PostgreSQL/Redis 测试按用户要求在本机跳过，由 CI 隔离服务执行，结果另见 PROGRESS.md。用户此前截图中 identity-schema 成功只适用于旧提交，不能代替新版本真实实例验证。未据本地审计通过宣称整条远端 CI 已绿。
