# M0 基线整理

原型从未提交和完整编译，包含开发会话与直接改 users.credits 的演示服务端。此次保存原型为 c3384c5，再将主线变为可编译、默认拒绝未认证业务的 Rust workspace，并让默认生产前端与 Mock UI 分离。

## 逐条验收

| 第 10 章 M0 验收项 | 结果 | 证据 |
| --- | --- | --- |
| cargo test 通过 | 通过 | 全 workspace 6 个测试、0 失败；鉴权矩阵 105 组请求 |
| npm run build 通过 | 通过 | Node 22，TypeScript + Vite 生产构建成功；不含 Mock 模块或演示身份 |
| mock 模式 UI 行为与现在一致 | 通过（测试范围内） | 保留原 Mock 业务回归；Playwright Edge 1/1：画布提交、结果回流、刷新保存、签到去重、管理员切换和普通用户隐藏管理入口 |

## 开发规则与验证

- 先归档旧迁移、写 M0 基线迁移和回归测试，再写实现。未引入 M1 业务表或任何实际扣款能力。
- Rust fmt / clippy --workspace --all-targets -- -D warnings / test / check：通过。
- 前端 typecheck / lint / format:check / test:mock / build / build:mock：通过。
- 生产产物测试 2/2、OpenAPI 一致性：通过。npm audit：0 漏洞。
- cargo audit：未通过验证（本机工具安装索引受阻，离线缓存不全，官方发布 API 出口限流）。CI 包含硬门禁，尚未执行远端流水线；不能宣称全 CI 绿。
- PostgreSQL / Redis、真实迁移与 Google 登录：未运行，遵照用户部署后回归的安排。
- 路由依赖为修复审计从 6 更新到兼容声明式 API 的 7.18.4，依据及 Node 环境假设写入 DECISIONS.md。

## 交付边界

默认 HTTP 页面只显示服务状态；正式登录、钱包、素材、生成和管理接口尚未接入。空 crate 不表示功能完成。旧版数据库禁止直接套用新迁移。没有推送、远端 PR、安装包或部署；本文件为可直接使用的 PR 描述。
