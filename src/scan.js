/**
 * 项目素材索引：一次递归扫描 root 下的图片/视频/音频与顶层脚本，
 * 之后所有面板查询都走内存缓存（默认 45 秒，可手动刷新）。
 */
import { readdir, stat } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'

export const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.avif'])
export const VIDEO_EXT = new Set(['.mp4', '.webm', '.mov', '.m4v', '.mkv', '.avi'])
export const AUDIO_EXT = new Set(['.mp3', '.wav', '.m4a', '.aac', '.flac', '.ogg'])

export const MIME = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp',
  '.avif': 'image/avif',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.m4v': 'video/x-m4v',
  '.mkv': 'video/x-matroska',
  '.avi': 'video/x-msvideo',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.flac': 'audio/flac',
  '.ogg': 'audio/ogg',
}

const MAX_FILES = 40000
const MAX_DEPTH = 7
const TTL = 45_000
const SCRIPT_TTL = 30_000

export function extOf(name) {
  const i = name.lastIndexOf('.')
  if (i <= 0) return ''
  return name.slice(i).toLowerCase()
}

export function kindOf(name) {
  const ext = extOf(name)
  if (IMAGE_EXT.has(ext)) return 'image'
  if (VIDEO_EXT.has(ext)) return 'video'
  if (AUDIO_EXT.has(ext)) return 'audio'
  return 'other'
}

function toRel(root, full) {
  return relative(root, full).split(sep).join('/')
}

export class MediaIndex {
  constructor(config) {
    this.config = config
    this.items = []
    this.truncated = false
    this.scannedAt = 0
    this.root = ''
    this.workRows = []
    this.pending = null
    this.scripts = []
    this.scriptsAt = 0
    this.scriptsPending = null
  }

  /** 扫描一次（或返回进行中的扫描）。force=true 忽略缓存。 */
  async ensure(force = false) {
    const cfg = await this.config.read()
    const fresh = this.scannedAt && Date.now() - this.scannedAt < TTL && this.root === cfg.root && !force
    if (fresh) return this
    if (this.pending) return this.pending
    this.pending = this.scan(cfg).finally(() => { this.pending = null })
    return this.pending
  }

  async scan(cfg) {
    const root = cfg.root
    const ignore = new Set(cfg.ignore.map(row => row.toLowerCase()))
    const items = []
    let truncated = false
    let guard = 0
    /** @type {Array<{full:string, rel:string, depth:number}>} */
    const stack = [{ full: root, rel: '', depth: 0 }]
    while (stack.length) {
      const current = stack.pop()
      if (!current) break
      let entries
      try {
        entries = await readdir(current.full, { withFileTypes: true })
      } catch {
        continue
      }
      for (const entry of entries) {
        if (entry.name.startsWith('.') && entry.name !== '.') {
          if (entry.isDirectory()) continue
        }
        const name = entry.name
        const full = join(current.full, name)
        const rel = current.rel ? `${current.rel}/${name}` : name
        if (entry.isDirectory()) {
          if (ignore.has(name.toLowerCase())) continue
          if (current.depth + 1 > MAX_DEPTH) continue
          stack.push({ full, rel, depth: current.depth + 1 })
          continue
        }
        if (!entry.isFile()) continue
        const kind = kindOf(name)
        if (kind === 'other') continue
        guard += 1
        if (guard > MAX_FILES) {
          truncated = true
          break
        }
        let info
        try {
          info = await stat(full)
        } catch {
          continue
        }
        const segs = rel.split('/')
        items.push({
          rel,
          name,
          ext: extOf(name),
          kind,
          size: info.size,
          mtime: info.mtimeMs,
          dir: segs.length > 1 ? segs.slice(0, -1).join('/') : '',
          work: segs.length > 1 ? segs[0] : '根目录',
        })
      }
      if (truncated) break
    }
    items.sort((a, b) => b.mtime - a.mtime)
    this.root = root
    this.items = items
    this.truncated = truncated
    this.scannedAt = Date.now()
    this.workRows = await this.buildWorks(cfg, items)
    return this
  }

