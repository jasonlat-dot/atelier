# M1 部署后回归

本文件用于负责人自行部署后的 Google 实账号回归；CI 的合成 Google 提供方、隔离 PostgreSQL/Redis 不代替实际域名/OAuth 配置验证。不进入 M2，也不包含生产打包或部署操作。

## 启动配置

参照 `services/api/.env.example`，将配置注入后端进程环境。Google 凭据、MASTER_KEY 仅在后端使用，不能放入 VITE_*。MASTER_KEY 是持久保存的随机 32 字节 base64，可以在可信终端一次生成：

```powershell
node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('base64'))"
```

配置 Google Cloud 的 Web OAuth 客户端，回调严格为 `PUBLIC_BASE_URL/api/v1/auth/google/callback`。生产 PUBLIC_BASE_URL 使用实际 HTTPS origin，不带子路径/查询。设置 BOOTSTRAP_ADMIN_EMAILS 为自己的个人 Gmail；仅首次注册授予 SUPER_ADMIN，改环境变量不会提升已有普通用户。

反向代理转发原始 Host，覆盖 X-Real-IP，并将实际代理连接 IP 加到 TRUSTED_PROXY_IPS；未配置时服务只使用 TCP 对端 IP，忽略所有转发头。默认注册 CLOSED，已有用户可登录，Bootstrap 账号可首次登录。注册设置存于 system_settings；完整管理界面属 M9。

后端启动自动执行迁移，包含 `202610220300_m1_login_mfa.sql`。缺少必填凭据、主密钥长度错误或基础服务不可用会拒绝启动，不提供默认身份或内存 Session。

## 功能回归

1. 匿名 GET /api/v1/me 返回 401；public/config 仅返回注册模式和版本。登录页显示当前注册模式，按钮只导航到后端 start。
2. 自己的 Bootstrap Gmail 经 Google 登录后进入 MFA 绑定页，不能先访问设置或管理业务。绑定个人验证器，输入六位码，成功后进入工作台，可从侧栏打开账号设置；同一码重复验证被拒，12 小时后重新验证。
3. 设置页修改显示名，刷新后保留；在另一浏览器登录，设备列表可见；取消撤销无变化，确认撤销使该设备后续请求 401。退出所有设备使原 Cookie 全部失效。
4. 使用其他个人 Gmail：CLOSED 时新用户被拒；切 OPEN 后新用户可登录，切回 CLOSED 后已有用户仍可登录。INVITE_ONLY 下有效邀请码或规范化白名单可注册，失效/用完的邀请码不可注册；同 IP 24 小时配额生效。
5. 非 Gmail 与带 Workspace hd 声明的身份被拒；伪造/重放 state、伪造 Cookie/id_token 均不能建立会话。自动化矩阵另覆盖 Gmail 别名、错误签名/issuer/audience/nonce/过期。
6. 普通用户访问任何管理接口 403；跨用户设备撤销 404。禁用用户立即拒绝，改角色撤销旧会话；所有已认证非 GET 缺 Origin/Host 匹配或 CSRF 时拒绝。

## 自动化回归

只对隔离测试实例设置 DATABASE_URL、TEST_REDIS_URL。SQLx 测试账号需要创建测试数据库权限；Redis 使用专用测试数据库。

```powershell
cd services/api
cargo fmt --all --check
cargo clippy --locked --workspace --all-targets -- -D warnings
cargo test --locked --workspace
cargo test --locked -p atelier-auth --tests -- --ignored
cargo check --locked --workspace --all-targets
cargo audit
cd ../../apps/web
npm run typecheck
npm run build
npm run lint
npm run format:check
npm run test:mock
npm run test:e2e
npm run test:e2e:http
npm audit
cd ../..
python scripts/check_contract.py
node --test tests/baseline.test.cjs
```

完整浏览器集成：在 `apps/web` 执行 `npm run test:e2e:auth`，它启动 tests/browser_harness.rs，用真实数据库/Redis 与合成签名验证登录、会话与 TOTP。该测试会向独立测试库写数据；不得指向生产。夹具不是部署入口，生产 main 不引用它。

法律条款、积分/赠送、资源业务、生产加固不属于本次 M1 交付；法律文案和生产上线验收在 M10 完成。
