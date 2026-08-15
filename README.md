# dsh-dashboard

[DeepSeek Harness](https://github.com/deepseek-ai/DeepSeek-Harness)（DSH）web 界面的工作台插件：为会话视图补充侧边栏、底部面板与一组文件/任务工具面。单包双半结构（host + client），按 DSH 官方插件规范组织，不修改宿主源码。

**核心能力**：文件资源管理、编辑与多种格式预览、内嵌浏览器、真实终端、Git 面板、后台任务视图，以及供第三方插件注册扩展页面与文件预览器的 `ctx.dashboard` 服务。

基于 [omdsh-dev/DSH-better-sidebar](https://github.com/omdsh-dev/DSH-better-sidebar) 二次开发（fork，v0.10.3），后续演进独立进行；上游的接入文档由本仓库的 [AGENTS.md](./AGENTS.md) 延续。

<div align="center">

中文 · <a href="./README_EN.md">English</a>

</div>

## 概述

DSH 的会话视图原生提供对话流与轨迹两栏，长任务中对工作区文件的查看、编辑与对照需求没有承载面。本插件在会话视图右侧挂载一个 VSCode 式工作台：右侧栏与底部面板各持有独立的标签页体系，支持分栏与拖拽；所有状态（布局、分栏、标签、面板开关）按会话隔离持久化。

技术路线要点：

- **零宿主侵入**。插件作为独立 npm 包被 profile 引用，通过 cordis 挂载机制接入；不改 DSH 源码、不反向依赖其构建。
- **host/client 双半**。host 半提供会话级 HTTP/WebSocket API（文件系统、git、伪终端、媒体路由），全部经过与宿主 `/api` 一致的信任围栏；client 半通过 slot 机制挂接界面。
- **按需加载**。重依赖（Univer、docx-preview、pptx-renderer、CodeMirror、xterm）按功能分块，首次使用时经插件自有路由下发；核心包约 325KB。

演示视频与界面截图见发布页。

## 功能

### 文件与编辑

- **资源管理器**：懒加载目录树（根 = 会话 cwd），点击在侧边栏打开；行尾悬浮按钮插入 `@文件` 引用到输入框；右键复制相对/绝对路径。
- **编辑与预览**：CodeMirror 6 多语言语法高亮，Ctrl/Cmd+S 原子保存；图片、Markdown（预览/编辑切换）、HTML（沙箱 iframe，可加载相对资源）、PDF、Word、Excel、PPT 内联预览；切换标签不丢失未保存草稿。

### 工作台

- **分栏体系**：拖动标签拆分/合并分栏（支持跨面板拖动），分隔线调节比例；两面板共享拐角，可双向拖动调节尺寸。
- **底部面板**：与右侧栏同构的第二个工作台，只挤占中间 Agent 输出区；右侧栏折叠时自动延伸至对话与轨迹两列下方；首次展开可自动开启一个终端（可在设置中关闭）。
- **输入框折叠**：输入卡可折叠为单行——左侧保留「+ 附加文件」与权限选择（仅图标），中间为单行输入（内容换行后逐行增高，与展开态同上限后转为内部滚动），右侧为展开按钮、模型选择、上下文占用环与发送。折叠带动画过渡（盒高 FLIP 与渐隐），遵循系统减弱动态偏好；状态持久化。
- **会话隔离**：布局/分栏/标签/面板状态按会话持久化于 localStorage，陈旧状态自动清理。

### 扩展面

- **浏览器**：内嵌网页浏览标签（可多开），后退/前进/刷新；内容在不透明源沙箱 iframe 中渲染（详见「安全」），界面实时显示沙箱状态；被 `X-Frame-Options` 等拒绝嵌入的站点显示原因面板。
- **终端**：xterm.js + node-pty 真实 shell（每会话 3 个界面实例上限），标签保活、断线重连回放；可选择为模型注入 8 个 `terminal_*` 工具。
- **Git 面板**：真实 diff 与 diff 标签页、懒加载提交历史、暂存/放弃/提交/还原/捡取。
- **后台任务页**：主会话的完整 agent 拓扑与执行记录跳转；同页汇总当前树的后台任务（类型徽标 + 退出码，实时输出为非消费式 peek，不干扰模型的 `job_output`；二次确认后可强制终止）。
- **移动端**：视口 < 768px 时仅保留右侧栏，底部面板的标签页并入其标签条，以全宽抽屉呈现。

### 平台服务

- **`ctx.dashboard` 服务**：第三方插件可注册侧边栏页面（tab）与文件预览器（viewer）；内置 7 个 tab 与 9 个 viewer 也经同一服务注册。v0.10.4 随包改名，旧服务名 `ctx.betterSidebar` 作为兼容别名仍然解析——已接入的外部插件无需修改。
- **声明式设置**：设置页按注册表渲染功能清单（可逐项启停），功能相关的二级设置经原生弹窗编辑。
- **多语言**：界面文案跟随 DSH 语言设置（zh/en），Host 偏好优先于浏览器语言，切换实时生效。

## 安装（从源码）

从源码构建安装。前置：DSH 已安装（`dsh web` 可运行），Node.js ≥ 20，pnpm ≥ 10。

```sh
# 1. 克隆并构建
git clone https://github.com/Howardzhangdqs/dsh-dashboard.git ~/Code/dsh-dashboard
cd ~/Code/dsh-dashboard && pnpm install && pnpm build

# 2. 放行 node-pty / protobufjs 构建脚本（pnpm 11 默认拦截；pnpm 10 可跳过）
cd ~/.dsh/profiles/web && pnpm approve-builds --all

# 3. 依赖指向本地克隆（package.json 的 dependencies）
#    "dsh-dashboard": "link:/home/you/Code/dsh-dashboard"

# 4. 追加挂载行（cordis.patch.yml）
#    - insert:
#        - id: dashboard
#          name: 'dsh-dashboard'

# 5. 安装并重启
pnpm install
```

完成后重启 DSH 并硬刷新（Cmd/Ctrl+Shift+R）。

更新：`git pull && pnpm install && pnpm build` 后重启 DSH（仅 client 改动可硬刷新）。

<details>
<summary>Windows（PowerShell）等价步骤</summary>

```powershell
git clone https://github.com/Howardzhangdqs/dsh-dashboard.git ~/Code/dsh-dashboard
cd ~/Code/dsh-dashboard; pnpm install; pnpm build

cd ~\.dsh\profiles\web
pnpm approve-builds --all
# package.json dependencies: "dsh-dashboard": "link:<克隆绝对路径>"
# cordis.patch.yml 追加:
#   - insert:
#       - id: dashboard
#         name: 'dsh-dashboard'
pnpm install
```

路径含空格时给 link: 值加引号。重启 DSH 后硬刷新。

</details>

<details>
<summary>npm 通道（上游发布过旧名包；本仓库未发布 npm）</summary>

上游 [omdsh-dev/DSH-better-sidebar](https://github.com/omdsh-dev/DSH-better-sidebar) 以 `dsh-better-sidebar` 发布到 npm；本仓库（改名后的 dsh-dashboard）**不发布 npm**，请从源码安装。仓内仍保留一键脚本（`scripts/install.sh` / `scripts/install.ps1`，按 npm 通道编写）供参考或自行发布后使用。

</details>

<details>
<summary>常见问题</summary>

| 现象 | 原因与处理 |
|---|---|
| `Ignored build scripts` | pnpm 11 拦截构建脚本。执行 `pnpm approve-builds --all`。 |
| `minimum release age` / 版本不足 24h | pnpm 拦截发布不足 24 小时的依赖版本。在 `pnpm-workspace.yaml` 的 `minimumReleaseAgeExclude` 下加该包名，或等待 24 小时。 |
| 「找不到 profile 目录」 | 先运行一次 `dsh web` 初始化 `~/.dsh/profiles/web`。 |
| 页面出现两个侧边栏 | 双挂载：`~/.dsh/profiles/web/cordis.patch.yml` 存在重复的手动挂载行（如上游旧名 `id: better-sidebar` 与 `id: dashboard` 并存），删除多余的那段。 |
| Windows 终端不可用 | `node-pty` 依赖预编译二进制；当前 Node 版本无对应产物时需编译工具链（VS Build Tools）。主流 Node 版本一般已有预编译。 |
| Windows 无 bash / curl | 使用 PowerShell 等价步骤，或安装 Git Bash / WSL。 |

</details>

<details>
<summary>开发</summary>

克隆后 `pnpm install && pnpm build`；日常循环用 `pnpm watch`（tsdown 增量）+ `pnpm test`。调试期 profile 依赖保持 `link:` 指向工作区即可；仅 client 改动硬刷新生效，host 半改动需重启 DSH。

</details>

<details>
<summary>经 plugin-registry 安装（与主流程二选一）</summary>

前置：DSH 已集成 [plugin-registry](https://github.com/dsh-external/plugin-registry)（`dsh registry` 可用）。**两个通道同时启用会双挂载**（Node 半加载两次、页面出现两个侧边栏）。

```sh
git clone https://github.com/Howardzhangdqs/dsh-dashboard.git && cd dsh-dashboard
pnpm install && pnpm build
node scripts/package-registry.mjs   # 组装 registry/ 暂存（清单 + 产物 + README，不入库）
dsh registry install ./registry     # 安装（默认禁用）
dsh registry enable dsh-external/dsh-dashboard
```

更新：`git pull && pnpm install && pnpm build` → `node scripts/package-registry.mjs` → `dsh registry uninstall/install/enable`。切换通道前先移除另一通道的挂载。

</details>

## 快捷键

| 操作 | 按键 |
|---|---|
| 保存编辑 | `Ctrl/Cmd + S` |
| Git 提交 | `Ctrl + Enter` |
| 关闭标签 | 鼠标中键 |
| 拆分/合并分栏 | 拖动标签至分栏边缘 / 中间 |
| 引用文件到输入框 | 悬浮行尾 `@文件` 按钮 |
| 复制文件路径 | 右键行 → 复制相对/绝对路径 |

## 服务接口：注册页面与文件预览器

自 v0.4.0 起暴露 `ctx.dashboard` 服务（v0.10.4 随包改名；旧名 `ctx.betterSidebar` 作为兼容别名仍然解析），第三方插件可注册侧边栏页面与文件预览器：

```ts
import type {} from 'dsh-dashboard'  // 触发 ctx.dashboard 类型合并
export const inject = ['dashboard']  // 旧名 'betterSidebar' 别名同样有效
export function apply(ctx: Context) {
  ctx.effect(() => ctx.dashboard.registerTab({
    id: 'my-plugin:db', title: 'Database', component: ({ scope }) => <DbView sessionId={scope.sessionId} />,
  }))
}
```

完整接入文档（`TabDescriptor` / `FileViewerDescriptor` 字段定义、匹配算法、HMR 生命周期、声明式设置）见 [`AGENTS.md`](./AGENTS.md)。

## 开发与构建

```sh
pnpm install      # @deepseek-ai/* 已发布到 npm（^0.1.0-rc.6），直接解析
pnpm typecheck    # tsc --noEmit
pnpm build        # → lib/index.js + lib/invariant.js + lib/client.js + lib/client-registry.js + lib/types
pnpm test         # vitest（含 manifest 一致性守卫；需先 build）
pnpm watch        # tsdown --watch
```

**架构**：单 npm 包、host/client 双半结构。host 半（`src/index.ts`）提供 `/sidebar/api/*` JSON API、`/sidebar/file` 媒体路由、`/sidebar/html` 预览路由、`/sidebar/ws/terminal` WebSocket（文件系统 / git / 伪终端 / 预览，全部会话级并经信任围栏）；client 半（`src/client/index.tsx`）负责 portal 侧边栏、各视图与拦截；状态按会话持久化于 localStorage。运行期不依赖 npm 或源码 checkout（`@deepseek-ai/*` 由 web profile 提供）。

## 安全

- 路由受 Host 头信任围栏保护（与 `/api` 一致）；`fs.write` 原子写入；媒体/预览路由仅限会话 cwd 内文件；git 仅调用 CLI，不设置身份。
- HTML 预览与浏览器标签的内容在**不透明源沙箱 iframe** 中渲染：无 `allow-same-origin` / `allow-top-navigation`、`no-referrer`、权限策略全禁；`/sidebar/html` 路由附加 CSP `sandbox` 与大小/路径边界；地址栏拒绝 `javascript:` / `data:` / `file:` 与 localhost 等本机地址。
- 界面实时显示沙箱状态（关闭时红色警示），可临时解锁当前页面；设置页可按功能关闭沙箱（默认关闭该开关并附警告文案）——关闭后内容与界面同源，仅建议用于完全可信内容。

## 已知限制

- Git 不支持 push/pull/fetch；无文件监听（手动刷新）；工具行内文件打开按钮不可拦截。
- 终端标签拖至另一分栏会重挂载（shell 重启）。
- `.xlsx` 预览不保留单元格样式（SheetJS 社区版限制）；Office/PPTX 预览内联进 client bundle（约 23MB），首次加载较慢。
- HTML 预览渲染已保存文件（不反映未保存草稿）。
- 移动端（<768px）无底部面板：进入窄屏时其标签页一次性并入右侧栏；桌面端底部面板仅在宽视口可用。

## 平台支持

Windows / Linux / macOS 三平台适配（Linux 日常验证，其余经单元测试覆盖）。`node-pty` 优先使用预编译二进制，缺失时需编译工具链（Windows VS Build Tools / Linux make+g+++python3 / macOS Xcode CLT）。

## 许可

MIT（见 [LICENSE](./LICENSE)）。
