/**
 * 复刻项目的状态机：原片 → 角色图（审核门）→ 换人 → 质检 → 成片。
 *
 * 一个项目就是根目录下的一个文件夹，里面的 project.json 记录每个阶段的产物与状态；
 * 素材、成片、质检帧都放在各自子目录里，随时可以用资源管理器打开。
 *
 * 审核门是硬约束：cast.approvedId 为空时 startSwap 直接拒绝——
 * 这是项目里反复强调的规则（角色图必须先给人看、确认通过，才能花钱跑视频）。
 */
import { copyFile, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { basename, extname, join } from 'node:path'
import { castPrompt, qaPrompt } from './ai.js'

export const STAGES = [
  { id: 'source', label: '原片' },
  { id: 'cast', label: '角色图' },
  { id: 'swap', label: '换人' },
  { id: 'qa', label: '质检' },
  { id: 'final', label: '成片' },
]

const VIDEO_EXT = new Set(['.mp4', '.mov', '.mkv', '.webm', '.m4v'])
const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp'])

function now() {
  return Date.now()
}

function emptyProject(name) {
  return {
    name,
    createdAt: now(),
    updatedAt: now(),
    person: { name: '', describe: '' },
    source: { rel: '', duration: 0, width: 0, height: 0, fps: 0, at: 0 },
    cast: { approvedId: '', versions: [] },
    swap: { workflowId: '', takes: [], at: 0 },
    qa: { runs: [] },
    final: { rel: '', at: 0 },
  }
}

export class ProjectStore {
  constructor({ config, index, ff, rh, ai, dataDir }) {
    this.config = config
    this.index = index
    this.ff = ff
    this.rh = rh
    this.ai = ai
    this.dataDir = dataDir
    this.tasks = new Map()
    this.locks = new Map()
  }

  root() {
    return this.index.root
  }

  /** 索引未扫描时 root 还是空串，所有读写入口都先确保根目录已加载。 */
  async ensureRoot() {
    await this.index.ensure()
    return this.index.root
  }

  /** 项目名只能是一层目录名，禁止路径穿越。 */
  checkName(name) {
    const clean = String(name == null ? '' : name).trim()
    if (!clean || clean === '.' || clean === '..' || /[<>:"/\\|?*]/.test(clean)) {
      throw Object.assign(new Error('项目名不合法（不能含 \\ / : * ? " < > |）'), { status: 400 })
    }
    return clean
  }

  abs(rel) {
    return join(this.root(), rel)
  }

  async withLock(name, fn) {
    const previous = this.locks.get(name) || Promise.resolve()
    const next = previous.then(fn, fn)
    this.locks.set(name, next.catch(() => {}))
    return next
  }

  async read(name) {
    this.checkName(name)
    const root = await this.ensureRoot()
    const file = join(root, name, 'project.json')
    const raw = await readFile(file, 'utf8').catch((error) => {
      if (error.code === 'ENOENT') throw Object.assign(new Error('没有这个项目'), { status: 404 })
      throw error
    })
    const data = JSON.parse(raw)
    const base = emptyProject(name)
    return { ...base, ...data, cast: { ...base.cast, ...(data.cast || {}) }, swap: { ...base.swap, ...(data.swap || {}) }, qa: { ...base.qa, ...(data.qa || {}) }, source: { ...base.source, ...(data.source || {}) }, final: { ...base.final, ...(data.final || {}) } }
  }

  async write(name, project) {
    this.checkName(name)
    const root = await this.ensureRoot()
    project.updatedAt = now()
    await mkdir(join(root, name), { recursive: true })
    await writeFile(join(root, name, 'project.json'), JSON.stringify(project, null, 2), 'utf8')
    return project
  }

  async patch(name, fn) {
    return this.withLock(name, async () => {
      const project = await this.read(name)
      await fn(project)
      return this.write(name, project)
    })
  }

  /** 项目列表：已登记的（有 project.json）+ 可导入的候选目录（有一级 mp4）。 */
  async list() {
    await this.index.ensure()
    const cfg = await this.config.read()
    const ignore = new Set((cfg.ignore || []).map(row => row.toLowerCase()))
    const entries = await readdir(this.root(), { withFileTypes: true })
    const rows = []
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const name = entry.name
      if (name.startsWith('.') || name.startsWith('_') || ignore.has(name.toLowerCase())) continue
      try {
        const project = await this.read(name)
        rows.push(summarize(project))
        continue
      } catch {
        /* 没有 project.json，看看能不能导入 */
      }
      const candidate = await this.findFirstVideo(name)
      if (candidate) {
        rows.push({
          name,
          imported: false,
          source: { rel: candidate, duration: 0, width: 0, height: 0, fps: 0, at: 0 },
          cast: { approvedId: '', versions: [] },
          swap: { takes: [] },
          qa: { runs: [] },
          final: { rel: '', at: 0 },
          stage: '待导入',
          counts: { cast: 0, takes: 0, qa: 0 },
        })
      }
    }
    rows.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
    return { root: this.root(), projects: rows }
  }

  async findFirstVideo(name) {
    const base = join(this.root(), name)
    for (const dir of ['src', '']) {
      const folder = join(base, dir)
      if (!existsSync(folder)) continue
      const entries = await readdir(folder, { withFileTypes: true }).catch(() => [])
      for (const entry of entries) {
        if (!entry.isFile()) continue
        if (!VIDEO_EXT.has(extname(entry.name).toLowerCase())) continue
        return (dir ? `${name}/${dir}/` : `${name}/`) + entry.name
      }
    }
    return ''
  }

  async create({ name, sourceRel, person }) {
    const clean = this.checkName(name)
    const root = await this.ensureRoot()
    const dir = join(root, clean)
    if (existsSync(dir) && existsSync(join(dir, 'project.json'))) throw Object.assign(new Error('同名项目已存在'), { status: 409 })
    const project = emptyProject(clean)
    if (person && typeof person === 'object') {
      project.person = { name: String(person.name || ''), describe: String(person.describe || '') }
    }
    await mkdir(join(dir, 'src'), { recursive: true })
    await mkdir(join(dir, 'refs'), { recursive: true })
    await mkdir(join(dir, 'cast'), { recursive: true })
    await mkdir(join(dir, 'shots'), { recursive: true })
    await mkdir(join(dir, 'takes'), { recursive: true })
    await mkdir(join(dir, 'qa'), { recursive: true })
    await mkdir(join(dir, 'final'), { recursive: true })
    if (sourceRel) await this.attachSource(project, sourceRel)
    await this.write(clean, project)
    return project
  }

  /** 登记一个已有目录为项目。 */
  async importDir(name) {
    const existing = await this.read(name).catch(() => null)
    if (existing) return existing
    const sourceRel = await this.findFirstVideo(name)
    if (!sourceRel) throw Object.assign(new Error('这个目录里没有找到视频文件'), { status: 400 })
    return this.create({ name, sourceRel })
  }

  async attachSource(project, sourceRel) {
    const abs = this.abs(sourceRel)
    const info = await stat(abs)
    if (!info.isFile() || !VIDEO_EXT.has(extname(abs).toLowerCase())) throw Object.assign(new Error('原片必须是视频文件'), { status: 400 })
    const probe = await this.ff.probe(abs).catch(() => null)
    project.source = {
      rel: sourceRel,
      duration: probe ? probe.duration : 0,
      width: probe ? probe.width : 0,
      height: probe ? probe.height : 0,
      fps: probe ? probe.fps : 0,
      at: now(),
    }
  }

  async setSource(name, sourceRel) {
    return this.patch(name, async (project) => {
      await this.attachSource(project, sourceRel)
      project.final = { rel: '', at: 0 }
    })
  }

  /* ---------------------------- 角色图 ---------------------------- */

  async generateCast(name, input = {}) {
    const project = await this.read(name)
    const id = `cast-${Date.now().toString(36)}`
    const version = {
      id,
      rel: `cast/${id}.png`,
      outfit: String(input.outfit || '').trim(),
      pose: String(input.pose || '').trim(),
      shoes: String(input.shoes || '').trim(),
      scene: String(input.scene || '').trim(),
      keepBg: Boolean(input.keepBg),
      refs: Array.isArray(input.refs) ? input.refs.slice(0, 6) : [],
      status: 'generating',
      cost: 0,
      error: '',
      gate: null,
      at: now(),
    }
    if (!version.outfit) throw Object.assign(new Error('先写当次服装（outfit）'), { status: 400 })
    project.cast.versions.unshift(version)
    await this.write(name, project)

    this.run(`cast:${name}:${id}`, async () => {
      const refs = version.refs.length
        ? version.refs.map(rel => this.abs(rel)).filter(row => existsSync(row))
        : await this.defaultRefs(name)
      const prompt = castPrompt(version)
      const result = await this.ai.generateImage({
        prompt,
        refs,
        outPath: this.abs(version.rel),
        size: input.size || '9:16',
        resolution: input.resolution || '2k',
        quality: input.quality || 'high',
      })
      await this.patch(name, async (fresh) => {
        const row = fresh.cast.versions.find(item => item.id === id)
        if (row) {
          row.status = 'ready'
          row.cost = result.cost
        }
      })
    }, async (error) => {
      await this.patch(name, async (fresh) => {
        const row = fresh.cast.versions.find(item => item.id === id)
        if (row) {
          row.status = 'failed'
          row.error = error.message
        }
      })
    })
    return version
  }

  async defaultRefs(name) {
    const dir = join(this.root(), name, 'refs')
    const entries = await readdir(dir).catch(() => [])
    return entries
      .filter(row => IMAGE_EXT.has(extname(row).toLowerCase()))
      .slice(0, 4)
      .map(row => join(dir, row))
  }

  /** 审核门：只有一个版本能被批准；批准后其它版本的 approved 标记清掉。 */
  async approveCast(name, id, approved = true) {
    return this.patch(name, async (project) => {
      const row = project.cast.versions.find(item => item.id === id)
      if (!row) throw Object.assign(new Error('没有这个角色图版本'), { status: 404 })
      if (approved) {
        if (row.status !== 'ready') throw Object.assign(new Error('这张图还没生成完'), { status: 400 })
        project.cast.approvedId = id
      } else if (project.cast.approvedId === id) {
        project.cast.approvedId = ''
      }
      row.gate = { approved, at: now() }
    })
  }

  /* ---------------------------- 分镜 ---------------------------- */

  /** 按固定时长把原片切成若干镜（不依赖场景检测，结果可解释）。 */
  async splitShots(name, seconds = 8) {
    const project = await this.read(name)
    if (!project.source.rel) throw Object.assign(new Error('还没有原片'), { status: 400 })
    await this.ff.require()
    const step = Math.max(2, Math.min(15, Number(seconds) || 8))
    const dir = join(this.root(), name, 'shots')
    await rm(dir, { recursive: true, force: true })
    await mkdir(dir, { recursive: true })
    const { ffmpeg } = await this.ff.paths()
    const src = this.abs(project.source.rel)
    const probe = await this.ff.probe(src)
    const total = Number(probe.duration) || 0
    if (total < 1) throw Object.assign(new Error('读不到原片时长'), { status: 400 })
    const count = Math.max(1, Math.ceil(total / step))
    const shots = []
    for (let i = 0; i < count; i += 1) {
      const start = i * step
      const length = Math.min(step, total - start)
      if (length < 1) break
      const file = join(dir, `s${String(i + 1).padStart(3, '0')}.mp4`)
      await runFfmpeg(ffmpeg, [
        '-y', '-v', 'error', '-i', src, '-ss', String(start), '-t', String(length),
        '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-pix_fmt', 'yuv420p',
        '-c:a', 'aac', '-b:a', '192k', file,
      ])
      shots.push(`${name}/shots/${basename(file)}`)
    }
    return { shots, seconds: step, duration: total }
  }

  /* ---------------------------- 换人 ---------------------------- */

  async startSwap(name, input = {}) {
    const project = await this.read(name)
    const approved = project.cast.versions.find(row => row.id === project.cast.approvedId)
    if (!approved || approved.status !== 'ready') {
      throw Object.assign(new Error('角色图还没有通过审核：先在「角色图」里选一张并点「通过」，才能提交视频任务'), { status: 403, gate: true })
    }
    if (!project.source.rel) throw Object.assign(new Error('还没有原片'), { status: 400 })
    const settings = await this.rh.settings()
    const workflowId = String(input.workflowId || settings.swapWorkflowId || '').trim()
    if (!workflowId) throw Object.assign(new Error('还没有配置换人工作流 ID'), { status: 400 })
    const shotFiles = (await readdir(join(this.root(), name, 'shots')).catch(() => []))
      .filter(row => row.endsWith('.mp4')).sort()
    const jobs = shotFiles.length
      ? shotFiles.map((row, i) => ({ shot: `s${String(i + 1).padStart(3, '0')}`, rel: `${name}/shots/${row}` }))
      : [{ shot: 's001', rel: project.source.rel }]
    const takes = jobs.map((row, i) => ({
      id: `take-${Date.now().toString(36)}-${i}`,
      shot: row.shot,
      video: row.rel,
      rel: `takes/${row.shot}-${Date.now().toString(36)}.mp4`,
      status: 'queued',
      taskId: '',
      keyName: '',
      cost: 0,
      error: '',
      at: now(),
      prompt: String(input.prompt || '').trim(),
      seconds: Number(input.seconds) || Math.min(15, Number(project.source.duration) || 8),
      seed: Number(input.seed) || 20261024 + i,
    }))
    project.swap.workflowId = workflowId
    project.swap.takes.unshift(...takes)
    project.swap.at = now()
    await this.write(name, project)

    this.run(`swap:${name}`, async () => {
      const keys = await this.rh.keys()
      if (!keys.length) throw new Error('还没有配置 RunningHub API Key')
      const settings = await this.rh.settings()
      const pool = keys.map((_, i) => `k${i + 1}`)
      const cap = Math.max(1, settings.concurrency)
      const active = new Map()
      const pending = takes.slice()
      const refs = [this.abs(approved.rel)]
      while (pending.length || active.size) {
        while (pending.length && active.size < pool.length * cap) {
          const take = pending.shift()
          const keyName = pool[active.size % pool.length]
          try {
            await this.markTake(name, take.id, { status: 'running', keyName })
            const { taskId } = await this.rh.submitSwap({
              id: take.id,
              video: this.abs(take.video),
              pictures: refs,
              prompt: take.prompt || defaultSwapPrompt(project, approved),
              seconds: take.seconds,
              width: project.source.width || 832,
              height: project.source.height || 1216,
              seed: take.seed,
            }, keyName)
            await this.markTake(name, take.id, { taskId, status: 'running' })
            active.set(take.id, { take, keyName })
          } catch (error) {
            await this.markTake(name, take.id, { status: 'failed', error: error.message })
          }
        }
        if (!active.size) break
        await new Promise(resolve => setTimeout(resolve, 8000))
        for (const [id, row] of Array.from(active.entries())) {
          const take = row.take
          const fresh = await this.read(name)
          const current = fresh.swap.takes.find(item => item.id === id)
          if (!current || !current.taskId) { active.delete(id); continue }
          const result = await this.rh.collect(row.keyName, current.taskId, this.abs(take.rel))
          if (result.status === 'done') {
            await this.markTake(name, id, { status: 'done', cost: result.cny, taskId: '' })
            active.delete(id)
          } else if (result.status === 'failed') {
            await this.markTake(name, id, { status: 'failed', error: result.error || '任务失败', taskId: '' })
            active.delete(id)
          }
        }
      }
    }, async (error) => {
      await this.markTake(name, null, { status: 'failed', error: error.message })
    })
    return { takes }
  }

  async markTake(name, id, patch) {
    await this.patch(name, async (project) => {
      const rows = id ? project.swap.takes.filter(row => row.id === id) : project.swap.takes.filter(row => row.status === 'queued' || row.status === 'running')
      for (const row of rows) Object.assign(row, patch)
    })
  }

  /* ---------------------------- 质检 ---------------------------- */

  async runQa(name, rel = '') {
    const project = await this.read(name)
    const done = project.swap.takes.filter(row => row.status === 'done')
    const targetRel = String(rel || '') || project.final.rel || (done[0] && done[0].rel)
    if (!targetRel) throw Object.assign(new Error('还没有可质检的成片或片段'), { status: 400 })
    const id = `qa-${Date.now().toString(36)}`
    const run = { id, rel: targetRel, status: 'running', verdict: 'SKIP', frames: [], jsonRel: `qa/${id}.json`, at: now(), error: '' }
    project.qa.runs.unshift(run)
    await this.write(name, project)

    this.run(`qa:${name}:${id}`, async () => {
      await this.ff.require()
      const target = this.abs(targetRel)
      const probe = await this.ff.probe(target)
      const outDir = join(this.root(), name, 'qa', id)
      await mkdir(outDir, { recursive: true })
      const sampled = await this.ff.frames(target, probe.duration, outDir, { count: 12, head: 8, width: 240 })
      const frameRels = sampled.picked.map(row => `${name}/qa/${id}/${basename(row.file)}`)
      const approved = project.cast.versions.find(row => row.id === project.cast.approvedId) || {}
      const anchor = await this.ff.frame(project.source.rel ? this.abs(project.source.rel) : target,
        Math.min(0.5, (project.source.duration || probe.duration) / 2), join(outDir, 'anchor.jpg'), { width: 480 })
      const images = [
        ...(await this.defaultRefs(name)).slice(0, 2),
        approved.rel ? this.abs(approved.rel) : '',
        anchor ? join(outDir, 'anchor.jpg') : '',
        ...sampled.picked.map(row => row.file),
      ].filter(Boolean)
      const prompt = qaPrompt({
        subject: project.person.describe || project.person.name || '',
        outfit: approved.outfit || '',
        scene: String(project.source.rel ? '' : ''),
      })
      const answer = await this.ai.askJson(prompt, images)
      const bad = answer.same_person === false || answer.second_face_or_ghost === true
        || answer.face_deformed === true || answer.visible_text_logo_ui === true || answer.frame_jump === true
      answer.verdict = bad ? 'FAIL' : 'PASS'
      const report = {
        video: targetRel,
        duration: probe.duration,
        timestamps: sampled.times,
        identity: { same_person: answer.same_person, second_face_or_ghost: answer.second_face_or_ghost },
        full_check: answer,
        frames: frameRels,
        head: sampled.headFiles.map(row => `${name}/qa/${id}/head/${basename(row)}`),
      }
      await writeFile(join(this.root(), name, 'qa', `${id}.json`), JSON.stringify(report, null, 2), 'utf8')
      await this.patch(name, async (fresh) => {
        const row = fresh.qa.runs.find(item => item.id === id)
        if (row) {
          row.status = 'done'
          row.verdict = answer.verdict
          row.frames = frameRels
          row.head = report.head
          row.check = answer
        }
      })
    }, async (error) => {
      await this.patch(name, async (fresh) => {
        const row = fresh.qa.runs.find(item => item.id === id)
        if (row) {
          row.status = 'failed'
          row.error = error.message
        }
      })
    })
    return run
  }

  /* ---------------------------- 成片 ---------------------------- */

  async render(name) {
    const project = await this.read(name)
    const done = project.swap.takes
      .filter(row => row.status === 'done')
      .sort((a, b) => String(a.shot).localeCompare(String(b.shot)))
    if (!done.length) throw Object.assign(new Error('还没有完成的片段'), { status: 400 })
    await this.ff.require()
    const rel = `final/${name}-成片-${new Date().toISOString().slice(0, 10)}.mp4`
    await this.ff.concat(done.map(row => this.abs(row.rel)), this.abs(rel))
    await this.patch(name, async (fresh) => { fresh.final = { rel, at: now() } })
    return { rel }
  }

  /* ---------------------------- 任务登记 ---------------------------- */

  run(id, fn, onError) {
    if (this.tasks.has(id)) return
    const task = { id, startedAt: now(), status: 'running' }
    this.tasks.set(id, task)
    Promise.resolve()
      .then(fn)
      .then(() => { task.status = 'done' })
      .catch(async (error) => {
        task.status = 'failed'
        task.error = error && error.message
        if (onError) await onError(error)
      })
      .finally(() => {
        setTimeout(() => this.tasks.delete(id), 5 * 60 * 1000).unref?.()
      })
  }

  tasksState() {
    return Array.from(this.tasks.values())
  }
}

function runFfmpeg(bin, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { windowsHide: true })
    let stderr = ''
    child.stderr.on('data', chunk => { stderr += chunk.toString() })
    child.on('error', reject)
    child.on('close', code => (code === 0 ? resolve() : reject(new Error(`ffmpeg 退出 ${code}：${stderr.slice(0, 400)}`))))
  })
}

