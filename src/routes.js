/**
 * 工作台的 HTTP 路由：/wanfeng-studio/*。
 * 每个请求先过 connection 的 Host/Origin 与登录凭证检查；文件只允许 root 内的相对路径。
 */
import { createReadStream } from 'node:fs'
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { basename, extname, join } from 'node:path'
import { MIME } from './scan.js'
import { redactConfig } from './config.js'
import { BUILTIN, guessPlan, probeGraph } from './workflows.js'

export const PREFIX = '/wanfeng-studio'

const MAX_JSON = 2_000_000
const MAX_UPLOAD = 400_000_000
const EMPTY_TIMELINE = {
  width: 1920,
  height: 1080,
  fps: 30,
  duration: 30,
  tracks: { video: [], graphics: [], audio: [] },
  updatedAt: 0,
}

function json(res, status, body) {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(JSON.stringify(body))
}

async function readJson(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_JSON) throw Object.assign(new Error('请求内容太大'), { status: 413 })
    chunks.push(chunk)
  }
  const raw = Buffer.concat(chunks)
  if (!raw.length) return {}
  try {
    return JSON.parse(raw.toString('utf8'))
  } catch {
    throw Object.assign(new Error('请求不是有效的 JSON'), { status: 400 })
  }
}

/** 支持 Range，视频才能正常拖动预览。 */
async function sendFile(req, res, file) {
  const type = MIME[extname(file).toLowerCase()]
  if (!type) return json(res, 404, { error: '不支持的文件类型' })
  let info
  try {
    info = await stat(file)
  } catch {
    return json(res, 404, { error: '文件不存在' })
  }
  if (!info.isFile()) return json(res, 404, { error: '不是文件' })
  res.setHeader('content-type', type)
  res.setHeader('accept-ranges', 'bytes')
  res.setHeader('cache-control', 'private, max-age=3600')
  res.setHeader('x-content-type-options', 'nosniff')
  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '')
  if (range && (range[1] || range[2])) {
    const start = range[1] ? Number(range[1]) : Math.max(0, info.size - Number(range[2]))
    const end = range[1] && range[2] ? Math.min(Number(range[2]), info.size - 1) : info.size - 1
    if (start >= info.size || start > end) {
      res.statusCode = 416
      res.setHeader('content-range', `bytes */${info.size}`)
      return res.end()
    }
    res.statusCode = 206
    res.setHeader('content-range', `bytes ${start}-${end}/${info.size}`)
    res.setHeader('content-length', end - start + 1)
    return createReadStream(file, { start, end }).pipe(res)
  }
  res.statusCode = 200
  res.setHeader('content-length', info.size)
  if (req.method === 'HEAD') return res.end()
  return createReadStream(file).pipe(res)
}

function safeName(input) {
  const raw = basename(String(input || '').replace(/\\/g, '/'))
  const cleaned = raw
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
    .replace(/^\.+/, '')
    .trim()
    .slice(0, 120)
  return cleaned || `上传-${Date.now()}.png`
}

function safeJson(value, depth = 0) {
  if (depth > 6) return null
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (Array.isArray(value)) return value.slice(0, 500).map(row => safeJson(row, depth + 1))
  if (typeof value === 'object') {
    const out = {}
    for (const [key, row] of Object.entries(value).slice(0, 200)) out[key] = safeJson(row, depth + 1)
    return out
  }
  return null
}

