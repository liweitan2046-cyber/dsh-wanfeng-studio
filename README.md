# 万风复刻工作台 · dsh-wanfeng-studio

[![npm](https://img.shields.io/npm/v/dsh-wanfeng-studio?logo=npm&color=cb3837)](https://www.npmjs.com/package/dsh-wanfeng-studio)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![CI](https://github.com/liweitan2046-cyber/dsh-wanfeng-studio/actions/workflows/ci.yml/badge.svg)](https://github.com/liweitan2046-cyber/dsh-wanfeng-studio/actions/workflows/ci.yml)
[![GitHub](https://img.shields.io/badge/GitHub-liweitan2046--cyber%2Fdsh--wanfeng--studio-181717?logo=github)](https://github.com/liweitan2046-cyber/dsh-wanfeng-studio)

一个装在 [DeepSeek Harness](https://github.com/deepseek-ai) 里的**爆款短视频复刻工作台**。
从侧栏「万风工作台」进入，把「选原片 → 出角色图 → 换人 → 质检 → 成片」整条流水线放在一个界面里，
顺手带素材库、三轨时间线和 RunningHub 任意工作流接入。

> 设计前提：**你用自己的 API Key**。插件本身不代付、不内置任何人的 Key，也不会上传你的素材到除你配置的服务之外的任何地方。

![工作流实验室](https://cdn.jsdelivr.net/gh/liweitan2046-cyber/dsh-wanfeng-studio@main/docs/labs.png)

> 上图：左侧内置工作流，中间是探测出的 24 个节点与输入映射，右侧填工作流 ID 并运行。

---

## 它是怎么工作的

一条复刻任务的五步，对应界面里的五段进度：

| 阶段 | 做什么 | 花钱吗 |
| --- | --- | --- |
| ① 原片 | 选一条 mp4 当底片，按镜头切分（也可以整条） | 否 |
| ② 角色图 | 用图形模型按「服装 / 姿势 / 场景」重画主角，**必须人工审核通过** | 是（APIMart 图片） |
| ③ 换人 | 每个镜头跑一次换人工作流，人物替换、机位与背景保持原片像素 | 是（RunningHub） |
| ④ 质检 | 抽 12 帧 + 前 8 帧，视觉模型判定身份 / 第二张脸 / 变形 / 烧录文字 / 跳变 | 是（视觉模型，通常很便宜） |
| ⑤ 成片 | 拼接所有通过镜头，可选 SeedVR2 超分到 1080p | 拼接免费，超分要钱 |

### 审核门是硬的

角色图没有点「通过」，**换人接口直接返回 403**，后端和前端都拦。
这不是 UI 提示，是 `POST /flow/swap/start` 里的服务端校验 —— 避免「手滑跑掉一晚上额度」。

---

## 界面

- **顶栏**：项目名 / 序列规格（宽×高·帧率）/ 刷新 / ＋导入 / 复刻·工作流·素材库切换 / 审阅与导出
- **左栏**：复刻 · 工作流 · 素材 · 作品 · 任务 · 设置 六个 tab
  - 复刻：新建 / 导入项目，项目列表带阶段徽章
  - 工作流：内置换人与超分，也能接别人的工作流
  - 素材：图片 / 视频 / 音频卡片，点选即预览
  - 作品：按作品文件夹聚合，阶段徽章（成片 / 视频素材 / 待自查 …）
  - 任务：直接跑项目里的 `.py` / `.ps1` / `.cmd` 脚本，实时看日志
  - 设置：项目根目录、Python、ffmpeg、所有 API 配置与连通测试
- **中栏**：交互预览 + 播放控制；复刻模式是五步 stepper；工作流模式是输入映射与节点探测结果
- **右栏**：序列设置 / 选中素材详情 / 角色图生成表单 / 换人提交 / 质检帧条
- **底部时间线**：Video / Graphics / Audio 三轨，草稿自动保存到 `<项目根>/.wanfeng-studio/timeline.json`

---

## 安装

插件以 DSH bundle 的形式安装。装法有两种，任选其一。

**方式 A：从 npm 装（推荐）**

```bash
npm install -g dsh-wanfeng-studio
```

然后让 DSH 安装这个包所在目录（Windows 上是 `npm root -g` 下的 `dsh-wanfeng-studio`）：

```
plugin_manager(action="install_bundle", target="<全局 node_modules 里的 dsh-wanfeng-studio 目录绝对路径>")
```

**方式 B：从 GitHub 克隆**

```bash
git clone https://github.com/liweitan2046-cyber/dsh-wanfeng-studio.git
```

然后在 DSH 里：

```
plugin_manager(action="install_bundle", target="<克隆下来的目录绝对路径>")
```

安装完刷新 Web UI，侧栏会出现「万风工作台」。之后改源码不需要重装（bundle 是软链），刷新页面即可。

要求：

- DSH `>= 0.2.2-rc.1 < 0.3.0`
- Node.js `>= 20`
- `ffmpeg` / `ffprobe` 在 PATH（也可以在设置里填绝对路径）
- Python 3（只有「任务」tab 跑脚本时需要）

---

## 配置

两种方式，等价：

1. 界面里的 **设置 → API** 填完点「保存 API 设置」
2. 直接改 `~/.dsh/wanfeng-studio/config.json`（Windows：`C:\Users\<你>\.dsh\wanfeng-studio\config.json`）

```jsonc
{
  "root": "D:\\codex\\wanfeng",        // 项目根目录，随时可改；所有项目都是它下面的文件夹
  "python": "python",
  "uploadDir": "上传素材",
  "ignore": ["ComfyUI", "ComfyUI-venv", "__pycache__", "node_modules", ".git"],
  "person": { "name": "噗噗", "describe": "短发、单眼皮、冷白皮，日常淡妆" },

  "runninghub": {
    "base": "https://www.runninghub.cn",
    "key": "",                          // 支持逗号分隔多个 Key，会按并发轮着用
    "swapWorkflowId": "2109190174289780738",
    "upscaleWorkflowId": "1989896719183867905",
    "concurrency": 5,
    "coinCny": 0.0022166                // RH 币兑人民币，只用来估算费用
  },

  "apimart": {
    "base": "https://api.apimart.ai/v1",
    "visionBase": "https://api.apimart.ai/v1",
    "key": "",                          // 图片生成 Key
    "visionKey": "",                    // 视觉 Key，留空回退到 key
    "imageModel": "gpt-image-2.5-sunburst",
    "visionModel": "gemini-3.8-flash",
    "usdCny": 7.2,
    "visionPriceIn": 0.3,
    "visionPriceOut": 2.5
  },

  "tools": { "ffmpeg": "ffmpeg", "ffprobe": "ffprobe" },
  "workflows": []                       // 工作流实验室里保存的自定义条目
}
```

Key 保存在本机文件里，接口返回时永远是 `abcd••••wxyz` 这种打码形式，前端拿不到明文。

### 需要申请什么

- **RunningHub**（换人 / 超分）：<https://www.runninghub.cn> 注册 → API 控制台 → 拿 API Key → 充值。
  你要用的工作流必须是「能通过 API 调用」的公开工作流，节点 ID 可以从工作流图里看到。
- **APIMart**（角色图 + 视觉质检）：<https://api.apimart.ai> 拿 Key。图片模型与视觉模型都可以在设置里换成你账号可用的型号。

---

## 怎么用一条爆款

1. **新建项目**：左栏「复刻」→ 起个名字 → 新建（或者「导入」已有作品文件夹）
2. **放原片**：把 mp4 拖进项目 `src/`，或在界面里选一个视频「用选中视频替换」；点「切分镜」（默认 8 秒一镜）
3. **出角色图**：右栏填服装（必填）、姿势、鞋、场景，勾上参考图 → 生成
   - 生成完**先看**：像不像、身材/腿型对不对、有没有第二个人、有没有文字 logo
   - 满意才点「通过审核」；不满意按意见改了再生成
4. **换人**：右栏点「提交换人」→ 每个镜头一条 take，实时显示状态与费用；多 Key 会并发跑
5. **质检**：点「开始质检」→ 看 verdict 与 12 帧灰条；FAIL 会列出具体问题（不同人 / 第二张脸 / 变形 / 文字 / 跳变）
6. **成片**：点「合成成片」→ `final/` 下得到拼接好的 mp4；需要更清晰再接超分工作流

### 工作流实验室

想用别人的工作流：

1. 左栏「工作流」→ 右栏填 RunningHub 工作流 ID
2. 点「探测节点」——插件会拉一次 API 格式图，自动认出视频输入 / 图片输入 / 文本输入 / 数字参数 / 输出
3. 确认映射没问题 →「保存到列表」
4. 中栏选素材、填提示词与参数 →「运行（付费）」

---

## 项目目录结构

一个项目就是一个普通文件夹，用资源管理器也能直接管：

```
<root>/<项目名>/
  project.json        # 状态：人物、原片、角色图版本与审核、takes、质检、成片
  src/                # 原片
  refs/               # 角色参考图（默认拿前 4 张）
  cast/               # 生成的角色图版本
  shots/              # 切好的分镜
  takes/              # 每个镜头的换人结果
  qa/                 # 质检结果（JSON + 帧图）
  final/              # 成片
```

插件自己的数据（配置、工作流缓存）在 `~/.dsh/wanfeng-studio/`。

---

## 开发

```bash
node --check index.js && node --check client.js
node selftest.mjs        # 21 项后端自测，不联网、不花钱
```

`selftest.mjs` 直接驱动 Routes（绕过 HTTP 鉴权），用 `ffmpeg lavfi testsrc` 造测试原片，
覆盖素材索引、上传、时间线、脚本任务、流程创建/切片、**审核门 403**、无 Key 时的失败路径、设置打码等。

主要模块：

| 文件 | 职责 |
| --- | --- |
| `index.js` | Host 入口：组装配置 / 索引 / 脚本任务 / 项目流程，注册 `/wanfeng-studio/*` 路由 |
| `client.js` | Web UI：侧栏入口 + 工作台三个栏位 + 时间线（React，无 iframe） |
| `src/config.js` | 配置读写与 Key 打码 |
| `src/scan.js` | 素材索引（45 秒缓存，忽略依赖与缓存目录） |
| `src/jobs.js` | 跑 `.py` / `.ps1` / `.cmd` 脚本，收集日志，可杀进程 |
| `src/ff.js` | ffmpeg / ffprobe：探时长、抽帧、缩图、拼接、封面 |
| `src/rh.js` | RunningHub：多 Key 调度、上传、建任务、收结果、费用 |
| `src/ai.js` | APIMart：视觉问答（返回 JSON）、图片生成 |
| `src/workflows.js` | 工作流节点探测、参数猜测、按映射填图 |
| `src/project.js` | 五步流程状态机、审核门、切镜、质检、合成 |
| `src/routes.js` | HTTP 路由与参数校验 |

---

## 注意

- **会花钱**：换人与图片生成都按次计费。RunningHub 侧有余额与并发限制，插件会在结果里回填单次费用，但不保证与账单一致。
- **审核门不要绕过**：直接改 `project.json` 的 `cast.approvedId` 也能跑，但那是你自己的选择。
- 换人工作流**保留原片背景**；想换场景要在提示词里改，或后期合成。
- 质检接口异常时一律 SKIP 放行，不会自动重跑——重跑意味着再花一次钱。
- 这是非官方插件，与 RunningHub / APIMart 无隶属关系。

---

## 发版（维护者）

npm 对「开启 2FA 的账号」不允许命令行直接 `npm publish`（403），改用两步的暂存发布：

```bash
npm stage publish          # 上传到 npm 暂存区，输出一个 staged id
```

然后打开 <https://www.npmjs.com/settings/liweitan2046-cyber/staged-packages>，
等包上方的 `Validating` 扫描结束后点 **Approve**（浏览器里能用 security key / 指纹完成 2FA）。

批准后核验：

```bash
npm view dsh-wanfeng-studio version   # 应返回新版本号
git tag v0.1.1 && git push origin v0.1.1
gh release create v0.1.1 --notes "…"
```

## License

MIT