# M7 对话与意图识别

把已有三栏对话原型接为本人私有的 PostgreSQL 会话、真实上游 SSE 与账本计费。用户选择管理员配置的 chat 模型，阅读实时回复、停止、核对断线提交、复制 Markdown/代码、重新生成与管理历史；图像动作卡只准备画布草稿，必须再次确认生成。

agent-core 对外只有 LlmClient、IntentClassifier、ContextCompressor，不依赖 SSH/工具/文件。预算和事实保留原则抽取自同工作区 ShellPilot，创意分类为新领域规则。70% 触发早期内容摘要，保留最近原文和来源校验的事实，原始消息仍持久化；默认窗口 8192/输出预留 2048，保守估算而非供应商精确 tokenizer。

每条完整助手回复默认 1 积分（可设 0）；创建 HOLD，完成正文/动作/审计/SETTLE 原子提交，失败/取消/断连 RELEASE，过期租约恢复。幂等重放不重复调用或收费。新增迁移保护输入、用户原文与终态不可改写。Markdown 禁原始 HTML，经 sanitize，远程图片只显示链接。无管理员查看他人对话入口。

## 本地验证

- 意图基准 37/37 正确，超过不少于 30 条、准确率 90% 门槛；并非通用分类器准确率声明。
- Chat 隔离数据库 5 项：重复请求、归属、免费模式、失败/断连/取消/回收、登录失效、完成审计回滚、不可改写、删除后重放，以及 12 轮压缩后的名称/预算事实续聊。
- Rust workspace fmt/clippy/test/check、接口契约、前端 typecheck/lint/format/mock/build、构建隔离/代理及换源回归通过。
- HTTP 浏览器 39 项、Mock 浏览器 1 项通过；实际 PG/Redis 浏览器 2 项、完整数据库/Redis/媒体及 app HTTP 全部通过。真实 HTTP 流验证保存扣 1、停止释放、502/无 DONE 截断不扣，动作卡不创建任务；供应商为夹具，无付费调用。
- cargo audit 342 依赖及官方 npm audit 均零漏洞，无豁免。

## 配置与边界

配置 chat 模型、账号绑定和 message 定价后启用；实际用户收费按全站 chat_credits_per_message，模型价格不覆盖该统一值。参数和接入步骤见 README，SSE 事件/限制见 API。当前为 OpenAI 兼容 chat/completions 的文本流，不执行工具、读取本地文件或自动付费生成，不接用户 API 密钥。真实供应商付费效果及公网部署未声明验收，S3 仍待定。

## 远端

后端基础 a12699d 的 Actions #39903985055 两作业 completed/success。完整功能 `20a54b3` 的 [Actions #39905794003](https://github.com/jasonlat-dot/atelier/actions/runs/39905794003) baseline 成功，真实浏览器测试存在跳转等待时序问题；已补 UUID URL 等待与响应成功断言，修复后的最终结果见下方与 PROGRESS 完成记录。本轮完成 M7 后停止，不进入 M8。


最终完整功能 `4af169f5925ad0839d5eeb208e20b641e303512a` 的 [Actions #39907015646](https://github.com/jasonlat-dot/atelier/actions/runs/39907015646) 已核对两个作业 completed/success，M7 完成。先前测试读取 URL 过早的问题修正后，最新真实浏览器全流程通过。本轮仅提交完成记录后停止，不进入 M8。