function sanitizeTimeline(input) {
  const base = safeJson(input) || {}
  const tracksIn = base.tracks && typeof base.tracks === 'object' ? base.tracks : {}
  const tracks = {}
  for (const key of ['video', 'graphics', 'audio']) {
    const rows = Array.isArray(tracksIn[key]) ? tracksIn[key] : []
    tracks[key] = rows
      .filter(row => row && typeof row === 'object' && typeof row.rel === 'string')
      .slice(0, 300)
      .map((row, index) => ({
        id: typeof row.id === 'string' ? row.id.slice(0, 80) : `clip-${Date.now()}-${index}`,
        rel: row.rel.slice(0, 500),
        name: typeof row.name === 'string' ? row.name.slice(0, 200) : row.rel.split('/').pop() || row.rel,
        kind: row.kind === 'video' || row.kind === 'image' || row.kind === 'audio' || row.kind === 'text' ? row.kind : 'image',
        start: Math.max(Number(row.start) || 0, 0),
        length: Math.max(Number(row.length) || 3, 0.2),
        volume: typeof row.volume === 'number' ? Math.min(Math.max(row.volume, 0), 2) : 1,
      }))
  }
  return {
    width: Math.min(Math.max(Number(base.width) || 1920, 240), 7680),
    height: Math.min(Math.max(Number(base.height) || 1080, 240), 4320),
    fps: Math.min(Math.max(Number(base.fps) || 30, 1), 120),
    duration: Math.min(Math.max(Number(base.duration) || 30, 1), 86400),
    tracks,
    updatedAt: Date.now(),
  }
}

export class Routes {
  constructor(ctx, config, index, jobs, flow, rh, ai, ff) {
    this.ctx = ctx
    this.config = config
    this.index = index
    this.jobs = jobs
    this.flow = flow
    this.rh = rh
    this.ai = ai
    this.ff = ff
    this.timelineFile = () => join(index.root, '.wanfeng-studio', 'timeline.json')
    /** 通用工作流（用户自己接进来的 RunningHub 流程）的运行记录。 */
    this.rhRuns = []
  }

  rejection(req) {
    const connection = this.ctx.get('connection')
    if (typeof connection?.requestRejection !== 'function') return 403
    return connection.requestRejection({ headers: req.headers })
  }

  async handle(req, res) {
    const rejection = this.rejection(req)
    if (rejection) {
      json(res, rejection, { error: '未授权' })
      return
    }
    const url = new URL(req.url || '/', 'http://localhost')
    const path = url.pathname.startsWith(PREFIX) ? url.pathname.slice(PREFIX.length) : url.pathname
    const route = path.replace(/^\/+/, '')
    try {
      await this.dispatch(route, url, req, res)
    } catch (error) {
      if (res.headersSent) {
        res.end()
        return
      }
      json(res, error?.status || 500, { error: error?.message || String(error), ...(error?.gate ? { gate: true } : {}) })
    }
  }

