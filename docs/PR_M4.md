# M4 · 上游账号池与模型

管理员现在可以在现有原型内维护真实服务账号、模型能力、账号绑定和积分价格。内部适配器可在受控网络策略下调用图片生成/编辑与异步视频接口；账号容量由 Redis 租约和 PostgreSQL 额度预占共同约束，失败按固定类别换号、冷却或停止。

## 使用顺序

从仓库根目录重启 `npm run dev`，API 自动执行新迁移。管理员登录并完成 MFA 后：

1. **上游账号池** `/admin/accounts`：新增兼容接口地址、密钥、分组、优先级、权重、并发和额度，然后测试连接。基础地址通常以 `/v1` 结尾，不填 `/images/generations` 等具体动作路径。
2. **模型与定价** `/admin/models`：创建公开别名和展示名称，填写内部模型标识以及真实支持的图片/视频/对话能力。新建默认为关闭。
3. 为模型绑定指定账号或分组，两者取并集；分组是动态匹配。
4. 在“积分定价”配置各质量基础积分、分辨率倍率和图片编辑附加费；保存后回目录启用。

接口地址、API 密钥和内部模型标识只写不读，编辑留空保留，任何响应/审计不回显。密钥沿用后端 MASTER_KEY 独立域派生加密，主密钥必须持久保存。上游额度目前由管理员核对后更新；连接成功不会被伪装成上游实时余额查询。

账号 JSON 导入接受 1–100 项、最多 1 MiB，使用 AccountInput 字段，任何一项不合法则整体回滚。必填字段示例（使用自己的配置替换）：

```json
[
  {
    "name": "图片主池",
    "base_url": "https://api.example.com/v1",
    "secret": "replace-with-your-authorized-api-key",
    "group_tag": "images",
    "priority": 0,
    "weight": 100,
    "concurrency_limit": 2,
    "quota_total": 100,
    "quota_remaining": 100,
    "quota_reset_at": null,
    "enabled": true
  }
]
```

优先级数值越小越优先，同优先级按权重、空闲容量与剩余额度计算评分；同分随机。图片额度按有效产出张数、视频按秒记录。统计窗口 24 小时，包含连通性测试；列表每 15 秒在可见且无编辑时刷新，编辑后版本冲突要求重新载入。

## 实现与边界

- `202610230200_m4_upstream.sql`：账号、模型、价格、绑定、租约和固定错误统计；没有改写已发布迁移。
- `crates/upstream/crypto.rs`：XChaCha20-Poly1305、独立域、账号与版本 AAD、随机 nonce、凭据不参与 Debug/Serialize。
- `egress.rs`：逐请求解析并固定 DNS、全解析结果拒绝私网/元数据/特殊地址、HTTPS、禁重定向/环境代理、有限并发/时长/响应体。开发例外默认关闭，仅允许显式准确 loopback origin 且 API/公开入口均为 loopback；生产保持空值。
- `provider.rs`：图片 JSON generations、multipart edits；视频 JSON 提交、同 ID 轮询、内容下载。图片支持 b64 或经相同安全策略下载 URL，跨站下载不转发 Authorization；原始上游错误不回显。
- `slots.rs` / `runtime.rs`：Redis 原子槽、PG 额度预占；60 秒租约/20 秒续期、令牌栅栏、取消与 panic 释放。最多三个账号尝试；图片已有产出或视频已获得 ID 后不重复提交。
- 401/403 标为凭据无效；429 使用 Retry-After/明确额度周期或默认一小时冷却，耗尽单独标记。5xx/超时连续三次进入五分钟指数退避，最长一小时；内容拒绝/参数错误不换号。本地参数、容量或存储错误不计为上游故障，直接返回并释放租约；三次非法参考图回归保持账号健康且无虚假失败统计。每五分钟探测到期候选，仅显式重置时间到期且探测正常才恢复额度。
- `app/upstream_http.rs`：管理接口要求服务端角色、最近 MFA、同源/CSRF、写限流和原子审计；完整输入与乐观版本校验。普通 `/api/v1/models` 只返回已启用公开模型、能力和价格。
- `features/upstream/*`：账号搜索/分页/状态/冷却/额度/统计，新增/编辑/导入/测试/启停/软删，模型能力/绑定/价格矩阵。抽屉和确认框支持键盘、Esc、遮罩关闭及焦点恢复，请求期间防重入。沿用原型工作台，无新组件库或运行依赖。

