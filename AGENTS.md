# Atelier 开发续接

- 开工先读 docs/PROGRESS.md、docs/DECISIONS.md 和规格第 0、3 章及当前里程碑章节。只改当前里程碑；先迁移和测试，再实现。
- 每完成一项更新进度、代码位置与真实验证结果；未接通或未验证功能不能标为可用。
- 用户已于 2026-10-22 明确授权：完成检查与文档后自行提交并推送至可信目标 https://github.com/jasonlat-dot/atelier.git 的 main 分支，然后继续下一项，不重复请求确认。
- 正常推送，不强推；保留现有未提交变更。目标发生变化或操作被自动审批阻止时说明实际原因，不绕过。
- 用户已部署 WSL PostgreSQL 16（15432）和 Redis 7（16380）；复用现有服务，不安装或启动。业务和测试分库、分角色；连接配置仅放 Git 忽略的 services/api/.env 与 .env.test.local，禁止输出凭据。运行真实回归并记录结果。
- 不打包；按要求运行 cargo fmt/clippy/test 和 npm typecheck/build。只通过 wallet 模块修改余额，前端禁止密钥。

- 提交作者固定使用 jasonlat-dot / 223874649+jasonlat-dot@users.noreply.github.com（公开账号 ID 已核对为 223874649）。只设置本仓库，不改全局 Git 配置；提交前核对 git var GIT_AUTHOR_IDENT，禁止继承全局旧邮箱。

- 用户要求不能保留已知漏洞依赖：发现时升级或替换所有引入路径；禁止用审计豁免、降阈值或忽略退出码使其通过。新增/升级依赖后重新运行 cargo audit 与 npm audit。

- 本轮用户最新范围：根据文档和 Git 继续下一阶段，先补 PG/Redis，再完成 M2 后停止，不进入 M3。覆盖此前 M1 停止约定。
