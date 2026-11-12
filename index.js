/**
 * 万风工作台 · Host 半边
 *
 * 只做两件事：
 *  1. 提供 /wanfeng-studio 下的 HTTP 接口（素材索引、媒体文件、上传、时间线草稿、脚本任务、
 *     以及「复刻流程」：原片 / 角色图 / 换人 / 质检 / 成片）；
 *  2. 启动时预热一次项目扫描。
 * 页面渲染全部在 client.js。
 */
import { DATA_DIR, StudioConfig } from './src/config.js'
import { MediaIndex } from './src/scan.js'
import { JobRunner } from './src/jobs.js'
import { PREFIX, Routes } from './src/routes.js'
import { RunningHub } from './src/rh.js'
import { ApiMart } from './src/ai.js'
import { FFmpeg } from './src/ff.js'
import { ProjectStore } from './src/project.js'

export const name = 'dsh-wanfeng-studio'

export const inject = ['webServer', 'connection']

export function apply(ctx) {
  const config = new StudioConfig()
  const index = new MediaIndex(config)
  const jobs = new JobRunner(config, index)
  const ff = new FFmpeg({ config })
  const rh = new RunningHub({ config, dataDir: DATA_DIR })
  const ai = new ApiMart({ config, ff, dataDir: DATA_DIR })
  const flow = new ProjectStore({ config, index, ff, rh, ai, dataDir: DATA_DIR })
  const routes = new Routes(ctx, config, index, jobs, flow, rh, ai, ff)

  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: PREFIX,
    handler: (req, res) => routes.handle(req, res),
  }), 'dsh-wanfeng-studio: /wanfeng-studio routes')

  // 预热：首次打开面板前就把索引和作品列表准备好（失败不影响面板打开）
  config.read()
    .then(() => index.ensure())
    .catch(() => {})

  // 顺手确认 ffmpeg 是否可用，日志里给一行提示
  ff.available()
    .then(info => {
      if (!info.ffmpeg || !info.ffprobe) {
        ctx.logger?.warn?.(`[wanfeng-studio] ffmpeg/ffprobe 不可用：${info.error || '未找到'}；分镜、质检、成片会失败`)
      }
    })
    .catch(() => {})
}

export { DATA_DIR }