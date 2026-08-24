// assembler-sdk.ts — scaffold 页面的固定通信层(骨架,禁改;与 _vendor 的 JS 版
// 同源同纪律:围栏出声/服务脸发现/失败必报)。页面的一切出网必须经此模块——
// lint 门机械查 src/pages/ 里的裸 fetch/WebSocket。
// 路由三档(PAGE-SPEC 同款词汇):
//   face   确定性流:sqliteFace().sql(...)   —— 零模型,毫秒级
//   wire   判断流:createClient().ask(...)   —— 真 agent 会话
//   ai-thin 薄判断:aiFace().complete(...) —— 一次补全,不开会话
import cfg from '../../app.config.json'

export const APP = cfg as { recipe: string; APP_NAME: string; PRESET_ID: string; WORKDIR: string }

// ── wire(会话面)────────────────────────────────────────────────────────────
export interface AskResult {
  reply: string
  fence: { ok: true; data: unknown } | { ok: false; reason: string }
}

export interface ClientHooks {
  onDelta?: (cumulative: string) => void
  onToolCall?: (name: string) => void
  onError?: (message: string) => void
}

export function extractFence(text: string): AskResult['fence'] {
  const fences = [...String(text ?? '').matchAll(/```json\s*([\s\S]*?)```/g)]
  if (fences.length === 0) return { ok: false, reason: '回复末尾没有 ```json 围栏(agent 未按页面契约输出)' }
  try {
    return { ok: true, data: JSON.parse(fences[fences.length - 1][1]) }
  } catch (e) {
    return { ok: false, reason: 'json 围栏解析失败:' + String((e as Error).message).slice(0, 120) }
  }
}

export function createClient(hooks: ClientHooks = {}) {
  let sessionId: string | null = null
  let ws: WebSocket | null = null
  let busy = false
  let replyBuf = ''
  let waiters: Array<(r: AskResult) => void> = []

  async function rpc(method: string, payload: unknown): Promise<any> {
    const res = await fetch('/api/' + method, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId: 'fe-' + Date.now() + '-' + Math.random().toString(36).slice(2), method, payload }),
    })
    const j = await res.json()
    if (!j.result || !j.result.ok) throw new Error(method + ' 失败:' + JSON.stringify(j.result?.error ?? j).slice(0, 200))
    return j.result.value
  }

  function textOf(e: any): string {
    const c = e?.data?.message?.content
    if (typeof c === 'string') return c
    if (Array.isArray(c)) return c.map((b: any) => (b && b.type === 'text' ? b.text : '')).join('')
    return ''
  }

  function handle(e: any): void {
    if (e.type === 'assistant/message') {
      const t = textOf(e)
      if (t) { replyBuf += (replyBuf === '' ? '' : '\n') + t; hooks.onDelta?.(replyBuf) }
    } else if (e.type === 'tool/call') {
      hooks.onToolCall?.(String(e?.data?.name ?? '?').replace(/^mcp__/, '').replace(/__/, ' · '))
    } else if (e.type === 'turn/end') {
      busy = false
      const w = waiters; waiters = []
      const out: AskResult = { reply: replyBuf, fence: extractFence(replyBuf) }
      w.forEach((fn) => fn(out))
    }
  }

  function openWs(): void {
    ws = new WebSocket(location.origin.replace(/^http/, 'ws') + '/api/events.mux')
    ws.onmessage = (m) => {
      let f: any
      try { f = JSON.parse(String(m.data)) } catch { return }
      const p = f.payload
      if (!p || p.type !== 'session/event' || p.sessionId !== sessionId) return
      handle(p.event)
    }
    ws.onclose = () => { if (sessionId) setTimeout(openWs, 1500) }
  }

  async function ensureSession(): Promise<void> {
    if (sessionId) return
    const v = await rpc('session.create', { cwd: APP.WORKDIR, agentPreset: APP.PRESET_ID })
    sessionId = v.sessionId
    openWs()
    await new Promise<void>((r) => {
      const t = setInterval(() => { if (ws && ws.readyState === 1) { clearInterval(t); r() } }, 50)
    })
  }

  async function ask(text: string): Promise<AskResult> {
    if (busy) throw new Error('上一轮还在进行')
    replyBuf = ''; busy = true
    try {
      await ensureSession()
      await rpc('session.prompt', { sessionId, mode: 'queue', content: [{ type: 'text', text }] })
    } catch (err) {
      busy = false
      hooks.onError?.(String((err as Error)?.message ?? err))
      throw err
    }
    return new Promise<AskResult>((resolve) => { waiters.push(resolve) })
  }

  return { ask, rpc, get busy() { return busy } }
}

