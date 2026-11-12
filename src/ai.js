/**
 * APIMart 客户端：任意 OpenAI 兼容的视觉模型（认人、审片）+ GPT Image（角色图 / 分镜图）。
 *
 * 两个 Key 可以分开配：
 *   api.apimart.key       画图（/images/generations）
 *   api.apimart.visionKey 视觉（/chat/completions）；留空则复用画图 Key
 * 也都支持环境变量 APIMART_API_KEY / VISION_API_KEY。
 *
 * 视觉请求里图片走 base64 data URL：超过 ~200 KB 的图先用 ffmpeg 缩到 768px 长边，
 * 不然一张 1.7 MB 的全身图要传好几分钟，而模型在这个尺寸上看不出更多东西。
 */
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { basename, extname, join } from 'node:path'

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'
const MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' }

export class ApiMartError extends Error {
  constructor(message, code) {
    super(message)
    this.name = 'ApiMartError'
    this.code = code
  }
}

export class ApiMart {
  constructor({ config, ff, dataDir }) {
    this.config = config
    this.ff = ff
    this.dataDir = dataDir
    this.spent = { vision: 0, image: 0 }
  }

  async settings() {
    const cfg = await this.config.read()
    const api = (cfg.apimart && typeof cfg.apimart === 'object') ? cfg.apimart : {}
    const usdCny = Number(api.usdCny)
    return {
      base: String(api.base || 'https://api.apimart.ai/v1').replace(/\/+$/, ''),
      visionBase: String(api.visionBase || api.base || 'https://api.apimart.ai/v1').replace(/\/+$/, ''),
      key: String(api.key || '').trim() || String(process.env.APIMART_API_KEY || '').trim(),
      visionKey: String(api.visionKey || '').trim() || String(process.env.VISION_API_KEY || '').trim(),
      imageModel: String(api.imageModel || 'gpt-image-2.5-sunburst').trim(),
      visionModel: String(api.visionModel || 'gemini-3.8-flash').trim(),
      usdCny: Number.isFinite(usdCny) && usdCny > 0 ? usdCny : 7.2,
      visionPriceIn: Number(api.visionPriceIn) || 0.3,
      visionPriceOut: Number(api.visionPriceOut) || 2.5,
    }
  }

  async imageKey() {
    const settings = await this.settings()
    if (!settings.key) throw new ApiMartError('还没有配置 APIMart Key（角色图 / 分镜图要用）', 'NO_KEY')
    return settings.key
  }

  async visionKey() {
    const settings = await this.settings()
    const key = settings.visionKey || settings.key
    if (!key) throw new ApiMartError('还没有配置 APIMart / VISION Key（审片要用）', 'NO_KEY')
    return { key, base: settings.visionBase }
  }

