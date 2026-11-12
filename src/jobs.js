/**
 * 流水线脚本任务：spawn 一个 Python/PS1 进程，按时间顺序收集输出，
 * 面板轮询进度与日志。日志有上限，避免长期运行把内存撑爆。
 */
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'

const MAX_LOG_CHARS = 240_000
const MAX_JOBS = 40

export class JobRunner {
  constructor(config, index) {
    this.config = config
    this.index = index
    /** @type {Map<string, any>} */
    this.jobs = new Map()
    /** @type {Map<string, import('node:child_process').ChildProcess>} */
    this.procs = new Map()
  }

  list() {
    return [...this.jobs.values()]
      .sort((a, b) => b.startedAt - a.startedAt)
      .map(job => ({
        id: job.id,
        work: job.work,
        script: job.script,
        args: job.args,
        status: job.status,
        startedAt: job.startedAt,
        endedAt: job.endedAt,
        exitCode: job.exitCode,
        tail: job.log.slice(-4000),
      }))
  }

  get(id) {
    const job = this.jobs.get(id)
    if (!job) return null
    return { ...job }
  }

  append(job, text) {
    job.log += text
    if (job.log.length > MAX_LOG_CHARS) {
      job.log = `…（日志过长，已截断前段）\n${job.log.slice(job.log.length - MAX_LOG_CHARS / 2)}`
    }
    if (job.log.length > MAX_LOG_CHARS) job.log = job.log.slice(job.log.length - MAX_LOG_CHARS)
  }

  async start(input = {}) {
    const cfg = await this.config.read()
    await this.index.ensure()
    const script = String(input.script || '').trim()
    if (!script) throw Object.assign(new Error('请选择要运行的脚本'), { status: 400 })
    const abs = this.index.resolve(script)
    if (!abs) throw Object.assign(new Error('脚本路径不合法'), { status: 400 })
    const work = typeof input.work === 'string' ? input.work.trim() : ''
    const cwd = work ? this.index.resolve(work) : cfg.root
    if (!cwd) throw Object.assign(new Error('作品目录不合法'), { status: 400 })
    const args = Array.isArray(input.args) ? input.args.map(row => String(row)).slice(0, 40) : []
    const id = randomUUID()
    const python = cfg.python || 'python'
    const lower = script.toLowerCase()
    const command = lower.endsWith('.ps1') || lower.endsWith('.cmd') ? 'powershell' : python
    const argv = lower.endsWith('.ps1') || lower.endsWith('.cmd')
      ? ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', abs, ...args]
      : [abs, ...args]
    const job = {
      id,
      work,
      script,
      args,
      command,
      argv,
      status: 'running',
      startedAt: Date.now(),
      endedAt: null,
      exitCode: null,
      log: `$ ${command} ${argv.join(' ')}\n（工作目录 ${cwd}）\n\n`,
    }
    this.jobs.set(id, job)
    this.prune()
    const proc = spawn(command, argv, {
      cwd,
      env: {
        ...process.env,
        PYTHONIOENCODING: 'utf-8',
        PYTHONUTF8: '1',
        PYTHONUNBUFFERED: '1',
      },
      windowsHide: true,
      shell: false,
    })
    this.procs.set(id, proc)
    const onData = (chunk) => {
      this.append(job, chunk.toString('utf8'))
    }
    proc.stdout?.on('data', onData)
    proc.stderr?.on('data', onData)
    proc.on('error', (error) => {
      this.append(job, `\n[启动失败] ${error.message}\n`)
      job.status = 'failed'
      job.endedAt = Date.now()
      this.procs.delete(id)
    })
    proc.on('close', (code) => {
      job.exitCode = typeof code === 'number' ? code : -1
      if (job.status !== 'killed') job.status = job.exitCode === 0 ? 'done' : 'failed'
      job.endedAt = job.endedAt || Date.now()
      this.append(job, `\n[进程结束] 退出码 ${job.exitCode}\n`)
      this.procs.delete(id)
    })
    return { ...job, log: job.log.slice(-2000) }
  }

  kill(id) {
    const proc = this.procs.get(id)
    const job = this.jobs.get(id)
    if (!proc || !job) return false
    job.status = 'killed'
    job.endedAt = Date.now()
    try {
      if (process.platform === 'win32' && proc.pid) {
        spawn('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
      } else {
        proc.kill('SIGTERM')
      }
    } catch {
      try {
        proc.kill()
      } catch {
        // 进程可能刚好自己退出
      }
    }
    this.procs.delete(id)
    return true
  }

  prune() {
    if (this.jobs.size <= MAX_JOBS) return
    const rows = [...this.jobs.values()].sort((a, b) => a.startedAt - b.startedAt)
    for (const job of rows) {
      if (this.jobs.size <= MAX_JOBS) break
      if (job.status === 'running') continue
      this.jobs.delete(job.id)
    }
  }
}