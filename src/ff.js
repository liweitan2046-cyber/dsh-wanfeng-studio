/**
 * ffmpeg / ffprobe 封装：探测时长、抽帧、缩图、拼接。
 *
 * 插件不自带 ffmpeg：没有就用系统 PATH 里的，也可以在设置里填绝对路径。
 * 所有方法都先跑一次 `-version` 探测，失败时返回可读的错误而不是抛一堆 stderr。
 */
import { spawn } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

function run(bin, args, timeout = 120000) {
  return new Promise((resolve) => {
    const child = spawn(bin, args, { windowsHide: true })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      child.kill()
      resolve({ ok: false, stdout, stderr: stderr + '\n[超时]' })
    }, timeout)
    child.stdout.on('data', chunk => { stdout += chunk.toString() })
    child.stderr.on('data', chunk => { stderr += chunk.toString() })
    child.on('error', error => {
      clearTimeout(timer)
      resolve({ ok: false, stdout, stderr: String(error.message || error) })
    })
    child.on('close', code => {
      clearTimeout(timer)
      resolve({ ok: code === 0, code, stdout, stderr })
    })
  })
}

export class FFmpeg {
  constructor({ config }) {
    this.config = config
  }

  async paths() {
    const cfg = await this.config.read()
    const tools = cfg.tools || {}
    return {
      ffmpeg: String(tools.ffmpeg || 'ffmpeg'),
      ffprobe: String(tools.ffprobe || 'ffprobe'),
    }
  }

  async available() {
    const { ffmpeg, ffprobe } = await this.paths()
    const [a, b] = await Promise.all([run(ffmpeg, ['-version'], 15000), run(ffprobe, ['-version'], 15000)])
    return {
      ffmpeg: a.ok,
      ffprobe: b.ok,
      version: a.ok ? (a.stdout.split('\n')[0] || '').slice(0, 120) : (a.stderr.split('\n').pop() || '').slice(0, 200),
      error: a.ok ? '' : (a.stderr.split('\n').find(row => row.trim()) || 'ffmpeg 不在 PATH 里').slice(0, 300),
    }
  }

  async require() {
    const state = await this.available()
    if (!state.ffmpeg || !state.ffprobe) {
      throw Object.assign(new Error(`ffmpeg / ffprobe 不可用：${state.error || '请安装 https://ffmpeg.org 并在设置里填写路径'}`), { status: 400 })
    }
  }

  async probe(file) {
    const { ffprobe } = await this.paths()
    const out = await run(ffprobe, [
      '-v', 'error',
      '-select_streams', 'v:0',
      '-show_entries', 'stream=width,height,r_frame_rate,duration',
      '-show_entries', 'format=duration',
      '-of', 'json',
      file,
    ])
    if (!out.ok) throw new Error(`ffprobe 失败：${out.stderr.slice(0, 300)}`)
    let data
    try {
      data = JSON.parse(out.stdout)
    } catch {
      throw new Error('ffprobe 返回的不是 JSON')
    }
    const stream = (data.streams && data.streams[0]) || {}
    const duration = Number(stream.duration) || Number(data.format && data.format.duration) || 0
    const [num, den] = String(stream.r_frame_rate || '24/1').split('/').map(Number)
    return {
      width: Number(stream.width) || 0,
      height: Number(stream.height) || 0,
      duration: Math.round(duration * 1000) / 1000,
      fps: den ? Math.round((num / den) * 100) / 100 : 24,
    }
  }

  /** 在指定时间点抽一帧；返回是否成功。 */
  async frame(video, seconds, outPath, { width = 0 } = {}) {
    const { ffmpeg } = await this.paths()
    await mkdir(join(outPath, '..'), { recursive: true })
    const args = ['-y', '-v', 'error', '-ss', String(seconds), '-i', video, '-frames:v', '1']
    if (width) args.push('-vf', `scale=${width}:-2`)
    args.push(outPath)
    const out = await spawnRun(ffmpeg, args)
    return out.ok
  }

  /** 均匀抽 n 帧 + 单独抽前 head 帧，成片质检一次要用的素材。 */
  async frames(video, duration, outDir, { count = 12, head = 8, width = 240 } = {}) {
    await mkdir(outDir, { recursive: true })
    const times = Array.from({ length: count }, (_, i) => Math.round((duration * i / count) * 100) / 100)
    const picked = []
    for (let i = 0; i < times.length; i += 1) {
      const target = join(outDir, `f${String(i).padStart(2, '0')}-${times[i].toFixed(2)}s.jpg`)
      // eslint-disable-next-line no-await-in-loop
      const ok = await this.frame(video, times[i], target, { width })
      if (ok) picked.push({ at: times[i], file: target })
    }
    const headFiles = []
    const { ffmpeg } = await this.paths()
    const headDir = join(outDir, 'head')
    await mkdir(headDir, { recursive: true })
    const headRun = await spawnRun(ffmpeg, [
      '-y', '-v', 'error', '-i', video, '-vf', `select=lt(n\\,${head}),scale=${width}:-2`,
      '-vsync', '0', join(headDir, '%02d.jpg'),
    ])
    if (headRun.ok) {
      const { readdir } = await import('node:fs/promises')
      const names = (await readdir(headDir)).filter(row => row.endsWith('.jpg')).sort().slice(0, head)
      for (const name of names) headFiles.push(join(headDir, name))
    }
    return { times, picked, headFiles }
  }

  async thumb(src, outPath, longest = 768) {
    const { ffmpeg } = await this.paths()
    await mkdir(join(outPath, '..'), { recursive: true })
    const out = await spawnRun(ffmpeg, ['-y', '-v', 'error', '-i', src, '-vf', `scale='min(${longest},iw)':-2`, '-q:v', '3', outPath])
    return out.ok
  }

  /** 把多段 mp4 直接拼起来（要求同编码/同分辨率，适合同一工作流产出的镜头）。 */
  async concat(files, outPath) {
    if (!files.length) throw new Error('没有可拼接的片段')
    const { ffmpeg } = await this.paths()
    const listFile = join(join(outPath, '..'), `concat-${Date.now()}.txt`)
    await mkdir(join(outPath, '..'), { recursive: true })
    const body = files.map(row => `file '${row.replace(/'/g, "'\\''")}'`).join('\n')
    await writeFile(listFile, body + '\n', 'utf8')
    const out = await spawnRun(ffmpeg, ['-y', '-v', 'error', '-f', 'concat', '-safe', '0', '-i', listFile, '-c', 'copy', outPath], 30 * 60 * 1000)
    if (!out.ok) throw new Error(`拼接失败：${out.stderr.slice(0, 400)}`)
    return outPath
  }

  /** 单帧导出（用于给时间线生成封面）。 */
  async cover(video, outPath, at = 0.5) {
    return this.frame(video, at, outPath)
  }
}

function spawnRun(bin, args, timeout) {
  return run(bin, args, timeout)
}