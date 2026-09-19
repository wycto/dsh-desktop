# DSH Desktop — DSH Web 桌面启动器

> Desktop launcher for DeepSeek dsh (`npx @deepseek-ai/dsh web`) — double-click to run, no command line needed.

给不会用命令行的人用的 **`npx @deepseek-ai/dsh web`** 桌面壳。双击运行，点一下按钮，dsh 的网页界面直接出现在窗口里。

## 这是什么

**DSH Desktop** 是 DeepSeek 官方 npm 工具 `@deepseek-ai/dsh` 的 **Web 界面桌面壳**。dsh 的网页版平时要开终端敲 `npx @deepseek-ai/dsh web`，前提是机器上已经有 Node.js，启动后还得自己复制带 token 的网址去浏览器打开。这个项目把整条链路包成一个双击就能用的桌面 App：

**双击图标 → 点"启动服务" → dsh 界面直接出现在窗口里。**

- Node.js 没装？引导页点一下自动下载安装官方 LTS
- 装了多种 Node？自动探测 Homebrew、nvm、fnm、volta、scoop 等常见位置并实际运行验证
- 有新版本？启动时自动查 npm 源，可选"发现更新自动安装"
- 断网了？自动回退本地缓存版本继续用，不会卡住

## 适合谁用

- 不熟悉命令行、但想用上 dsh Web 界面的人
- 帮同事、朋友、家人装 dsh 的"技术担当"：你装完之后，他们以后双击就能用，不用再找你
- 想要"自动更新、离线也能跑"的省心启动方式的人
- macOS（Apple Silicon / Intel）与 Windows 64 位用户

## 和手动命令行跑有什么区别

| | 手动命令行跑 dsh | DSH Desktop |
|---|---|---|
| 前置条件 | 自己装 Node.js、配 PATH | 没有一键引导安装，有就自动探测并验证 |
| 日常启动 | 开终端，敲 `npx @deepseek-ai/dsh web` 带参数 | 双击图标，点"启动服务" |
| 打开界面 | 自己复制带 token 的网址到浏览器 | 自动解析地址，内嵌窗口直接显示，也可一键浏览器打开 |
| 版本更新 | 自己查新版、手动升级 | 启动时自动查 npm 源新版，可勾选自动安装 |
| 断网情况 | 本地没缓存时 npx 拉不到包 | 自动改用本地缓存版本（`npx --offline`） |
| 出错时 | 面对命令行报错 | 中文横幅 + 日志提示，如端口被占用 |

## 下载安装

前往 [GitHub Releases](https://github.com/wycto/dsh-desktop/releases) 下载对应平台的安装包：

| 平台 | 文件 | 说明 |
|---|---|---|
| macOS Apple Silicon | `DSH.Desktop-<版本>-arm64.dmg` | M1/M2/M3/M4 |
| macOS Intel | `DSH.Desktop-<版本>.dmg` | x64 |
| Windows 64 位 | `DSH-Desktop-Setup-<版本>.exe` | 一键安装，装完自动启动 |

> 安装包未做代码签名：macOS 首次打开若提示"无法验证开发者"，右键 App → 打开，或到
> 系统设置 → 隐私与安全性里点"仍要打开"；Windows 若弹出 SmartScreen，点"更多信息 → 仍要运行"。

## 功能

- **傻瓜式启动**：只需要填监听 IP（默认 127.0.0.1）和端口，点"启动服务"。
- **内嵌页面**：dsh 启动后自动解析带 token 的地址，把 DeepSeek Harness 界面嵌进窗口；
  也可点"浏览器打开"在系统浏览器中使用。
- **更新弹窗**：启动时自动查询 npm 源上的最新版本。发现新版本会弹窗询问"立即更新并启动 / 使用当前版本启动"，
  勾选"发现更新后自动安装"则不再询问。查询失败（离线）时自动改用本地缓存版本（`npx --offline`），不会卡住。
- **Node.js 一键安装**：第一次使用没有 npm 时，显示引导页，点一下即自动下载官方 LTS 安装包并静默安装
  （macOS 会请求一次开机密码，Windows 会弹一次 UAC 确认）。
- **环境探测**：自动扫描官方安装、Homebrew、nvm、fnm、volta、scoop、asdf、`~/.local/bin` 等常见位置，
  并回退到用户登录 shell 查找，找到的 Node 还会实际运行验证。
- **离线兜底 / 错误提示**：端口被占用、npm 源不可达等失败会以中文横幅 + 日志提示，不会让用户面对命令行。
- 设置（IP/端口/工作目录/更新选项）持久化到用户数据目录 `settings.json`。

## 技术实现

- Electron 37 + electron-builder 26；主进程 ESM（`src/main.mjs`），上下文隔离 + preload 桥接。
- dsh 的启动命令本质是 `node <npm 内置 npx-cli.js> -y --prefer-offline @deepseek-ai/dsh@<版本> web --no-open --host <ip> --port <端口>`：
  用固定版本号 + `-y` 避免任何交互式 y/N 提示；更新询问完全由壳自己查 registry 驱动。
- dsh 不支持 `--host 0.0.0.0`（安全限制，会拒绝启动），界面已做拦截提示。
- 启动成功以 stdout 的 `dsh web: http://…/?token=…` 行为准，解析后内嵌加载。

## 开发

```bash
npm i                # 若 electron 二进制未下载：node node_modules/electron/install.js
npm start            # 开发运行
npm run dist:mac     # 打 macOS dmg（arm64 + x64）
npm run dist:win     # 打 Windows NSIS exe
npm run gen:icon     # 重新生成 build/icon.png
```

国内网络建议带镜像环境变量：

```bash
ELECTRON_MIRROR='https://npmmirror.com/mirrors/electron/' \
ELECTRON_BUILDER_BINARIES_MIRROR='https://npmmirror.com/mirrors/electron-builder-binaries/' \
npx electron-builder --mac --win
```

## E2E 自测脚本

```bash
scripts/run-e2e.sh t1 'DSH_E2E_SETTINGS={"port":18501}'            # 开发版全流程
scripts/run-e2e-pack.sh update                                     # 打包版全流程（更新弹窗自动选"更新"）
DSH_E2E=1 DSH_E2E_FAKE_NO_NODE=1 DSH_DESKTOP_INSTALL_DRYRUN=1 …    # 模拟缺 Node + 干跑安装下载
```

E2E 过程中的关键节点会写到 `/tmp/dsh-e2e.log`，窗口截图写入 `/tmp/dsh-e2e-<标签>-*.png`。

## 许可证

[MIT](LICENSE)
