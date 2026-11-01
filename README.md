# dsh-turn-notify

DSH 的 Windows 系统通知插件，在会话结束一轮运行时提醒你。

# 作者的碎碎念

dsh为啥还没有后台消息通知啊……后台跑任务的时候根本不知道任务跑完没。所以就vibe coding了一个插件。

## 功能

- 会话本轮运行结束后发送系统通知，标题显示会话名称。
- 正文默认显示“本轮已完成”；观察到本轮开始时间时，同时显示耗时。
- 点击通知可将 DSH 窗口拉回前台。
- 默认前台、后台均提醒，可设置为正在查看该会话时不打扰。
- 默认跳过子代理会话，避免重复打扰。
- 结合状态订阅、完成标记和两秒轮询检测回合结束，并对同一完成周期去重。

通知依赖 DSH 客户端保持运行及系统通知权限。DSH 完全退出后无法提醒。
“本轮已完成”表示运行已结束，不区分成功、失败或取消；仅靠轮询且没有完成标记时，
两次采样之间结束的短回合仍可能漏报。

## 安装

需要 Windows、DSH 桌面客户端，以及客户端提供的 `dsh` 命令。

1. 安装 npm 包，桌面版使用 `desktop` profile：

   ```sh
   dsh plugin --profile desktop add @99galaxy/dsh-turn-notify
   ```

   也可直接从 GitHub 安装：

   ```sh
   dsh plugin --profile desktop add github:99galaxy/dsh-turn-notify
   ```

2. 重启 DSH，并确保 Windows 允许 DSH 发送系统通知。安装器通过包内的 `dsh.bundle` 自动注册插件，无需手动追加 `insert`。

   如需修改默认设置，在该 profile 的 `cordis.patch.yml` 顶层数组末尾添加配置覆盖：

   ```yaml
   - id: dsh-turn-notify
     config:
       enabled: true
       notifyWhenFocused: true
       skipSubagents: true
       message: 本轮已完成
   ```

配置说明：

| 配置项 | 默认值 | 作用 |
| --- | --- | --- |
| `enabled` | `true` | 是否启用通知 |
| `notifyWhenFocused` | `true` | 设为 `false` 时，窗口在前台且正在查看该会话则不提醒 |
| `skipSubagents` | `true` | 是否跳过子代理会话 |
| `message` | `本轮已完成` | 通知正文前缀 |

配置需要 profile 提供 `webServer` 服务。修改配置后重启 DSH，使客户端重新读取。

## 项目目录

```text
.
├── lib/
│   ├── index.js       # Host 入口及客户端配置接口
│   └── client.js      # 会话状态检测和系统通知
├── test/
│   └── smoke.mjs      # 回归测试
├── .gitignore         # 本地配置、凭据及构建产物忽略规则
├── LICENSE            # MIT 许可证
├── cordis.patch.yml   # DSH bundle 安装入口
├── package.json       # 包信息与 DSH 客户端声明
└── README.md
```

## 从源码构建

需要 Node.js 22 或更新版本、Git；本地安装到 DSH 时还需要 pnpm。
项目以原生 JavaScript 编写，无第三方运行依赖，也不需要转译或打包器；`lib/` 中的代码就是发布入口。

```sh
git clone https://github.com/99galaxy/dsh-turn-notify.git
cd dsh-turn-notify

node --check lib/index.js
node --check lib/client.js
node test/smoke.mjs

npm pack --dry-run
npm pack
```

最后一条命令在项目目录生成 `99galaxy-dsh-turn-notify-<version>.tgz`。执行
`dsh plugin --profile desktop add <插件压缩包的路径>`，再重启 DSH。
每次修改源码后，需重新打包、安装，再重启客户端。

## 开源许可

本项目采用 [MIT License](LICENSE)。允许使用、修改和分发，须保留版权声明与许可证文本。
