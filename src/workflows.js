/**
 * RunningHub 工作流接入层。
 *
 * 万风自己的换人 / 超分工作流是写死节点号的；但 RunningHub 上任何公开工作流都能接进来：
 * 拉一次图（getJsonApiFormat），按 class_type 认出「哪个节点吃视频、哪个吃图、哪个是提示词、
 * 哪几个是数字参数」，让用户点一下确认映射，就变成可复用的一条工作流。
 *
 * 这样插件不用内置一堆未知作者的 ID，也不会因为别人改了工作流而静默跑出错误结果。
 */

const VIDEO_IN = /loadvideo|vhs_loadvideo|load_video|videoinput/i
const IMAGE_IN = /^loadimage$|load_image|imageinput/i
const TEXT_IN = /cliptextencode|jjktext|textencode|^string$|primitive_string|t5text/i
const NUMBER_IN = /^(float|int|primitivefloat|primitiveint|number|integer)$/i
const VIDEO_OUT = /savevideo|vhs_videocombine|createvideo|saveanimatedwebp|video_combine|savevideo|vhs_video/i
const IMAGE_OUT = /^saveimage$|save_image/i

/** 内置两条已经验证过节点的流程；其余由用户在界面上探测后保存。 */
export const BUILTIN = [
  {
    id: 'swap',
    name: '换人 · Wan2.2 Animate',
    workflowId: '2109190174289780738',
    kind: 'video',
    desc: '保留原片的机位、布景与动作，只把人物换成角色图。背景来自原片像素，不重画场景。',
    plan: { video: '554', images: ['200'], text: '557', numbers: { seconds: '386', width: '385', height: '385', seed: '456' } },
  },
  {
    id: 'seedvr2',
    name: '超分 · SeedVR2',
    workflowId: '1989896719183867905',
    kind: 'upscale',
    desc: '把成片短边放大到 1080p；对 AI 换人后的软边缘改善明显，画质提升但不改内容。',
    plan: { video: '16', images: [], text: '', numbers: { shortSide: '71' } },
  },
  {
    id: 'animate-h3',
    name: '参考生视频 · MiniMax H3（示例）',
    workflowId: '',
    kind: 'video',
    desc: '示例条目：粘贴你在 RunningHub 上看到的 H3 工作流 ID，点「探测节点」确认输入接线后即可用。',
    plan: { video: '', images: [], text: '', numbers: {} },
  },
]

function titleOf(node) {
  return String((node && node._meta && node._meta.title) || '')
}

/**
 * 扫一遍工作流图，按 class_type 给每个节点打角色标签。
 * 返回的 id 列表按节点号排序，方便默认选第一个。
 */
export function probeGraph(graph) {
  const rows = []
  let count = 0
  for (const [id, node] of Object.entries(graph || {})) {
    if (!node || typeof node !== 'object' || !node.class_type) continue
    count += 1
    const type = String(node.class_type)
    const title = titleOf(node)
    const base = { id, type, title }
    if (VIDEO_IN.test(type)) rows.push({ ...base, role: 'video' })
    else if (IMAGE_IN.test(type)) rows.push({ ...base, role: 'image' })
    else if (TEXT_IN.test(type)) rows.push({ ...base, role: 'text' })
    else if (NUMBER_IN.test(type)) rows.push({ ...base, role: 'number', value: node.inputs ? node.inputs.value : undefined })
    if (VIDEO_OUT.test(type)) rows.push({ ...base, role: 'outVideo' })
    else if (IMAGE_OUT.test(type)) rows.push({ ...base, role: 'outImage' })
  }
  const pick = role => rows.filter(row => row.role === role).map(row => row.id)
  const numbers = rows.filter(row => row.role === 'number')
  return {
    total: count,
    video: pick('video'),
    image: pick('image'),
    text: pick('text'),
    numbers: numbers.map(row => ({ id: row.id, type: row.type, title: row.title, value: row.value })),
    outVideo: pick('outVideo'),
    outImage: pick('outImage'),
    labels: {
      video: rows.filter(row => row.role === 'video').map(row => `${row.id} · ${row.title || row.type}`),
      image: rows.filter(row => row.role === 'image').map(row => `${row.id} · ${row.title || row.type}`),
      text: rows.filter(row => row.role === 'text').map(row => `${row.id} · ${row.title || row.type}`),
    },
  }
}

/** 从标题猜数值节点的语义：宽 / 高 / 种子 / 秒数 / 帧数 / 帧率 / 短边。 */
export function guessNumbers(probe) {
  const out = {}
  const take = (list, pattern) => {
    const hit = list.find(row => pattern.test(`${row.title} ${row.type}`.toLowerCase()))
    return hit ? hit.id : ''
  }
  const list = probe.numbers || []
  out.width = take(list, /width|宽/)
  out.height = take(list, /height|高/)
  out.seed = take(list, /seed|种子/)
  out.seconds = take(list, /second|时长|duration|length/)
  out.frames = take(list, /frame|帧数|length/)
  out.fps = take(list, /fps/)
  out.shortSide = take(list, /short|短边|resolution|尺寸/)
  return Object.fromEntries(Object.entries(out).filter(([, value]) => value))
}

/** 探测结果的默认接线：第一个视频/提示词，最多两张图。 */
export function guessPlan(probe) {
  return {
    video: (probe.video || [])[0] || '',
    images: (probe.image || []).slice(0, 2),
    text: (probe.text || [])[0] || '',
    numbers: guessNumbers(probe),
  }
}

/**
 * 按映射把上传后的文件名与参数填进图。
 * uploaded = { video, images: [文件名] }，inputs = { text, values: {seconds, width, ...} }
 */
export function fillGraph(base, plan, inputs, uploaded) {
  const graph = JSON.parse(JSON.stringify(base))
  const set = (id, patch) => {
    if (!id || !graph[id]) return
    graph[id].inputs = Object.assign({}, graph[id].inputs || {}, patch)
  }
  if (uploaded.video) set(plan.video, { video: uploaded.video })
  ;(plan.images || []).forEach((id, i) => {
    if (uploaded.images && uploaded.images[i]) set(id, { image: uploaded.images[i] })
  })
  if (plan.text && inputs.text) set(plan.text, { text: String(inputs.text) })
  for (const [key, value] of Object.entries(inputs.values || {})) {
    const id = plan.numbers && plan.numbers[key]
    if (!id || value === '' || value === null || value === undefined) continue
    const num = Number(value)
    if (!Number.isFinite(num)) continue
    set(id, { value: num })
  }
  return graph
}

/** 把工作流产物的落点算出来：项目目录优先，否则放上传目录。 */
export function outputRel(workflow, root, stamp) {
  const suffix = String(workflow.kind === 'upscale' ? 'upscale' : 'run').slice(0, 12)
  return `生成结果/${suffix}-${stamp}.mp4`
}