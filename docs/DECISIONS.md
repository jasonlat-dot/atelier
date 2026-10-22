# Atelier 开发决策

## 2026-10-22 · M0 基线整理

- 当前提示词中的 M{n} 未替换，仓库没有历史提交或里程碑进度；按规格第 0、10 章从 M0 开始。原始原型先提交为 c3384c5。
- 仅操作 Atelier，ShellPilot SSH Agent 与客户端不属于本轮范围。
- M0 只建立 workspace 边界，不把空模块标成可用功能。认证由 M1 实现；在此之前受保护 API 一律拒绝，不继续提供不安全的原型余额、任务及开发登录。
- 旧迁移从活动 migrations 移到 docs/legacy，保留原文件便于审计；本机尚无数据库，M0 使用无业务表的基线迁移。已有旧版数据库不得直接套用新迁移，需要独立的数据迁移方案。
- Mock 保留为明确选择的开发模式。默认生产构建使用独立 HTTP 入口，不导入演示身份、本地积分与种子数据；Mock 构建只可输出 dist-mock。
- PostgreSQL / Redis 未安装，不安装或启动基础服务。纯测试与编译正常运行，真实实例回归单独标为待验证。
- 用户要求本地提交，未要求推送或创建远端 PR；在 docs/PR_M0.md 保存逐条验收描述，保持远端不变。

- 实机系统 Node 18.12 不满足当前检查工具要求；本轮仅在忽略目录 `.tools/node` 安装 Node 22/npm 10，未更改全局环境。项目 engines 与 CI 固定 Node 22。
- 规格 3.1 的版本规则要求稳定版本。原 Router 6 的 npm audit 报告两项 moderate，且修复只在新主版本发布；升级为 React Router DOM 7.18.4，保留声明式路由 API，不新增路由功能。类型检查及完整 Mock 浏览器回归通过，更新后 npm audit 为 0。这是技术表中 Router 6 的显式兼容性偏离，便于后续审阅。
- cargo-audit 未全局安装；尝试项目内源码安装时索引长时间阻塞，终止本次安装释放缓存锁，离线重试缺 addr2line；官方发布 API 又被出口限流。CI 保留真实 cargo audit 门禁，本机审计未通过验证，不把未运行的检查写成通过。

## 2026-10-22 · M1 身份基础切片

- M0 代码提交后按用户要求继续 M1。本切片仅实现身份迁移、纯策略和会话材料工具，正式 API 继续拒绝所有身份；不能把它认定为已实现 Google 登录、Session 或 MFA。
- 规格同时写“仅 gmail.com”和“googlemail.com 视为 gmail.com”。保守处理：规范化函数支持 googlemail.com 以用于去重；实际已验证 Google 身份的邮箱域仍严格要求 gmail.com（大小写不敏感），任何 hd 声明均拒绝。
- Bootstrap 管理员仅绕过注册模式，仍受新注册 IP 数量上限约束；已有身份登录不计新注册额度。数据库并发计数、邀请码消费和首次授予角色由后续 service/repo 在事务内实现。
- 会话 Cookie 按 __Host- 要求始终 Secure，令牌和 CSRF 各用系统 CSPRNG 生成独立 32 字节；数据库只接收令牌 SHA-256。摘要对传输的 Base64url 字符串计算；Debug 输出脱敏。
- 非 GET（包括 HEAD / OPTIONS）严格按规格检查 Origin 和 CSRF，重复安全头直接拒绝。Origin 应来自服务端规范化配置；不接受请求 Host 自动成为信任来源。
- 数据库绝对期限采用 720 小时，避免会话数据库时区有夏令时时 interval '30 days' 与 UTC 策略产生偏差。
- 无本地数据库时，真实迁移测试显式 ignore，不能报告通过；CI 新增隔离 PostgreSQL 16 作业专门运行 ignored schema 测试。本轮未推送或运行远端 CI。
- 未实现注册赠送积分；M2 通过 wallet service 接入，禁止 auth 直接改余额。

## 2026-10-22 · 会话服务与推送约定

- 用户已明确授权当前及后续正常推送至 https://github.com/jasonlat-dot/atelier.git 的 main；覆盖上文“仅本地提交”的历史范围，不创建/强推历史。
- GitHub 公开账号信息确认 jasonlat-dot ID=223874649，提交身份只在本仓库设置为 jasonlat-dot / 223874649+jasonlat-dot@users.noreply.github.com；此前三个提交沿用的全局身份不重写。
- 规格要求“设备及撤销”但未列 URL，补 GET /api/v1/me/sessions 和 DELETE /api/v1/me/sessions/{id}。设备 ID 为独立随机 UUID，绝不把 token_hash 当设备 ID 返回。
- 数据库不可用返回 503 SERVICE_UNAVAILABLE，不能伪装成 401 导致前端错误退出；SQL 错误、连接串和原始 Cookie 不回显。
- PUBLIC_BASE_URL 为必填，以规范化可信配置比对 Origin 和 Host；不信 Forwarded/X-Forwarded-Host，HTTP/2 authority 也必须匹配。生产只允 HTTPS，回环 HTTP 仅开发白名单。
- 按规格对所有非 GET（含 HEAD/OPTIONS）做 CSRF；GET /me 和注销允许未完成 MFA 的管理员进入，用于取得身份/CSRF和安全退出，其他业务要求最近 12 小时 MFA。
- Session last_seen_at 使用 GREATEST 更新，避免并发请求覆盖为更早时间；条件更新拒绝查询后发生的会话撤销和角色变化。不是会话缓存，不在内存保存生产 Session。
- /me 暂不返回虚构钱包/订阅摘要，待 M2/M8 按模块接入。没有 OIDC 前不提供任何开发或测试登录给用户，Google 按钮暂禁用。
- 前端浏览器测试使用 HTTP 响应合同替身，Rust HTTP 测试使用测试仓库替身；它们不替代真实 PostgreSQL/Redis/OIDC 回归。远端 CI 状态读取遭 API 限流，结果仍按未确认记录。