实际供应商的额外协议和模型尺寸/时长仍需部署者按授权接口核对。验收使用可控假上游，未读取真实供应商密钥或发起付费生成。

## 验收

本地复用 WSL PostgreSQL 16 / Redis 7，独立测试配置、SQLx 隔离数据库与独立 Redis 名空间；不修改业务账号或停止用户开发服务。

| 检查 | 结果 |
| --- | --- |
| Rust fmt / clippy（全部 target，警告为错误）/ workspace test / check | 通过，58 项普通测试 |
| 全部真实 PG/Redis、媒体转码、账号与路由测试 | 35/35 通过，其中 M4 新增 9 项 |
| 前端 typecheck / lint / format:check / test:mock / build | 通过 |
| OpenAPI 与生成 TypeScript 契约 | 通过 |
| 生产隔离、迁移/锁文件与开发代理 | 4/4 通过 |
| Mock 浏览器 / HTTP 页面 / 真实认证浏览器 | 1/1、23/23、2/2 通过 |
| RustSec / npm 官方审计 | 1349 公告、339 Rust 依赖，均 0 漏洞；无豁免 |
| 1440 桌面 / 320 手机人工截图核对 | 通过，无页面脚本错误；截图仅在忽略目录 |

路由测试真实覆盖 401、429、额度耗尽、502、超时、内容拒绝、参数错误、危险产出 URL、跨站下载不带密钥、部分图片、multipart 编辑、视频提交/轮询/下载、冷却恢复、显式额度重置、100 并发容量、过期令牌、取消/panic 和实际 21 秒租约续期。事务测试覆盖权限、输入约束、密文篡改、版本冲突、导入/审计失败回滚和模型启用前置检查。

真实浏览器以合成 Google/MFA 身份贯通账号新增与探测、刷新持久化、敏感字段不回填、模型新增/绑定/价格/启用、用户目录脱敏及钱包余额不变；原有图片/视频上传和播放流程同轮通过。夹具的临时上游地址文件仅为测试进程通信，不增加生产入口。

运行真实基础设施回归：先在 `.env.test.local` 配好专用 DATABASE_URL / TEST_REDIS_URL 和 FFmpeg，再执行 `./scripts/api.ps1 -Action test-infrastructure`。浏览器先 `npm --prefix apps/web run build`，再执行 `./scripts/api.ps1 -Action test-browser`；本机已有 8080 时，可设置 `TEST_AUTH_BASE_URL=http://127.0.0.1:8082`，不停止已有服务。

最终功能提交 `9fa4b8b3485b50daace051f8860f67f214c3c4aa` 的 [Actions #39834923711](https://github.com/jasonlat-dot/atelier/actions/runs/39834923711) 已核对 baseline、identity-schema 均 completed/success。此前页面切片 7f78f18 和后端切片 ddb984b 的 Actions 也均成功；准确续接记录见 PROGRESS.md。

## 本轮停止点

负责人明确要求：完成 M4 后停止，**不继续 M5**。S3 仍为待定，未做实服务验收。用户生成任务、持久任务队列、用户报价授权、钱包预占/结算、任务历史与 SSE 属于 M5，本轮没有接入。

下次先读取 AGENTS、PROGRESS、DECISIONS 和 Git，核对最新 Actions；获得阶段授权后再依据规格推进，保留当前原型与只写凭据规则。