  async dispatch(route, url, req, res) {
    const method = (req.method || 'GET').toUpperCase()
    const q = Object.fromEntries(url.searchParams.entries())

    if (route === 'health') {
      await this.index.ensure(Boolean(q.force))
      return json(res, 200, {
        ok: true,
        root: this.index.root,
        items: this.index.items.length,
        scannedAt: this.index.scannedAt,
        truncated: this.index.truncated,
        uptime: process.uptime(),
      })
    }

    if (route === 'config') {
      const cfg = await this.config.read()
      if (method === 'POST') {
        const body = await readJson(req)
        const patch = {}
        if (typeof body.root === 'string' && body.root.trim()) {
          const nextRoot = body.root.trim()
          let info
          try {
            info = await stat(nextRoot)
          } catch {
            return json(res, 400, { error: '目录不存在：' + nextRoot })
          }
          if (!info.isDirectory()) return json(res, 400, { error: '不是目录：' + nextRoot })
          patch.root = nextRoot
        }
        if (typeof body.python === 'string' && body.python.trim()) patch.python = body.python.trim()
        if (typeof body.uploadDir === 'string' && body.uploadDir.trim()) patch.uploadDir = body.uploadDir.trim()
        const next = await this.config.write(patch)
        this.index.scannedAt = 0
        this.index.scriptsAt = 0
        await this.index.ensure(true)
        return json(res, 200, { ...redactConfig(next), works: this.index.workRows.length, items: this.index.items.length })
      }
      return json(res, 200, { ...redactConfig(cfg), dataDir: join(process.env.USERPROFILE || process.env.HOME || '', '.dsh', 'wanfeng-studio') })
    }

    if (route === 'refresh') {
      await this.index.ensure(true)
      return json(res, 200, { ok: true, root: this.index.root, items: this.index.items.length, works: this.index.workRows.length, scannedAt: this.index.scannedAt })
    }

    if (route === 'works') {
      const data = await this.index.works(Boolean(q.force))
      return json(res, 200, data)
    }

    if (route === 'assets') {
      const data = await this.index.assets({
        work: q.work,
        kind: q.kind,
        q: q.q,
        limit: q.limit,
        offset: q.offset,
        force: q.force === '1',
      })
      return json(res, 200, data)
    }

    if (route === 'media') {
      const abs = this.index.resolve(q.path || '')
      if (!abs) return json(res, 400, { error: '路径不合法' })
      return sendFile(req, res, abs)
    }

    if (route === 'reveal' && method === 'POST') {
      const body = await readJson(req)
      const abs = this.index.resolve(body.rel || '')
      if (!abs) return json(res, 400, { error: '路径不合法' })
      if (process.platform === 'win32') {
        const child = spawn('explorer.exe', ['/select,', abs], { detached: true, stdio: 'ignore', windowsHide: true })
        child.unref()
      }
      return json(res, 200, { ok: true })
    }

    if (route === 'upload') {
      if (method !== 'POST') return json(res, 405, { error: '只接受 POST' })
      return this.upload(url, req, res)
    }

    if (route === 'timeline') {
      await this.index.ensure()
      const file = this.timelineFile()
      if (method === 'POST') {
        const body = await readJson(req)
        const data = sanitizeTimeline(body)
        await mkdir(join(this.index.root, '.wanfeng-studio'), { recursive: true })
        await writeFile(file, `${JSON.stringify(data, null, 2)}\n`, 'utf8')
        return json(res, 200, { ok: true, timeline: data })
      }
      try {
        const raw = await readFile(file, 'utf8')
        return json(res, 200, { ok: true, timeline: JSON.parse(raw) })
      } catch {
        return json(res, 200, { ok: true, timeline: EMPTY_TIMELINE })
      }
    }

    if (route === 'scripts') {
      await this.index.ensure()
      const rows = await this.index.readScripts(await this.config.read())
      const work = typeof q.work === 'string' ? q.work : ''
      const items = (work ? rows.filter(row => row.rel === work || row.rel.startsWith(`${work}/`)) : rows)
        .slice(0, 300)
        .map(row => ({ rel: row.rel, name: row.name, work: row.rel.includes('/') ? row.rel.split('/')[0] : '根目录', mtime: row.mtime, size: row.size }))
      return json(res, 200, { items })
    }

    if (route === 'jobs') {
      if (method === 'POST') {
        const body = await readJson(req)
        const job = await this.jobs.start(body)
        return json(res, 200, job)
      }
      return json(res, 200, { items: this.jobs.list() })
    }

    if (route.startsWith('jobs/')) {
      const rest = route.slice('jobs/'.length)
      const [id, action] = rest.split('/')
      if (!id) return json(res, 404, { error: '缺少任务 id' })
      if (action === 'kill') {
        if (method !== 'POST') return json(res, 405, { error: '只接受 POST' })
        const ok = this.jobs.kill(id)
        return json(res, ok ? 200 : 404, ok ? { ok: true } : { error: '任务不存在或已结束' })
      }
      const job = this.jobs.get(id)
      if (!job) return json(res, 404, { error: '任务不存在' })
      return json(res, 200, job)
    }

    if (route.startsWith('flow/')) {
      const body = method === 'POST' ? await readJson(req) : q
      return this.flowRoute(route.slice('flow/'.length), method, body, res, q)
    }

    return json(res, 404, { error: '接口不存在：' + route })
  }

