# M1 当前 API 契约

结构化契约：`openapi.json`（Rust utoipa 导出）；前端：`apps/web/src/lib/generated/api.d.ts`（openapi-typescript 生成）。检查：根目录 `python scripts/check_contract.py`。

| 方法与路径 | 当前行为 |
| --- | --- |
| GET /api/v1/health | 公开进程存活检查，不代表数据库或完整认证可用 |
| GET /api/v1/me | Cookie 会话查询，返回 user、csrf_token、mfa_required；不返回哈希、MFA 密钥、Google sub/token 或虚构积分 |
| PATCH /api/v1/me | 只接受 display_name；1..100 字符，trim 后校验，未知字段拒绝；修改与审计同事务 |
| GET /api/v1/me/sessions | 当前用户的有效设备列表（最多 100），独立设备 UUID、时间、IP、UA、是否当前设备 |
| DELETE /api/v1/me/sessions/{id} | 只撤销当前用户设备，跨用户/不存在 404；当前设备撤销同时清 Cookie |
| POST /api/v1/auth/logout | 撤销当前用户所有 Session 并清 Cookie；与审计同事务 |
| /api/v1/admin/*、/api/admin/* | 权限/MFA 校验后，未实现的业务返回 404；普通用户 403 |
| /api/v1/dev/login | 永久移除，404 |
| /media/* | 404，M3 再接入 |

所有受保护响应包含 Cache-Control: no-store。Cookie 名 __Host-sid；非 GET 必须带匹配可信 PUBLIC_BASE_URL 的 Origin/Host 与 X-CSRF-Token。重复安全头拒绝。OpenAPI 声明 cookie/CSRF security scheme。

- 无/伪造/过期/撤销 Session：401 UNAUTHENTICATED。
- 当前数据库用户禁用：403 ACCOUNT_DISABLED；角色逐请求查询，不接受请求体身份。
- 普通用户管理请求或 CSRF：403 FORBIDDEN；缺少/过期 MFA：403 MFA_REQUIRED。
- 参数校验：422 VALIDATION；数据库异常：503 SERVICE_UNAVAILABLE。
- 错误体统一 `{error:{code,message,request_id}}`，内部细节不返回。
- /api/openapi.json 默认 404；显式 EXPOSE_OPENAPI=true 且回环绑定时可公开开发查看。

**Google 登录/注册、Session 签发轮换、Redis state/限流、真实 TOTP 尚未接通。** 当前接口只消费已有有效数据库会话，生产前端不提供假登录。5 项 PostgreSQL 测试待真实实例运行，完整 M1 未验收。
