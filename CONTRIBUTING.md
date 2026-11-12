# 参与开发

这个插件是「一个文件夹 + 一台装了 DSH 的机器」就能跑起来的类型：没有构建步骤，Host 侧是普通 ESM，客户端是 `window.__ModuleLoader__` 里手写 `h()`。改完刷新页面就能看到效果，不需要打包。

## 本地起来

```bash
git clone https://github.com/liweitan2046-cyber/dsh-wanfeng-studio.git
```

在 DSH 里安装这个目录（软链安装，改源码立即生效）：

```
plugin_manager(action="install_bundle", target="<克隆目录的绝对路径>")
```

然后刷新 Web UI，侧栏出现「万风工作台」。

## 跑测试

```bash
npm run check                    # 每个文件的语法检查
node selftest.mjs                # 21 项后端自测，需要真实作品库
```

没有作品库（或想跑干净的 CI 场景）时用隔离模式，脚本会自己造几个作品文件夹：

```bash
WANFENG_ROOT=/tmp/wanfeng-root node selftest.mjs
```

Windows PowerShell：

```powershell
$env:WANFENG_ROOT="C:\Temp\wanfeng-root"; node selftest.mjs
```

自测**不需要任何 API Key**：出图、换人这些付费路径只验证「没配 Key 时给出正确失败」，不会真的调用。

## 目录结构

| 文件 | 职责 |
| --- | --- |
| `index.js` | Host 入口，组装 config / index / ff / rh / ai / flow / routes，注册 `/wanfeng-studio` 前缀路由 |
| `client.js` | 全部界面（React 手写 `h()`，无 JSX、无构建），包含 CSS |
| `src/config.js` | 配置读写、默认值、Key 打码 |
| `src/scan.js` | 作品与素材索引 |
| `src/ff.js` | ffmpeg / ffprobe：探测、抽帧、缩略图、拼接 |
| `src/rh.js` | RunningHub：账号、工作流 JSON、上传、建任务、轮询、费用 |
| `src/ai.js` | APIMart：视觉问答（质检）、图生图（角色图） |
| `src/workflows.js` | 任意工作流的节点探测与参数填充 |
| `src/project.js` | 复刻项目状态机：原片 / 角色图审核门 / 换人 / 质检 / 成片 |
| `src/routes.js` | HTTP 路由与参数校验 |

## 代码约定

- **ESM，不引入构建工具。** Node 侧用 `import`，别写 `require`（`src/project.js` 曾经因此报过 `require is not defined`）。
- **客户端不要 require Harness 的内部包**，只能用 `react`、`react/jsx-runtime` 这类注入包；控件自己写。
- **不要引用 `--dsw-alias-*` 主题变量。** 宿主的皮肤中心会在运行时重写它们，工作台是固定深色，颜色与关键尺寸直接写字面值（这是踩过的坑，见 `client.js` 里 `.wf-card` 的三层样式保险）。
- **页面必须是 slot 里的 React 组件**，不要 iframe、不要独立 HTML 文件。
- **文案统一走 `ctx.locale`**，新增字符串记得两边都加。
- **审核门不许绕过**：`POST /flow/swap/start` 在没有 approved 角色图时必须 403，别为了调试方便加后门。
- **付费调用要有明确的前端提示**，并且失败要如实报出来（包括「接口异常 → SKIP」而不是假装通过）。

## 提交

- 一个提交做一件事，信息用 `feat:` / `fix:` / `docs:` / `style:` 前缀。
- 界面改动附一张截图。
- 涉及接口返回结构变化时，前端与 `selftest.mjs` 一起改。

## 不要提交的东西

`config.json`（里面有 Key）、`workflows/`、`生成结果/`、`上传素材/`、`自测-*` 都已在 `.gitignore` 里。提交前跑一次 `git status` 看一眼。

## 安全

发现安全问题（比如路径穿越、Key 泄漏、审核门可绕过）请不要开公开 issue，直接发邮件或在仓库里用 Security → Report a vulnerability。