  async request(base, key, method, path, body, timeout = 180000) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeout)
    try {
      const res = await fetch(base + path, {
        method,
        headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json', 'user-agent': UA },
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      })
      const text = await res.text()
      try {
        return JSON.parse(text)
      } catch {
        return { error: text.slice(0, 400) }
      }
    } catch (error) {
      throw new ApiMartError(`${path}: ${error.name}: ${String(error.message || error).replace(key, '[key]').slice(0, 200)}`)
    } finally {
      clearTimeout(timer)
    }
  }

  /** 视觉调用，要求模型只回 JSON；解析失败会追加一句再试一次。 */
  async askJson(prompt, imagePaths, maxTokens = 4000) {
    const { key, base } = await this.visionKey()
    const settings = await this.settings()
    const parts = [{ type: 'text', text: prompt }]
    for (const imagePath of imagePaths) parts.push({ type: 'image_url', image_url: { url: await this.dataUrl(imagePath) } })
    let lastText = ''
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const out = await this.request(base, key, 'POST', '/chat/completions', {
        model: settings.visionModel,
        messages: [{ role: 'user', content: attempt === 0 ? parts : [{ type: 'text', text: prompt + '\n\nAnswer with the JSON only.' }, ...parts.slice(1)] }],
        max_tokens: maxTokens,
        stream: false,
      })
      if (out.error) throw new ApiMartError(`视觉模型调用失败：${String(out.error).slice(0, 300)}`)
      const usage = out.usage || {}
      this.spent.vision += ((Number(usage.prompt_tokens) || 0) * settings.visionPriceIn
        + (Number(usage.completion_tokens) || 0) * settings.visionPriceOut) / 1e6 * settings.usdCny
      lastText = (out.choices && out.choices[0] && out.choices[0].message && out.choices[0].message.content) || ''
      const match = lastText.match(/\{[\s\S]*\}|\[[\s\S]*\]/)
      if (match) {
        try {
          return JSON.parse(match[0])
        } catch {
          /* 继续重试 */
        }
      }
    }
    throw new ApiMartError(`视觉模型没有返回 JSON：${lastText.slice(0, 300)}`)
  }

  /** 本地图 → data URL；大图先缩到 768px 长边。 */
  async dataUrl(imagePath) {
    let file = imagePath
    try {
      const info = await stat(imagePath)
      if (info.size > 200_000) {
        const small = join(this.dataDir, 'tmp', `q-${Date.now()}-${Math.random().toString(36).slice(2, 7)}.jpg`)
        await mkdir(join(this.dataDir, 'tmp'), { recursive: true })
        const ok = await this.ff.thumb(imagePath, small, 768)
        if (ok) file = small
      }
    } catch {
      /* 读不到就用原图，让请求自己报错 */
    }
    const mime = MIME[extname(file).toLowerCase()] || 'image/jpeg'
    const bytes = await readFile(file)
    return `data:${mime};base64,${bytes.toString('base64')}`
  }

  /** 上传图片到 APIMart，换一个 72 小时有效的公网 URL。 */
  async uploadImage(imagePath) {
    const key = await this.imageKey()
    const settings = await this.settings()
    const buffer = await readFile(imagePath)
    const form = new FormData()
    form.set('file', new Blob([buffer]), basename(imagePath))
    const res = await fetch(settings.base + '/uploads/images', {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'user-agent': UA },
      body: form,
    })
    const out = await res.json().catch(() => ({}))
    const url = out.url || (out.data && out.data.url)
    if (!url) throw new ApiMartError(`APIMart 上传失败：${JSON.stringify(out).slice(0, 200)}`)
    return url
  }

  /**
   * 画一张图（角色图 / 分镜图）。refs 是参考图，图模型的计费按参考图像素算，
   * 所以每张参考图先缩到 1024px 长边。
   */
  async generateImage({ prompt, refs = [], outPath, size = '9:16', resolution = '2k', quality = 'high' }) {
    const key = await this.imageKey()
    const settings = await this.settings()
    const tmpDir = join(this.dataDir, 'tmp')
    await mkdir(tmpDir, { recursive: true })
    const urls = []
    for (let i = 0; i < refs.length; i += 1) {
      const shrunk = join(tmpDir, `ref-${Date.now()}-${i}.jpg`)
      const ok = await this.ff.thumb(refs[i], shrunk, 1024)
      urls.push(await this.uploadImage(ok ? shrunk : refs[i]))
    }
    const created = await this.request(settings.base, key, 'POST', '/images/generations', {
      model: settings.imageModel,
      prompt,
      size,
      resolution,
      quality,
      n: 1,
      image_urls: urls,
    })
    const task = created.data && created.data[0] && created.data[0].task_id
    if (!task) throw new ApiMartError(`APIMart 没有返回任务 id：${JSON.stringify(created).slice(0, 300)}`)
    const deadline = Date.now() + 15 * 60 * 1000
    while (Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 5000))
      const state = await this.request(settings.base, key, 'GET', `/tasks/${task}`)
      const data = state.data || state
      const status = data.status
      if (status === 'completed') {
        const images = (data.result && data.result.images) || []
        const raw = images[0] && images[0].url
        const url = Array.isArray(raw) ? raw[0] : raw
        if (!url) throw new ApiMartError('APIMart 任务完成但没有图片 URL')
        const res = await fetch(url, { headers: { 'user-agent': UA } })
        if (!res.ok) throw new ApiMartError(`下载图片失败：HTTP ${res.status}`)
        await mkdir(join(outPath, '..'), { recursive: true })
        await writeFile(outPath, Buffer.from(await res.arrayBuffer()))
        const cny = Math.round((Number(data.cost) || 0) * settings.usdCny * 10000) / 10000
        this.spent.image += cny
        return { cost: cny, url }
      }
      if (status === 'failed' || status === 'cancelled') {
        throw new ApiMartError(`图片任务失败：${JSON.stringify(data.error || data).slice(0, 300)}`)
      }
    }
    throw new ApiMartError('图片任务超时（15 分钟）')
  }

  /** 不产生费用地验证 Key：列模型。 */
  async test() {
    const settings = await this.settings()
    const rows = []
    if (settings.key) {
      try {
        const out = await this.request(settings.base, settings.key, 'GET', '/models')
        rows.push({ provider: 'APIMart 画图', ok: true, models: (out.data || []).slice(0, 8).map(row => row.id || row) })
      } catch (error) {
        rows.push({ provider: 'APIMart 画图', ok: false, error: error.message })
      }
    } else {
      rows.push({ provider: 'APIMart 画图', ok: false, error: '未配置 Key' })
    }
    rows.push({
      provider: '视觉模型',
      ok: Boolean(settings.visionKey || settings.key),
      model: settings.visionModel,
      error: settings.visionKey || settings.key ? '' : '未配置 Key',
    })
    return rows
  }
}

