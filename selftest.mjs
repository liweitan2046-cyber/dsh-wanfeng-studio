/**
 * 自测：不经过 HTTP 鉴权，直接驱动 Routes，验证索引 / 上传 / 时间线 / 任务 / 复刻流程。
 * 跑完自行清理产生的文件。设置 WANFENG_ROOT 指向空目录时会自动生成最小素材，
 * 所以它也能在 CI（没有真实作品库）里跑。
 */
import { Readable } from 'node:stream'
import { spawn } from 'node:child_process'
import { writeFile, mkdir, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { DATA_DIR, StudioConfig } from './src/config.js'
import { MediaIndex } from './src/scan.js'
import { JobRunner } from './src/jobs.js'
import { Routes } from './src/routes.js'
import { RunningHub } from './src/rh.js'
import { ApiMart } from './src/ai.js'
import { FFmpeg } from './src/ff.js'
import { ProjectStore } from './src/project.js'

const ROOT = process.env.WANFENG_ROOT || 'D:\\codex\\wanfeng'
const ISOLATED = Boolean(process.env.WANFENG_ROOT)
const config = new StudioConfig()
const index = new MediaIndex(config)
const jobs = new JobRunner(config, index)
const ff = new FFmpeg({ config })
const rh = new RunningHub({ config, dataDir: DATA_DIR })
const ai = new ApiMart({ config, ff, dataDir: DATA_DIR })
const flow = new ProjectStore({ config, index, ff, rh, ai, dataDir: DATA_DIR })
const ctx = { get: () => ({ requestRejection: () => undefined }) }
const routes = new Routes(ctx, config, index, jobs, flow, rh, ai, ff)
const sleep = ms => new Promise(r => setTimeout(r, ms))

function mockReq(method, url, body) {
  const req = body === undefined ? Readable.from([]) : Readable.from([Buffer.from(body)])
  req.method = method
  req.url = url
  req.headers = {}
  return req
}

function mockRes() {
  const chunks = []
  const res = {
    statusCode: 200,
    headers: {},
    ended: false,
    setHeader(k, v) { this.headers[k.toLowerCase()] = v },
    write(chunk) { chunks.push(Buffer.from(chunk)); return true },
    end(chunk) { if (chunk) chunks.push(Buffer.from(chunk)); this.ended = true },
    pipe() { this.ended = true; return this },
    on() { return this },
  }
  Object.defineProperty(res, 'chunks', { get: () => chunks })
  Object.defineProperty(res, 'headersSent', { get: () => res.ended || chunks.length > 0 })
  return res
}

async function call(method, path, body) {
  const res = mockRes()
  await routes.handle(mockReq(method, '/wanfeng-studio' + path, body), res)
  const text = Buffer.concat(res.chunks).toString('utf8')
  let parsed = null
  try { parsed = JSON.parse(text) } catch { /* 非 JSON */ }
  return { status: res.statusCode, headers: res.headers, text, json: parsed }
}

const results = []
function check(name, ok, detail = '') {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  ${detail}`)
}

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)
const ECHO = join(ROOT, '.wanfeng-studio', 'echo-selftest.py')
const UPLOAD_NAME = '自测-上传.png'
const FLOW = '自测-流程-临时'
const FLOW_DIR = join(ROOT, FLOW)
let uploadedAbs = ''
let originalTimeline = null

function renderTestVideo(outPath) {
  return new Promise(async (resolve, reject) => {
    const { ffmpeg } = await ff.paths()
    const child = spawn(ffmpeg, ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=24:duration=3', '-pix_fmt', 'yuv420p', outPath], { windowsHide: true })
    let stderr = ''
    child.stderr.on('data', chunk => { stderr += chunk.toString() })
    child.on('error', reject)
    child.on('close', code => (code === 0 ? resolve() : reject(new Error(`ffmpeg ${code}: ${stderr.slice(0, 200)}`))))
  })
}

/** CI / 空目录：造几个作品文件夹，让索引、素材、流程断言有东西可测。 */
async function bootstrapFixture() {
  if (!ISOLATED) return
  const dirs = [
    join(ROOT, '测试-作品A', '参考图'),
    join(ROOT, '测试-作品B', '成片'),
    join(ROOT, '测试-作品C', 'source'),
  ]
  for (const dir of dirs) await mkdir(dir, { recursive: true })
  await writeFile(join(ROOT, '测试-作品A', '参考图', 'a1.png'), PNG)
  await writeFile(join(ROOT, '测试-作品A', '参考图', 'a2.png'), PNG)
  await writeFile(join(ROOT, '测试-作品A', '参考图', 'a3.png'), PNG)
  await writeFile(join(ROOT, '测试-作品B', '成片', 'b1.png'), PNG)
  await renderTestVideo(join(ROOT, '测试-作品C', 'source', 'demo.mp4'))
  await writeFile(join(ROOT, '测试-作品C', '处理.py'), 'print("fixture")\n', 'utf8')
  await index.ensure(true)
}

try {
  await bootstrapFixture()
  const health = await call('GET', '/health')
  check('health', health.status === 200 && health.json?.ok === true, `items=${health.json?.items} root=${health.json?.root}`)

  const works = await call('GET', '/works')
  check('works', works.status === 200 && Array.isArray(works.json?.works) && works.json.works.length >= 3, `works=${works.json?.works?.length}`)

  const assets = await call('GET', '/assets?kind=image&limit=3')
  check('assets', assets.status === 200 && assets.json?.items?.length === 3 && assets.json.items[0].url, `total=${assets.json?.total}`)

  const head = await call('HEAD', '/media?path=' + encodeURIComponent(assets.json.items[0].rel))
  check('media head', head.status === 200 && /image\//.test(head.headers['content-type'] || ''), head.headers['content-type'])

  const up = await call('POST', '/upload?name=' + encodeURIComponent(UPLOAD_NAME), PNG)
  uploadedAbs = join(ROOT, up.json?.rel || '')
  const upStat = uploadedAbs ? await stat(uploadedAbs).catch(() => null) : null
  check('upload', up.status === 200 && upStat?.size === PNG.length, `rel=${up.json?.rel} size=${upStat?.size}`)

  originalTimeline = (await call('GET', '/timeline')).json?.timeline
  const testTimeline = {
    width: 1280,
    height: 720,
    fps: 24,
    duration: 12,
    tracks: {
      video: [{ id: 'c1', rel: assets.json.items[0].rel, name: '测试', kind: 'image', start: 1, length: 4, volume: 1 }],
      graphics: [],
      audio: [],
    },
  }
  const saved = await call('POST', '/timeline', JSON.stringify(testTimeline))
  const reread = await call('GET', '/timeline')
  check('timeline roundtrip', saved.status === 200 && reread.json?.timeline?.fps === 24 && reread.json.timeline.tracks.video.length === 1, `fps=${reread.json?.timeline?.fps}`)
  if (originalTimeline) await call('POST', '/timeline', JSON.stringify(originalTimeline))

  await writeFile(ECHO, 'import sys\nprint("echo:", sys.argv[1:])\n', 'utf8')
  const started = await call('POST', '/jobs', JSON.stringify({ script: '.wanfeng-studio/echo-selftest.py', args: ['你好', 'job'] }))
  check('job start', started.status === 200 && started.json?.id, `id=${started.json?.id}`)
  await sleep(2500)
  const job = await call('GET', '/jobs/' + started.json.id)
  check('job run', job.json?.status === 'done' && /echo:/.test(job.json?.log || ''), `status=${job.json?.status} log=${(job.json?.log || '').trim().slice(0, 80)}`)
  const list = await call('GET', '/jobs')
  check('job list', list.json?.items?.length >= 1, `count=${list.json?.items?.length}`)

  const cfg = await call('GET', '/config')
  check('config', cfg.status === 200 && cfg.json?.root === ROOT, `root=${cfg.json?.root}`)

  const missing = await call('GET', '/assets?work=' + encodeURIComponent('不存在的作品'))
  check('empty work', missing.status === 200 && missing.json?.total === 0, `total=${missing.json?.total}`)

  /* ---------------- 复刻流程 ---------------- */

  await rm(FLOW_DIR, { recursive: true, force: true })

  const created = await call('POST', '/flow/create', JSON.stringify({ name: FLOW }))
  check('flow create', created.status === 200 && created.json?.project?.name === FLOW, `status=${created.status}`)

  const listed = await call('GET', '/flow/projects')
  check('flow list', listed.status === 200 && (listed.json?.projects || []).some(row => row.name === FLOW), `count=${listed.json?.projects?.length}`)

  const srcRel = `${FLOW}/src/source.mp4`
  try {
    await renderTestVideo(join(ROOT, srcRel))
  } catch (error) {
    check('flow testvideo', false, error.message)
  }
  const sourced = await call('POST', '/flow/source', JSON.stringify({ name: FLOW, rel: srcRel }))
  check('flow source', sourced.status === 200 && sourced.json?.project?.source?.duration > 2, `duration=${sourced.json?.project?.source?.duration}`)

  const split = await call('POST', '/flow/split', JSON.stringify({ name: FLOW, seconds: 2 }))
  check('flow split', split.status === 200 && (split.json?.shots || []).length === 2, `shots=${split.json?.shots?.length}`)

  const blocked = await call('POST', '/flow/swap/start', JSON.stringify({ name: FLOW }))
  check('gate blocks swap', blocked.status === 403 && blocked.json?.gate === true, `status=${blocked.status} error=${blocked.json?.error}`)

  const cast = await call('POST', '/flow/cast/generate', JSON.stringify({ name: FLOW, outfit: '白色针织衫' }))
  check('cast accepted', cast.status === 200 && cast.json?.version?.status === 'generating', `id=${cast.json?.version?.id}`)
  await sleep(1500)
  const afterCast = await call('GET', '/flow/project?name=' + encodeURIComponent(FLOW))
  const row = afterCast.json?.project?.cast?.versions?.[0]
  check('cast fails without key', row?.status === 'failed', `status=${row?.status} error=${row?.error}`)

  const settings = await call('GET', '/flow/settings')
  check('flow settings masked', settings.status === 200 && settings.json?.config?.runninghub?.hasKey === false && !settings.json?.config?.runninghub?.key, `hasKey=${settings.json?.config?.runninghub?.hasKey}`)

  const tested = await call('POST', '/flow/test')
  check('flow test', tested.status === 200 && Array.isArray(tested.json?.rows) && tested.json.rows.length >= 3, `rows=${tested.json?.rows?.length} ff=${tested.json?.ff?.ffmpeg}`)

  const bad = await call('GET', '/flow/project?name=' + encodeURIComponent('../etc'))
  check('flow name guarded', bad.status >= 400, `status=${bad.status}`)
} catch (error) {
  check('exception', false, error.stack || String(error))
} finally {
  if (uploadedAbs) await rm(uploadedAbs, { force: true }).catch(() => {})
  await rm(ECHO, { force: true }).catch(() => {})
  await rm(FLOW_DIR, { recursive: true, force: true }).catch(() => {})
}

const failed = results.filter(r => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
process.exit(failed.length ? 1 : 0)