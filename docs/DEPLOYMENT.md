# 部署指南

CodexWake 将公开源码与私人执行环境分开。以下步骤以 macOS、Node.js 24+、GitHub CLI 和 Cloudflare Wrangler 为基础。请先阅读 [操作手册](OPERATIONS.md) 中的凭证与失败恢复说明。

## 1. 创建私有执行仓库

从源码创建自己的**私有** GitHub 仓库并推送代码。所有包含 ChatGPT OAuth 或写入 Secrets 权限的工作流都必须在私有仓库运行。记录仓库的 `OWNER/REPO`，以项目根目录作为后续命令目录。确认 Actions 可以在该仓库运行。

```sh
npm ci
npm test
npm run check
npx wrangler login
gh auth login
```

## 2. 配置主 Worker

先在 Cloudflare 创建 KV 命名空间，并将返回的 ID 填入 `wrangler.toml` 的 `STATE_SNAPSHOTS`。这是非权威状态镜像，Durable Object 负责权威状态。按文件中的占位符填写下列信息：

- `GITHUB_DISPATCH_OWNER` 和 `GITHUB_DISPATCH_REPO` 指向私有执行仓库。
- `GITHUB_OIDC_REPOSITORY_ID` 和 `GITHUB_OIDC_OWNER_ID` 是 GitHub 返回的数字 ID。可使用 `gh api repos/OWNER/REPO --jq '.id, .owner.id'` 查询。
- `GITHUB_OIDC_AUDIENCE` 为主 Worker 的 HTTPS 源地址。
- `GITHUB_OIDC_WORKFLOW_REF` 为 `OWNER/REPO/.github/workflows/wake.yml@refs/heads/main`。如果使用其他受信任的默认分支，还需同步修改 `GITHUB_OIDC_REF`。
- 保持 `ACTIVATION_ENABLED` 和 `ACTIVITY_WAKES_ENABLED` 为 `false`，先部署并完成配置。

```sh
npx wrangler kv namespace create STATE_SNAPSHOTS
npx wrangler deploy
```

在仓库 GitHub Actions Variables 中设置 `CODEXWAKE_WORKER_URL` 和 `CODEXWAKE_OIDC_AUDIENCE`，均使用主 Worker 的 HTTPS 源地址。

设置管理员令牌。下列命令创建仅当前用户可读取的文件并通过标准输入上传。管理员令牌和活动上报令牌必须不同。

```sh
mkdir -p -m 700 ~/.codexwake
node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("base64url"))' > ~/.codexwake/admin-token
chmod 600 ~/.codexwake/admin-token
npx wrangler secret put ADMIN_TOKEN < ~/.codexwake/admin-token
printf '%s\n' 'https://YOUR-WORKER.workers.dev' > ~/.codexwake/worker-url
chmod 600 ~/.codexwake/worker-url
```

把上面地址替换为自己的 Worker 地址。`worker-url` 供本机 hook 和按需面板使用。需要时可以用 `CODEXWAKE_ADMIN_URL` 覆盖。

## 3. 配置最小权限令牌与工作流身份

创建两个只允许访问私有执行仓库的 GitHub fine-grained token。第一个授予 Actions Read and write，供 Worker 派发工作流。第二个授予 Secrets Read and write，供 Runner 更新 OAuth Secret。GitHub 会附带只读 Metadata 权限。

```sh
export CODEXWAKE_GITHUB_REPOSITORY='OWNER/REPO'
npm run setup:github-tokens
```

脚本会通过不回显的提示接收令牌。完成后将当前已推送的可信提交 SHA 固定到 Worker，再运行不发送消息的 OIDC smoke。每次更新工作流提交后，都需要在暂停且无运行中任务时更新 SHA。

```sh
git rev-parse HEAD | npx wrangler secret put GITHUB_OIDC_WORKFLOW_SHA
gh workflow run wake.yml --ref main -f attempt_id="$(uuidgen | tr '[:upper:]' '[:lower:]')" -f smoke_test=true
```

在 GitHub Actions 确认 `oidc-smoke` 成功、`activate` 跳过。公开项目代码更新必须先审查，只有可信的提交才可使用上述凭证。

## 4. 登录并登记模型

在 `wrangler.toml` 将 `ACTIVATION_ENABLED` 改为 `true` 并重新部署。`ACTIVITY_WAKES_ENABLED` 保持 `false`，管理员自动开关也保持关闭。下面的命令使用独立目录交互式登录 ChatGPT，查询该账号当前可用模型并导入 OAuth。选择 CLI 实际返回的模型 ID。

```sh
export CODEXWAKE_GITHUB_OWNER='OWNER'
export CODEXWAKE_GITHUB_REPO='REPO'
export CODEXWAKE_MODEL='YOUR_AVAILABLE_MODEL_ID'
npm run reauth
```

若尚不知道模型 ID，可先省略 `CODEXWAKE_MODEL` 运行，查看返回的可用列表，再选择模型重新运行。被阻止或结果不明确时，工具可能保留隔离登录目录以供恢复。不要公开、复制或随意删除其中的凭证。成功后该临时目录会被清理。模型不能仅凭名称推断用量。

接着用独立观察器登录相同 ChatGPT 账号，配置活动令牌并安装本机 hook：

```sh
mkdir -p -m 700 ~/.codexwake/observer
CODEX_HOME="$HOME/.codexwake/observer" node_modules/.bin/codex -c 'cli_auth_credentials_store="file"' login
npm run activity -- observe
npm run setup:activity-token
npm run monitor:install
npm run dashboard:install
```

重启或重新打开兼容的 Codex 客户端，按客户端提示审核并允许两个 hook。查看 `npm run monitor:status` 和本机面板的观测状态。hook 不会获得其他设备的活动。

## 5. 验证和启用

默认不发送模型请求。检查时区、工作时间、睡眠时段、模型及账号额度。需要验证真实发送时，在自动开关关闭的状态下明确执行一次 `test-now`，观察私有 Actions 运行及额度变化。

```sh
export CODEXWAKE_ADMIN_URL="$(cat ~/.codexwake/worker-url)"
export CODEXWAKE_ADMIN_TOKEN="$(cat ~/.codexwake/admin-token)"
npm run config -- status
npm run config -- test-now
unset CODEXWAKE_ADMIN_TOKEN
```

确认结果符合预期后，将 `ACTIVITY_WAKES_ENABLED` 改为 `true` 并重新部署，再在面板中开启自动激活。`completed_unverified` 表示 CLI 完成，仍需观察账号额度以确认窗口行为。手机端 Access、暂停与恢复见[操作手册](OPERATIONS.md)。