function summarize(project) {
  const approved = project.cast.versions.find(row => row.id === project.cast.approvedId)
  const doneTakes = project.swap.takes.filter(row => row.status === 'done')
  const stage = project.final.rel ? '成片'
    : project.qa.runs.length ? '质检'
      : doneTakes.length ? '换人'
        : approved ? '角色图已审'
          : project.cast.versions.length ? '角色图' : '原片'
  return {
    name: project.name,
    updatedAt: project.updatedAt,
    stage,
    source: project.source,
    person: project.person,
    cast: {
      approvedId: project.cast.approvedId,
      versions: project.cast.versions.map(row => ({ id: row.id, rel: row.rel, status: row.status, outfit: row.outfit, at: row.at })),
    },
    swap: { workflowId: project.swap.workflowId, takes: project.swap.takes },
    qa: { runs: project.qa.runs },
    final: project.final,
    counts: {
      cast: project.cast.versions.length,
      takes: doneTakes.length,
      qa: project.qa.runs.length,
    },
  }
}

/** 换人提示词：保留原片机位与布景，只替换人物；动作与衣着按当次角色图。 */
function defaultSwapPrompt(project, version) {
  const piece = [
    'Replace the person in the source video with the person in the character picture.',
    'Keep the original framing, camera movement, timing, background and lighting exactly.',
    version.outfit ? `The new person wears: ${version.outfit}.` : '',
    version.shoes ? `Footwear: ${version.shoes}.` : '',
    'Keep the same body proportions and face as the character picture. No extra people, no text, no watermark.',
    'Do not change the scene.',
  ]
  if (project.person.name) piece.splice(0, 0, `The character is ${project.person.name}.`)
  return piece.filter(Boolean).join(' ')
}