  /** 「复刻流程」这组接口：原片 / 角色图 / 换人 / 质检 / 成片 / 设置。 */
  async flowRoute(action, method, body, res, q) {
    const needPost = () => {
      if (method !== 'POST') throw Object.assign(new Error('只接受 POST'), { status: 405 })
    }
    const needName = () => {
      const name = String(body.name || q.name || '').trim()
      if (!name) throw Object.assign(new Error('缺少项目名'), { status: 400 })
      return name
    }

    switch (action) {
      case 'projects':
        return json(res, 200, await this.flow.list())

      case 'project':
        return json(res, 200, { ok: true, project: await this.flow.read(needName()) })

      case 'create': {
        needPost()
        const project = await this.flow.create({ name: body.name, sourceRel: body.sourceRel, person: body.person })
        return json(res, 200, { ok: true, project })
      }

      case 'import': {
        needPost()
        const project = await this.flow.importDir(needName())
        return json(res, 200, { ok: true, project })
      }

      case 'source': {
        needPost()
        return json(res, 200, { ok: true, project: await this.flow.setSource(needName(), String(body.rel || '')) })
      }

      case 'person': {
        needPost()
        const name = needName()
        const person = { name: String(body.person?.name || ''), describe: String(body.person?.describe || '') }
        const project = await this.flow.patch(name, async (fresh) => { fresh.person = person })
        return json(res, 200, { ok: true, project })
      }

      case 'split': {
        needPost()
        return json(res, 200, { ok: true, ...(await this.flow.splitShots(needName(), body.seconds)) })
      }

      case 'cast/generate': {
        needPost()
        const version = await this.flow.generateCast(needName(), body)
        return json(res, 200, { ok: true, version })
      }

      case 'cast/approve': {
        needPost()
        const name = needName()
        const id = String(body.id || '')
        if (!id) throw Object.assign(new Error('缺少版本 id'), { status: 400 })
        const project = await this.flow.approveCast(name, id, body.approved !== false)
        return json(res, 200, { ok: true, project })
      }

      case 'swap/start': {
        needPost()
        const result = await this.flow.startSwap(needName(), body)
        return json(res, 200, { ok: true, ...result })
      }

      case 'qa': {
        needPost()
        const run = await this.flow.runQa(needName(), String(body.rel || ''))
        return json(res, 200, { ok: true, run })
      }

      case 'render': {
        needPost()
        return json(res, 200, { ok: true, ...(await this.flow.render(needName())) })
      }

      case 'tasks':
        return json(res, 200, { items: this.flow.tasksState() })

      case 'workflows': {
        if (method === 'POST') {
          const workflowId = String(body.workflowId || '').trim()
          if (!workflowId) throw Object.assign(new Error('缺少工作流 ID'), { status: 400 })
          const cfg = await this.config.read()
          const row = {
            id: String(body.id || workflowId),
            name: String(body.name || workflowId).trim() || workflowId,
            workflowId,
            kind: body.kind === 'upscale' ? 'upscale' : 'video',
            desc: String(body.desc || ''),
            plan: body.plan && typeof body.plan === 'object' ? body.plan : {},
          }
          const rest = (cfg.workflows || []).filter(item => item.workflowId !== workflowId)
          await this.config.write({ workflows: [...rest, row] })
          return json(res, 200, { ok: true, workflow: row })
        }
        const cfg = await this.config.read()
        return json(res, 200, { builtin: BUILTIN, custom: cfg.workflows || [] })
      }

      case 'probe': {
        needPost()
        const workflowId = String(body.workflowId || '').trim()
        if (!workflowId) throw Object.assign(new Error('缺少工作流 ID'), { status: 400 })
        const graph = await this.rh.workflow(workflowId)
        const probe = probeGraph(graph)
        return json(res, 200, { ok: true, probe, plan: guessPlan(probe) })
      }

      case 'run': {
        needPost()
        const workflowId = String(body.workflowId || '').trim()
        if (!workflowId) throw Object.assign(new Error('缺少工作流 ID'), { status: 400 })
        const plan = body.plan && typeof body.plan === 'object' ? body.plan : {}
        const inputs = {
          video: body.video ? this.flow.abs(String(body.video)) : '',
          images: Array.isArray(body.images) ? body.images.map(rel => this.flow.abs(String(rel))) : [],
          text: String(body.text || ''),
          values: body.values && typeof body.values === 'object' ? body.values : {},
        }
        if (!inputs.video && !inputs.images.length && !inputs.text) {
          throw Object.assign(new Error('至少要给一个输入：视频 / 参考图 / 提示词'), { status: 400 })
        }
        const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15)
        const rel = `生成结果/${workflowId.slice(-6)}-${stamp}.mp4`
        const run = {
          id: `run-${stamp}`,
          workflowId,
          title: String(body.name || workflowId),
          status: 'queued',
          rel,
          at: Date.now(),
          cost: 0,
          error: '',
        }
        this.rhRuns.unshift(run)
        if (this.rhRuns.length > 60) this.rhRuns.length = 60
        const outPath = this.flow.abs(rel)
        void (async () => {
          try {
            run.status = 'running'
            const { taskId, keyName } = await this.rh.runWorkflow({ workflowId, plan, inputs })
            run.taskId = taskId
            for (let i = 0; i < 240; i += 1) {
              await new Promise(resolve => setTimeout(resolve, 5000))
              const result = await this.rh.collect(keyName, taskId, outPath)
              if (result.status === 'done') {
                run.status = 'done'
                run.cost = result.cny
                run.url = `${PREFIX}/media?path=${encodeURIComponent(rel)}`
                return
              }
              if (result.status === 'failed') {
                run.status = 'failed'
                run.error = result.error || '任务失败'
                return
              }
            }
            run.status = 'failed'
            run.error = '等太久了（20 分钟没拿到产物）'
          } catch (error) {
            run.status = 'failed'
            run.error = error.message
          }
        })()
        return json(res, 200, { ok: true, run })
      }

      case 'runs':
        return json(res, 200, { items: this.rhRuns })

      case 'settings': {
        if (method === 'POST') {
          const next = await this.config.write(body)
          return json(res, 200, { ok: true, config: redactConfig(next) })
        }
        return json(res, 200, { ok: true, config: redactConfig(await this.config.read()) })
      }

      case 'test': {
        const rows = []
        try {
          rows.push(...(await this.rh.test()))
        } catch (error) {
          rows.push({ provider: 'RunningHub', ok: false, error: error.message })
        }
        try {
          rows.push(...(await this.ai.test()))
        } catch (error) {
          rows.push({ provider: 'APIMart', ok: false, error: error.message })
        }
        return json(res, 200, { ok: true, rows, ff: await this.ff.available() })
      }
    }

