/**
 * 工作台的持久配置：项目根目录、Python 解释器、上传目录、各家 API 的 Key 与工作流 ID。
 * 配置文件放在用户目录下（不进项目目录，避免污染作品文件夹，也不会被 git 带走）。
 * 这里的 Key 是明文存本机；README 里会写明「只放自己的 Key、不要提交到 git」。
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const DATA_DIR = process.env.WANFENG_STUDIO_HOME || join(homedir(), '.dsh', 'wanfeng-studio')

export const DEFAULTS = {
  root: 'D:\\codex\\wanfeng',
  python: 'python',
  uploadDir: '上传素材',
  ignore: ['ComfyUI', 'ComfyUI-venv', '__pycache__', 'node_modules', '.git', '.workbuddy'],
  runninghub: {
    base: 'https://www.runninghub.cn',
    key: '',
    swapWorkflowId: '2109190174289780738',
    upscaleWorkflowId: '1989896719183867905',
    concurrency: 5,
    coinCny: 399 / 180000,
  },
  apimart: {
    base: 'https://api.apimart.ai/v1',
    key: '',
    visionBase: 'https://api.apimart.ai/v1',
    visionKey: '',
    visionModel: 'gemini-3.8-flash',
    imageModel: 'gpt-image-2.5-sunburst',
    usdCny: 7.2,
    visionPriceIn: 0.3,
    visionPriceOut: 2.5,
  },
  tools: { ffmpeg: 'ffmpeg', ffprobe: 'ffprobe' },
  person: { name: '', describe: '' },
  /** 用户从 RunningHub 接进来的自定义工作流（名称 + ID + 节点映射）。 */
  workflows: [],
}

function text(value, fallback) {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback
}

function number(value, fallback) {
  const num = Number(value)
  return Number.isFinite(num) ? num : fallback
}

function normalize(input) {
  const merged = { ...DEFAULTS, ...(input || {}) }
  merged.root = text(process.env.WANFENG_ROOT, text(merged.root, DEFAULTS.root))
  merged.python = text(process.env.WANFENG_PYTHON, text(merged.python, DEFAULTS.python))
  merged.uploadDir = text(merged.uploadDir, DEFAULTS.uploadDir)
  merged.ignore = Array.isArray(merged.ignore)
    ? merged.ignore.filter(row => typeof row === 'string' && row.trim()).map(row => row.trim())
    : [...DEFAULTS.ignore]

  const rh = { ...DEFAULTS.runninghub, ...(merged.runninghub || {}) }
  merged.runninghub = {
    base: text(rh.base, DEFAULTS.runninghub.base).replace(/\/+$/, ''),
    key: typeof rh.key === 'string' ? rh.key.trim() : '',
    swapWorkflowId: text(rh.swapWorkflowId, DEFAULTS.runninghub.swapWorkflowId),
    upscaleWorkflowId: text(rh.upscaleWorkflowId, DEFAULTS.runninghub.upscaleWorkflowId),
    concurrency: Math.max(1, Math.min(20, number(rh.concurrency, DEFAULTS.runninghub.concurrency))),
    coinCny: number(rh.coinCny, DEFAULTS.runninghub.coinCny),
  }

  const ai = { ...DEFAULTS.apimart, ...(merged.apimart || {}) }
  merged.apimart = {
    base: text(ai.base, DEFAULTS.apimart.base).replace(/\/+$/, ''),
    key: typeof ai.key === 'string' ? ai.key.trim() : '',
    visionBase: text(ai.visionBase, DEFAULTS.apimart.visionBase).replace(/\/+$/, ''),
    visionKey: typeof ai.visionKey === 'string' ? ai.visionKey.trim() : '',
    visionModel: text(ai.visionModel, DEFAULTS.apimart.visionModel),
    imageModel: text(ai.imageModel, DEFAULTS.apimart.imageModel),
    usdCny: number(ai.usdCny, DEFAULTS.apimart.usdCny),
    visionPriceIn: number(ai.visionPriceIn, DEFAULTS.apimart.visionPriceIn),
    visionPriceOut: number(ai.visionPriceOut, DEFAULTS.apimart.visionPriceOut),
  }

  const tools = { ...DEFAULTS.tools, ...(merged.tools || {}) }
  merged.tools = {
    ffmpeg: text(tools.ffmpeg, DEFAULTS.tools.ffmpeg),
    ffprobe: text(tools.ffprobe, DEFAULTS.tools.ffprobe),
  }

  const person = { ...DEFAULTS.person, ...(merged.person || {}) }
  merged.person = { name: String(person.name || ''), describe: String(person.describe || '') }

  merged.workflows = Array.isArray(merged.workflows)
    ? merged.workflows
      .filter(row => row && typeof row === 'object' && (row.workflowId || row.id))
      .map(row => {
        const plan = (row.plan && typeof row.plan === 'object') ? row.plan : {}
        const numbers = (plan.numbers && typeof plan.numbers === 'object') ? plan.numbers : {}
        return {
          id: String(row.id || row.workflowId),
          name: String(row.name || row.workflowId),
          workflowId: String(row.workflowId || ''),
          kind: row.kind === 'upscale' ? 'upscale' : 'video',
          desc: String(row.desc || ''),
          plan: {
            video: String(plan.video || ''),
            images: Array.isArray(plan.images) ? plan.images.slice(0, 4).map(String) : [],
            text: String(plan.text || ''),
            numbers: Object.fromEntries(Object.entries(numbers).map(([k, v]) => [String(k), String(v)])),
          },
        }
      })
    : []
  return merged
}