/** 角色图提示词：锁死身份，只换衣服 / 姿势 / 场景，保全身入画与真实摄影质感。 */
export function castPrompt({ outfit, pose, shoes, scene, keepBg }) {
  const setting = keepBg
    ? 'the same plain grey studio wall and floor as the reference, clean and empty'
    : (scene || 'a plain light grey studio wall and floor, clean and empty')
  return [
    'Edit the reference into ONE photographic full-body portrait of the SAME woman.',
    'Identity is locked: same face, facial features, eyebrows, eye shape, nose, lips, skin tone, hair colour,',
    'the exact same body proportions and leg shape as the reference sheet.',
    'Do not beautify, slim, lengthen or otherwise alter the body; the legs keep the same thinness and length ratio.',
    `Outfit: ${outfit}.`,
    `Footwear: ${shoes || 'shoes that match the outfit'}.`,
    `Pose: ${pose || 'standing, slightly turned to one side, feet naturally together'}. Natural relaxed stance,`,
    'weight on one leg, looking slightly away from the camera with a calm neutral expression.',
    `Setting: ${setting}. Single soft natural light source from one side, soft natural shadows.`,
    'Composition: head to toe fully inside the frame with a small margin above the head and below the feet,',
    'the whole figure centred, nothing cropped. Vertical portrait format.',
    'Style: real photography, neutral white balance, low saturation, visible skin texture and pores,',
    'no skin smoothing, no beauty filter, shallow depth of field, plain uncluttered background.',
    'Absolutely no text, no letters, no logo, no watermark, no border, no split panels, no collage,',
    'no mirror, no second person, no props.',
  ].join(' ')
}

/** 成片质检提示词：只判明确的硬伤，不给「低置信度 / 红唇 / 轻微调色」判死刑。 */
export function qaPrompt({ subject, outfit, scene }) {
  return [
    'Images 1-2 are the OFFICIAL identity reference photos of the person being remade.',
    'Image 3 is the APPROVED full-body character sheet for this video.',
    'Image 4 is a real frame of the ORIGINAL clip (the scene anchor).',
    'The remaining images are frames sampled from the AI-generated FINAL video, in time order.',
    subject ? `The person: ${subject}.` : '',
    outfit ? `The approved outfit: ${outfit}.` : '',
    scene ? `The original scene: ${scene}.` : '',
    'Judge ONLY these and answer JSON: (a) same_person (b) second_face_or_ghost: any second person,',
    'second face, semi-transparent duplicate figure or floating legs (c) face_deformed',
    '(d) outfit_matches_sheet (e) visible_text_logo_ui (f) scene_matches_anchor',
    '(g) framing_problem: cropped head or feet, black bars/letterbox, squeezed or stretched body',
    '(h) frame_jump: sudden outfit/person/size change between sampled frames.',
    'Use true/false for all eight, plus "problems": ["..."], "verdict": "PASS" or "FAIL".',
    'verdict FAIL ONLY for a clearly different person, a second face/person/ghost, genuine face deformation,',
    'visible baked-in text/UI, or a clear internal jump. Do NOT fail on low confidence, red lips,',
    'slight scene restyling, or a small blurry face.',
  ].filter(Boolean).join(' ')
}