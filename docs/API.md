# M0 API 契约

唯一结构化契约为 [openapi.json](openapi.json)，由 `atelier-app` 的 utoipa 定义导出。
前端类型为 `apps/web/src/lib/generated/api.d.ts`，禁止手工修改。

- `GET /api/v1/health`：200，`{status:"ok", milestone:"M0"}`。仅进程存活，不代表业务、数据库或 Redis 可用。
- `/api/v1/*` 与 `/api/admin/*` 的受保护业务：M0 返回 401 `UNAUTHENTICATED`，无 Cookie 和伪造 Cookie 均不能建立身份。尚无正式会话；不声称完成 M1 越权矩阵。
- 已移除的 `/api/v1/dev/login`：404；无演示身份映射。
- `/api/openapi.json`：默认 404；显式 `EXPOSE_OPENAPI=true` 且绑定回环地址时才开放开发查看。
- `/media/*`：404，签名素材属于 M3。
- 其他静态 GET 路径回退 SPA；API 与媒体前缀不会回退 HTML。
- 错误结构：`{error:{code,message,request_id}}`，不回显数据库连接串、密钥或请求体。

生成：在 `services/api` 执行 `cargo run -q -p atelier-app --example export_openapi`，将 UTF-8 输出写入 `docs/openapi.json`；在 `apps/web` 执行 `npm run api:generate`。
一致性检查：根目录 `python scripts/check_contract.py`（不需要数据库）。

M1 之后逐阶段替换受保护入口，不把原型的任务、钱包和用户字段当作新契约。
