/**
 * RunningHub 客户端。
 *
 * 职责：读工作流图（getJsonApiFormat）、上传素材、提交任务、轮询产物。
 * 所有调用都带 API Key；Key 只来自本地配置（config.json）或环境变量，
 * 任何错误信息都会把 Key 换成 [key] 再返回，绝不写入日志或磁盘。
 *
 * RunningHub 的错误码：
 *   0            成功
 *   605          钱包余额不足（NOT_ENOUGH_BALANCE）
 *   421 / 415    该 Key 的并发槽位已满
 *   805 / 807    任务执行失败（OOM 类错误重跑一次通常能过）
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { fillGraph } from './workflows.js'

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'

export class RunningHubError extends Error {
  constructor(message, code) {
    super(message)
    this.name = 'RunningHubError'
    this.code = code
  }
}

export class RunningHub {
  constructor({ config, dataDir }) {
    this.config = config
    this.dataDir = dataDir
  }

  async settings() {
    const cfg = await this.config.read()
    const rh = (cfg.runninghub && typeof cfg.runninghub === 'object') ? cfg.runninghub : {}
    const coinCny = Number(rh.coinCny)
    return {
      base: String(rh.base || 'https://www.runninghub.cn').replace(/\/+$/, ''),
      keys: String(rh.key || '')
        .split(',')
        .map(row => row.trim())
        .filter(Boolean),
      concurrency: Math.max(1, Math.min(16, Number(rh.concurrency) || 5)),
      coinCny: Number.isFinite(coinCny) && coinCny > 0 ? coinCny : 399 / 180000,
      swapWorkflowId: String(rh.swapWorkflowId || '').trim(),
      upscaleWorkflowId: String(rh.upscaleWorkflowId || '').trim(),
      swapNodes: rh.swapNodes && typeof rh.swapNodes === 'object' ? rh.swapNodes : {},
    }
  }

  /** 配置里没写 Key 时退回环境变量，方便在 CI / 命令行里试跑。 */
  async keys() {
    const settings = await this.settings()
    if (settings.keys.length) return settings.keys
    return String(process.env.RUNNINGHUB_API_KEY || '')
      .split(',')
      .map(row => row.trim())
      .filter(Boolean)
  }

  redact(value, keys) {
    let text = JSON.stringify(value)
    for (const key of keys) {
      if (key && key.length > 4) text = text.split(key).join('[key]')
    }
    try {
      return JSON.parse(text)
    } catch {
      return { code: -1, msg: text.slice(0, 400) }
    }
  }

  async call(key, path, body, timeout = 120000) {
    const settings = await this.settings()
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeout)
    try {
      const res = await fetch(settings.base + path, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${key}`, 'user-agent': UA },
        body: JSON.stringify({ apiKey: key, ...body }),
        signal: controller.signal,
      })
      const text = await res.text()
      let out
      try {
        out = JSON.parse(text)
      } catch {
        out = { code: -1, msg: text.slice(0, 300) }
      }
      if (out && typeof out === 'object' && out.data && typeof out.data === 'object') {
        delete out.data.netWssUrl
        delete out.data.clientId
      }
      return this.redact(out, [key])
    } catch (error) {
      return { code: -1, msg: `network: ${error.name}: ${String(error.message || error).replace(key, '[key]').slice(0, 200)}` }
    } finally {
      clearTimeout(timer)
    }
  }

  /** 账户信息与余额——不产生费用，用来验证 Key 是否可用。 */
  async account(key) {
    const out = await this.call(key, '/uc/openapi/accountStatus', { apikey: key }, 30000)
    if (out.code !== 0) throw new RunningHubError(`RunningHub 拒绝了 Key：${out.msg || out.code}`, out.code)
    return out.data || {}
  }

  async test() {
    const keys = await this.keys()
    if (!keys.length) throw new RunningHubError('还没有配置 RunningHub API Key', 'NO_KEY')
    const rows = []
    for (const key of keys) {
      try {
        const data = await this.account(key)
        rows.push({
          key: `${key.slice(0, 4)}…${key.slice(-4)}`,
          ok: true,
          name: data.nickName || data.userName || '',
          balance: data.remainCoins ?? data.coins ?? data.balance ?? null,
          member: data.memberType || data.vipLevel || '',
        })
      } catch (error) {
        rows.push({ key: `${key.slice(0, 4)}…${key.slice(-4)}`, ok: false, error: error.message })
      }
    }
    return rows
  }

  /**
   * 工作流的 API 图（节点图）。首次用 Key 取，之后用本地缓存；
   * requiredNodes 里每个 {节点号: class_type} 都会校验，作者改了工作流会立刻报错而不是跑出怪结果。
   */
  async workflow(workflowId, requiredNodes = {}) {
    if (!workflowId) throw new RunningHubError('没有配置工作流 ID', 'NO_WORKFLOW')
    const keys = await this.keys()
    if (!keys.length) throw new RunningHubError('还没有配置 RunningHub API Key', 'NO_KEY')
    const dir = join(this.dataDir, 'workflows')
    const cache = join(dir, `workflow-${workflowId}.json`)
    let graph = null
    try {
      graph = JSON.parse(await readFile(cache, 'utf8'))
    } catch {
      graph = null
    }
    if (!graph) {
      const out = await this.call(keys[0], '/api/openapi/getJsonApiFormat', { workflowId })
      const prompt = out.data && out.data.prompt
      if (out.code !== 0 || !prompt) {
        throw new RunningHubError(`取不到工作流 ${workflowId}：${out.msg || out.code}。先确认它仍在 RunningHub 上公开可用。`, out.code)
      }
      graph = typeof prompt === 'string' ? JSON.parse(prompt) : prompt
      await mkdir(dir, { recursive: true })
      await writeFile(cache, JSON.stringify(graph), 'utf8')
    }
    const bad = Object.entries(requiredNodes || {})
      .filter(([id, type]) => !graph[id] || (type && graph[id].class_type !== type))
      .map(([id]) => id)
    if (bad.length) {
      throw new RunningHubError(`工作流 ${workflowId} 的节点变了（${bad.join(', ')} 对不上），可能被作者改过；删掉 ${cache} 重取，或改配置里的节点号。`, 'NODE_MISMATCH')
    }
    return graph
  }

  async upload(filePath, keyName) {
    const keys = await this.keys()
    if (!keys.length) throw new RunningHubError('还没有配置 RunningHub API Key', 'NO_KEY')
    const key = keyName ? keys[Number(keyName.replace(/\D/g, '')) - 1] || keys[0] : keys[0]
    const settings = await this.settings()
    const buffer = await readFile(filePath)
    const form = new FormData()
    form.set('apiKey', key)
    form.set('fileType', 'input')
    form.set('file', new Blob([buffer]), basename(filePath))
    let last = null
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const res = await fetch(settings.base + '/task/openapi/upload', {
          method: 'POST',
          headers: { authorization: `Bearer ${key}`, 'user-agent': UA },
          body: form,
        })
        const out = await res.json()
        if (out.code === 0 && out.data && out.data.fileName) return out.data.fileName
        last = out
      } catch (error) {
        last = { code: -1, msg: String(error.message || error) }
      }
      await new Promise(resolve => setTimeout(resolve, 2000 * (attempt + 1)))
    }
    throw new RunningHubError(`上传 ${basename(filePath)} 失败：${(last && last.msg) || last}`, (last && last.code) || -1)
  }

  async create(key, workflowId, graph) {
    const out = await this.call(key, '/task/openapi/create', {
      workflowId,
      workflow: JSON.stringify(graph),
      addMetadata: false,
    })
    if (out.code === 0 && out.data && out.data.taskId) return String(out.data.taskId)
    throw new RunningHubError(`提交任务失败：${out.msg || out.code}`, out.code)
  }

  async outputs(key, taskId) {
    return this.call(key, '/task/openapi/outputs', { taskId })
  }

  async download(url, outPath) {
    const res = await fetch(url, { headers: { 'user-agent': UA } })
    if (!res.ok) throw new RunningHubError(`下载产物失败：HTTP ${res.status}`, res.status)
    const buffer = Buffer.from(await res.arrayBuffer())
    await mkdir(join(outPath, '..'), { recursive: true })
    await writeFile(outPath, buffer)
    return buffer.length
  }

  /**
   * 一个 take 的完整提交：上传视频与参考图 → 按 swap 图的约定填节点 → 创建任务。
   * take = { id, video, pictures[], prompt, seconds, width, height, seed, keyIndex }
   */
  async submitSwap(take, keyName) {
    const settings = await this.settings()
    const keys = await this.keys()
    const idx = Math.max(0, Number(String(keyName || 'k1').replace(/\D/g, '')) - 1)
    const key = keys[idx] || keys[0]
    const graph = await this.workflow(settings.swapWorkflowId, settings.swapNodes)
    const videoName = await this.upload(take.video, keyName)
    const pictureNames = []
    for (const picture of take.pictures || []) pictureNames.push(await this.upload(picture, keyName))
    const filled = buildSwapGraph(graph, videoName, pictureNames, take)
    const taskId = await this.create(key, settings.swapWorkflowId, filled)
    return { taskId, keyName: `k${idx + 1}` }
  }

  /**
   * 通用工作流提交：任何 RunningHub 工作流，只要给出输入节点映射（plan），
   * 就能把本地视频 / 参考图 / 提示词 / 数字参数填进去。
   */
  async runWorkflow({ workflowId, plan, inputs = {}, keyName }) {
    if (!workflowId) throw new RunningHubError('还没有选择工作流', 'NO_WORKFLOW')
    const keys = await this.keys()
    if (!keys.length) throw new RunningHubError('还没有配置 RunningHub API Key', 'NO_KEY')
    const idx = Math.max(0, Number(String(keyName || 'k1').replace(/\D/g, '')) - 1)
    const key = keys[idx] || keys[0]
    const graph = await this.workflow(workflowId)
    const video = inputs.video ? await this.upload(inputs.video, keyName) : ''
    const images = []
    for (const file of inputs.images || []) images.push(await this.upload(file, keyName))
    const filled = fillGraph(graph, plan || {}, inputs, { video, images })
    const taskId = await this.create(key, workflowId, filled)
    return { taskId, keyName: `k${idx + 1}` }
  }

  async submitUpscale(videoPath, keyName, shortSide = 1080) {
    const settings = await this.settings()
    if (!settings.upscaleWorkflowId) throw new RunningHubError('没有配置超分工作流 ID', 'NO_WORKFLOW')
    const keys = await this.keys()
    const idx = Math.max(0, Number(String(keyName || 'k1').replace(/\D/g, '')) - 1)
    const key = keys[idx] || keys[0]
    const graph = await this.workflow(settings.upscaleWorkflowId, { '16': 'VHS_LoadVideo', '65': null, '71': null })
    const videoName = await this.upload(videoPath, keyName)
    const filled = buildUpscaleGraph(graph, videoName, shortSide)
    const taskId = await this.create(key, settings.upscaleWorkflowId, filled)
    return { taskId, keyName: `k${idx + 1}` }
  }

  /** 把任务产物落到本地，顺便把 RH 币与钱包费用换算成人民币。 */
  async collect(keyName, taskId, outPath) {
    const settings = await this.settings()
    const keys = await this.keys()
    const idx = Math.max(0, Number(String(keyName || 'k1').replace(/\D/g, '')) - 1)
    const key = keys[idx] || keys[0]
    const out = await this.outputs(key, taskId)
    if (out.code !== 0 || !Array.isArray(out.data) || !out.data.length) {
      if (out.code === 805 || out.code === 807) {
        const reason = String((out.data && out.data.failedReason) || out.msg || '任务失败').slice(0, 300)
        return { status: 'failed', error: reason, code: out.code }
      }
      return { status: 'running', code: out.code }
    }
    const item = out.data.find(row => String(row.fileType || '').toLowerCase() === 'mp4')
      || out.data.find(row => String(row.fileType || '').toLowerCase() === 'video')
      || out.data[0]
    const url = item.fileUrl || item.url
    if (!url) return { status: 'running' }
    await this.download(url, outPath)
    const money = Number(item.consumeMoney || 0)
    const coins = Number(item.consumeCoins || 0)
    return {
      status: 'done',
      cny: Math.round((money + coins * settings.coinCny) * 10000) / 10000,
      money,
      coins,
      runSeconds: Number(item.taskCostTime || 0),
      url,
    }
  }
}

/** 按 mvswap 的节点约定填图：554=原片、200/90x=角色图、557=提示词、386=秒数、385=宽高、456=种子。 */
export function buildSwapGraph(base, videoName, pictureNames, take) {
  const graph = JSON.parse(JSON.stringify(base))
  if (graph['554']) graph['554'].inputs.video = videoName
  if (graph['200'] && pictureNames.length) graph['200'].inputs.image = pictureNames[0]
  const refNode = graph['385']
  if (refNode && pictureNames.length > 1) {
    pictureNames.slice(1).forEach((name, i) => {
      const id = String(900 + i)
      graph[id] = { class_type: 'LoadImage', inputs: { image: name }, _meta: { title: `picture ${i + 2}` } }
      if (refNode.inputs) refNode.inputs[`ref_images.ref_image_${i + 1}`] = [id, 0]
    })
  }
  if (graph['557'] && graph['557'].inputs) graph['557'].inputs.text = take.prompt || ''
  if (graph['386'] && graph['386'].inputs) graph['386'].inputs.value = Number(take.seconds) || 0
  if (refNode && refNode.inputs) {
    if (take.width) refNode.inputs.width = Number(take.width)
    if (take.height) refNode.inputs.height = Number(take.height)
  }
  if (graph['456'] && graph['456'].inputs) graph['456'].inputs.seed = Number(take.seed) || 20261024
  return graph
}

/** SeedVR2 超分：16=视频、65=SeedVR2（直接吃原帧）、71=短边像素。 */
export function buildUpscaleGraph(base, videoName, shortSide) {
  const graph = JSON.parse(JSON.stringify(base))
  if (graph['16'] && graph['16'].inputs) graph['16'].inputs.video = videoName
  if (graph['65'] && graph['65'].inputs) {
    graph['65'].inputs.images = ['16', 0]
    graph['65'].inputs.seed = 42
  }
  if (graph['71'] && graph['71'].inputs) graph['71'].inputs.value = Number(shortSide) || 1080
  delete graph['68']
  delete graph['69']
  return graph
}

/** 默认工作流节点表：让首次使用者填工作流 ID 后能立刻校验。 */
export const DEFAULT_SWAP_NODES = {
  '554': 'VHS_LoadVideo',
  '200': 'LoadImage',
  '385': 'MiniMaxH3ReferenceToVideo',
  '557': 'JjkText',
  '386': 'Float',
  '456': 'SelfLiftH3Sampler',
}