/** 对外返回时把 Key 打码，只留头尾几位，前端不需要拿到明文。 */
export function redactConfig(cfg) {
  const mask = value => {
    const raw = String(value || '')
    if (!raw) return ''
    const rows = raw.split(',').map(row => row.trim()).filter(Boolean)
    return rows.map(row => (row.length <= 8 ? '••••' : `${row.slice(0, 4)}••••${row.slice(-4)}`)).join(',')
  }
  return {
    ...cfg,
    runninghub: { ...cfg.runninghub, key: mask(cfg.runninghub.key), hasKey: Boolean(cfg.runninghub.key) },
    apimart: {
      ...cfg.apimart,
      key: mask(cfg.apimart.key),
      visionKey: mask(cfg.apimart.visionKey),
      hasKey: Boolean(cfg.apimart.key),
      hasVisionKey: Boolean(cfg.apimart.visionKey || cfg.apimart.key),
    },
  }
}

export class StudioConfig {
  constructor() {
    this.file = join(DATA_DIR, 'config.json')
    this.current = normalize({})
    this.loaded = false
  }

  /** 首次读取磁盘配置；之后走内存。 */
  async read() {
    if (this.loaded) return this.current
    let disk = {}
    try {
      disk = JSON.parse(await readFile(this.file, 'utf8'))
    } catch {
      disk = {}
    }
    this.current = normalize(disk)
    this.loaded = true
    return this.current
  }

  /** 合并写回；返回新配置。key 传空字符串表示不改动（前端拿到的是打码值）。 */
  async write(patch) {
    await this.read()
    const safe = { ...(patch || {}) }
    if (safe.runninghub) {
      const rh = { ...safe.runninghub }
      if (typeof rh.key === 'string' && rh.key.includes('••')) delete rh.key
      safe.runninghub = rh
    }
    if (safe.apimart) {
      const ai = { ...safe.apimart }
      if (typeof ai.key === 'string' && ai.key.includes('••')) delete ai.key
      if (typeof ai.visionKey === 'string' && ai.visionKey.includes('••')) delete ai.visionKey
      safe.apimart = ai
    }
    const next = normalize({ ...this.current, ...safe })
    await mkdir(DATA_DIR, { recursive: true })
    await writeFile(this.file, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
    this.current = next
    return next
  }
}