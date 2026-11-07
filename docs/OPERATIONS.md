# CodexWake 操作手册

## 服务与安全边界

使用自己的私有 GitHub 执行仓库和 Cloudflare Worker。管理员令牌保存在本机 `~/.codexwake/admin-token`（权限 `0600`）。不要打印或分享该文件。Worker 的 `GITHUB_ACTIONS_WRITE_TOKEN` 仅用于触发 Actions；仓库的 `CODEXWAKE_SECRETS_WRITE_TOKEN` 单独用于写入 Secrets。`CODEX_AUTH_BUNDLE` 是版本化、加密写入的 ChatGPT OAuth 文件；不要读取、打印、提交或上传它。

Codex CLI 固定为 `0.166.0`。所选模型必须来自同版本 CLI 在用户账号上的实际 `model/list`；仅在本机运行 App Server 查询，不在 GitHub-hosted Runner 使用 App Server 身份认证。这样避免对 [App Server 文档](https://learn.chatgpt.com/docs/app-server)中托管服务限制作未经确认的解释。可信私有 CI 的 ChatGPT 登录及刷新方式见 [OpenAI CI/CD 认证指南](https://learn.chatgpt.com/docs/auth/ci-cd-auth)。

本机真实使用会布防对应窗口的第一次预热，等观测重置时间加两分钟再进入允许时段。后续按实际执行时间估算下一轮，默认连续最多两次，可在面板改为 1–12 次。新的真实使用会重置计数。预约只需填开始时间，默认使用 2 小时。可选 1、3、4 小时或自定义结束时间。预热按期望恢复时间倒推，结合已知重置和睡眠时段执行；预约不自行产生滚动链。单次预约超过使用结束时间就不补发，重复可选每 24 小时或每 7 天。旅行暂停会取消待执行预热，尚在未来的其他预约保留，恢复后按当时的计划和时段重新评估。已发出的一次性许可可能仍会完成。

初始配置保留 `ACTIVITY_WAKES_ENABLED=false`。完成获授权的真实端到端验证之后，部署配置须显式启用该功能，再通过管理员开关恢复。当前可运行只读验证及独立的手动测试。CLI 成功保留为 `completed_unverified`，窗口是否真正开始要以额度证据为准。

模型验证记录保存在协调器状态，不人为设置固定到期日。平台可能调整模型；模型失效、令牌失效或执行失败时服务会停机。Plus 已购 credits 可能在订阅额度耗尽后被消耗；GitHub Actions 和 Cloudflare 免费额度与账号的其他工作共享，不能承诺无条件零费用。

## 查看、启停和手动触发

在项目目录的本机终端设置环境，操作结束后清除令牌变量。不要开启 shell 跟踪：

```sh
export CODEXWAKE_ADMIN_URL="$(cat ~/.codexwake/worker-url)"
export CODEXWAKE_ADMIN_TOKEN="$(cat "$HOME/.codexwake/admin-token")"
npm run config -- status
npm run config -- disable  # 关闭自动激活
npm run config -- resume   # 云端验收开放后才可开启
npm run config -- cancel   # 取消当前待执行预热
npm run config -- pause    # 旅行暂停，关闭开关并取消待执行预热
npm run config -- wake     # 立即检查已布防任务，仍遵守全部时间和许可条件
npm run config -- test-now # 仅在自动开关关闭时立即发送一次，绕过时段和推算
unset CODEXWAKE_ADMIN_TOKEN
```

`status` 包含非机密的运行阶段、配置、最近一次结果、估算的 `notBeforeMs`、模型验证时间及进行中的任务。`completed_unverified` 只表示 CLI 正常退出；工作流日志里的 `responseReceived: true` 另外表示检测到非空回复，仍不能证明额度窗口已启动。关闭开关会阻止之后的许可；如果任务已取得一次性许可并开始发送，无法保证取消已在途请求。

自定义工作时段、睡眠时段、时区、消息、模型和开关：将 `config.example.json` 复制到项目外的私有文件，修改后设置 `CODEXWAKE_CONFIG_FILE` 为绝对路径并运行 `npm run config -- set`。时间段起点包含、终点不包含，支持跨午夜；睡眠优先。更换模型前需关闭自动激活，再从当前 CLI 实际模型列表验证并重新登记。配置变更使用版本检查；有并发修改时重新读取状态。`maxRetries` 和 `retryIntervalMinutes` 只用于确定子进程根本未启动的情况；不确定的模型请求和 Secret PUT 不会重试。

## 本机监测与面板

先用单独登录初始化观察器，选择和云端同一个 ChatGPT 账号。观察器会按需使用自己的 OAuth 会话，云端凭证仍由 Runner 串行管理。

```sh
mkdir -m 700 -p ~/.codexwake/observer
CODEX_HOME="$HOME/.codexwake/observer" node_modules/.bin/codex -c 'cli_auth_credentials_store="file"' login
npm run activity -- observe
npm run setup:activity-token
npm run monitor:install
npm run dashboard:install
```

安装器把本项目的两个 hook 合并到 `~/.codex/hooks.json`。重启或重新打开兼容的 Codex 客户端后，按客户端提示审核并信任该 hook。安装、暂停、继续及卸载命令分别为 `npm run monitor:install`、`npm run monitor:stop`、`npm run monitor:start`、`npm run monitor:uninstall`。监测是事件驱动的，单独运行时无需 LaunchAgent。观察器只在同一轮的 `UserPromptSubmit` 和成功 `PostModelRequest` 都收到后读取额度。一个成功事件最多开始一次探测，密集活动时本机每分钟最多探测一次，跨已知重置边界会重新读数。没有后台定时唤醒。只读流程有两个额度/账号 RPC，实际后端流量取决于 CLI 是否刷新登录。活动上报最多发送两次相同事件。

不支持这两个 hook 的客户端，可在真实任务刚发生后用 `npm run activity -- confirm-user-turn` 明确报告。其他设备或未加载本机 hook 的客户端不会自动上报。本机自动化应在独立的 CODEX_HOME 运行，或设置 `CODEXWAKE_AUTOMATIC=1`，因为 hook 的输入没有可靠的客户端人机来源字段。云端执行器已有独立的空 CODEX_HOME。本机只有在识别到有效五小时桶、可信每周额度且无可用付费 credits 时布防。账户间使用或重置的变化仍可能发生在观察之后，云端只使用已报告的窗口证据。

登录 macOS 后，LaunchAgent 负责监听 `127.0.0.1:8787`。访问时才启动 Node，空闲约 60 秒后 Node 退出。安装时会使用 Xcode 或命令行工具编译一个很小的套接字交接程序。安装后可在浏览器访问或收藏 [http://127.0.0.1:8787](http://127.0.0.1:8787)，无需每次运行启动命令。在项目目录管理面板：

```sh
npm run dashboard:install    # 注册按需面板，验证端口可用
npm run dashboard:status     # 查看注册和 Node 运行状态
npm run dashboard:uninstall  # 停止并卸载按需面板
```

面板在空闲时不定时轮询；打开或刷新页面会读取云端和本机最近一次观测，只有点击「只读获取额度」才启动即时探测。浏览器只访问本机服务，保存操作通过 HTTPS 写入 Cloudflare。设置修改按 revision 校验，冲突时需刷新。更换模型前先暂停并按下文重新验证模型。打开成功通知前须先设置 webhook。关闭网页后，端口仍可接受下一次访问。已上报的云端任务独立运行。

如需临时运行，可在项目目录执行 `npm run dashboard`。临时面板默认打开浏览器并监听 `127.0.0.1` 的随机端口，可通过 `CODEXWAKE_DASHBOARD_PORT` 指定端口。临时服务可显式退出或按 Ctrl+C，十分钟无请求后也会自动退出。

## 手机远程面板

手机面板使用独立的 `codexwake-dashboard` Worker。部署前在 `wrangler.dashboard.toml` 将 `DASHBOARD_HOST` 改为自己的面板域名，并确保 Durable Object 的 `script_name` 对应主 Worker。本机和手机修改的是同一个 Durable Object。手机上的额度读数是本机上报的历史观测。允许时间、睡眠时间、连续上限、旅行暂停、取消和预约都可远程管理。

```sh
npm run dashboard:cloud:check
npm run dashboard:cloud:deploy
```

手机入口的默认响应是 403。首次开通可在 Cloudflare 网页控制台完成：

1. 打开 **Zero Trust → Access controls → Policies**，添加一个可复用的 **Allow** 策略。规则选 **Include → Emails**，填唯一获准的完整邮箱。如果需要邮件验证码，在 Zero Trust 的登录方式里启用 **One-time PIN**。
2. 回到 **Workers & Pages → codexwake-dashboard → Access**，点 **Protect this Worker behind Access**。选择 **All traffic**，在 **Authentication policy** 选择刚才的策略，然后点 **Apply Access**。原来的 `codexwake` Worker 负责本机上报和 GitHub OIDC，请把 Access 限定在 `codexwake-dashboard`。
3. 到 **Zero Trust → Access controls → Applications**，编辑该应用，在 **Additional settings** 复制 **Application Audience (AUD) Tag**。
4. 回到 **Workers & Pages → codexwake-dashboard → Settings → Variables and Secrets**。点 **Add**，类型选 **Secret**。添加 `DASHBOARD_ACCESS_AUD`（第 3 步的 AUD）和 `DASHBOARD_ALLOWED_EMAIL`（第 1 步同一个邮箱），点 **Deploy**。
5. 用 iPhone Safari 打开手机入口，用获准邮箱登录。使用 One-time PIN 时，输入邮件中的验证码。登录后可以通过 Safari 的分享菜单添加到主屏幕。

[保护单个 Worker](https://developers.cloudflare.com/workers/configuration/cloudflare-access/#protect-one-worker) · [查找 AUD](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/#get-your-aud-tag) · [设置 Worker Secrets](https://developers.cloudflare.com/workers/configuration/secrets/#via-the-dashboard)

也可以在已登录 Wrangler 的本机终端执行第 4 步，在提示中分别输入值：
```sh
npx wrangler secret put DASHBOARD_ACCESS_AUD --config wrangler.dashboard.toml
npx wrangler secret put DASHBOARD_ALLOWED_EMAIL --config wrangler.dashboard.toml
```

Worker 同时要求 Cloudflare 验证的身份、匹配的 AUD 和精确邮箱。以无痕窗口验证登录保护，再用获准邮箱在 iPhone Safari 登录。可保存到主屏幕。验证修改时段后本机刷新可见，最后改回原配置。手机端操作遇到断网或冲突时先刷新确认状态。保留生产自动预热开关关闭，直到完成已授权的真实发送验收。

## 通知

默认 `notifySuccess: false`。如需通知，先用 `npx wrangler secret put SUCCESS_WEBHOOK_URL` 在交互终端安全设置兼容 HTTPS webhook，再把配置的 `notifySuccess` 改为 `true`。Webhook 接收 JSON：事件名 `codexwake.activation_completed_unverified`、完成时间和 `conservative_estimate` 标识；不包含消息或凭证。通知只尝试一次，失败不会触发额外模型请求，也不能保证送达。

## 凭证和失败恢复

本机 `~/.codexwake/codex` 是初始独立登录目录，云端工作流启用后不要再用这份本机 OAuth 缓存运行 Codex；刷新后它可能过期。所有使用同一云端凭证的工作流必须共享 `codexwake-oauth` 并发组，并在访问凭证前通过版本和 OIDC 检查。

如果状态为 `FAILED` 或长时间停在 `DISPATCHING` / `ACTIVATING`，先关闭自动激活并查看对应的私有 GitHub Actions 运行。401、刷新令牌过期、取消授权和网络故障目前统一按不明确结果处理；日志不会输出 token。对于有确认 run ID、GitHub 已确认运行结束且 `credentialUpdateWriteState` 为空的情况，可在上述环境变量设置后执行：

```sh
CODEXWAKE_CONFIRM_RECOVERY=yes npm run config -- recover
```

恢复会核对仓库、工作流、提交、run ID 和完成状态，关闭自动激活并清除协调器的凭证版本，**要求重新登录与导入**；它不会自动重发消息。确认状态为 `WAITING` 且自动开关关闭后，在本机交互终端设置 `CODEXWAKE_GITHUB_OWNER` 和 `CODEXWAKE_GITHUB_REPO` 指向自己的私有仓库，再执行：

```sh
npm run reauth
```

该命令创建新的隔离 `CODEX_HOME`，打开 ChatGPT 登录，在本机读取可用模型，并使用本机 `gh` 登录令牌加密导入新凭证；随后登记模型和新的保守计时，确认成功后删除这次本机临时登录副本。保持 `CODEXWAKE_RESUME` 未设置，生产自动预热仍待验收。它不会把本机 `gh` 的令牌交给 Worker 或 Runner。若原模型不可用，命令显示可用模型，可通过 `CODEXWAKE_MODEL` 选择实际列表中的 ID 后重新执行。不要重新使用旧缓存。

模型不可用或 CLI 版本升级后的维护使用同一流程：先 `npm run config -- disable`，等待状态为 `WAITING`，再运行 `npm run reauth`。重新认证不会解除自动激活限制。如果 Secret 写回结果不明确，命令会停止并保留此次隔离登录目录；不要再次运行或删除它，先按照下面的状态不明流程处理。

如果 `credentialUpdateWriteState` 为 `writing`、bootstrap 写授权结果不明、dispatch 结果为 `unknown`，或者 GitHub 运行状态无法核实，自动恢复会拒绝。GitHub Secrets API 不提供 compare-and-swap，不能在结果不明后重复 PUT；保持停机，核查并撤销可能仍有写权限的旧任务或令牌后，再人工制定重登方案。不要手工修改 Durable Object 状态。

## GitHub 最小权限令牌

在 [GitHub fine-grained personal access tokens](https://github.com/settings/personal-access-tokens/new) 分别创建两个令牌，均只选择自己的私有执行仓库：一个授予 Actions Read and write，另一个授予 Secrets Read and write。GitHub 自动要求的 Metadata 为只读。选择到期时间并自行安排轮换；Secrets 写权限适用于整个仓库，不能限制到某一个 Secret。

设置 `CODEXWAKE_GITHUB_REPOSITORY=OWNER/REPO` 后，在本机运行 `npm run setup:github-tokens`，按隐藏提示分别粘贴；前者写入 Worker，后者写入仓库 Secret。脚本不能替代对实际权限和到期时间的核查。

## 更新与验证

在项目目录执行 `npm ci`、`npm test`、`npm run check`。工作流运行使用提交 SHA 固定：每次推送新提交后，在关闭自动激活、确认无进行中任务时，将 Worker Secret `GITHUB_OIDC_WORKFLOW_SHA` 更新为新提交 SHA，然后运行 `wake.yml` 的 OIDC smoke 模式验证，再考虑重新开启。不要在活动任务中更换 pin 或绕过协调器。