// ── 服务脸(确定性流)────────────────────────────────────────────────────────
export interface SqliteFace {
  sql: (sql: string, params?: unknown[]) => Promise<{ rows?: Array<Record<string, unknown>>; changes?: number; lastInsertRowid?: number }>
  schema: () => Promise<{ tables: Array<{ name: string; columns: Array<{ name: string; type: string; notnull: boolean; pk: boolean }> }> }>
}

let svcCache: Promise<any> | null = null

export function discoverServices(): Promise<any> {
  svcCache ??= fetch('/assembler/ui/' + encodeURIComponent(APP.PRESET_ID) + '/.service')
    .then((r) => (r.ok ? r.json() : null))
    .catch(() => null)
  return svcCache
}

export async function sqliteFace(): Promise<SqliteFace | null> {
  const svc = await discoverServices()
  if (!svc?.sqlite) return null
  const base: string = svc.sqlite.url
  const token: string = svc.sqlite.token
  const call = async (path: string, init: RequestInit = {}) => {
    const r = await fetch(base + path, { ...init, headers: { 'X-Service-Token': token, ...(init.headers ?? {}) } })
    const j = await r.json()
    if (j.error) throw new Error(j.error)
    return j
  }
  return {
    sql: (sql, params) => call('/sql', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sql, params: params ?? [] }) }),
    schema: () => call('/schema'),
  }
}

/** ai 服务脸(ai-thin 路由):一次补全,不开会话——薄判断的正确档位。 */
export interface AiFace {
  complete: (req: { prompt: string; system?: string; model?: string; maxTokens?: number }) => Promise<{ model: string; text: string; usage?: { prompt: number; completion: number } }>
}

export async function aiFace(): Promise<AiFace | null> {
  const svc = await discoverServices()
  if (!svc?.ai) return null
  const base: string = svc.ai.url
  const token: string = svc.ai.token
  return {
    complete: async (req) => {
      const r = await fetch(base + '/complete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Service-Token': token },
        body: JSON.stringify(req),
      })
      const j = await r.json()
      if (j.error) throw new Error(j.error)
      return j
    },
  }
}

/** 公共文件通道:大字节直传/取回,不过模型(页面喂文件的正确姿势)。 */
export interface FilesFace {
  upload: (name: string, body: Blob | ArrayBuffer | string) => Promise<{ ok: boolean; name: string; path: string; bytes: number }>
  list: () => Promise<{ files: Array<{ name: string; bytes: number; modifiedAt: string }>; dir: string }>
  fileUrl: (name: string) => string
}

export async function filesFace(): Promise<FilesFace | null> {
  const svc = await discoverServices()
  if (!svc?.files) return null
  const base: string = svc.files.url
  const token: string = svc.files.token
  const call = async (path: string, init: RequestInit = {}) => {
    const r = await fetch(base + path, { ...init, headers: { 'X-Service-Token': token, ...(init.headers ?? {}) } })
    const j = await r.json()
    if (j.error) throw new Error(j.error)
    return j
  }
  return {
    upload: (name, body) => call('/upload/' + encodeURIComponent(name), { method: 'POST', body: body as BodyInit }),
    list: () => call('/list'),
    fileUrl: (name) => base + '/file/' + encodeURIComponent(name),
  }
}

// ── 通用原子 ────────────────────────────────────────────────────────────────
/** 回车触发(IME 守卫内置:选字确认回车不触发)。 */
export function bindEnter(el: HTMLElement, fn: () => void): void {
  el.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.isComposing || e.keyCode === 229) return
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); fn() }
  })
}
