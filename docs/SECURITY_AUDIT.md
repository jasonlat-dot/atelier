# 依赖审计记录 · 2026-10-22

当前结论：cargo audit 未通过；不能宣称全 CI 通过或安全清单已完成。

## RUSTSEC-2023-0071

用户截图所示 baseline 作业失败于 cargo audit，rsa 0.9.10 命中 [RustSec 公告](https://rustsec.org/advisories/RUSTSEC-2023-0071.html)，CVSS 5.9，中等。问题是可观察的 RSA 私钥运算计时可能泄漏私钥；官方公告当前没有修复版本，不能仅靠升级声称修复。

截图对应已提交版本 32691c3 的锁文件路径为 rsa ← sqlx-mysql ← sqlx/sqlx-macros-core；项目运行时使用 PostgreSQL。当前 M1 新增的实际编译依赖路径由 `cargo tree --locked --offline -i rsa` 确认为 rsa ← openidconnect 4.0.1 ← atelier-auth ← atelier-app。

当前业务源码未调用 RSA 私钥生成、解密或签名；OIDC 后续用途为验证 Google 公钥签名。这是使用范围的判断，不是漏洞已修复的证明，未来依赖/调用变化需重新评估。

## 本地复现

工具在忽略目录 `.tools/cargo/bin`，公告库从官方 RustSec GitHub 仓库经已配置本机代理克隆到 `.tools/advisory-db`。直接 cargo-audit 拉取曾失败；对刚克隆的库执行：

```powershell
.tools/cargo/bin/cargo-audit.exe audit --file services/api/Cargo.lock --db .tools/advisory-db --no-fetch
```

实际输出：加载 1348 条公告，扫描 346 个锁文件依赖；发现 1 个漏洞 RUSTSEC-2023-0071，退出码 1，`No fixed upgrade is available!`。本地 npm audit 结果另见 PROGRESS.md。

## 处理状态

保留真实失败，未忽略公告、未降低阈值、未把退出码改为成功。需要后续有依据的依赖替换或上游修复才能关闭此项；目前未关闭。CI 的 npm audit 独立执行，避免被 Rust 审计失败跳过。

用户截图显示此前 identity-schema 作业成功；这是远端截图证据，不是本机数据库验证，且不能代表本次新增 Redis 测试已通过。
