# M5 生成流水线

创建生成任务会在服务端重新计算价格，并将任务与积分 HOLD 原子写入。持久 worker 领取并执行图片/视频，结果先校验转码、隔离暂存，发布、逐输出 SETTLE 和余量 RELEASE 与终态/事件同事务。取消与完成竞争、崩溃恢复、重复投递不会重复扣分或错退。

## 实现与验收

| 项目 | 代码/证据 |
| --- | --- |
| 输入/服务端报价/幂等/引用归属/内容规则/活跃限制 | generation/service.rs，数据库与 HTTP 回归；100 并发同键单次 HOLD、异参拒绝、余额不足回滚、MFA/CSRF/跨用户隔离 |
| 持久 worker/重试/租约与恢复 | generation/worker.rs，60 秒租约、20 秒续期、30 秒回收、SKIP LOCKED 与令牌栅栏；不同 worker 三次重试上限、旧 worker 无权发布、实际 21 秒续期 |
| 取消/部分结算/事务失败 | worker 测试：完整和部分输出、并发取消、发布审计失败整体回滚且恢复重用检查点、失败释放、不可变终态 |
| 视频派发恢复 | 已知上游 ID 后仅续取原任务且额度按派发身份去重；提交返回前崩溃不重发，用户全额释放，平台承担潜在上游成本 |
| 生成媒体私有发布 | assets/generated.rs：重新编码，未发布素材对用户隐藏；发布审计/钱包/结果/事件同事务 |
| SSE | PostgreSQL 事件重放 + Redis 唤醒，Last-Event-ID/after、本人事件、三连接上限、会话撤销和 MFA 过期断流、轮询兜底 |
| 当前原型接线 | /generate 的参数、参考图选择/上传、权威报价、幂等提交、任务列表/取消/复用、预览/下载与积分状态；M6 画布/项目仍待开放 |

本地验证：Rust fmt/clippy/workspace test/check（59 项普通测试），49/49 隔离 PostgreSQL/Redis/真实视频回归，前端 typecheck/lint/format:check/test:mock/build，基线/代理 4/4，Mock 浏览器 1/1，HTTP 页面 29/29，真实 Google/MFA/配置/图片与视频生成浏览器 2/2，OpenAPI/TS 契约一致。1440 桌面和 320 手机截图已核对，仅留忽略目录。cargo audit 340 依赖/1349 公告、npm 官方 audit 均零漏洞，无豁免。

真实浏览器通过合成 Google 和本地假供应商，实际使用 PG/Redis、后台 worker、钱包事务、媒体重编码及签名授权；图片和视频各自完成、刷新后保留、输出可预览，钱包 20→10→6。没有使用真实供应商凭据或发起付费调用。

## 配置与边界

- 沿用根目录 npm run dev；本次需要重启 API 执行两个 M5 迁移。复用现有 PG/Redis 和 MASTER_KEY，本地私有媒体目录，不新增前端凭据。
- 上游账号/模型/价格按 README 的 M4 顺序配置，参数必须与实际供应商相符。视频处理须有 FFmpeg/ffprobe。
- 当前订阅业务未实现，全部 FREE；默认 max_active_jobs_free=1、free_max_resolution=2K，视频最长沿用模型能力/M3限制。不接受非空 project_id/node_id；M6 再接画布项目持久化。
- 未产出取消/失败全额释放，部分产出按张结算。上游已产生但没有发布的成本由平台承担。
- SSE 代理关闭缓冲；断线重新连接携带游标，页面通过查询任务/钱包同步最终结果。
- S3 维持待定；不声明真实供应商、实际域名或公网上线已验收。

## 提交与远端检查

基础切片 e7d7eaf 的 Actions #39881534276 全绿。worker 305383b 与 SSE e062360 的 baseline 均通过，基础设施作业因 Azure 镜像长时间卡住由负责人取消；不能写为全绿。025d572 的三分钟安装时限失败，178caee 已改用 Ubuntu 官方镜像、IPv4 和最小依赖，工具安装与基础设施步骤已通过；旧运行按负责人指示取消，不再单独跟进。

最终功能提交 `00ccdf7b1f897252add6b8b2ad45cca001d63bb8` 的 [Actions #39888171556](https://github.com/jasonlat-dot/atelier/actions/runs/39888171556) 已核对 completed/success：baseline、identity-schema 均通过。它包含前述所有切片、CI 换源及完整原型生成界面；以此完整代码验收为准。

M5 已完成，本轮停止，不进入 M6；收尾提交仅更新完成/交接文档。S3 仍待定。
