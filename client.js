/**
 * 万风工作台 · 浏览器半边
 *
 * 侧栏加一个「万风工作台」入口，主区域是原生 React 工作台页面（不是 iframe）：
 *   左：素材库 / 作品集 / 任务 / 设置
 *   中：预览舞台（图片、视频直接播）
 *   右：序列设置 + 选中素材信息 + 加入时间线
 *   下：Video / Graphics / Audio 三轨时间线，草稿存到项目根 .wanfeng-studio/timeline.json
 */
window.__ModuleLoader__.load({
  id: 'dsh-wanfeng-studio',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useMemo, useRef, useCallback } = React

    const PANEL = 'wanfeng-studio'
    const API = '/wanfeng-studio'
    const TRACKS = [
      { id: 'video', label: 'Video', hint: '视频' },
      { id: 'graphics', label: 'Graphics', hint: '图片 / 字幕' },
      { id: 'audio', label: 'Audio', hint: '音频' },
    ]
    const EMPTY_TIMELINE = { width: 1920, height: 1080, fps: 30, duration: 30, tracks: { video: [], graphics: [], audio: [] } }
    const FLOW_STEPS = [
      { id: 'source', label: '原片' },
      { id: 'cast', label: '角色图' },
      { id: 'swap', label: '换人' },
      { id: 'qa', label: '质检' },
      { id: 'final', label: '成片' },
    ]
    const LABEL = '万风工作台'

    /* ------------------------------------------------------------------ */
    /* 小工具                                                              */
    /* ------------------------------------------------------------------ */

    async function api(path, options) {
      const res = await fetch(API + path, { credentials: 'same-origin', ...(options || {}) })
      const type = res.headers.get('content-type') || ''
      const data = type.includes('application/json') ? await res.json().catch(() => ({})) : {}
      if (!res.ok) throw new Error(data.error || `请求失败（${res.status}）`)
      return data
    }

    function fmtSize(n) {
      if (!n) return '0 B'
      if (n < 1024) return `${n} B`
      if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
      if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`
      return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`
    }

    function fmtClock(seconds) {
      const s = Math.max(0, Math.floor(seconds || 0))
      const mm = String(Math.floor(s / 60)).padStart(2, '0')
      const ss = String(s % 60).padStart(2, '0')
      const cs = String(Math.floor(((seconds || 0) - s) * 10)).padStart(1, '0')
      return `00:${mm}:${ss}.${cs}`
    }

    function fmtDate(ms) {
      if (!ms) return '—'
      const d = new Date(ms)
      const pad = (v) => String(v).padStart(2, '0')
      return `${d.getMonth() + 1}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
    }

    function mediaUrl(rel) {
      return `${API}/media?path=${encodeURIComponent(rel)}`
    }

    function clipColor(track) {
      if (track === 'video') return 'wf-clip-video'
      if (track === 'audio') return 'wf-clip-audio'
      return 'wf-clip-graphics'
    }

    function normalizeTimeline(input) {
      const base = input && typeof input === 'object' ? input : {}
      const tracks = base.tracks && typeof base.tracks === 'object' ? base.tracks : {}
      return {
        width: Number(base.width) || 1920,
        height: Number(base.height) || 1080,
        fps: Number(base.fps) || 30,
        duration: Number(base.duration) || 30,
        tracks: {
          video: Array.isArray(tracks.video) ? tracks.video : [],
          graphics: Array.isArray(tracks.graphics) ? tracks.graphics : [],
          audio: Array.isArray(tracks.audio) ? tracks.audio : [],
        },
      }
    }

    /* ------------------------------------------------------------------ */
    /* 样式                                                                */
    /* ------------------------------------------------------------------ */

    const CSS = `
.wf-root{display:flex;flex-direction:column;width:100%;height:100%;min-height:0;overflow:hidden;color-scheme:dark;
--dsw-alias-bg-layer-1:#14161a;--dsw-alias-bg-layer-2:#191c22;--dsw-alias-bg-layer-3:#20242b;--dsw-alias-bg-layer-4:#262b33;
--dsw-alias-label-primary:#e8eaf0;--dsw-alias-label-secondary:#8f97a5;--dsw-alias-label-dimmed:#4a515e;--dsw-alias-border-l2:#2b2f37;--dsw-alias-brand-primary:#6f8cff;
background:#14161a;color:#e8eaf0;font:13px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif}
.wf-root *{box-sizing:border-box}
.wf-top{display:flex;align-items:center;gap:12px;height:46px;padding:0 14px;border-bottom:1px solid var(--dsw-alias-border-l2,#2b2f37);background:var(--dsw-alias-bg-layer-2,#191c22);flex:none}
.wf-brand{display:flex;align-items:center;gap:8px;font-weight:600;font-size:14px;letter-spacing:.2px}
.wf-brand-dot{width:8px;height:8px;border-radius:50%;background:var(--dsw-alias-brand-primary,#7c9cff);box-shadow:0 0 10px rgba(124,156,255,.7)}
.wf-path{color:var(--dsw-alias-label-secondary,#8f97a5);font-size:12px;max-width:44vw;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:ui-monospace,Consolas,monospace}
.wf-spacer{flex:1}
.wf-btn{appearance:none;display:inline-flex;align-items:center;gap:6px;height:30px;padding:0 11px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2,#2b2f37);background:var(--dsw-alias-bg-layer-3,#20242b);color:var(--dsw-alias-label-primary,#e8eaf0);font:inherit;font-size:12px;cursor:pointer;transition:background .15s,border-color .15s,opacity .15s;white-space:nowrap}
.wf-btn:hover{background:var(--dsw-alias-bg-layer-4,#262b33);border-color:var(--dsw-alias-label-dimmed,#4a515e)}
.wf-btn:disabled{opacity:.45;cursor:default}
.wf-btn-primary{background:#6f8cff;background:var(--dsw-alias-brand-primary,#6f8cff);border-color:transparent;color:#fff;font-weight:600;text-shadow:0 1px 0 rgba(0,0,0,.25)}
.wf-btn-primary:hover{background:#8aa2ff}
.wf-btn-danger{color:#ff8a8a;border-color:rgba(255,110,110,.35)}
.wf-btn-sm{height:24px;padding:0 8px;font-size:11px;border-radius:6px}
.wf-chip{display:inline-flex;align-items:center;gap:4px;height:22px;padding:0 8px;border-radius:999px;border:1px solid var(--dsw-alias-border-l2,#2b2f37);background:var(--dsw-alias-bg-layer-3,#20242b);font-size:11px;color:var(--dsw-alias-label-secondary,#8f97a5);cursor:pointer;white-space:nowrap}
.wf-chip:hover{color:var(--dsw-alias-label-primary,#e8eaf0)}
.wf-chip.on{background:rgba(124,156,255,.16);border-color:rgba(124,156,255,.5);color:#b9c9ff}
.wf-main{display:grid;grid-template-columns:262px minmax(0,1fr) 296px;min-height:0;flex:1}
.wf-col{display:flex;flex-direction:column;min-height:0;min-width:0}
.wf-left{border-right:1px solid var(--dsw-alias-border-l2,#2b2f37);background:var(--dsw-alias-bg-layer-2,#191c22)}
.wf-right{border-left:1px solid var(--dsw-alias-border-l2,#2b2f37);background:var(--dsw-alias-bg-layer-2,#191c22);overflow-y:auto}
.wf-tabs{display:flex;gap:1px;padding:8px 6px 0;border-bottom:1px solid var(--dsw-alias-border-l2,#2b2f37);flex:none;overflow:hidden}
.wf-tab{appearance:none;flex:1 1 0;min-width:0;height:28px;border:0;border-radius:7px 7px 0 0;background:transparent;color:var(--dsw-alias-label-secondary,#8f97a5);font:inherit;font-size:11px;cursor:pointer;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;padding:0 2px}
.wf-tab:hover{color:var(--dsw-alias-label-primary,#e8eaf0)}
.wf-tab.on{background:var(--dsw-alias-bg-layer-3,#20242b);color:var(--dsw-alias-label-primary,#e8eaf0);font-weight:600}
.wf-left-body{display:flex;flex-direction:column;min-height:0;flex:1}
.wf-filters{display:flex;flex-direction:column;gap:7px;padding:9px 10px;border-bottom:1px solid var(--dsw-alias-border-l2,#2b2f37);flex:none}
.wf-input{width:100%;height:30px;padding:0 10px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2,#2b2f37);background:var(--dsw-alias-bg-layer-1,#14161a);color:var(--dsw-alias-label-primary,#e8eaf0);font:inherit;font-size:12px;outline:none}
.wf-input:focus{border-color:var(--dsw-alias-brand-primary,#7c9cff)}
.wf-select{width:100%;height:30px;padding:0 8px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2,#2b2f37);background:var(--dsw-alias-bg-layer-1,#14161a);color:var(--dsw-alias-label-primary,#e8eaf0);font:inherit;font-size:12px;outline:none}
.wf-row{display:flex;align-items:center;gap:6px}
.wf-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:7px;padding:9px 10px;overflow-y:auto;overflow-x:hidden;align-content:start;flex:1;min-height:0}
.wf-grid-more{grid-column:1/-1;padding:6px 2px 2px;text-align:center;font-size:10.5px;color:var(--dsw-alias-label-secondary,#8f97a5)}
.wf-card{position:relative;display:flex;flex-direction:column;height:136px;border-radius:8px;overflow:hidden;border:1px solid var(--dsw-alias-border-l2,#2b2f37);background:var(--dsw-alias-bg-layer-3,#20242b);cursor:pointer;transition:border-color .15s,transform .12s}
.wf-card:hover{border-color:#4d5666;transform:translateY(-1px)}
.wf-card.on{border-color:var(--dsw-alias-brand-primary,#7c9cff);box-shadow:0 0 0 1px rgba(124,156,255,.5) inset}
.wf-card-thumb{display:block;width:100%;height:88px;flex:none;object-fit:cover;background:#0e1014}
.wf-card-thumb-video{width:100%;height:88px;flex:none;object-fit:cover;background:#0e1014}
.wf-card-meta{padding:4px 7px 5px;font-size:10.5px;color:var(--dsw-alias-label-secondary,#8f97a5);line-height:1.3;flex:1;min-height:0;overflow:hidden}
.wf-card-name{color:var(--dsw-alias-label-primary,#e8eaf0);font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.wf-card-kind{position:absolute;top:5px;left:5px;padding:1px 6px;border-radius:999px;background:rgba(8,10,14,.72);border:1px solid rgba(255,255,255,.12);font-size:9.5px;color:#cfd6e4;letter-spacing:.3px}
.wf-empty{padding:26px 18px;text-align:center;color:var(--dsw-alias-label-secondary,#8f97a5);font-size:12px;line-height:1.7}
.wf-empty b{display:block;color:var(--dsw-alias-label-primary,#e8eaf0);font-size:13px;margin-bottom:4px;font-weight:600}
.wf-center{display:flex;flex-direction:column;min-height:0;background:radial-gradient(120% 90% at 50% 0%,rgba(124,156,255,.07),transparent 60%),var(--dsw-alias-bg-layer-1,#14161a)}
.wf-stage-tools{display:flex;align-items:center;gap:8px;padding:8px 12px;border-bottom:1px solid var(--dsw-alias-border-l2,#2b2f37);flex:none;color:var(--dsw-alias-label-secondary,#8f97a5);font-size:11.5px;white-space:nowrap;overflow:hidden}
.wf-stage-tools>span{white-space:nowrap;flex:none}
.wf-stage{flex:1;display:flex;align-items:center;justify-content:center;min-height:0;padding:18px 22px;position:relative}
.wf-stage-inner{display:flex;align-items:center;justify-content:center;width:100%;height:100%;border-radius:10px;overflow:hidden;background:#0b0d11;border:1px solid var(--dsw-alias-border-l2,#2b2f37);position:relative}
.wf-stage-inner img{max-width:100%;max-height:100%;object-fit:contain;display:block}
.wf-stage-inner video{max-width:100%;max-height:100%;object-fit:contain;display:block;background:#000}
.wf-stage-empty{display:flex;flex-direction:column;align-items:center;gap:10px;color:var(--dsw-alias-label-secondary,#8f97a5);text-align:center;font-size:12.5px;line-height:1.8}
.wf-stage-empty .wf-drop{border:1.5px dashed #3a414d;border-radius:12px;padding:18px 26px;color:#aab3c2;transition:border-color .15s,background .15s;background:rgba(255,255,255,.015)}
.wf-stage-empty .wf-drop.over{border-color:var(--dsw-alias-brand-primary,#7c9cff);background:rgba(124,156,255,.08)}
.wf-stage-tag{position:absolute;top:10px;right:12px;padding:2px 8px;border-radius:999px;background:rgba(10,12,16,.72);border:1px solid rgba(255,255,255,.14);font-size:10.5px;color:#c8d0de}
.wf-transport{display:flex;align-items:center;gap:10px;padding:8px 14px;border-top:1px solid var(--dsw-alias-border-l2,#2b2f37);flex:none;color:var(--dsw-alias-label-secondary,#8f97a5);font-size:12px}
.wf-transport b{color:var(--dsw-alias-label-primary,#e8eaf0);font-weight:600;font-family:ui-monospace,Consolas,monospace}
.wf-progress{flex:1;height:4px;border-radius:999px;background:#252a33;overflow:hidden;position:relative}
.wf-progress-fill{position:absolute;left:0;top:0;bottom:0;width:35%;border-radius:999px;background:linear-gradient(90deg,#5b7cff,#9db4ff);animation:wf-slide 1.1s ease-in-out infinite}
@keyframes wf-slide{0%{transform:translateX(-100%)}100%{transform:translateX(320%)}}
.wf-right-scroll{padding:12px 14px;display:flex;flex-direction:column;gap:14px}
.wf-sect{display:flex;flex-direction:column;gap:8px}
.wf-sect-title{display:flex;align-items:center;justify-content:space-between;font-size:11px;letter-spacing:.6px;text-transform:uppercase;color:var(--dsw-alias-label-secondary,#8f97a5);font-weight:600}
.wf-field{display:flex;flex-direction:column;gap:4px}
.wf-field > span{font-size:11px;color:var(--dsw-alias-label-secondary,#8f97a5)}
.wf-field input{height:30px;padding:0 9px;border-radius:7px;border:1px solid var(--dsw-alias-border-l2,#2b2f37);background:var(--dsw-alias-bg-layer-1,#14161a);color:var(--dsw-alias-label-primary,#e8eaf0);font:inherit;font-size:12px;outline:none;width:100%}
.wf-field input:focus{border-color:var(--dsw-alias-brand-primary,#7c9cff)}
.wf-two{display:grid;grid-template-columns:1fr 1fr;gap:8px}
.wf-kv{display:flex;justify-content:space-between;gap:10px;font-size:11.5px;padding:5px 0;border-bottom:1px dashed rgba(255,255,255,.06)}
.wf-kv span{color:var(--dsw-alias-label-secondary,#8f97a5);flex:none}
.wf-kv b{color:var(--dsw-alias-label-primary,#e8eaf0);font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;text-align:right}
.wf-bottom{display:flex;flex-direction:column;height:250px;flex:none;border-top:1px solid var(--dsw-alias-border-l2,#2b2f37);background:var(--dsw-alias-bg-layer-2,#191c22)}
.wf-tl-tools{display:flex;align-items:center;gap:8px;padding:6px 12px;border-bottom:1px solid var(--dsw-alias-border-l2,#2b2f37);flex:none}
.wf-tl-hint{color:var(--dsw-alias-label-secondary,#8f97a5);font-size:11px;margin-left:4px}
.wf-tl-body{display:flex;flex:1;min-height:0}
.wf-tl-heads{width:92px;flex:none;border-right:1px solid var(--dsw-alias-border-l2,#2b2f37);background:var(--dsw-alias-bg-layer-3,#20242b)}
.wf-tl-head-ruler{height:26px;border-bottom:1px solid var(--dsw-alias-border-l2,#2b2f37)}
.wf-tl-head{display:flex;align-items:center;gap:6px;height:54px;padding:0 10px;border-bottom:1px solid rgba(255,255,255,.05);font-size:11.5px;color:var(--dsw-alias-label-secondary,#8f97a5)}
.wf-tl-head i{width:7px;height:7px;border-radius:50%;flex:none}
.wf-tl-scroll{flex:1;overflow-x:auto;overflow-y:hidden;position:relative;min-width:0}
.wf-tl-canvas{position:relative;min-width:100%;height:100%}
.wf-ruler{position:sticky;top:0;height:26px;border-bottom:1px solid var(--dsw-alias-border-l2,#2b2f37);background:var(--dsw-alias-bg-layer-3,#20242b);z-index:3;overflow:hidden}
.wf-tick{position:absolute;top:0;bottom:0;border-left:1px solid rgba(255,255,255,.09)}
.wf-tick span{position:absolute;top:3px;left:4px;font-size:9.5px;color:#7f8797;font-family:ui-monospace,Consolas,monospace;white-space:nowrap}
.wf-track{position:relative;height:54px;border-bottom:1px solid rgba(255,255,255,.05);background:linear-gradient(180deg,rgba(255,255,255,.012),transparent)}
.wf-track.over{background:rgba(124,156,255,.07)}
.wf-clip{position:absolute;top:7px;height:40px;border-radius:6px;overflow:hidden;border:1px solid rgba(255,255,255,.16);cursor:grab;user-select:none;display:flex;align-items:center;gap:6px;padding:0 7px;min-width:18px}
.wf-clip:active{cursor:grabbing}
.wf-clip-video{background:linear-gradient(180deg,#2c3f79,#22325f);color:#dbe4ff}
.wf-clip-graphics{background:linear-gradient(180deg,#3a3350,#2c2740);color:#e6ddff}
.wf-clip-audio{background:linear-gradient(180deg,#2c5547,#22443a);color:#d5f3e6}
.wf-clip.on{outline:2px solid var(--dsw-alias-brand-primary,#7c9cff);outline-offset:-1px}
.wf-clip-thumb{width:34px;height:28px;border-radius:4px;object-fit:cover;flex:none;background:#0b0d11}
.wf-clip-name{font-size:10.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-weight:500}
.wf-clip-x{position:absolute;top:2px;right:3px;width:13px;height:13px;border-radius:50%;background:rgba(0,0,0,.4);color:#fff;font-size:10px;line-height:13px;text-align:center;opacity:0;cursor:pointer}
.wf-clip:hover .wf-clip-x{opacity:1}
.wf-playhead{position:absolute;top:0;bottom:0;width:1px;background:#ff6b6b;z-index:4;pointer-events:none}
.wf-playhead::before{content:'';position:absolute;top:0;left:-4px;width:9px;height:9px;background:#ff6b6b;clip-path:polygon(0 0,100% 0,50% 100%)}
.wf-work-list{display:flex;flex-direction:column;gap:6px;padding:9px 10px;overflow-y:auto;flex:1;min-height:0}
.wf-work{display:flex;gap:9px;align-items:center;padding:7px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2,#2b2f37);background:var(--dsw-alias-bg-layer-3,#20242b);cursor:pointer;transition:border-color .15s}
.wf-work:hover{border-color:#4d5666}
.wf-work.on{border-color:var(--dsw-alias-brand-primary,#7c9cff)}
.wf-work-cover{width:44px;height:44px;border-radius:6px;object-fit:cover;background:#0d0f13;flex:none;display:flex;align-items:center;justify-content:center;color:#4d5765;font-size:16px;border:1px solid rgba(255,255,255,.06)}
.wf-work-meta{flex:1;min-width:0}
.wf-work-name{font-size:12px;color:var(--dsw-alias-label-primary,#e8eaf0);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-weight:500}
.wf-work-sub{font-size:10.5px;color:var(--dsw-alias-label-secondary,#8f97a5);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-top:2px}
.wf-badge{display:inline-flex;align-items:center;height:17px;padding:0 6px;border-radius:999px;font-size:9.5px;border:1px solid rgba(255,255,255,.14);background:rgba(255,255,255,.05);color:#c2cad8;white-space:nowrap}
.wf-badge.done{background:rgba(88,196,140,.16);border-color:rgba(88,196,140,.4);color:#8fe0b5}
.wf-badge.warn{background:rgba(255,190,90,.14);border-color:rgba(255,190,90,.4);color:#ffd9a0}
.wf-jobs{display:flex;flex-direction:column;gap:8px;padding:9px 10px;overflow-y:auto;flex:1;min-height:0}
.wf-job{border:1px solid var(--dsw-alias-border-l2,#2b2f37);border-radius:8px;background:var(--dsw-alias-bg-layer-3,#20242b);overflow:hidden}
.wf-job-head{display:flex;align-items:center;gap:7px;padding:7px 9px;font-size:11.5px}
.wf-job-title{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-primary,#e8eaf0)}
.wf-job-log{max-height:180px;overflow:auto;margin:0;padding:8px 9px;border-top:1px solid rgba(255,255,255,.06);background:#0d1015;color:#b7c1cf;font:10.5px/1.5 ui-monospace,Consolas,monospace;white-space:pre-wrap;word-break:break-all}
.wf-dot{width:7px;height:7px;border-radius:50%;flex:none}
.wf-dot.running{background:#ffc857;box-shadow:0 0 8px rgba(255,200,87,.7)}
.wf-dot.done{background:#58c48c}
.wf-dot.failed{background:#ff6b6b}
.wf-dot.killed{background:#8a929f}
.wf-form{display:flex;flex-direction:column;gap:7px;padding:9px 10px;border-bottom:1px solid var(--dsw-alias-border-l2,#2b2f37);flex:none}
.wf-toast{position:absolute;left:50%;bottom:20px;transform:translateX(-50%);padding:8px 14px;border-radius:999px;background:rgba(20,24,31,.95);border:1px solid var(--dsw-alias-border-l2,#2b2f37);color:#dbe2ee;font-size:12px;z-index:20;box-shadow:0 8px 26px rgba(0,0,0,.4);max-width:80%}
.wf-toast.err{border-color:rgba(255,107,107,.5);color:#ffb3b3}
.wf-root input:not([type=range]):not([type=checkbox]):not([type=file]),.wf-root select{background:#14161a!important;background-color:#14161a!important;color:#e8eaf0!important;border:1px solid #2b2f37!important;box-shadow:none!important;color-scheme:dark!important}
.wf-root .wf-input::placeholder{color:#5c6472!important}
.wf-root .wf-btn{background:#20242b!important;color:#e8eaf0!important;border:1px solid #2b2f37!important}
.wf-root .wf-btn-primary{background:#6f8cff!important;color:#fff!important;border-color:transparent!important}
.wf-root .wf-btn-primary:hover{background:#8aa2ff!important}
.wf-root .wf-btn-danger{background:#20242b;color:#ff8a8a;border-color:rgba(255,110,110,.35)}
.wf-hidden{display:none!important}
@media(max-width:1180px){.wf-main{grid-template-columns:220px minmax(0,1fr) 250px}}
/* ---- 复刻流程 ---- */
.wf-flow-list{display:flex;flex-direction:column;gap:2px;overflow-y:auto;flex:1;min-height:0;padding:6px}
.wf-flow-item{display:flex;align-items:center;gap:8px;padding:7px 8px;border-radius:7px;cursor:pointer;border:1px solid transparent}
.wf-flow-item:hover{background:var(--dsw-alias-bg-layer-3,#20242b)}
.wf-flow-item.on{background:rgba(124,156,255,.12);border-color:rgba(124,156,255,.38)}
.wf-flow-item .wf-work-name{font-size:12px}
.wf-flow-new{display:flex;gap:6px;padding:8px 8px 6px;flex:none}
.wf-flow-new input{flex:1;min-width:0;height:26px;padding:0 8px;border-radius:6px;border:1px solid #2b2f37;background:#14161a;color:#e8eaf0;font:inherit;font-size:11.5px}
.wf-flow-center{overflow-y:auto;min-height:0;padding:12px 14px;display:flex;flex-direction:column;gap:10px}
.wf-stepper{display:flex;align-items:center;gap:4px;padding:8px 10px;border:1px solid var(--dsw-alias-border-l2,#2b2f37);border-radius:10px;background:var(--dsw-alias-bg-layer-2,#191c22);flex:none;overflow-x:auto}
.wf-step{display:flex;align-items:center;gap:6px;height:26px;padding:0 9px;border-radius:999px;font-size:11.5px;color:#8f97a5;white-space:nowrap;border:1px solid transparent}
.wf-step i{width:16px;height:16px;border-radius:50%;background:rgba(255,255,255,.08);display:inline-flex;align-items:center;justify-content:center;font-style:normal;font-size:9.5px;font-weight:700}
.wf-step.on{background:rgba(124,156,255,.16);border-color:rgba(124,156,255,.45);color:#c7d3ff}
.wf-step.on i{background:#6f8cff;color:#fff}
.wf-step.done{color:#8fe0b5}
.wf-step.done i{background:rgba(88,196,140,.28);color:#8fe0b5}
.wf-step-sep{flex:1;height:1px;background:rgba(255,255,255,.1);min-width:10px}
.wf-flow-card{border:1px solid var(--dsw-alias-border-l2,#2b2f37);border-radius:10px;background:var(--dsw-alias-bg-layer-2,#191c22);overflow:hidden;flex:none}
.wf-flow-head{display:flex;align-items:center;gap:8px;padding:8px 10px;border-bottom:1px solid rgba(255,255,255,.06);font-size:12px;font-weight:600}
.wf-flow-head .wf-badge{margin-left:auto}
.wf-flow-pad{padding:10px}
.wf-src{display:flex;gap:10px}
.wf-src-thumb{width:148px;aspect-ratio:16/9;border-radius:7px;background:#0b0d11;object-fit:cover;flex:none;border:1px solid rgba(255,255,255,.06)}
.wf-src-meta{flex:1;min-width:0;display:flex;flex-direction:column;gap:3px}
.wf-meta-line{font-size:11px;color:#9aa3b2;display:flex;gap:6px;justify-content:space-between;min-width:0}
.wf-meta-line b{color:#e8eaf0;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.wf-cast-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:8px;padding:10px}
.wf-cast{border:1px solid rgba(255,255,255,.08);border-radius:8px;overflow:hidden;background:#11141a;display:flex;flex-direction:column}
.wf-cast.on{border-color:rgba(88,196,140,.6);box-shadow:0 0 0 1px rgba(88,196,140,.25) inset}
.wf-cast img{width:100%;height:150px;object-fit:cover;background:#0b0d11;cursor:pointer;display:block}
.wf-cast-foot{padding:6px 7px;display:flex;flex-direction:column;gap:4px}
.wf-cast-note{font-size:10.5px;color:#8f97a5;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.wf-take{border:1px solid rgba(255,255,255,.07);border-radius:8px;padding:7px 9px;display:flex;align-items:center;gap:8px;font-size:11.5px;background:#171b21}
.wf-take + .wf-take{margin-top:6px}
.wf-take-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#dfe5ef}
.wf-qa-frames{display:grid;grid-template-columns:repeat(auto-fill,minmax(84px,1fr));gap:4px;padding:10px}
.wf-qa-frames img{width:100%;height:52px;object-fit:cover;border-radius:4px;background:#0b0d11;filter:grayscale(.35)}
.wf-flow-empty{padding:14px;color:#7d8697;font-size:12px;text-align:center}
.wf-flow-right{padding:10px;display:flex;flex-direction:column;gap:10px;overflow-y:auto;min-height:0}
.wf-subhead{font-size:10.5px;letter-spacing:.4px;text-transform:uppercase;color:#6d7686;margin-top:2px}
.wf-notice{padding:8px 9px;border-radius:8px;background:rgba(255,190,90,.1);border:1px solid rgba(255,190,90,.32);color:#ffd9a0;font-size:11px;line-height:1.5}
.wf-notice.ok{background:rgba(88,196,140,.1);border-color:rgba(88,196,140,.32);color:#9fe6c0}
.wf-notice.err{background:rgba(255,107,107,.1);border-color:rgba(255,107,107,.36);color:#ffb3b3}
.wf-flow-actions{display:flex;gap:6px;flex-wrap:wrap}
.wf-check{display:flex;align-items:center;gap:6px;font-size:11.5px;color:#9aa3b2;cursor:pointer}
.wf-check input{width:13px;height:13px;accent-color:#6f8cff}
.wf-lab-scroll{flex:1;min-height:0;overflow:auto;padding:12px}
.wf-lab-grid{display:grid;grid-template-columns:minmax(270px,1fr) minmax(240px,1fr);gap:14px;align-items:start}
.wf-lab-col{min-width:0}
.wf-lab-imgs{display:grid;grid-template-columns:repeat(auto-fill,minmax(72px,1fr));gap:6px;max-height:220px;overflow:auto;padding:2px}
.wf-lab-img{display:flex;flex-direction:column;gap:3px;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;overflow:hidden;cursor:pointer;background:#191c22}
.wf-lab-img.on{border-color:#6f8cff;box-shadow:0 0 0 1px #6f8cff inset}
.wf-lab-img input{display:none}
.wf-lab-img img{width:100%;height:54px;object-fit:cover;display:block}
.wf-lab-img span{font-size:9.5px;color:#8f97a5;padding:0 4px 4px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.wf-lab-node{display:flex;flex-direction:column;gap:2px;padding:7px 8px;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;background:#191c22;margin-bottom:6px}
.wf-lab-node b{font-size:11px;color:#c8cfdb}
.wf-lab-node span{font-size:10.5px;color:#8f97a5;word-break:break-all}
.wf-textarea{width:100%;background:#14161a;color:#e8eaf0;border:1px solid #2b2f37;border-radius:6px;padding:7px;font-size:11.5px;resize:vertical;font-family:inherit}
.wf-run{padding:7px 8px;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;background:#191c22;margin-bottom:6px}
.wf-run-head{display:flex;align-items:center;gap:6px;justify-content:space-between}
.wf-run-head b{font-size:11.5px;color:#e8eaf0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.wf-run-sub{font-size:10px;color:#7d8592;margin-top:3px;word-break:break-all}
.wf-subhead{font-size:11px;color:#8f97a5;text-transform:none;letter-spacing:0;margin-bottom:6px}
.wf-top-project{display:flex;flex-direction:column;gap:1px;min-width:0;max-width:280px}
.wf-top-project b{font-size:12.5px;color:#e8eaf0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-weight:600}
.wf-top-project span{font-size:10px;color:#7d8592;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.wf-top-seq{display:flex;align-items:center;gap:6px;padding:4px 8px;border:1px solid #2b2f37;border-radius:6px;background:#16191e;font-size:10.5px;color:#8f97a5}
.wf-top-seq b{color:#e8eaf0;font-size:11px}
.wf-top-seq i{font-style:normal;color:#6c7482;font-size:10px}
.wf-top-actions{display:flex;gap:4px;padding:2px;border:1px solid #242932;border-radius:7px;background:#16191e}
.wf-top-actions .wf-btn{background:transparent!important;border-color:transparent!important;padding:4px 8px;font-size:11px;color:#9aa3b2}
.wf-top-actions .wf-btn.on{background:#262c36!important;color:#e8eaf0}
.wf-btn-go{background:#a3e635!important;color:#0d1117!important;border-color:transparent!important;font-weight:700}
.wf-btn-go:hover{background:#b6f04a!important}
.wf-stage-live{color:#c8cfdb}
.wf-stage-tabs{display:flex;gap:2px;align-items:center;flex:none}
.wf-stage-tab{padding:3px 8px;border-radius:5px;font-size:10.5px;color:#7d8592;cursor:default;white-space:nowrap;flex:none}
.wf-stage-tab.on{background:#242932;color:#e8eaf0}
.wf-tool-sep{width:1px;height:12px;background:#2b2f37;margin:0 4px}
.wf-zoom-bar{display:flex;align-items:center;gap:6px;padding:5px 12px;border-bottom:1px solid #23272f;flex:none;color:#8f97a5;font-size:10.5px}
.wf-zoom-bar .wf-btn{padding:2px 7px;font-size:11px;line-height:1.3}
.wf-zoom-val{min-width:38px;text-align:center;color:#c8cfdb;font-size:10.5px}
.wf-select-sm{padding:3px 6px;font-size:10.5px;width:auto}
.wf-tp-time{display:flex;align-items:center;gap:6px;min-width:160px}
.wf-tp-mid{display:flex;align-items:center;justify-content:center;gap:8px;flex:1}
.wf-tp-right{display:flex;align-items:center;gap:8px;min-width:190px;justify-content:flex-end}
.wf-tp-right .wf-progress{max-width:130px}
.wf-tp-btn{width:26px;height:26px;border-radius:50%;border:1px solid #2b2f37;background:#20242b;color:#c8cfdb;cursor:pointer;font-size:11px;line-height:1;display:inline-flex;align-items:center;justify-content:center;padding:0}
.wf-tp-btn:hover{background:#2a303a}
.wf-tp-play{width:32px;height:32px;background:#e8eaf0;color:#0d1117;border-color:transparent;font-size:13px}
.wf-tool{display:inline-flex;align-items:center;gap:4px;padding:3px 7px;border:1px solid transparent;border-radius:5px;background:transparent;color:#9aa3b2;font-size:10.5px;cursor:pointer;white-space:nowrap}
.wf-tool:hover:not(:disabled){background:#242932;color:#e8eaf0}
.wf-tool:disabled{opacity:.4;cursor:default}
.wf-tool b{font-weight:600;color:#c8cfdb}
.wf-tl-info{display:flex;align-items:center;gap:8px;padding:4px 12px;border-bottom:1px solid var(--dsw-alias-border-l2,#2b2f37);flex:none;font-size:11px;color:#8f97a5}
.wf-tl-info b{color:#c8cfdb;font-size:11.5px}
.wf-tl-sep{width:1px;height:11px;background:#2b2f37}
`

    function ensureCss() {
      if (typeof document === 'undefined') return
      if (document.querySelector('style[data-wanfeng-studio]')) return
      const tag = document.createElement('style')
      tag.dataset.wanfengStudio = '1'
      tag.textContent = CSS
      document.head.appendChild(tag)
    }

    /* ------------------------------------------------------------------ */
    /* 侧栏图标                                                            */
    /* ------------------------------------------------------------------ */

    function StudioIcon(props) {
      const size = (props && props.size) || 18
      return h('svg', {
        'data-dsh-panel-entry': PANEL,
        viewBox: '0 0 24 24',
        width: size,
        height: size,
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.5,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': 'true',
        children: [
          h('rect', { key: 'frame', x: 2.5, y: 4.5, width: 19, height: 12, rx: 2 }),
          h('path', { key: 'line', d: 'M2.5 16.5h19' }),
          h('path', { key: 'sprocket', d: 'M7 7.5v6M12 7.5v6M17 7.5v6' }),
          h('path', { key: 'feet', d: 'M6 20.5h4M14 20.5h4' }),
        ],
      })
    }

    /* ------------------------------------------------------------------ */
    /* 页面                                                                */
    /* ------------------------------------------------------------------ */

    function StudioPanel() {
      const [tab, setTab] = useState('flow')
      const [config, setConfig] = useState(null)
      const [works, setWorks] = useState([])
      const [workFilter, setWorkFilter] = useState('')
      const [kind, setKind] = useState('all')
      const [query, setQuery] = useState('')
      const [assets, setAssets] = useState({ items: [], total: 0 })
      const [timeline, setTimeline] = useState(EMPTY_TIMELINE)
      const [selected, setSelected] = useState(null)
      const [selectedClip, setSelectedClip] = useState(null)
      const [jobs, setJobs] = useState([])
      const [busy, setBusy] = useState(false)
      const [status, setStatus] = useState('')
      const [toast, setToast] = useState('')
      const [scanAt, setScanAt] = useState(0)
      const [settingRoot, setSettingRoot] = useState('')
      const [settingPython, setSettingPython] = useState('python')
      const [settingUpload, setSettingUpload] = useState('上传素材')
      const [jobWork, setJobWork] = useState('')
      const [jobScript, setJobScript] = useState('')
      const [jobArgs, setJobArgs] = useState('')
      const [scripts, setScripts] = useState([])
      const [pendingAssets, setPendingAssets] = useState(0)
      const [reloadKey, setReloadKey] = useState(0)
      const [zoom, setZoom] = useState(64)
      const [stageScale, setStageScale] = useState(1)
      const [playhead, setPlayhead] = useState(0)
      const [dragOver, setDragOver] = useState(false)

      /* 复刻流程 */
      const [flowProjects, setFlowProjects] = useState([])
      const [flowName, setFlowName] = useState('')
      const [flowProject, setFlowProject] = useState(null)
      const [flowBusy, setFlowBusy] = useState(false)
      const [newFlowName, setNewFlowName] = useState('')
      const [castForm, setCastForm] = useState({ outfit: '', pose: '', shoes: '', scene: '', keepBg: false })
      const [castRefs, setCastRefs] = useState([])
      const [splitSeconds, setSplitSeconds] = useState(8)
      const [swapPrompt, setSwapPrompt] = useState('')
      const [swapSeconds, setSwapSeconds] = useState(8)
      const [apiForm, setApiForm] = useState(null)
      const [testRows, setTestRows] = useState([])

      /* 工作流实验室：把 RunningHub 上任意公开工作流接进来 */
      const [labs, setLabs] = useState({ builtin: [], custom: [] })
      const [labsSel, setLabsSel] = useState(null)
      const [labsProbe, setLabsProbe] = useState(null)
      const [labsPlan, setLabsPlan] = useState({ video: '', images: [], text: '', numbers: {} })
      const [labsText, setLabsText] = useState('')
      const [labsValues, setLabsValues] = useState({})
      const [labsVideo, setLabsVideo] = useState('')
      const [labsImages, setLabsImages] = useState([])
      const [labsRuns, setLabsRuns] = useState([])
      const [labsMedia, setLabsMedia] = useState({ video: [], image: [] })
      const [labsId, setLabsId] = useState('')
      const [labsName, setLabsName] = useState('')

      const fileInputRef = useRef(null)
      const stageRef = useRef(null)
      const rootRef = useRef(null)
      const toastTimer = useRef(null)
      const saveTimer = useRef(null)
      const queryTimer = useRef(null)

      const notify = useCallback((message, isError) => {
        setToast(message)
        if (toastTimer.current) clearTimeout(toastTimer.current)
        toastTimer.current = setTimeout(() => setToast(''), isError ? 5200 : 2600)
      }, [])

      /* ---------------- 初始加载 ---------------- */

      useEffect(() => {
        ensureCss()
      }, [])

      useEffect(() => {
        let alive = true
        setBusy(true)
        Promise.all([api('/config'), api('/works'), api('/timeline')])
          .then(([cfg, w, t]) => {
            if (!alive) return
            setConfig(cfg)
            setWorks(w.works || [])
            setScanAt(w.scannedAt || Date.now())
            setTimeline(normalizeTimeline(t.timeline))
            setSettingRoot(cfg.root || '')
            setSettingPython(cfg.python || 'python')
            setSettingUpload(cfg.uploadDir || '上传素材')
            setApiForm({
              runninghub: { ...(cfg.runninghub || {}) },
              apimart: { ...(cfg.apimart || {}) },
              tools: { ...(cfg.tools || {}) },
            })
            setJobWork(w.works && w.works.length ? w.works[0].name : '')
            if (w.works && w.works.length && w.works[0].cover) setSelected({ rel: w.works[0].cover.rel, kind: w.works[0].cover.kind, name: w.works[0].name, work: w.works[0].name })
            setStatus(`已索引 ${w.total || 0} 个媒体文件 · ${(w.works || []).length} 个作品`)
          })
          .catch((error) => { if (alive) notify(error.message, true) })
          .finally(() => { if (alive) setBusy(false) })
        return () => { alive = false }
      }, [notify])

      /* ---------------- 素材查询 ---------------- */

      useEffect(() => {
        if (!config) return undefined
        if (queryTimer.current) clearTimeout(queryTimer.current)
        queryTimer.current = setTimeout(() => {
          const params = new URLSearchParams()
          if (workFilter) params.set('work', workFilter)
          if (kind !== 'all') params.set('kind', kind)
          if (query.trim()) params.set('q', query.trim())
          params.set('limit', '80')
          api(`/assets?${params.toString()}`)
            .then((data) => { setAssets({ items: data.items || [], total: data.total || 0 }) })
            .catch((error) => notify(error.message, true))
        }, 220)
        return () => { if (queryTimer.current) clearTimeout(queryTimer.current) }
      }, [config, workFilter, kind, query, reloadKey, notify])

      /* ---------------- 任务轮询 ---------------- */

      useEffect(() => {
        let alive = true
        const tick = () => {
          api('/jobs')
            .then((data) => {
              if (!alive) return
              const items = data.items || []
              setJobs(items)
              if (items.some((job) => job.status === 'running')) setStatus('有任务在跑…')
            })
            .catch(() => {})
        }
        tick()
        const timer = setInterval(tick, 2500)
        return () => { alive = false; clearInterval(timer) }
      }, [])

      /* ---------------- 时间线保存（防抖） ---------------- */

      const persistTimeline = useCallback((next) => {
        setTimeline(next)
        if (saveTimer.current) clearTimeout(saveTimer.current)
        saveTimer.current = setTimeout(() => {
          api('/timeline', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(next),
          }).catch((error) => notify(`时间线保存失败：${error.message}`, true))
        }, 700)
      }, [notify])

      const patchTimeline = useCallback((patch) => {
        const next = { ...timeline, ...patch }
        persistTimeline(next)
      }, [persistTimeline, timeline])

      /* ---------------- 选中 / 预览 ---------------- */

      const mediaOf = useCallback((rel, kindHint) => {
        const found = assets.items.find((item) => item.rel === rel)
        if (found) return found
        if (!rel) return null
        return { rel, name: rel.split('/').pop(), kind: kindHint || 'image', url: mediaUrl(rel) }
      }, [assets.items])

      const selectedMedia = useMemo(() => {
        if (!selected) return null
        return mediaOf(selected.rel, selected.kind)
      }, [selected, mediaOf])

      function selectAsset(item) {
        setSelected({ rel: item.rel, kind: item.kind, name: item.name, work: item.work })
        setSelectedClip(null)
        setPlayhead(0)
      }

      /* ---------------- 上传 ---------------- */

      const uploadFiles = useCallback(async (fileList) => {
        const files = Array.from(fileList || [])
        if (!files.length) return
        setPendingAssets(files.length)
        setBusy(true)
        let ok = 0
        for (const file of files) {
          try {
            const work = workFilter || ''
            const res = await fetch(`${API}/upload?work=${encodeURIComponent(work)}&name=${encodeURIComponent(file.name)}`, {
              method: 'POST',
              credentials: 'same-origin',
              body: file,
            })
            const data = await res.json().catch(() => ({}))
            if (!res.ok) throw new Error(data.error || res.statusText)
            ok += 1
          } catch (error) {
            notify(`上传 ${file.name} 失败：${error.message}`, true)
          } finally {
            setPendingAssets((n) => Math.max(0, n - 1))
          }
        }
        setBusy(false)
        if (ok) {
          notify(`已上传 ${ok} 个文件到「${workFilter || '上传素材'}」`)
          const data = await api('/refresh').catch(() => null)
          if (data) setScanAt(data.scannedAt || Date.now())
          setReloadKey((value) => value + 1)
        }
      }, [notify, workFilter])

      /* ---------------- 加入时间线 ---------------- */

      const addToTimeline = useCallback((media, trackId) => {
        if (!media) return
        const track = timeline.tracks[trackId] || []
        const last = track.reduce((max, clip) => Math.max(max, clip.start + clip.length), 0)
        const clip = {
          id: `clip-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
          rel: media.rel,
          name: media.name || media.rel.split('/').pop(),
          kind: media.kind || 'image',
          start: Math.round(last * 10) / 10,
          length: media.kind === 'image' ? 3 : 4,
          volume: 1,
        }
        patchTimeline({ tracks: { ...timeline.tracks, [trackId]: [...track, clip] } })
        setSelectedClip({ track: trackId, id: clip.id })
        notify(`已加入 ${TRACKS.find((row) => row.id === trackId)?.label || trackId} 轨`)
      }, [notify, patchTimeline, timeline])

      const removeClip = useCallback((trackId, id) => {
        const track = (timeline.tracks[trackId] || []).filter((clip) => clip.id !== id)
        patchTimeline({ tracks: { ...timeline.tracks, [trackId]: track } })
        setSelectedClip(null)
      }, [patchTimeline, timeline])

      const addTextClip = useCallback(() => {
        const track = timeline.tracks.graphics || []
        const clip = {
          id: `clip-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
          rel: '',
          name: '字幕',
          kind: 'text',
          start: Math.round(playhead * 10) / 10,
          length: 3,
          volume: 1,
        }
        patchTimeline({ tracks: { ...timeline.tracks, graphics: [...track, clip] } })
        setSelectedClip({ track: 'graphics', id: clip.id })
        notify('已加一条字幕片段（文案编辑下一步接进来）')
      }, [notify, patchTimeline, playhead, timeline])

      const splitAtPlayhead = useCallback(() => {
        if (!selectedClip) { notify('先在时间线上选一个片段', true); return }
        const track = timeline.tracks[selectedClip.track] || []
        const index = track.findIndex((clip) => clip.id === selectedClip.id)
        const clip = track[index]
        if (!clip) return
        const cut = Math.round((playhead - clip.start) * 10) / 10
        if (cut < 0.3 || cut > clip.length - 0.3) {
          notify('播放头要落在片段内部才能切分', true)
          return
        }
        const left = { ...clip, length: cut }
        const right = {
          ...clip,
          id: `clip-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
          start: Math.round((clip.start + cut) * 10) / 10,
          length: Math.round((clip.length - cut) * 10) / 10,
        }
        patchTimeline({ tracks: { ...timeline.tracks, [selectedClip.track]: [...track.slice(0, index), left, right, ...track.slice(index + 1)] } })
        setSelectedClip({ track: selectedClip.track, id: right.id })
        notify('已在播放头切分')
      }, [notify, patchTimeline, playhead, selectedClip, timeline])

      const rippleDelete = useCallback(() => {
        if (!selectedClip) { notify('先在时间线上选一个片段', true); return }
        const track = timeline.tracks[selectedClip.track] || []
        const clip = track.find((row) => row.id === selectedClip.id)
        if (!clip) return
        const rest = track
          .filter((row) => row.id !== clip.id)
          .map((row) => (row.start > clip.start ? { ...row, start: Math.max(0, Math.round((row.start - clip.length) * 10) / 10) } : row))
        patchTimeline({ tracks: { ...timeline.tracks, [selectedClip.track]: rest } })
        setSelectedClip(null)
        notify('已删除并把后续片段前移')
      }, [notify, patchTimeline, selectedClip, timeline])

      const timelineRef = useRef(timeline)
      useEffect(() => { timelineRef.current = timeline }, [timeline])

      const handleClipDrag = useCallback((event, trackId, clip) => {
        event.stopPropagation()
        const startX = event.clientX
        const baseStart = clip.start
        let latest = timelineRef.current
        const move = (e) => {
          const delta = (e.clientX - startX) / zoom
          const start = Math.max(0, Math.round((baseStart + delta) * 10) / 10)
          const track = (latest.tracks[trackId] || []).map((row) => (
            row.id === clip.id ? { ...row, start } : row
          ))
          latest = { ...latest, tracks: { ...latest.tracks, [trackId]: track } }
          setTimeline(latest)
        }
        const up = () => {
          window.removeEventListener('mousemove', move)
          window.removeEventListener('mouseup', up)
          persistTimeline(latest)
        }
        window.addEventListener('mousemove', move)
        window.addEventListener('mouseup', up)
        setSelectedClip({ track: trackId, id: clip.id })
      }, [persistTimeline, zoom])

      const handleTrackDrop = useCallback((event, trackId) => {
        event.preventDefault()
        setDragOver(false)
        const rel = event.dataTransfer.getData('application/x-wanfeng-asset') || event.dataTransfer.getData('text/plain')
        if (!rel) return
        const media = mediaOf(rel)
        if (!media) return
        const rect = event.currentTarget.getBoundingClientRect()
        const start = Math.max(0, (event.clientX - rect.left) / zoom)
        const track = timeline.tracks[trackId] || []
        const clip = {
          id: `clip-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
          rel: media.rel,
          name: media.name || media.rel.split('/').pop(),
          kind: media.kind || 'image',
          start: Math.round(start * 10) / 10,
          length: media.kind === 'image' ? 3 : 4,
          volume: 1,
        }
        patchTimeline({ tracks: { ...timeline.tracks, [trackId]: [...track, clip] } })
        setSelectedClip({ track: trackId, id: clip.id })
      }, [mediaOf, patchTimeline, timeline, zoom])

      /* ---------------- 设置保存 ---------------- */

      const saveSettings = useCallback(async () => {
        try {
          setBusy(true)
          const res = await api('/config', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ root: settingRoot, python: settingPython, uploadDir: settingUpload }),
          })
          setConfig(res)
          const w = await api('/works')
          setWorks(w.works || [])
          setScanAt(w.scannedAt || Date.now())
          notify('设置已保存，索引已重建')
        } catch (error) {
          notify(error.message, true)
        } finally {
          setBusy(false)
        }
      }, [notify, settingPython, settingRoot, settingUpload])

      const refreshIndex = useCallback(async () => {
        try {
          setBusy(true)
          const data = await api('/refresh')
          setScanAt(data.scannedAt || Date.now())
          const w = await api('/works')
          setWorks(w.works || [])
          notify(`已刷新：${data.items} 个媒体文件`)
        } catch (error) {
          notify(error.message, true)
        } finally {
          setBusy(false)
        }
      }, [notify])

      /* ---------------- 脚本任务 ---------------- */

      useEffect(() => {
        if (tab !== 'jobs') return undefined
        let alive = true
        api(`/scripts${jobWork ? `?work=${encodeURIComponent(jobWork)}` : ''}`)
          .then((data) => {
            if (!alive) return
            const items = data.items || []
            setScripts(items)
            if (items.length && !items.some((row) => row.rel === jobScript)) setJobScript(items[0].rel)
          })
          .catch(() => {})
        return () => { alive = false }
      }, [tab, jobWork, jobScript])

      const runJob = useCallback(async () => {
        if (!jobScript) { notify('先选一个脚本', true); return }
        try {
          setBusy(true)
          const args = jobArgs.trim() ? jobArgs.trim().split(/\s+/) : []
          const job = await api('/jobs', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ work: jobWork, script: jobScript, args }),
          })
          notify(`已启动：${job.script.split('/').pop()}`)
          const list = await api('/jobs')
          setJobs(list.items || [])
        } catch (error) {
          notify(error.message, true)
        } finally {
          setBusy(false)
        }
      }, [jobArgs, jobScript, jobWork, notify])

      const killJob = useCallback(async (id) => {
        try {
          await api(`/jobs/${id}/kill`, { method: 'POST' })
          notify('已停止任务')
        } catch (error) {
          notify(error.message, true)
        }
      }, [notify])

      /* ---------------- 复刻流程 ---------------- */

      const post = useCallback((path, body) => api(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body || {}),
      }), [])

      const reflect = useCallback(async (name) => {
        const row = await api(`/flow/project?name=${encodeURIComponent(name)}`)
        setFlowProject(row.project)
        return row.project
      }, [])

      const loadFlowProjects = useCallback(async (prefer) => {
        try {
          const data = await api('/flow/projects')
          const rows = data.projects || []
          setFlowProjects(rows)
          const target = prefer || (rows[0] && rows[0].name) || ''
          if (!target) { setFlowName(''); setFlowProject(null); return }
          setFlowName(target)
          await reflect(target)
        } catch (error) {
          notify(error.message, true)
        }
      }, [notify, reflect])

      useEffect(() => {
        let alive = true
        api('/flow/projects')
          .then((data) => {
            if (!alive) return
            const rows = data.projects || []
            setFlowProjects(rows)
            if (rows.length) {
              setFlowName(rows[0].name)
              return api(`/flow/project?name=${encodeURIComponent(rows[0].name)}`)
                .then((row) => { if (alive) setFlowProject(row.project) })
            }
            return null
          })
          .catch(() => {})
        return () => { alive = false }
      }, [])

      const loadFlowRefs = useCallback(async (name) => {
        try {
          const data = await api(`/assets?work=${encodeURIComponent(name)}&limit=400`)
          setCastRefs((data.items || []).filter((row) => row.rel.includes('/refs/')).map((row) => ({ ...row, picked: false })))
        } catch {
          setCastRefs([])
        }
      }, [])

      const openFlow = useCallback(async (name) => {
        setFlowName(name)
        try {
          await reflect(name)
          loadFlowRefs(name)
        } catch (error) {
          notify(error.message, true)
        }
      }, [loadFlowRefs, notify, reflect])

      /* ---------------- 工作流实验室 ---------------- */

      const postJson = useCallback((path, body) => api(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }), [])

      const loadLabs = useCallback(async () => {
        try {
          const data = await api('/flow/workflows')
          setLabs({ builtin: data.builtin || [], custom: data.custom || [] })
          const runs = await api('/flow/runs')
          setLabsRuns(runs.items || [])
          const [videos, images] = await Promise.all([
            api('/assets?kind=video&limit=200').catch(() => ({ items: [] })),
            api('/assets?kind=image&limit=120').catch(() => ({ items: [] })),
          ])
          setLabsMedia({ video: videos.items || [], image: images.items || [] })
        } catch (error) {
          notify(error.message, true)
        }
      }, [notify])

      useEffect(() => {
        if (tab !== 'labs') return undefined
        loadLabs()
        const timer = setInterval(() => {
          api('/flow/runs').then((data) => setLabsRuns(data.items || [])).catch(() => {})
        }, 4000)
        return () => clearInterval(timer)
      }, [tab, loadLabs])

      const pickLabs = useCallback(async (row) => {
        setLabsSel(row)
        setLabsProbe(null)
        setLabsText('')
        setLabsValues({})
        setLabsVideo('')
        setLabsImages([])
        const plan = row.plan || { video: '', images: [], text: '', numbers: {} }
        setLabsPlan(plan)
        setLabsValues(Object.fromEntries(Object.entries(plan.numbers || {}).map(([key]) => [key, ''])))
        if (!row.workflowId) return
        try {
          const data = await postJson('/flow/probe', { workflowId: row.workflowId })
          setLabsProbe(data.probe)
          if (!plan.video && data.plan) {
            setLabsPlan(data.plan)
            setLabsValues(Object.fromEntries(Object.entries(data.plan.numbers || {}).map(([key]) => [key, ''])))
          }
        } catch (error) {
          notify(`探测失败：${error.message}（工作流要公开、Key 要可用）`, true)
        }
      }, [notify, postJson])

      const probeLabs = useCallback(async () => {
        const workflowId = labsId.trim()
        if (!workflowId) { notify('先填 RunningHub 工作流 ID', true); return }
        try {
          setFlowBusy(true)
          const data = await postJson('/flow/probe', { workflowId })
          setLabsProbe(data.probe)
          setLabsPlan(data.plan)
          setLabsValues(Object.fromEntries(Object.entries(data.plan.numbers || {}).map(([key]) => [key, ''])))
          notify(`探测到 ${data.probe.total} 个节点：视频 ${data.probe.video.length} / 图 ${data.probe.image.length} / 文本 ${data.probe.text.length}`)
        } catch (error) {
          notify(error.message, true)
        } finally {
          setFlowBusy(false)
        }
      }, [labsId, notify, postJson])

      const saveLabs = useCallback(async () => {
        const workflowId = labsId.trim()
        if (!workflowId) { notify('先填工作流 ID', true); return }
        try {
          setFlowBusy(true)
          await postJson('/flow/workflows', {
            name: labsName.trim() || `工作流 ${workflowId.slice(-4)}`,
            workflowId,
            plan: labsPlan,
          })
          await loadLabs()
          notify('已保存到工作流列表')
        } catch (error) {
          notify(error.message, true)
        } finally {
          setFlowBusy(false)
        }
      }, [labsId, labsName, labsPlan, loadLabs, notify, postJson])

      const runLabs = useCallback(async () => {
        if (!labsSel || !labsSel.workflowId) { notify('先选一个有 ID 的工作流', true); return }
        try {
          setFlowBusy(true)
          await postJson('/flow/run', {
            workflowId: labsSel.workflowId,
            name: labsSel.name,
            plan: labsPlan,
            video: labsVideo,
            images: labsImages,
            text: labsText,
            values: labsValues,
          })
          const runs = await api('/flow/runs')
          setLabsRuns(runs.items || [])
          notify('已提交')
        } catch (error) {
          notify(error.message, true)
        } finally {
          setFlowBusy(false)
        }
      }, [labsImages, labsPlan, labsSel, labsText, labsValues, labsVideo, notify, postJson])

      /* 有生成 / 换人 / 质检在跑时，每 3 秒拉一次项目状态 */
      useEffect(() => {
        if (!flowProject || tab !== 'flow') return undefined
        const live = (flowProject.cast.versions || []).some((row) => row.status === 'generating')
          || (flowProject.swap.takes || []).some((row) => row.status === 'queued' || row.status === 'running')
          || (flowProject.qa.runs || []).some((row) => row.status === 'running')
        if (!live) return undefined
        const timer = setInterval(() => {
          api(`/flow/project?name=${encodeURIComponent(flowProject.name)}`)
            .then((row) => setFlowProject(row.project))
            .catch(() => {})
        }, 3000)
        return () => clearInterval(timer)
      }, [flowProject, tab])

      const createFlow = useCallback(async () => {
        const name = newFlowName.trim()
        if (!name) { notify('先写项目名', true); return }
        try {
          setFlowBusy(true)
          const sourceRel = selectedMedia && selectedMedia.kind === 'video' ? selectedMedia.rel : ''
          await post('/flow/create', { name, sourceRel })
          setNewFlowName('')
          await loadFlowProjects(name)
          notify(`已建项目「${name}」`)
        } catch (error) {
          notify(error.message, true)
        } finally {
          setFlowBusy(false)
        }
      }, [loadFlowProjects, newFlowName, notify, post, selectedMedia])

      const importFlow = useCallback(async (explicit) => {
        const name = String(explicit || newFlowName || '').trim()
        if (!name) { notify('先写要导入的目录名', true); return }
        try {
          setFlowBusy(true)
          await post('/flow/import', { name })
          setNewFlowName('')
          await loadFlowProjects(name)
          notify(`已导入「${name}」`)
        } catch (error) {
          notify(error.message, true)
        } finally {
          setFlowBusy(false)
        }
      }, [loadFlowProjects, newFlowName, notify, post])

      const useAsSource = useCallback(async () => {
        if (!flowProject || !selectedMedia || selectedMedia.kind !== 'video') { notify('先在素材里选一个视频', true); return }
        try {
          await post('/flow/source', { name: flowProject.name, rel: selectedMedia.rel })
          await reflect(flowProject.name)
          notify('原片已设置')
        } catch (error) { notify(error.message, true) }
      }, [flowProject, notify, post, reflect, selectedMedia])

      const savePerson = useCallback(async (person) => {
        if (!flowProject) return
        try {
          await post('/flow/person', { name: flowProject.name, person })
          await reflect(flowProject.name)
        } catch (error) { notify(error.message, true) }
      }, [flowProject, notify, post, reflect])

      const makeSplit = useCallback(async () => {
        if (!flowProject) return
        try {
          setFlowBusy(true)
          const res = await post('/flow/split', { name: flowProject.name, seconds: splitSeconds })
          await reflect(flowProject.name)
          notify(`已切成 ${res.shots.length} 个镜头（每段约 ${res.seconds} 秒）`)
        } catch (error) {
          notify(error.message, true)
        } finally {
          setFlowBusy(false)
        }
      }, [flowProject, notify, post, reflect, splitSeconds])

      const generateCast = useCallback(async () => {
        if (!flowProject) { notify('先选一个项目', true); return }
        if (!castForm.outfit.trim()) { notify('先写当次服装', true); return }
        try {
          setFlowBusy(true)
          await post('/flow/cast/generate', { name: flowProject.name, ...castForm, refs: castRefs.filter((row) => row.picked).map((row) => row.rel) })
          await reflect(flowProject.name)
          notify('已提交角色图任务，出图后自动刷新')
        } catch (error) {
          notify(error.message, true)
        } finally {
          setFlowBusy(false)
        }
      }, [castForm, castRefs, flowProject, notify, post, reflect])

      const approveCast = useCallback(async (id, approved) => {
        if (!flowProject) return
        try {
          await post('/flow/cast/approve', { name: flowProject.name, id, approved })
          await reflect(flowProject.name)
          notify(approved ? '已通过审核：现在可以提交换人了' : '已取消通过')
        } catch (error) {
          notify(error.message, true)
        }
      }, [flowProject, notify, post, reflect])

      const startSwap = useCallback(async () => {
        if (!flowProject) return
        try {
          setFlowBusy(true)
          const res = await post('/flow/swap/start', { name: flowProject.name, prompt: swapPrompt, seconds: swapSeconds })
          await reflect(flowProject.name)
          notify(`已提交 ${res.takes.length} 个换人任务（会用「已通过」的角色图）`)
        } catch (error) {
          notify(error.message, true)
        } finally {
          setFlowBusy(false)
        }
      }, [flowProject, notify, post, reflect, swapPrompt, swapSeconds])

      const startQa = useCallback(async (rel) => {
        if (!flowProject) return
        try {
          setFlowBusy(true)
          await post('/flow/qa', { name: flowProject.name, rel: rel || '' })
          await reflect(flowProject.name)
          notify('已开始质检（会抽帧 + 调视觉模型）')
        } catch (error) {
          notify(error.message, true)
        } finally {
          setFlowBusy(false)
        }
      }, [flowProject, notify, post, reflect])

      const renderFinal = useCallback(async () => {
        if (!flowProject) return
        try {
          setFlowBusy(true)
          const res = await post('/flow/render', { name: flowProject.name })
          await reflect(flowProject.name)
          notify(`成片已合成：${res.rel}`)
        } catch (error) {
          notify(error.message, true)
        } finally {
          setFlowBusy(false)
        }
      }, [flowProject, notify, post, reflect])

      const saveApiSettings = useCallback(async () => {
        try {
          setFlowBusy(true)
          const res = await api('/flow/settings', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(apiForm || {}),
          })
          setApiForm({
            runninghub: { ...(res.config.runninghub || {}) },
            apimart: { ...(res.config.apimart || {}) },
            tools: { ...(res.config.tools || {}) },
          })
          notify('API 设置已保存')
        } catch (error) {
          notify(error.message, true)
        } finally {
          setFlowBusy(false)
        }
      }, [apiForm, notify])

      const testApis = useCallback(async () => {
        try {
          setFlowBusy(true)
          const res = await post('/flow/test')
          setTestRows(res.rows || [])
          notify(res.ff && res.ff.ffmpeg ? '连通测试完成' : '连通测试完成，但 ffmpeg 不可用', !(res.ff && res.ff.ffmpeg))
        } catch (error) {
          notify(error.message, true)
        } finally {
          setFlowBusy(false)
        }
      }, [notify, post])

      /* ---------------- 复刻流程视图 ---------------- */

      const stageIndex = (project) => {
        if (!project || !project.source || !project.source.rel) return 0
        if (project.final && project.final.rel) return 4
        if ((project.swap.takes || []).some((take) => take.status === 'done')) return 3
        if (project.cast && project.cast.approvedId) return 2
        return 1
      }

      const flowSteps = () => {
        const idx = stageIndex(flowProject)
        const nodes = []
        FLOW_STEPS.forEach((row, i) => {
          nodes.push(h('div', {
            key: row.id,
            className: `wf-step${i === idx ? ' on' : i < idx ? ' done' : ''}`,
          }, [h('i', { key: 'i' }, i < idx ? '✓' : String(i + 1)), row.label]))
          if (i < FLOW_STEPS.length - 1) nodes.push(h('div', { key: `sep${i}`, className: 'wf-step-sep' }))
        })
        return h('div', { className: 'wf-stepper' }, nodes)
      }

      const metaLine = (label, value, title) => h('div', { className: 'wf-meta-line', key: `m-${label}` }, [
        h('span', { key: 'l' }, label),
        h('b', { key: 'v', title: title || String(value) }, String(value)),
      ])

      const flowCenter = () => {
        const project = flowProject
        if (!project) {
          return h('section', { className: 'wf-col wf-center', key: 'center', ref: stageRef }, [
            h('div', { className: 'wf-stage-tools' }, [
              h('span', { className: 'wf-stage-live' }, '交互预览'),
              h('span', { className: 'wf-spacer', style: { flex: 1 } }),
              h('span', {}, `${timeline.width}×${timeline.height} · ${timeline.fps} fps`),
            ]),
            h('div', { className: 'wf-stage' }, h('div', { className: 'wf-stage-empty' }, [
              h('div', { key: 'icon', style: { fontSize: '34px', opacity: .5 } }, '▣'),
              h('b', { key: 't', style: { fontSize: '14px' } }, '从左侧新建 / 导入一个复刻项目'),
              h('div', { key: 'd', className: 'wf-drop' }, '原片 → 角色图（审核门）→ 换人 → 质检 → 成片'),
            ])),
            h('div', { className: 'wf-transport' }, [
              h('div', { className: 'wf-tp-time' }, [
                h('b', {}, '00:00:00.0'),
                h('span', {}, '/'),
                h('b', {}, '00:30:00.0'),
              ]),
              h('div', { className: 'wf-tp-mid' }, [
                h('button', { className: 'wf-tp-btn', disabled: true }, '⏮'),
                h('button', { className: 'wf-tp-btn wf-tp-play', disabled: true }, '▶'),
                h('button', { className: 'wf-tp-btn', disabled: true }, '⏭'),
              ]),
              h('div', { className: 'wf-tp-right' }, [
                h('span', { className: 'wf-tl-hint' }, '本地预览'),
              ]),
            ]),
          ])
        }
        const versions = project.cast.versions || []
        const takes = project.swap.takes || []
        const runs = project.qa.runs || []
        const shotCount = new Set(takes.map((row) => row.shot)).size
        const doneTakes = takes.filter((row) => row.status === 'done')
        const latestQa = runs[0]

        const sourceCard = h('div', { className: 'wf-flow-card', key: 'src' }, [
          h('div', { className: 'wf-flow-head' }, [
            h('span', { key: 't' }, '① 原片'),
            h('span', { key: 'b', className: 'wf-badge' }, project.source.rel
              ? `${Number(project.source.duration || 0).toFixed(1)}s · ${project.source.width || '?'}×${project.source.height || '?'}`
              : '未设置'),
          ]),
          project.source.rel
            ? h('div', { className: 'wf-flow-pad' }, [
              h('div', { className: 'wf-src' }, [
                h('video', { key: 'v', className: 'wf-src-thumb', src: mediaUrl(project.source.rel), muted: true, preload: 'metadata' }),
                h('div', { className: 'wf-src-meta' }, [
                  metaLine('文件', project.source.rel.split('/').pop(), project.source.rel),
                  metaLine('时长', `${Number(project.source.duration || 0).toFixed(2)} 秒`),
                  metaLine('分镜', shotCount ? `${shotCount} 个镜头` : '还没切分镜'),
                  h('div', { className: 'wf-flow-actions', style: { marginTop: '6px' } }, [
                    h('button', { className: 'wf-btn wf-btn-sm', onClick: () => makeSplit(), disabled: flowBusy }, '按秒切分镜'),
                    h('input', {
                      type: 'number',
                      min: '2',
                      max: '15',
                      value: splitSeconds,
                      style: { width: '54px' },
                      onChange: (event) => setSplitSeconds(Math.max(2, Math.min(15, Number(event.target.value) || 8))),
                    }),
                    h('button', { className: 'wf-btn wf-btn-sm', onClick: () => useAsSource(), disabled: !selectedMedia || selectedMedia.kind !== 'video' }, '用选中的视频替换'),
                  ]),
                ]),
              ]),
            ])
            : h('div', { className: 'wf-flow-pad' }, h('div', { className: 'wf-flow-empty' }, [
              '还没有原片。',
              h('br', { key: 'b' }),
              '去「素材」选一个视频，再回来点「用选中的视频替换」；也可以直接把视频拖进项目目录。',
            ])),
        ])

        const castCard = h('div', { className: 'wf-flow-card', key: 'cast' }, [
          h('div', { className: 'wf-flow-head' }, [
            h('span', { key: 't' }, '② 角色图（审核门）'),
            project.cast.approvedId
              ? h('span', { key: 'b', className: 'wf-badge done' }, '已通过 · 可提交视频')
              : h('span', { key: 'b', className: 'wf-badge warn' }, versions.length ? '待审核' : '未生成'),
          ]),
          versions.length
            ? h('div', { className: 'wf-cast-grid' }, versions.map((version) => h('div', {
              key: version.id,
              className: `wf-cast${project.cast.approvedId === version.id ? ' on' : ''}`,
            }, [
              version.status === 'ready'
                ? h('img', {
                  key: 'img',
                  src: mediaUrl(version.rel),
                  alt: '',
                  onClick: () => setSelected({ rel: version.rel, kind: 'image', name: version.rel.split('/').pop(), work: project.name }),
                })
                : h('div', {
                  key: 'ph',
                  style: { height: '150px', display: 'flex', alignItems: 'center', justifyContent: 'center', color: version.status === 'failed' ? '#ff9d9d' : '#6d7686', fontSize: '11px', padding: '8px', textAlign: 'center' },
                }, version.status === 'generating' ? '生成中…' : (version.error || '失败')),
              h('div', { className: 'wf-cast-foot' }, [
                h('div', { className: 'wf-cast-note', title: version.outfit }, version.outfit || '（没写服装）'),
                h('div', { style: { display: 'flex', gap: '4px', alignItems: 'center' } }, [
                  version.status === 'ready'
                    ? h('button', {
                      className: `wf-btn wf-btn-sm${project.cast.approvedId === version.id ? '' : ' wf-btn-primary'}`,
                      onClick: () => approveCast(version.id, project.cast.approvedId !== version.id),
                    }, project.cast.approvedId === version.id ? '撤销通过' : '通过审核')
                    : null,
                  version.cost ? h('span', { style: { fontSize: '10px', color: '#6d7686' } }, `¥${version.cost}`) : null,
                ]),
              ]),
            ])))
            : h('div', { className: 'wf-flow-pad' }, h('div', { className: 'wf-flow-empty' }, '还没有角色图。在右栏填「当次服装」，点「生成角色图」。')),
        ])

        const swapCard = h('div', { className: 'wf-flow-card', key: 'swap' }, [
          h('div', { className: 'wf-flow-head' }, [
            h('span', { key: 't' }, '③ 换人'),
            h('span', { key: 'b', className: 'wf-badge' }, takes.length ? `${doneTakes.length} / ${takes.length} 段完成` : '未提交'),
          ]),
          takes.length
            ? h('div', { className: 'wf-flow-pad' }, takes.map((take) => h('div', { key: take.id, className: 'wf-take' }, [
              h('span', { className: `wf-dot ${take.status === 'done' ? 'done' : take.status === 'failed' ? 'failed' : take.status === 'running' ? 'running' : 'killed'}` }),
              h('span', { className: 'wf-take-name', title: take.rel }, `${take.shot} · ${take.rel.split('/').pop()}`),
              take.error ? h('span', { className: 'wf-cast-note', title: take.error, style: { maxWidth: '180px' } }, take.error) : null,
              h('span', { className: 'wf-badge' }, take.status),
              take.cost ? h('span', { className: 'wf-badge' }, `¥${Number(take.cost).toFixed(2)}`) : null,
              take.status === 'done'
                ? h('button', {
                  className: 'wf-btn wf-btn-sm',
                  onClick: () => setSelected({ rel: take.rel, kind: 'video', name: take.rel.split('/').pop(), work: project.name }),
                }, '看片')
                : null,
            ]))) 
            : h('div', { className: 'wf-flow-pad' }, h('div', { className: 'wf-flow-empty' }, '还没有换人片段。角色图通过审核后，在右栏点「提交换人」。')),
        ])

        const qaCard = h('div', { className: 'wf-flow-card', key: 'qa' }, [
          h('div', { className: 'wf-flow-head' }, [
            h('span', { key: 't' }, '④ 质检'),
            latestQa
              ? h('span', { key: 'b', className: `wf-badge${latestQa.verdict === 'PASS' ? ' done' : latestQa.status === 'running' ? ' warn' : ''}` }, latestQa.status === 'running' ? '检测中…' : (latestQa.verdict || latestQa.status))
              : h('span', { key: 'b', className: 'wf-badge' }, '未跑'),
          ]),
          latestQa
            ? h('div', { key: 'body' }, [
              h('div', { className: 'wf-flow-pad' }, [
                latestQa.error
                  ? h('div', { className: 'wf-notice err' }, latestQa.error)
                  : latestQa.check
                    ? h('div', { className: `wf-notice ${latestQa.verdict === 'PASS' ? 'ok' : 'err'}` }, [
                      latestQa.verdict === 'PASS' ? '通过：没有发现不同人 / 第二张脸 / 变形 / 烧录文字 / 内部跳变。' : '未通过：见下方 JSON 里被标红的项。',
                    ])
                    : null,
                latestQa.check ? h('pre', {
                  style: { margin: '8px 0 0', padding: '8px', borderRadius: '6px', background: '#0d1015', color: '#a9b4c4', font: '10.5px/1.5 ui-monospace,Consolas,monospace', maxHeight: '160px', overflow: 'auto', whiteSpace: 'pre-wrap' },
                }, JSON.stringify(latestQa.check, null, 2)) : null,
              ]),
              (latestQa.frames || []).length
                ? h('div', { className: 'wf-qa-frames', key: 'frames' }, latestQa.frames.map((rel, i) => h('img', {
                  key: rel,
                  src: mediaUrl(rel),
                  alt: `帧 ${i + 1}`,
                  title: `${Number((latestQa.timestamps || [])[i] || 0).toFixed(1)}s`,
                })))
                : null,
            ])
            : h('div', { className: 'wf-flow-pad' }, h('div', { className: 'wf-flow-empty' }, '跑完换人后点「开始质检」：会抽 12 帧 + 前 8 帧，对照角色参考与原片锚帧。')),
        ])

        const finalCard = h('div', { className: 'wf-flow-card', key: 'final' }, [
          h('div', { className: 'wf-flow-head' }, [
            h('span', { key: 't' }, '⑤ 成片'),
            project.final.rel
              ? h('span', { key: 'b', className: 'wf-badge done' }, '已合成')
              : h('span', { key: 'b', className: 'wf-badge' }, '未合成'),
          ]),
          project.final.rel
            ? h('div', { className: 'wf-flow-pad' }, [
              h('video', {
                key: 'v',
                src: mediaUrl(project.final.rel),
                controls: true,
                style: { width: '100%', maxHeight: '46vh', borderRadius: '8px', background: '#0b0d11' },
              }),
              h('div', { className: 'wf-flow-actions', style: { marginTop: '8px' } }, [
                h('button', { className: 'wf-btn wf-btn-sm', onClick: () => startQa(project.final.rel) }, '质检这条成片'),
                h('button', {
                  className: 'wf-btn wf-btn-sm',
                  onClick: () => api('/reveal', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ rel: project.final.rel }) }).catch((error) => notify(error.message, true)),
                }, '在资源管理器中显示'),
              ]),
            ])
            : h('div', { className: 'wf-flow-pad' }, h('div', { className: 'wf-flow-empty' }, '至少有一段完成的换人片段后，在右栏点「合成成片」。')),
        ])

        const missing = []
        if (!config || !config.runninghub || !config.runninghub.hasKey) missing.push('RunningHub Key')
        if (!config || !config.apimart || !config.apimart.hasKey) missing.push('APIMart Key（画角色图）')
        if (!config || !config.apimart || !config.apimart.hasVisionKey) missing.push('视觉模型 Key（质检）')

        return h('section', { className: 'wf-col wf-center', key: 'center' }, h('div', { className: 'wf-flow-center' }, [
          missing.length
            ? h('div', { className: 'wf-notice', key: 'setup' }, [
              `还没配置：${missing.join(' / ')}。`,
              h('br', { key: 'b' }),
              '去左侧「设置」填自己的 Key，就能跑完整流程；不配也能先浏览素材做草稿。',
            ])
            : null,
          flowSteps(),
          sourceCard,
          castCard,
          swapCard,
          qaCard,
          finalCard,
        ]))
      }

      const flowRight = () => {
        const project = flowProject
        const approved = project && project.cast.versions.find((row) => row.id === project.cast.approvedId)
        const takes = project ? project.swap.takes || [] : []
        const doneTakes = takes.filter((row) => row.status === 'done')
        return h('aside', { className: 'wf-col wf-right', key: 'right' }, h('div', { className: 'wf-flow-right' }, [
          h('div', { className: 'wf-sect', key: 'head' }, [
            h('div', { className: 'wf-sect-title' }, [h('span', { key: 't' }, project ? project.name : '没有选中项目')]),
            project
              ? h('div', { className: 'wf-flow-actions' }, [
                h('button', {
                  className: 'wf-btn wf-btn-sm',
                  onClick: () => api('/reveal', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ rel: `${project.name}/project.json` }) }).catch((error) => notify(error.message, true)),
                }, '打开项目目录'),
              ])
              : h('div', { className: 'wf-flow-empty', style: { padding: '0' } }, '从左侧选一个项目。'),
          ]),

          project ? h('div', { className: 'wf-sect', key: 'person' }, [
            h('div', { className: 'wf-subhead' }, '人物（写进提示词与质检）'),
            field('名字', h('input', {
              value: (project.person && project.person.name) || '',
              placeholder: '例如 噗噗',
              onChange: (event) => savePerson({ ...(project.person || {}), name: event.target.value }),
            })),
            field('外貌描述', h('input', {
              value: (project.person && project.person.describe) || '',
              placeholder: '例如 25 岁女生，黑色长发，细腰长腿',
              onChange: (event) => savePerson({ ...(project.person || {}), describe: event.target.value }),
            })),
          ]) : null,

          project ? h('div', { className: 'wf-sect', key: 'cast' }, [
            h('div', { className: 'wf-subhead' }, '生成角色图'),
            field('当次服装 *', h('input', {
              value: castForm.outfit,
              placeholder: '例如 白色短款针织上衣 + 高腰牛仔短裤 + 白色球鞋',
              onChange: (event) => setCastForm({ ...castForm, outfit: event.target.value }),
            })),
            h('div', { className: 'wf-two' }, [
              field('姿势', h('input', { value: castForm.pose, placeholder: '可选', onChange: (event) => setCastForm({ ...castForm, pose: event.target.value }) })),
              field('鞋', h('input', { value: castForm.shoes, placeholder: '可选', onChange: (event) => setCastForm({ ...castForm, shoes: event.target.value }) })),
            ]),
            field('场景', h('input', {
              value: castForm.scene,
              placeholder: '默认纯灰棚；要保留参考图背景就勾下面的「保持背景」',
              onChange: (event) => setCastForm({ ...castForm, scene: event.target.value }),
            })),
            h('label', { className: 'wf-check', key: 'keep' }, [
              h('input', { type: 'checkbox', checked: castForm.keepBg, onChange: (event) => setCastForm({ ...castForm, keepBg: event.target.checked }) }),
              '保持参考图的背景',
            ]),
            castRefs.length
              ? h('div', { key: 'refs' }, [
                h('div', { className: 'wf-subhead' }, '参考图（不选就自动用 refs/ 前 4 张）'),
                h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(5,1fr)', gap: '4px' } }, castRefs.slice(0, 10).map((row) => h('img', {
                  key: row.rel,
                  src: mediaUrl(row.rel),
                  alt: '',
                  title: row.name,
                  style: { width: '100%', height: '38px', objectFit: 'cover', borderRadius: '4px', cursor: 'pointer', outline: row.picked ? '2px solid #6f8cff' : '1px solid rgba(255,255,255,.08)' },
                  onClick: () => setCastRefs(castRefs.map((item) => (item.rel === row.rel ? { ...item, picked: !item.picked } : item))),
                }))),
              ])
              : null,
            h('button', {
              className: 'wf-btn wf-btn-primary',
              onClick: () => generateCast(),
              disabled: flowBusy || !castForm.outfit.trim(),
            }, flowBusy ? '处理中…' : '生成角色图（付费）'),
            h('div', { className: 'wf-cast-note' }, '生成后可在这里点「通过审核」；没通过之前，换人接口会拒绝提交。'),
          ]) : null,

          project ? h('div', { className: 'wf-sect', key: 'swap' }, [
            h('div', { className: 'wf-subhead' }, '提交换人'),
            h('div', { className: 'wf-notice' + (approved ? ' ok' : '') }, approved
              ? `已通过：${approved.outfit || '当前角色图'}`
              : '还没有通过审核的角色图——换人按钮会被后端拒绝（这是故意设的审核门）。'),
            field('镜头提示词（可选）', h('input', {
              value: swapPrompt,
              placeholder: '留空用默认：保机位/保场景/只换人',
              onChange: (event) => setSwapPrompt(event.target.value),
            })),
            field('单镜秒数', h('input', {
              type: 'number', min: '2', max: '15', value: swapSeconds,
              onChange: (event) => setSwapSeconds(Math.max(2, Math.min(15, Number(event.target.value) || 8))),
            })),
            h('div', { className: 'wf-flow-actions' }, [
              h('button', {
                className: 'wf-btn wf-btn-primary',
                onClick: () => startSwap(),
                disabled: flowBusy || !approved || !project.source.rel,
              }, '提交换人（付费）'),
              h('button', {
                className: 'wf-btn',
                onClick: () => renderFinal(),
                disabled: flowBusy || !doneTakes.length,
              }, '合成成片'),
            ]),
            h('div', { className: 'wf-cast-note' }, `会跑 ${new Set(takes.map((row) => row.shot)).size || 1} 个镜头；每段单独计费，RunningHub 多 Key 会并发调度。`),
          ]) : null,

          project ? h('div', { className: 'wf-sect', key: 'qa' }, [
            h('div', { className: 'wf-subhead' }, '质检'),
            h('div', { className: 'wf-cast-note' }, '抽 12 帧 + 前 8 帧，对照角色参考与原片锚帧；模型只判硬伤，接口异常会记 SKIP 而不是误判。'),
            h('div', { className: 'wf-flow-actions' }, [
              h('button', {
                className: 'wf-btn',
                onClick: () => startQa(''),
                disabled: flowBusy || !doneTakes.length,
              }, '开始质检（付费）'),
            ]),
          ]) : null,

          h('div', { className: 'wf-sect', key: 'note' }, [
            h('div', { className: 'wf-subhead' }, '目录'),
            h('div', { className: 'wf-cast-note' }, '每个项目就是一个普通文件夹：src/ 原片、refs/ 参考图、cast/ 角色图、shots/ 分镜、takes/ 换人片段、qa/ 质检、final/ 成片。可以用资源管理器直接管理。'),
          ]),
        ]))
      }

      /* ---------------- 工作流实验室 ---------------- */

      const labsCenter = () => {
        const probe = labsProbe
        const videos = (labsMedia.video || []).slice(0, 200)
        const images = (labsMedia.image || []).slice(0, 120)
        const numbers = Object.entries(labsPlan.numbers || {})
        return h('section', { className: 'wf-col wf-center', key: 'center' }, [
          h('div', { className: 'wf-stage-tools' }, [
            h('span', {}, '工作流实验室'),
            h('span', { className: 'wf-spacer', style: { flex: 1 } }),
            h('span', {}, labsSel ? labsSel.name : '未选择工作流'),
          ]),
          labsSel ? h('div', { className: 'wf-lab-scroll' }, [
            h('div', { className: 'wf-lab-grid' }, [
              h('div', { className: 'wf-lab-col' }, [
                h('div', { className: 'wf-subhead' }, '输入'),
                field('视频（原片 / 分镜）', h('select', {
                  className: 'wf-select',
                  value: labsVideo,
                  onChange: (event) => setLabsVideo(event.target.value),
                }, [
                  h('option', { key: '', value: '' }, '— 不传视频 —'),
                  ...videos.map((item) => h('option', { key: item.rel, value: item.rel }, `${item.name} · ${item.work}`)),
                ])),
                h('div', { className: 'wf-subhead', style: { marginTop: 10 } }, `参考图（可多选，已选 ${labsImages.length}）`),
                images.length ? h('div', { className: 'wf-lab-imgs' }, images.map((item) => h('label', {
                  key: item.rel,
                  className: `wf-lab-img${labsImages.includes(item.rel) ? ' on' : ''}`,
                  title: item.rel,
                }, [
                  h('input', {
                    type: 'checkbox',
                    checked: labsImages.includes(item.rel),
                    onChange: (event) => setLabsImages(event.target.checked
                      ? [...labsImages, item.rel]
                      : labsImages.filter((rel) => rel !== item.rel)),
                  }),
                  h('img', { src: mediaUrl(item.rel), alt: '', loading: 'lazy' }),
                  h('span', {}, item.name),
                ]))) : h('div', { className: 'wf-empty' }, '素材索引里还没有图片'),
                field('文本提示（可选）', h('textarea', {
                  className: 'wf-textarea',
                  rows: 3,
                  value: labsText,
                  placeholder: '例如：让画面里的人换成参考图中的人，保持镜头与背景不变',
                  onChange: (event) => setLabsText(event.target.value),
                })),
                numbers.length ? h('div', null, [
                  h('div', { className: 'wf-subhead', style: { marginTop: 10 } }, '数字参数（留空用工作流默认）'),
                  ...numbers.map(([name, nodeId]) => field(`${name} · #${nodeId}`, h('input', {
                    type: 'number',
                    value: labsValues[name] ?? '',
                    onChange: (event) => setLabsValues({ ...labsValues, [name]: event.target.value }),
                  }))),
                ]) : null,
              ]),
              h('div', { className: 'wf-lab-col' }, [
                h('div', { className: 'wf-subhead' }, `探测到的节点${probe ? `（${probe.total}）` : '（未探测）'}`),
                probe ? [
                  h('div', { className: 'wf-lab-node' }, [h('b', {}, '视频输入'), h('span', {}, (probe.video || []).map((id) => `#${id}`).join('、') || '—')]),
                  h('div', { className: 'wf-lab-node' }, [h('b', {}, '图片输入'), h('span', {}, (probe.image || []).map((id) => `#${id}`).join('、') || '—')]),
                  h('div', { className: 'wf-lab-node' }, [h('b', {}, '文本输入'), h('span', {}, (probe.text || []).map((id) => `#${id}`).join('、') || '—')]),
                  h('div', { className: 'wf-lab-node' }, [h('b', {}, '输出'), h('span', {}, [...(probe.outVideo || []).map((id) => `视频 #${id}`), ...(probe.outImage || []).map((id) => `图片 #${id}`)].join(' / ') || '—')]),
                  h('div', { className: 'wf-lab-node' }, [h('b', {}, '数字参数'), h('span', {}, (probe.numbers || []).map((node) => `#${node.id} ${node.title || node.type}`).join('、') || '—')]),
                ] : h('div', { className: 'wf-empty' }, '右边点「探测」读一遍工作流节点，或直接选一个内置工作流。'),
                h('div', { className: 'wf-subhead', style: { marginTop: 12 } }, '说明'),
                h('div', { className: 'wf-cast-note' }, '探测会读取该工作流的 API 格式图并自动认节点：视频输入、图片输入、文本输入、数字参数、输出。运行时用你选的素材填进去。'),
              ]),
            ]),
          ]) : h('div', { className: 'wf-stage-empty', style: { margin: 'auto' } }, [
            h('b', {}, '接入任意 RunningHub 工作流'),
            h('div', { className: 'wf-drop' }, '左边是内置的换人与超分；右边填你的工作流 ID，探测节点后就能带素材运行。'),
          ]),
        ])
      }

      const labsRight = () => h('aside', { className: 'wf-col wf-right', key: 'right' }, h('div', { className: 'wf-right-scroll' }, [
        h('div', { className: 'wf-sect' }, [
          h('div', { className: 'wf-sect-title' }, [h('span', { key: 't' }, '运行工作流'), h('span', { key: 's', className: 'wf-badge' }, 'RunningHub')]),
          field('工作流 ID', h('input', {
            value: labsId,
            placeholder: '2109190174289780738',
            onChange: (event) => setLabsId(event.target.value),
          })),
          field('名称（保存时用）', h('input', {
            value: labsName,
            placeholder: '我的换人工作流',
            onChange: (event) => setLabsName(event.target.value),
          })),
          h('div', { className: 'wf-flow-actions' }, [
            h('button', { className: 'wf-btn', onClick: probeLabs, disabled: flowBusy }, '探测节点'),
            h('button', { className: 'wf-btn', onClick: saveLabs, disabled: flowBusy }, '保存到列表'),
          ]),
          h('button', {
            className: 'wf-btn wf-btn-primary',
            onClick: runLabs,
            disabled: flowBusy || !labsSel || !labsSel.workflowId,
            style: { width: '100%', marginTop: 8 },
          }, '▶ 运行（付费）'),
          h('div', { className: 'wf-cast-note' }, '工作流要公开可调；运行费用按 RunningHub 实际扣费结算。'),
        ]),
        h('div', { className: 'wf-sect' }, [
          h('div', { className: 'wf-subhead' }, '运行记录'),
          labsRuns.length ? labsRuns.slice(0, 10).map((run) => h('div', { key: run.id, className: 'wf-run' }, [
            h('div', { className: 'wf-run-head' }, [
              h('b', { title: run.rel }, run.title || run.workflowId),
              h('span', { className: `wf-badge${run.status === 'done' ? ' done' : run.status === 'failed' ? ' warn' : ''}` }, run.status),
            ]),
            h('div', { className: 'wf-run-sub' }, `${run.rel || ''}${run.cost ? ` · ¥${run.cost}` : ''}`),
            run.error ? h('div', { className: 'wf-notice err' }, run.error) : null,
            run.url ? h('a', { className: 'wf-btn wf-btn-sm', href: run.url, target: '_blank', rel: 'noreferrer', style: { marginTop: 6, display: 'inline-block' } }, '看结果') : null,
          ])) : h('div', { className: 'wf-empty' }, '还没有运行记录'),
        ]),
      ]))

      /* ---------------- 渲染 ---------------- */

      /* 皮肤类插件会在运行中后注入带 !important 的输入框皮肤，把工作台自己的控件钉回深色 */
      useEffect(() => {
        const root = rootRef.current
        if (!root) return undefined
        const apply = () => {
          for (const el of root.querySelectorAll('input, select')) {
            const type = (el.getAttribute('type') || '').toLowerCase()
            if (type === 'range' || type === 'checkbox' || type === 'file') continue
            el.style.setProperty('background', '#14161a', 'important')
            el.style.setProperty('color', '#e8eaf0', 'important')
            el.style.setProperty('border-color', '#2b2f37', 'important')
            el.style.setProperty('box-shadow', 'none', 'important')
            el.style.setProperty('color-scheme', 'dark', 'important')
          }
        }
        apply()
        const observer = new MutationObserver(() => apply())
        observer.observe(root, { childList: true, subtree: true })
        return () => observer.disconnect()
      }, [])

      const trackTotals = useMemo(() => {
        const totals = {}
        for (const row of TRACKS) {
          totals[row.id] = (timeline.tracks[row.id] || []).reduce((max, clip) => Math.max(max, clip.start + clip.length), 0)
        }
        return totals
      }, [timeline])

      const duration = Math.max(timeline.duration || 30, ...Object.values(trackTotals), 10)
      const ready = Boolean(config)

      return h('div', { className: 'wf-root', ref: rootRef }, [
        /* 顶部 */
        h('header', { className: 'wf-top', key: 'top' }, [
          h('div', { className: 'wf-brand', key: 'brand' }, [
            h('span', { className: 'wf-brand-dot' }),
            h('span', { className: 'wf-brand-label' }, LABEL),
          ]),
          h('div', { className: 'wf-top-project', key: 'project' }, [
            h('b', { title: flowName || '' }, flowName || '未选择项目'),
            h('span', { title: config ? config.root : '' }, status || (ready ? '已保存' : '读取中')),
          ]),
          h('div', { className: 'wf-top-seq', key: 'seq' }, [
            h('span', {}, '序列'),
            h('b', {}, 'Main'),
            h('i', {}, `${timeline.width}×${timeline.height} · ${timeline.fps}fps`),
          ]),
          h('div', { className: 'wf-spacer' }),
          h('button', { className: 'wf-btn', onClick: refreshIndex, disabled: busy }, '刷新'),
          h('button', { className: 'wf-btn', onClick: () => fileInputRef.current && fileInputRef.current.click(), disabled: busy }, '＋ 导入'),
          h('div', { className: 'wf-top-actions' }, [
            h('button', { className: `wf-btn${tab === 'flow' ? ' on' : ''}`, onClick: () => setTab('flow') }, '复刻'),
            h('button', { className: `wf-btn${tab === 'labs' ? ' on' : ''}`, onClick: () => setTab('labs') }, '工作流'),
            h('button', { className: `wf-btn${tab === 'assets' ? ' on' : ''}`, onClick: () => setTab('assets') }, '素材库'),
          ]),
          h('button', {
            className: 'wf-btn wf-btn-go',
            onClick: () => setTab('flow'),
            disabled: !ready,
          }, '审阅与导出'),
          h('input', {
            ref: fileInputRef,
            type: 'file',
            multiple: true,
            accept: 'image/*,video/*,audio/*',
            className: 'wf-hidden',
            onChange: (event) => { uploadFiles(event.target.files); event.target.value = '' },
          }),
        ]),

        /* 主体 */
        h('div', { className: 'wf-main', key: 'main' }, [
          /* 左栏 */
          h('aside', { className: 'wf-col wf-left', key: 'left' }, [
            h('div', { className: 'wf-tabs' }, [
              ['flow', '复刻'], ['labs', '工作流'], ['assets', '素材'], ['works', '作品'], ['jobs', '任务'], ['settings', '设置'],
            ].map(([id, label]) => h('button', {
              key: id,
              className: `wf-tab${tab === id ? ' on' : ''}`,
              onClick: () => setTab(id),
            }, label))),

            h('div', { className: 'wf-left-body' }, [
              /* 复刻 tab：项目列表 */
              tab === 'flow' ? h('div', { key: 'flow', style: { display: 'flex', flexDirection: 'column', minHeight: 0, flex: 1 } }, [
                h('div', { className: 'wf-flow-new' }, [
                  h('input', {
                    value: newFlowName,
                    placeholder: '新项目名 / 已有目录名',
                    onChange: (event) => setNewFlowName(event.target.value),
                    onKeyDown: (event) => { if (event.key === 'Enter') createFlow() },
                  }),
                  h('button', { className: 'wf-btn wf-btn-sm', onClick: () => createFlow(), disabled: flowBusy }, '新建'),
                  h('button', { className: 'wf-btn wf-btn-sm', onClick: () => importFlow(), disabled: flowBusy }, '导入'),
                ]),
                h('div', { className: 'wf-flow-list' }, flowProjects.length ? flowProjects.map((row) => h('div', {
                  key: row.name,
                  className: `wf-flow-item${flowName === row.name ? ' on' : ''}`,
                  onClick: () => (row.imported === false ? importFlow(row.name) : openFlow(row.name)),
                  title: row.name,
                }, [
                  h('div', { className: 'wf-work-meta' }, [
                    h('div', { className: 'wf-work-name' }, row.name),
                    h('div', { className: 'wf-work-sub' }, `${row.imported === false ? '待导入' : row.stage} · ${(row.cast.versions || []).length} 版角色图 · ${(row.swap.takes || []).filter((take) => take.status === 'done').length} 段换人`),
                  ]),
                  h('span', { className: `wf-badge${row.stage === '成片' ? ' done' : row.stage === '质检' ? ' warn' : ''}` }, row.stage),
                ])) : h('div', { className: 'wf-flow-empty', style: { flex: 1 } }, ['还没有项目。', h('br', { key: 'br' }), '新建一个，或把已有作品目录导入进来。'])),
              ]) : null,

              /* 工作流实验室 tab */
              tab === 'labs' ? h('div', { key: 'labs', style: { display: 'flex', flexDirection: 'column', minHeight: 0, flex: 1 } }, [
                h('div', { className: 'wf-subhead' }, '内置 / 已接工作流'),
                h('div', { className: 'wf-flow-list' }, [...(labs.builtin || []), ...(labs.custom || [])].map((row) => h('div', {
                  key: `${row.workflowId || 'none'}-${row.name}`,
                  className: `wf-flow-item${labsSel && labsSel.workflowId === row.workflowId ? ' on' : ''}`,
                  onClick: () => pickLabs(row),
                  title: row.desc || row.workflowId || '',
                }, [
                  h('div', { className: 'wf-work-meta' }, [
                    h('div', { className: 'wf-work-name' }, row.name),
                    h('div', { className: 'wf-work-sub' }, row.workflowId || '还没有 ID'),
                  ]),
                  h('span', { className: 'wf-badge' }, row.kind === 'upscale' ? '超分' : '视频'),
                ]))),
                h('div', { className: 'wf-flow-empty' }, [
                  '换别人的工作流：右边填 ID → 探测节点 → 保存。',
                  h('br', { key: 'br' }),
                  '跑到 WebUI / API 调用的工作流都行。',
                ]),
              ]) : null,

              /* 素材 tab */
              tab === 'assets' ? h('div', { className: 'wf-left-body', key: 'assets' }, [
                h('div', { className: 'wf-filters' }, [
                  h('input', {
                    className: 'wf-input',
                    placeholder: '搜索素材名 / 路径…',
                    value: query,
                    onChange: (event) => setQuery(event.target.value),
                  }),
                  h('div', { className: 'wf-row' }, [
                    h('select', { className: 'wf-select', value: workFilter, onChange: (event) => setWorkFilter(event.target.value) }, [
                      h('option', { key: '', value: '' }, `全部作品（${works.length}）`),
                      ...works.map((work) => h('option', { key: work.name, value: work.name }, `${work.name}（${work.total}）`)),
                    ]),
                  ]),
                  h('div', { className: 'wf-row', style: { flexWrap: 'wrap' } }, [
                    ['all', '全部'], ['image', '图片'], ['video', '视频'], ['audio', '音频'],
                  ].map(([id, label]) => h('button', {
                    key: id,
                    className: `wf-chip${kind === id ? ' on' : ''}`,
                    onClick: () => setKind(id),
                  }, label))),
                ]),
                assetGrid({
                  assets,
                  works,
                  workFilter,
                  setWorkFilter,
                  selected,
                  selectAsset,
                  onDropFiles: uploadFiles,
                  pendingAssets,
                }),
              ]) : null,

              /* 作品 tab */
              tab === 'works' ? h('div', { className: 'wf-left-body', key: 'works' }, [
                h('div', { className: 'wf-work-list' }, works.length ? works.map((work) => h('div', {
                  key: work.name,
                  className: `wf-work${workFilter === work.name ? ' on' : ''}`,
                  onClick: () => {
                    setWorkFilter(work.name)
                    setTab('assets')
                    setKind('all')
                  },
                }, [
                  work.cover
                    ? h('img', { className: 'wf-work-cover', src: mediaUrl(work.cover.rel), loading: 'lazy', alt: '' })
                    : h('div', { className: 'wf-work-cover' }, '▦'),
                  h('div', { className: 'wf-work-meta' }, [
                    h('div', { className: 'wf-work-name' }, work.name),
                    h('div', { className: 'wf-work-sub' }, `${work.images} 图 · ${work.videos} 视频 · ${work.scripts.length} 脚本`),
                  ]),
                  h('span', { className: `wf-badge${work.stage === '成片' ? ' done' : work.stage === '视频素材' ? ' warn' : ''}` }, work.stage),
                ])) : h('div', { className: 'wf-empty' }, [h('b', { key: 'b' }, '还没有作品'), '索引里没有一级作品目录。'])),
              ]) : null,

              /* 任务 tab */
              tab === 'jobs' ? h('div', { className: 'wf-left-body', key: 'jobs' }, [
                h('div', { className: 'wf-form' }, [
                  h('select', { className: 'wf-select', value: jobWork, onChange: (event) => setJobWork(event.target.value) }, [
                    h('option', { key: '', value: '' }, '（项目根目录）'),
                    ...works.map((work) => h('option', { key: work.name, value: work.name }, work.name)),
                  ]),
                  h('select', { className: 'wf-select', value: jobScript, onChange: (event) => setJobScript(event.target.value) }, scripts.length
                    ? scripts.map((row) => h('option', { key: row.rel, value: row.rel }, row.rel))
                    : [h('option', { key: '', value: '' }, '这个目录里没有脚本')]),
                  h('input', {
                    className: 'wf-input',
                    placeholder: '参数（可选，空格分隔）',
                    value: jobArgs,
                    onChange: (event) => setJobArgs(event.target.value),
                  }),
                  h('div', { className: 'wf-row' }, [
                    h('button', { className: 'wf-btn wf-btn-primary', style: { flex: 1 }, onClick: runJob, disabled: busy || !jobScript }, '▶ 运行脚本'),
                    h('button', { className: 'wf-btn', onClick: () => api('/scripts' + (jobWork ? `?work=${encodeURIComponent(jobWork)}` : '')).then((data) => setScripts(data.items || [])).catch(() => {}) }, '重扫'),
                  ]),
                ]),
                h('div', { className: 'wf-jobs' }, jobs.length ? jobs.map((job) => jobRow({ job, notify, killJob })) : h('div', { className: 'wf-empty' }, [h('b', { key: 'b' }, '还没有任务'), '运行时输出会出现在这里；脚本用项目里的相对路径。'])),
              ]) : null,

              /* 设置 tab */
              tab === 'settings' ? h('div', { className: 'wf-left-body', key: 'settings' }, [
                h('div', { style: { padding: '10px', display: 'flex', flexDirection: 'column', gap: '10px' } }, [
                  field('项目根目录', h('input', { value: settingRoot, onChange: (event) => setSettingRoot(event.target.value) })),
                  field('Python 解释器', h('input', { value: settingPython, onChange: (event) => setSettingPython(event.target.value), placeholder: 'python 或 venv 的 python.exe 绝对路径' })),
                  field('上传子目录', h('input', { value: settingUpload, onChange: (event) => setSettingUpload(event.target.value) })),
                  h('button', { className: 'wf-btn wf-btn-primary', onClick: saveSettings, disabled: busy }, '保存并重建索引'),
                  h('div', { className: 'wf-subhead' }, 'RunningHub（换人视频）'),
                  field('API Key（多个用逗号分隔）', h('input', {
                    value: (apiForm && apiForm.runninghub && apiForm.runninghub.key) || '',
                    placeholder: '未配置',
                    onChange: (event) => setApiForm({ ...(apiForm || {}), runninghub: { ...((apiForm && apiForm.runninghub) || {}), key: event.target.value } }),
                  })),
                  field('换人工作流 ID', h('input', {
                    value: (apiForm && apiForm.runninghub && apiForm.runninghub.swapWorkflowId) || '',
                    placeholder: '2109190174289780738',
                    onChange: (event) => setApiForm({ ...(apiForm || {}), runninghub: { ...((apiForm && apiForm.runninghub) || {}), swapWorkflowId: event.target.value } }),
                  })),
                  h('div', { className: 'wf-two' }, [
                    field('并发', h('input', {
                      type: 'number', min: '1', max: '20',
                      value: (apiForm && apiForm.runninghub && apiForm.runninghub.concurrency) || 5,
                      onChange: (event) => setApiForm({ ...(apiForm || {}), runninghub: { ...((apiForm && apiForm.runninghub) || {}), concurrency: Number(event.target.value) || 5 } }),
                    })),
                    field('RH 币 / 元', h('input', {
                      type: 'number', step: '0.0001',
                      value: (apiForm && apiForm.runninghub && apiForm.runninghub.coinCny) || 0.0022,
                      onChange: (event) => setApiForm({ ...(apiForm || {}), runninghub: { ...((apiForm && apiForm.runninghub) || {}), coinCny: Number(event.target.value) || 0.0022 } }),
                    })),
                  ]),
                  h('div', { className: 'wf-subhead' }, 'APIMart（角色图 + 质检）'),
                  field('API Key', h('input', {
                    value: (apiForm && apiForm.apimart && apiForm.apimart.key) || '',
                    placeholder: '未配置',
                    onChange: (event) => setApiForm({ ...(apiForm || {}), apimart: { ...((apiForm && apiForm.apimart) || {}), key: event.target.value } }),
                  })),
                  h('div', { className: 'wf-two' }, [
                    field('画图模型', h('input', {
                      value: (apiForm && apiForm.apimart && apiForm.apimart.imageModel) || '',
                      placeholder: 'gpt-image-2.5-sunburst',
                      onChange: (event) => setApiForm({ ...(apiForm || {}), apimart: { ...((apiForm && apiForm.apimart) || {}), imageModel: event.target.value } }),
                    })),
                    field('视觉模型', h('input', {
                      value: (apiForm && apiForm.apimart && apiForm.apimart.visionModel) || '',
                      placeholder: 'gemini-3.8-flash',
                      onChange: (event) => setApiForm({ ...(apiForm || {}), apimart: { ...((apiForm && apiForm.apimart) || {}), visionModel: event.target.value } }),
                    })),
                  ]),
                  h('div', { className: 'wf-two' }, [
                    field('视觉 Key（可留空复用上面的）', h('input', {
                      value: (apiForm && apiForm.apimart && apiForm.apimart.visionKey) || '',
                      placeholder: '可留空',
                      onChange: (event) => setApiForm({ ...(apiForm || {}), apimart: { ...((apiForm && apiForm.apimart) || {}), visionKey: event.target.value } }),
                    })),
                    field('USD → CNY', h('input', {
                      type: 'number', step: '0.1',
                      value: (apiForm && apiForm.apimart && apiForm.apimart.usdCny) || 7.2,
                      onChange: (event) => setApiForm({ ...(apiForm || {}), apimart: { ...((apiForm && apiForm.apimart) || {}), usdCny: Number(event.target.value) || 7.2 } }),
                    })),
                  ]),
                  h('div', { className: 'wf-two' }, [
                    field('ffmpeg', h('input', {
                      value: (apiForm && apiForm.tools && apiForm.tools.ffmpeg) || 'ffmpeg',
                      onChange: (event) => setApiForm({ ...(apiForm || {}), tools: { ...((apiForm && apiForm.tools) || {}), ffmpeg: event.target.value } }),
                    })),
                    field('ffprobe', h('input', {
                      value: (apiForm && apiForm.tools && apiForm.tools.ffprobe) || 'ffprobe',
                      onChange: (event) => setApiForm({ ...(apiForm || {}), tools: { ...((apiForm && apiForm.tools) || {}), ffprobe: event.target.value } }),
                    })),
                  ]),
                  h('div', { className: 'wf-flow-actions' }, [
                    h('button', { className: 'wf-btn wf-btn-primary', onClick: saveApiSettings, disabled: flowBusy }, '保存 API 设置'),
                    h('button', { className: 'wf-btn', onClick: testApis, disabled: flowBusy }, '连通测试'),
                  ]),
                  ...(testRows.length ? testRows.map((row, i) => h('div', { key: `t${i}`, className: `wf-notice${row.ok ? ' ok' : ' err'}` }, `${row.provider}：${row.ok ? '可用' : (row.error || '不可用')}`)) : []),
                  h('div', { className: 'wf-kv' }, [h('span', {}, '索引文件数'), h('b', {}, String(config?.items || assets.total || 0))]),
                  h('div', { className: 'wf-kv' }, [h('span', {}, '最近扫描'), h('b', {}, fmtDate(scanAt))]),
                  h('div', { className: 'wf-empty', style: { padding: '10px 4px', textAlign: 'left' } }, '索引会跳过 ComfyUI、ComfyUI-venv、__pycache__、node_modules 等大目录，最多收 4 万个媒体文件。'),
                ]),
              ]) : null,
            ]),
          ]),

          /* 中间舞台 */
          tab === 'flow' ? flowCenter() : tab === 'labs' ? labsCenter() : h('section', { className: 'wf-col wf-center', key: 'center', ref: stageRef }, [
            h('div', { className: 'wf-stage-tools' }, [
              h('span', { className: 'wf-stage-live' }, '交互预览'),
              h('span', { className: 'wf-spacer', style: { flex: 1 } }),
              h('div', { className: 'wf-stage-tabs' }, ['原片对照', '审阅意见', '画布编辑', '序列设置'].map((label, index) => h('span', {
                key: label,
                className: `wf-stage-tab${index === 0 ? ' on' : ''}`,
              }, label))),
              h('span', { className: 'wf-tool-sep' }),
              h('span', {}, `${timeline.width}×${timeline.height} · ${timeline.fps} fps`),
            ]),
            h('div', { className: 'wf-zoom-bar' }, [
              h('button', { className: 'wf-btn wf-btn-sm', onClick: () => setStageScale((value) => Math.max(0.4, Number((value - 0.1).toFixed(2)))), title: '缩小' }, '−'),
              h('span', { className: 'wf-zoom-val' }, stageScale === 1 ? '适配' : `${Math.round(stageScale * 100)}%`),
              h('button', { className: 'wf-btn wf-btn-sm', onClick: () => setStageScale((value) => Math.min(2, Number((value + 0.1).toFixed(2)))), title: '放大' }, '+'),
              h('select', {
                className: 'wf-select wf-select-sm',
                value: String(stageScale),
                onChange: (event) => setStageScale(Number(event.target.value)),
              }, [['1', '适配'], ['0.5', '50%'], ['0.75', '75%'], ['1.25', '125%'], ['2', '200%']].map(([value, label]) => h('option', { key: value, value }, label))),
              h('span', { className: 'wf-spacer', style: { flex: 1 } }),
              h('span', { className: 'wf-tl-hint' }, '平移'),
            ]),
            h('div', { className: 'wf-stage' }, [
              h('div', {
                className: `wf-stage-inner${dragOver ? ' over' : ''}`,
                style: { transform: `scale(${stageScale})`, transition: 'transform .12s ease' },
                onDragOver: (event) => { event.preventDefault(); setDragOver(true) },
                onDragLeave: () => setDragOver(false),
                onDrop: (event) => {
                  event.preventDefault()
                  setDragOver(false)
                  if (event.dataTransfer.files && event.dataTransfer.files.length) uploadFiles(event.dataTransfer.files)
                },
              }, selectedMedia
                ? (selectedMedia.kind === 'video'
                  ? h('video', {
                    key: selectedMedia.rel,
                    src: selectedMedia.url || mediaUrl(selectedMedia.rel),
                    controls: true,
                    autoPlay: false,
                    onTimeUpdate: (event) => setPlayhead(event.target.currentTime),
                  })
                  : selectedMedia.kind === 'audio'
                    ? h('div', { className: 'wf-stage-empty' }, [h('div', { key: 'a' }, '🎵'), h('div', { key: 'b', style: { color: '#cfd7e4' } }, selectedMedia.name || selectedMedia.rel)])
                    : h('img', {
                      key: selectedMedia.rel,
                      src: selectedMedia.url || mediaUrl(selectedMedia.rel),
                      alt: selectedMedia.name || '',
                      draggable: true,
                      onDragStart: (event) => {
                        event.dataTransfer.setData('application/x-wanfeng-asset', selectedMedia.rel)
                        event.dataTransfer.setData('text/plain', selectedMedia.rel)
                      },
                    }))
                : h('div', { className: 'wf-stage-empty' }, [
                  h('div', { key: 'icon', style: { fontSize: '34px', opacity: .5 } }, '▣'),
                  h('b', { key: 't', style: { fontSize: '14px' } }, '从左侧选一个素材开始'),
                  h('div', { key: 'd', className: 'wf-drop', onDragOver: (event) => { event.preventDefault(); setDragOver(true) }, onDragLeave: () => setDragOver(false) }, [
                    '把图片 / 视频拖到这里上传，',
                    h('br', { key: 'br' }),
                    '或点顶部「＋ 上传素材」',
                  ]),
                ])),
              selectedMedia ? h('div', { className: 'wf-stage-tag' }, `${selectedMedia.kind} · ${selectedMedia.name || ''}`) : null,
            ]),
            h('div', { className: 'wf-transport' }, [
              h('div', { className: 'wf-tp-time' }, [
                h('b', {}, fmtClock(playhead)),
                h('span', {}, '/'),
                h('b', {}, fmtClock(duration)),
              ]),
              h('div', { className: 'wf-tp-mid' }, [
                h('button', { className: 'wf-tp-btn', onClick: () => setPlayhead(0), title: '回到开头' }, '⏮'),
                h('button', {
                  className: 'wf-tp-btn wf-tp-play',
                  onClick: () => notify('在预览画布点视频播放；拖动时间线下方的播放头可移动预览位置。'),
                  title: '播放',
                }, '▶'),
                h('button', { className: 'wf-tp-btn', onClick: () => setPlayhead(Math.min(duration, Number((playhead + 1).toFixed(1)))), title: '前进 1 秒' }, '⏭'),
              ]),
              h('div', { className: 'wf-tp-right' }, [
                h('div', { className: 'wf-progress' }, h('div', { className: 'wf-progress-fill', style: { width: `${Math.min(100, (playhead / Math.max(duration, 1)) * 100)}%`, animation: playhead ? 'none' : undefined } })),
                h('span', { className: 'wf-tl-hint' }, pendingAssets ? `上传中 ${pendingAssets}…` : '本地预览'),
              ]),
            ]),
          ]),

          /* 右栏 */
          tab === 'flow' ? flowRight() : tab === 'labs' ? labsRight() : h('aside', { className: 'wf-col wf-right', key: 'right' }, h('div', { className: 'wf-right-scroll' }, [
            h('div', { className: 'wf-sect' }, [
              h('div', { className: 'wf-sect-title' }, [h('span', { key: 't' }, '序列设置'), h('span', { key: 's', className: 'wf-badge' }, '自动保存')]),
              h('div', { className: 'wf-two' }, [
                field('宽度', h('input', { type: 'number', value: timeline.width, onChange: (event) => patchTimeline({ width: Number(event.target.value) || 1920 }) })),
                field('高度', h('input', { type: 'number', value: timeline.height, onChange: (event) => patchTimeline({ height: Number(event.target.value) || 1080 }) })),
              ]),
              field('帧率', h('input', { type: 'number', value: timeline.fps, onChange: (event) => patchTimeline({ fps: Number(event.target.value) || 30 }) })),
              field('时长（秒）', h('input', { type: 'number', value: timeline.duration, onChange: (event) => patchTimeline({ duration: Number(event.target.value) || 30 }) })),
            ]),

            h('div', { className: 'wf-sect' }, [
              h('div', { className: 'wf-sect-title' }, [h('span', { key: 't' }, '选中素材')]),
              selectedMedia ? h('div', {}, [
                h('div', { className: 'wf-kv' }, [h('span', {}, '文件'), h('b', { title: selectedMedia.name }, selectedMedia.name)]),
                h('div', { className: 'wf-kv' }, [h('span', {}, '类型'), h('b', {}, selectedMedia.kind)]),
                h('div', { className: 'wf-kv' }, [h('span', {}, '大小'), h('b', {}, fmtSize(selectedMedia.size || 0))]),
                h('div', { className: 'wf-kv' }, [h('span', {}, '作品'), h('b', { title: selectedMedia.work }, selectedMedia.work || '—')]),
                h('div', { className: 'wf-kv' }, [h('span', {}, '路径'), h('b', { title: selectedMedia.rel }, selectedMedia.rel)]),
                h('div', { className: 'wf-row', style: { marginTop: '8px', flexWrap: 'wrap' } }, [
                  h('button', { className: 'wf-btn wf-btn-sm', onClick: () => addToTimeline(selectedMedia, 'video') }, '加入 Video'),
                  h('button', { className: 'wf-btn wf-btn-sm', onClick: () => addToTimeline(selectedMedia, 'graphics') }, '加入 Graphics'),
                  h('button', { className: 'wf-btn wf-btn-sm', onClick: () => addToTimeline(selectedMedia, 'audio') }, '加入 Audio'),
                ]),
                h('button', {
                  className: 'wf-btn wf-btn-sm',
                  style: { marginTop: '6px' },
                  onClick: () => api('/reveal', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ rel: selectedMedia.rel }) }).catch((error) => notify(error.message, true)),
                }, '在资源管理器中显示'),
              ]) : h('div', { className: 'wf-empty', style: { padding: '10px 2px', textAlign: 'left' } }, '在左侧素材库里选一个素材，这里会显示路径、大小和加入轨道的按钮。'),
            ]),

            h('div', { className: 'wf-sect' }, [
              h('div', { className: 'wf-sect-title' }, [h('span', { key: 't' }, '时间线'), h('span', { key: 'c', className: 'wf-badge' }, `${(timeline.tracks.video.length + timeline.tracks.graphics.length + timeline.tracks.audio.length)} 个片段`)]),
              ...TRACKS.map((row) => h('div', { className: 'wf-kv', key: row.id }, [
                h('span', {}, row.label),
                h('b', {}, `${(timeline.tracks[row.id] || []).length} 段 · ${Math.round(trackTotals[row.id] || 0)} 秒`),
              ])),
              selectedClip ? h('button', { className: 'wf-btn wf-btn-sm wf-btn-danger', onClick: () => removeClip(selectedClip.track, selectedClip.id) }, `删除选中片段（${selectedClip.track}）`) : null,
            ]),

            h('div', { className: 'wf-sect' }, [
              h('div', { className: 'wf-sect-title' }, [h('span', { key: 't' }, '项目')]),
              h('div', { className: 'wf-kv' }, [h('span', {}, '作品数'), h('b', {}, String(works.length))]),
              h('div', { className: 'wf-kv' }, [h('span', {}, '媒体数'), h('b', {}, String(assets.total || 0))]),
              h('div', { className: 'wf-kv' }, [h('span', {}, '扫描'), h('b', {}, fmtDate(scanAt))]),
            ]),
          ])),
        ]),

        /* 底部时间线 */
        h('footer', { className: 'wf-bottom', key: 'bottom' }, [
          h('div', { className: 'wf-tl-tools' }, [
            h('button', { className: 'wf-tool', onClick: addTextClip }, [h('b', { key: 'i' }, 'T'), h('span', { key: 't' }, '添加字幕')]),
            h('button', { className: 'wf-tool', onClick: splitAtPlayhead, disabled: !selectedClip }, [h('b', { key: 'i' }, '✂'), h('span', { key: 't' }, '在播放头切分')]),
            h('button', { className: 'wf-tool', disabled: true }, '滚动接点'),
            h('button', { className: 'wf-tool', disabled: true }, '滑动片段'),
            h('button', { className: 'wf-tool', onClick: () => { if (selectedClip) removeClip(selectedClip.track, selectedClip.id) }, disabled: !selectedClip }, '删除'),
            h('button', { className: 'wf-tool', onClick: rippleDelete, disabled: !selectedClip }, '波纹删除区间'),
            h('button', { className: 'wf-tool', disabled: true }, '关联所选'),
            h('button', { className: 'wf-tool', disabled: true }, '解除关联'),
            h('span', { className: 'wf-spacer', style: { flex: 1 } }),
            h('button', { className: 'wf-tool', disabled: true }, '复制选区给 AI'),
          ]),
          h('div', { className: 'wf-tl-info' }, [
            h('b', {}, '时间线'),
            h('span', { className: 'wf-tl-hint' }, '移动 · 滑移素材 · 滚动接点 · 滑动片段'),
            h('span', { className: 'wf-tl-sep' }),
            h('span', { className: 'wf-tl-hint' }, '3 轨 · 拖素材到轨道排片，拖动片段调整起点'),
            h('span', { className: 'wf-spacer', style: { flex: 1 } }),
            h('span', { className: 'wf-tl-hint' }, '缩放'),
            h('input', {
              type: 'range',
              min: '24',
              max: '180',
              value: String(zoom),
              style: { width: '120px', accentColor: 'var(--dsw-alias-brand-primary,#7c9cff)' },
              onChange: (event) => setZoom(Number(event.target.value)),
            }),
          ]),
          h('div', { className: 'wf-tl-body' }, [
            h('div', { className: 'wf-tl-heads' }, [
              h('div', { className: 'wf-tl-head-ruler' }),
              ...TRACKS.map((row) => h('div', { className: 'wf-tl-head', key: row.id }, [
                h('i', { style: { background: row.id === 'video' ? '#5b7cff' : row.id === 'graphics' ? '#a98bff' : '#58c48c' } }),
                h('span', { title: row.hint }, row.label),
              ])),
            ]),
            h('div', { className: 'wf-tl-scroll' }, h('div', {
              className: 'wf-tl-canvas',
              style: { width: `${Math.max(duration * zoom + 120, 600)}px` },
            }, [
              h('div', { className: 'wf-ruler' }, tickMarks({ duration, zoom, fps: timeline.fps })),
              h('div', { className: 'wf-playhead', style: { left: `${playhead * zoom}px` } }),
              ...TRACKS.map((row) => h('div', {
                key: row.id,
                className: `wf-track${dragOver ? ' over' : ''}`,
                onDragOver: (event) => { event.preventDefault(); setDragOver(true) },
                onDragLeave: () => setDragOver(false),
                onDrop: (event) => handleTrackDrop(event, row.id),
              }, (timeline.tracks[row.id] || []).map((clip) => h('div', {
                key: clip.id,
                className: `wf-clip ${clipColor(row.id)}${selectedClip && selectedClip.id === clip.id ? ' on' : ''}`,
                style: { left: `${clip.start * zoom}px`, width: `${Math.max(clip.length * zoom, 22)}px` },
                title: `${clip.name}\n${clip.start.toFixed(1)}s 起 · ${clip.length.toFixed(1)}s`,
                draggable: true,
                onDragStart: (event) => {
                  event.stopPropagation()
                  event.dataTransfer.setData('application/x-wanfeng-asset', clip.rel)
                },
                onMouseDown: (event) => handleClipDrag(event, row.id, clip),
              }, [
                clip.kind === 'image'
                  ? h('img', { key: 'thumb', className: 'wf-clip-thumb', src: mediaUrl(clip.rel), loading: 'lazy', alt: '' })
                  : h('span', { key: 'icon', style: { fontSize: '13px', opacity: .85 } }, clip.kind === 'video' ? '▶' : clip.kind === 'text' ? 'T' : '♪'),
                h('span', { key: 'name', className: 'wf-clip-name' }, clip.name),
                h('span', {
                  key: 'x',
                  className: 'wf-clip-x',
                  onClick: (event) => { event.stopPropagation(); removeClip(row.id, clip.id) },
                }, '×'),
              ])))),
            ])),
          ]),
        ]),

        toast ? h('div', { className: `wf-toast${toast.includes('失败') || toast.includes('错误') ? ' err' : ''}` }, toast) : null,
      ])
    }

    /* ------------------------------------------------------------------ */
    /* 子组件（普通函数返回 vnode，避免额外 hooks）                          */
    /* ------------------------------------------------------------------ */

    function field(label, input) {
      return h('label', { className: 'wf-field', key: label }, [h('span', { key: 'l' }, label), input])
    }

    function tickMarks({ duration, zoom, fps }) {
      const marks = []
      const step = zoom >= 90 ? 1 : zoom >= 40 ? 2 : 5
      const total = Math.max(duration, 10)
      for (let t = 0; t <= total; t += step) {
        marks.push(h('div', { key: `t${t}`, className: 'wf-tick', style: { left: `${t * zoom}px` } }, h('span', {}, `${t}s`)))
      }
      if (fps && zoom >= 120) {
        for (let t = 0; t <= total; t += 0.5) marks.push(h('div', { key: `h${t}`, className: 'wf-tick', style: { left: `${t * zoom}px`, opacity: .35 } }))
      }
      return marks
    }

    function assetGrid({ assets, works, workFilter, setWorkFilter, selected, selectAsset, onDropFiles, pendingAssets }) {
      const items = assets.items || []
      if (!items.length) {
        return h('div', { className: 'wf-empty', style: { flex: 1 } }, [
          h('b', { key: 'b' }, pendingAssets ? '正在上传…' : '没有匹配的素材'),
          h('div', { key: 'd' }, workFilter ? `「${workFilter}」里还没有可显示的素材。` : '换一个筛选条件，或把文件拖到这里上传。'),
        ])
      }
      return h('div', { className: 'wf-grid' }, [
        ...items.map((item) => h('div', {
          key: item.rel,
          className: `wf-card${selected && selected.rel === item.rel ? ' on' : ''}`,
          onClick: () => selectAsset(item),
          draggable: true,
          onDragStart: (event) => {
            event.dataTransfer.setData('application/x-wanfeng-asset', item.rel)
            event.dataTransfer.setData('text/plain', item.rel)
          },
          title: item.rel,
        }, [
          item.kind === 'video'
            ? h('video', { key: 'v', className: 'wf-card-thumb-video', src: item.url, preload: 'metadata', muted: true })
            : item.kind === 'audio'
              ? h('div', { key: 'a', className: 'wf-card-thumb', style: { display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '22px', color: '#5d6775' } }, '♪')
              : h('img', { key: 'i', className: 'wf-card-thumb', src: item.url, loading: 'lazy', alt: '' }),
          h('span', { key: 'k', className: 'wf-card-kind' }, item.kind === 'image' ? 'IMG' : item.kind === 'video' ? 'VID' : 'AUD'),
          h('div', { key: 'm', className: 'wf-card-meta' }, [
            h('div', { key: 'n', className: 'wf-card-name' }, item.name),
            h('div', { key: 's' }, `${fmtSize(item.size)} · ${fmtDate(item.mtime)}`),
          ]),
        ])),
        h('div', { key: 'more', className: 'wf-grid-more' }, assets.total > items.length
          ? `共 ${assets.total} 个，先显示前 ${items.length} 个（用搜索或作品筛选缩小范围）`
          : `共 ${items.length} 个`),
      ])
    }

    function jobRow({ job, notify, killJob }) {
      const statusText = { running: '运行中', done: '完成', failed: '失败', killed: '已停止' }
      return h('div', { className: 'wf-job', key: job.id }, [
        h('div', { className: 'wf-job-head' }, [
          h('span', { className: `wf-dot ${job.status}` }),
          h('span', { className: 'wf-job-title', title: job.script }, job.script.split('/').pop()),
          h('span', { className: 'wf-badge' }, statusText[job.status] || job.status),
          job.status === 'running'
            ? h('button', { className: 'wf-btn wf-btn-sm wf-btn-danger', onClick: () => killJob(job.id) }, '停止')
            : null,
        ]),
        h('div', { className: 'wf-job-head', style: { paddingTop: 0, color: 'var(--dsw-alias-label-secondary,#8f97a5)', fontSize: '10.5px' } }, [
          h('span', {}, `退出码 ${job.exitCode ?? '—'} · ${fmtDate(job.startedAt)}`),
        ]),
        h('pre', { className: 'wf-job-log' }, job.tail || '（等待输出…）'),
      ])
    }

    /* ------------------------------------------------------------------ */
    /* 插件入口                                                            */
    /* ------------------------------------------------------------------ */

    return {
      isPlugin: true,
      inject: ['slots'],
      apply(ctx) {
        ensureCss()
        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
          name: 'sidebar.panellist',
          id: PANEL,
          order: 30,
          label: () => LABEL,
        }, StudioIcon))
        ctx.slots.inject('main', () => ctx.slots.register({
          name: 'main',
          key: PANEL,
        }, StudioPanel))
      },
    }
  },
})