  async buildWorks(cfg, items) {
    const ignore = new Set(cfg.ignore.map(row => row.toLowerCase()))
    const byWork = new Map()
    for (const item of items) {
      let row = byWork.get(item.work)
      if (!row) {
        row = { name: item.work, rel: item.work === '根目录' ? '' : item.work, images: 0, videos: 0, audios: 0, mtime: 0, cover: null, latestVideo: null, earliest: Infinity }
        byWork.set(item.work, row)
      }
      if (item.kind === 'image') row.images += 1
      else if (item.kind === 'video') {
        row.videos += 1
        if (!row.latestVideo || item.mtime > row.latestVideo.mtime) row.latestVideo = item
      } else if (item.kind === 'audio') row.audios += 1
      if (item.mtime > row.mtime) row.mtime = item.mtime
      if (item.mtime < row.earliest) row.earliest = item.mtime
      if (!row.cover && item.kind === 'image') row.cover = item
    }

    // 一级目录里也可能只有脚本/文本，没有媒体：也列出来，方便跑任务
    let dirs = []
    try {
      dirs = await readdir(cfg.root, { withFileTypes: true })
    } catch {
      dirs = []
    }
    for (const entry of dirs) {
      if (!entry.isDirectory()) continue
      if (ignore.has(entry.name.toLowerCase())) continue
      if (entry.name.startsWith('.') || entry.name.startsWith('_')) continue
      if (byWork.has(entry.name)) continue
      byWork.set(entry.name, { name: entry.name, rel: entry.name, images: 0, videos: 0, audios: 0, mtime: 0, cover: null, latestVideo: null, earliest: Infinity })
    }

    const scripts = await this.readScripts(cfg)
    const byWorkScripts = new Map()
    for (const script of scripts) {
      const key = script.rel.includes('/') ? script.rel.split('/')[0] : '根目录'
      const list = byWorkScripts.get(key) || []
      list.push(script)
      byWorkScripts.set(key, list)
    }

    const rows = []
    for (const row of byWork.values()) {
      const list = (byWorkScripts.get(row.name) || []).slice(0, 60)
      let stage = '空'
      const videoNames = items.filter(item => item.work === row.name && item.kind === 'video').map(item => item.name)
      if (videoNames.some(name => /成片|final|拼接|stitch|merge|合集/i.test(name))) stage = '成片'
      else if (row.videos > 0) stage = '视频素材'
      else if (list.some(script => /review|自查/i.test(script.name))) stage = '待自查'
      else if (row.images > 0) stage = '图片素材'
      else if (list.length) stage = '仅脚本'
      rows.push({
        name: row.name,
        rel: row.rel,
        images: row.images,
        videos: row.videos,
        audios: row.audios,
        total: row.images + row.videos + row.audios,
        mtime: row.mtime,
        cover: row.cover ? { rel: row.cover.rel, kind: row.cover.kind } : null,
        latestVideo: row.latestVideo ? { rel: row.latestVideo.rel, kind: 'video' } : null,
        scripts: list.map(script => ({ rel: script.rel, name: script.name, mtime: script.mtime })),
        stage,
      })
    }
    rows.sort((a, b) => b.mtime - a.mtime)
    return rows
  }

  async readScripts(cfg) {
    if (this.scriptsAt && Date.now() - this.scriptsAt < SCRIPT_TTL) return this.scripts
    if (this.scriptsPending) return this.scriptsPending
    this.scriptsPending = this.scanScripts(cfg).finally(() => { this.scriptsPending = null })
    return this.scriptsPending
  }

  async scanScripts(cfg) {
    const ignore = new Set(cfg.ignore.map(row => row.toLowerCase()))
    const found = []
    const stack = [{ full: cfg.root, rel: '', depth: 0 }]
    while (stack.length) {
      const current = stack.pop()
      let entries
      try {
        entries = await readdir(current.full, { withFileTypes: true })
      } catch {
        continue
      }
      for (const entry of entries) {
        const full = join(current.full, entry.name)
        const rel = current.rel ? `${current.rel}/${entry.name}` : entry.name
        if (entry.isDirectory()) {
          if (ignore.has(entry.name.toLowerCase())) continue
          if (current.depth >= 2) continue
          if (entry.name.startsWith('.')) continue
          stack.push({ full, rel, depth: current.depth + 1 })
          continue
        }
        if (!entry.isFile()) continue
        if (extOf(entry.name) !== '.py' && extOf(entry.name) !== '.ps1' && extOf(entry.name) !== '.cmd') continue
        let info
        try {
          info = await stat(full)
        } catch {
          continue
        }
        found.push({ rel, name: entry.name, mtime: info.mtimeMs, size: info.size })
      }
    }
    found.sort((a, b) => b.mtime - a.mtime)
    this.scripts = found
    this.scriptsAt = Date.now()
    return found
  }

  async works(force = false) {
    await this.ensure(force)
    return { root: this.root, works: this.workRows, scannedAt: this.scannedAt, truncated: this.truncated, total: this.items.length }
  }

  async assets(query = {}) {
    await this.ensure(Boolean(query.force))
    const work = typeof query.work === 'string' && query.work.trim() ? query.work.trim() : ''
    const kind = typeof query.kind === 'string' && query.kind !== 'all' ? query.kind : ''
    const q = typeof query.q === 'string' ? query.q.trim().toLowerCase() : ''
    const limit = Math.min(Math.max(Number(query.limit) || 120, 1), 600)
    const offset = Math.max(Number(query.offset) || 0, 0)
    let rows = this.items
    if (work) rows = rows.filter(item => item.work === work)
    if (kind) rows = rows.filter(item => item.kind === kind)
    if (q) rows = rows.filter(item => item.name.toLowerCase().includes(q) || item.rel.toLowerCase().includes(q))
    const total = rows.length
    const page = rows.slice(offset, offset + limit).map(item => ({
      rel: item.rel,
      name: item.name,
      kind: item.kind,
      size: item.size,
      mtime: item.mtime,
      work: item.work,
      dir: item.dir,
      url: `/wanfeng-studio/media?path=${encodeURIComponent(item.rel)}`,
    }))
    const works = new Map()
    for (const item of rows) {
      works.set(item.work, (works.get(item.work) || 0) + 1)
    }
    return { total, offset, limit, items: page, truncated: this.truncated }
  }

  /** 相对路径的绝对路径；不在 root 内返回 null（防穿越）。 */
  resolve(rel) {
    const normalized = String(rel || '').replace(/\\/g, '/').replace(/^\/+/, '')
    if (!normalized || normalized.split('/').some(seg => seg === '..')) return null
    if (/^[a-zA-Z]:/.test(normalized)) return null
    return join(this.root, normalized)
  }

  find(rel) {
    return this.items.find(item => item.rel === rel)
  }
}