    return json(res, 404, { error: '接口不存在：flow/' + action })
  }

  /** 原始字节上传：一次一个文件，文件名走查询参数或 x-file-name。 */
  async upload(url, req, res) {
    const cfg = await this.config.read()
    await this.index.ensure()
    const work = (url.searchParams.get('work') || '').trim()
    const rawName = url.searchParams.get('name') || req.headers['x-file-name'] || ''
    const name = safeName(decodeURIComponent(String(rawName)))
    let dir
    if (work) {
      const parent = this.index.resolve(work)
      if (!parent) return json(res, 400, { error: '作品目录不合法' })
      dir = join(parent, cfg.uploadDir)
    } else {
      dir = join(this.index.root, cfg.uploadDir)
    }
    await mkdir(dir, { recursive: true })
    let target = join(dir, name)
    let attempt = 1
    while (true) {
      try {
        const info = await stat(target)
        if (!info.isFile()) break
      } catch {
        break
      }
      const ext = extname(name)
      const stem = name.slice(0, name.length - ext.length)
      target = join(dir, `${stem}-${attempt}${ext}`)
      attempt += 1
    }
    // 流式落盘：视频动辄几百兆，不能整段读进内存
    const { createWriteStream } = await import('node:fs')
    const { pipeline } = await import('node:stream/promises')
    const { Transform } = await import('node:stream')
    let size = 0
    const counter = new Transform({
      transform(chunk, _encoding, callback) {
        size += chunk.length
        if (size > MAX_UPLOAD) {
          callback(Object.assign(new Error('文件太大'), { status: 413 }))
          return
        }
        callback(null, chunk)
      },
    })
    try {
      await pipeline(req, counter, createWriteStream(target))
    } catch (error) {
      await rm(target, { force: true })
      throw error
    }
    const rel = join(work || '', cfg.uploadDir, basename(target)).replace(/\\/g, '/').replace(/^\/+/, '')
    this.index.scannedAt = 0
    await this.index.ensure(true)
    return json(res, 200, { ok: true, rel, name: basename(target), size, url: `${PREFIX}/media?path=${encodeURIComponent(rel)}` })
  }
}