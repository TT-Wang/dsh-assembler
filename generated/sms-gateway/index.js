/**
 * @dsh-index/sms-gateway — MCP stdio server for sending SMS via cloud gateways.
 *
 * Tools:
 *   - sms-send            : 通过所选网关给手机号发送短信(提醒/告警/验证码)
 *   - sms-delivery-status : 查询某号码的短信发送状态(回执)
 *   - sms-provider-info   : 各网关凭证配置状态(掩码展示,不含明文密钥)
 *
 * 支持的网关:
 *   - aliyun   : 阿里云短信(Dysmsapi 2017-05-25, RPC 风格 HMAC-SHA1 签名)
 *   - tencent  : 腾讯云短信(sms 2021-01-11, TC3-HMAC-SHA256 签名)
 *   - generic  : 通用 HTTP 网关(向 SMS_GENERIC_ENDPOINT POST JSON {to, content})
 *   - mock     : 本地模拟网关(不发起任何网络请求,用于联调/测试/冒烟)
 *
 * 凭证铁律:所有凭证只从本进程环境变量读取(host 或 .env 提供),绝不写进代码、
 * 绝不接受工具参数传入。未配置凭证时 listTools 照常成功;调用返回 isError
 * 并说明缺哪个变量、去哪配——不崩溃、不静默假装成功。
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import crypto from 'node:crypto'

const UA = 'dsh-assembler/0.1 (+https://github.com/TT-Wang/dsh-assembler)'
const TIMEOUT_MS = 15000
const ALIYUN_ENDPOINT = 'https://dysmsapi.aliyuncs.com/'
const TENCENT_ENDPOINT = 'https://sms.tencentcloudapi.com/'
const PROVIDERS = ['auto', 'aliyun', 'tencent', 'generic', 'mock']

const ok = (text) => ({ content: [{ type: 'text', text }] })
const fail = (text) => ({ isError: true, content: [{ type: 'text', text }] })
const errText = (e) => (e instanceof Error ? e.message : String(e))

/** JSON 文本结果,裁剪成 agent 用得上的字段。 */
const jsonOut = (obj) => ok(JSON.stringify(obj, null, 2))

// ── 传输层:超时 + 瞬时抖动原路重试一次 + 仍失败显式绕开代理 ──────────────
// 参照 generated/sec-filings/index.js 的 fetchWithProxyFallback:undici 按
// dispatcher 读 NODE_USE_ENV_PROXY,新建 Agent 即直连。HTTP 错误码不重试
// (4xx/5xx 是答复,不是断路)。
async function httpPost(url, { body, headers = {}, what }) {
  const init = {
    method: 'POST',
    headers: { 'User-Agent': UA, ...headers },
    body,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  }
  let res
  try {
    res = await fetch(url, init)
  } catch (err) {
    // 瞬时抖动(socket 重置 / DNS / TLS 打嗝):原路重试一次(约 400ms 退避)
    await new Promise((r) => setTimeout(r, 400))
    try {
      res = await fetch(url, init)
    } catch (err2) {
      const proxied = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy
      if (!proxied) return { error: `${what} 网络请求失败:${errText(err2)}` }
      try {
        const { Agent } = await import('undici')
        res = await fetch(url, { ...init, dispatcher: new Agent() })
      } catch (err3) {
        return { error: `${what} 网络请求失败(直连也失败):${errText(err3)}` }
      }
    }
  }
  return { res }
}

// ── 阿里云短信:RPC 风格签名(HMAC-SHA1)────────────────────────────────────
// https://help.aliyun.com/zh/sms/developer-reference/api-dysmsapi-2017-05-25-sendsms
const aliEncode = (s) =>
  encodeURIComponent(String(s)).replace(/\+/g, '%20').replace(/\*/g, '%2A').replace(/%7E/g, '~')

function aliyunSignature(secret, params) {
  const keys = Object.keys(params).sort()
  const canonical = keys.map((k) => `${aliEncode(k)}=${aliEncode(params[k])}`).join('&')
  const stringToSign = `POST&%2F&${aliEncode(canonical)}`
  const sig = crypto.createHmac('sha1', `${secret}&`).update(stringToSign, 'utf8').digest('base64')
  return { canonical, sig }
}

function aliyunCommon() {
  return {
    Format: 'JSON',
    SignatureMethod: 'HMAC-SHA1',
    SignatureNonce: crypto.randomUUID(),
    SignatureVersion: '1.0',
    Timestamp: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    RegionId: 'cn-hangzhou',
    Version: '2017-05-25',
  }
}

function aliyunMissing(env) {
  const need = ['SMS_ALIYUN_ACCESS_KEY_ID', 'SMS_ALIYUN_ACCESS_KEY_SECRET', 'SMS_ALIYUN_SIGN_NAME', 'SMS_ALIYUN_TEMPLATE_CODE']
  return need.filter((k) => !env[k])
}

/** 阿里云发送(模板短信:正文落入 SMS_ALIYUN_TEMPLATE_PARAM 指定的模板参数,默认 content)。 */
async function aliyunSendSms(env, to, content, templateParam) {
  const missing = aliyunMissing(env)
  if (missing.length > 0) {
    return { error: `阿里云短信未配置凭证,缺:${missing.join(', ')}——请在 host 环境变量或 .env 中配置后再试(可先用 provider=mock 联调)。` }
  }
  const paramName = env.SMS_ALIYUN_TEMPLATE_PARAM || 'content'
  const params = {
    ...aliyunCommon(),
    AccessKeyId: env.SMS_ALIYUN_ACCESS_KEY_ID,
    Action: 'SendSms',
    PhoneNumbers: to,
    SignName: env.SMS_ALIYUN_SIGN_NAME,
    TemplateCode: env.SMS_ALIYUN_TEMPLATE_CODE,
    TemplateParam: JSON.stringify(templateParam ?? { [paramName]: content }),
  }
  const { canonical, sig } = aliyunSignature(env.SMS_ALIYUN_ACCESS_KEY_SECRET, params)
  const body = `${canonical}&Signature=${aliEncode(sig)}`
  const { res, error } = await httpPost(ALIYUN_ENDPOINT, {
    body,
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    what: '阿里云短信 SendSms',
  })
  if (error) return { error }
  const data = await res.json().catch(() => null)
  if (!data) return { error: `阿里云短信返回无法解析的响应(HTTP ${res.status})。` }
  if (data.Code !== 'OK') {
    return { error: `阿里云短信发送失败:Code=${data.Code} Message=${data.Message ?? ''}(详情:https://help.aliyun.com/zh/sms/developer-reference/api-error-codes)`, raw: data }
  }
  return { messageId: data.BizId || null, status: 'accepted', sentAt: new Date().toISOString(), gateway: 'aliyun', raw: { Code: data.Code, Message: data.Message } }
}

/** 阿里云发送状态查询(QuerySmsDetail,按 号码+日期 查回执)。 */
async function aliyunQueryStatus(env, phone, sendDate) {
  const need = ['SMS_ALIYUN_ACCESS_KEY_ID', 'SMS_ALIYUN_ACCESS_KEY_SECRET']
  const missing = need.filter((k) => !env[k])
  if (missing.length > 0) {
    return { error: `阿里云短信未配置凭证,缺:${missing.join(', ')}。` }
  }
  const params = {
    ...aliyunCommon(),
    AccessKeyId: env.SMS_ALIYUN_ACCESS_KEY_ID,
    Action: 'QuerySmsDetail',
    PhoneNumber: phone,
    SendDate: sendDate,
    PageSize: '50',
    CurrentPage: '1',
  }
  const { canonical, sig } = aliyunSignature(env.SMS_ALIYUN_ACCESS_KEY_SECRET, params)
  const body = `${canonical}&Signature=${aliEncode(sig)}`
  const { res, error } = await httpPost(ALIYUN_ENDPOINT, {
    body,
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    what: '阿里云短信 QuerySmsDetail',
  })
  if (error) return { error }
  const data = await res.json().catch(() => null)
  if (!data) return { error: `阿里云短信返回无法解析的响应(HTTP ${res.status})。` }
  if (data.Code !== 'OK') {
    return { error: `阿里云状态查询失败:Code=${data.Code} Message=${data.Message ?? ''}`, raw: data }
  }
  const list = data.SmsSendDetailDTOs?.SmsSendDetailDTO ?? []
  return {
    gateway: 'aliyun',
    total: list.length,
    records: list.map((d) => ({
      phone: d.PhoneNum,
      sendStatus: d.SendStatus, // 1=等待回执 2=发送失败 3=发送成功
      sendStatusText: { 1: '等待回执', 2: '发送失败', 3: '发送成功' }[d.SendStatus] ?? String(d.SendStatus),
      errCode: d.ErrCode ?? '',
      content: d.Content ?? '',
      sendDate: d.SendDate ?? '',
      receiveDate: d.ReceiveDate ?? '',
    })),
  }
}

// ── 腾讯云短信:TC3-HMAC-SHA256 签名 ──────────────────────────────────────
// https://cloud.tencent.com/document/product/382/55981
function tc3Sign(secretKey, { action, payload, timestamp }) {
  const service = 'sms'
  const date = new Date(timestamp * 1000).toISOString().slice(0, 10) // UTC YYYY-MM-DD
  const host = 'sms.tencentcloudapi.com'
  const contentType = 'application/json; charset=utf-8'
  const canonicalHeaders = `content-type:${contentType}\nhost:${host}\nx-tc-action:${action.toLowerCase()}\n`
  const signedHeaders = 'content-type;host;x-tc-action'
  const hashedPayload = crypto.createHash('sha256').update(payload).digest('hex')
  const canonicalRequest = `POST\n/\n\n${canonicalHeaders}\n${signedHeaders}\n${hashedPayload}`
  const credentialScope = `${date}/${service}/tc3_request`
  const hashedCanonical = crypto.createHash('sha256').update(canonicalRequest).digest('hex')
  const stringToSign = `TC3-HMAC-SHA256\n${timestamp}\n${credentialScope}\n${hashedCanonical}`
  const kDate = crypto.createHmac('sha256', `TC3${secretKey}`).update(date).digest()
  const kService = crypto.createHmac('sha256', kDate).update(service).digest()
  const kSigning = crypto.createHmac('sha256', kService).update('tc3_request').digest()
  const signature = crypto.createHmac('sha256', kSigning).update(stringToSign).digest('hex')
  return { authorization: `TC3-HMAC-SHA256 Credential=PLACEHOLDER/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`, date }
}

/** 腾讯云短信(手机号自动补 +86 国际区号)。 */
const tcPhone = (p) => (p.startsWith('+') ? p : `+86${p}`)

async function tencentPost(env, action, payload) {
  const need = ['SMS_TENCENT_SECRET_ID', 'SMS_TENCENT_SECRET_KEY']
  const missing = need.filter((k) => !env[k])
  if (missing.length > 0) {
    return { error: `腾讯云短信未配置凭证,缺:${missing.join(', ')}——请在 host 环境变量或 .env 中配置后再试(可先用 provider=mock 联调)。` }
  }
  const timestamp = Math.floor(Date.now() / 1000)
  const body = JSON.stringify(payload)
  const { authorization, date } = tc3Sign(env.SMS_TENCENT_SECRET_KEY, { action, payload: body, timestamp })
  const authorizationFinal = authorization.replace('Credential=PLACEHOLDER', `Credential=${env.SMS_TENCENT_SECRET_ID}`)
  const { res, error } = await httpPost(TENCENT_ENDPOINT, {
    body,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      Host: 'sms.tencentcloudapi.com',
      'X-TC-Action': action,
      'X-TC-Version': '2021-01-11',
      'X-TC-Timestamp': String(timestamp),
      'X-TC-Region': 'ap-guangzhou',
      Authorization: authorizationFinal,
    },
    what: `腾讯云短信 ${action}`,
  })
  if (error) return { error }
  const data = await res.json().catch(() => null)
  if (!data) return { error: `腾讯云短信返回无法解析的响应(HTTP ${res.status})。` }
  const resp = data.Response ?? {}
  if (resp.Error) {
    return { error: `腾讯云短信失败:Code=${resp.Error.Code} Message=${resp.Error.Message}(详情:https://cloud.tencent.com/document/product/382/3771)`, raw: resp.Error }
  }
  return { data: resp, date }
}

async function tencentSendSms(env, to, content, templateParam) {
  const need = ['SMS_TENCENT_SECRET_ID', 'SMS_TENCENT_SECRET_KEY', 'SMS_TENCENT_SDKAPPID', 'SMS_TENCENT_SIGN_NAME', 'SMS_TENCENT_TEMPLATE_ID']
  const missing = need.filter((k) => !env[k])
  if (missing.length > 0) {
    return { error: `腾讯云短信未配置凭证,缺:${missing.join(', ')}——请在 host 环境变量或 .env 中配置后再试(可先用 provider=mock 联调)。` }
  }
  const { data, error } = await tencentPost(env, 'SendSms', {
    PhoneNumberSet: [tcPhone(to)],
    SmsSdkAppId: env.SMS_TENCENT_SDKAPPID,
    SignName: env.SMS_TENCENT_SIGN_NAME,
    TemplateId: env.SMS_TENCENT_TEMPLATE_ID,
    TemplateParamSet: templateParam ? Object.values(templateParam) : [content],
  })
  if (error) return { error }
  const s = data.SendSmsStatusSet?.[0] ?? {}
  return {
    gateway: 'tencent',
    messageId: s.SerialNo || null,
    status: s.Code === 'Ok' ? 'accepted' : 'failed',
    statusDetail: `${s.Code ?? ''} ${s.Message ?? ''}`.trim(),
    fee: s.Fee ?? 0,
    sentAt: new Date().toISOString(),
  }
}

async function tencentQueryStatus(env, phone, sendTime) {
  const { data, error } = await tencentPost(env, 'DescribeSmsSendDetails', {
    PhoneNumber: tcPhone(phone),
    SendTime: sendTime,
    Offset: 0,
    Limit: 50,
  })
  if (error) return { error }
  const list = data.SmsSendDetails?.SmsSendDetailList ?? []
  return {
    gateway: 'tencent',
    total: list.length,
    records: list.map((d) => ({
      phone: d.PhoneNum ?? '',
      sendStatus: d.SendStatus, // 0=失败 1=成功(腾讯云 DescribeSmsSendDetails)
      sendStatusText: d.SendStatus === 1 ? '发送成功' : d.SendStatus === 0 ? '发送失败' : String(d.SendStatus),
      errCode: d.ErrCode ?? '',
      content: d.Content ?? '',
      sendTime: d.SendTime ?? '',
    })),
  }
}

// ── 通用 HTTP 网关:POST JSON {to, content} 到 SMS_GENERIC_ENDPOINT ────────
async function genericSend(env, to, content) {
  const endpoint = env.SMS_GENERIC_ENDPOINT
  if (!endpoint) {
    return { error: '通用 HTTP 网关未配置:SMS_GENERIC_ENDPOINT 环境变量未设置——请把它指向网关地址(如 https://gw.example.com/sms),或改用 provider=aliyun/tencent/mock。' }
  }
  const { res, error } = await httpPost(endpoint, {
    body: JSON.stringify({ to, content }),
    headers: { 'Content-Type': 'application/json' },
    what: '通用短信网关',
  })
  if (error) return { error }
  const raw = await res.text().catch(() => '')
  if (res.status < 200 || res.status >= 300) {
    return { error: `通用短信网关返回 HTTP ${res.status}:${raw.slice(0, 300)}` }
  }
  const parsed = (() => { try { return JSON.parse(raw) } catch { return null } })()
  return {
    gateway: 'generic',
    messageId: parsed?.MessageId ?? parsed?.messageId ?? `gen-${Date.now()}`,
    status: 'accepted',
    sentAt: new Date().toISOString(),
    gatewayResponse: parsed ?? raw.slice(0, 300),
  }
}

// ── mock:本地模拟网关(不发网络请求)───────────────────────────────────────
function mockSend(to, content) {
  return {
    gateway: 'mock',
    messageId: `mock-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    status: 'delivered',
    sentAt: new Date().toISOString(),
    note: '本地模拟网关,未发起真实网络请求(仅用于联调/测试)',
  }
}

function mockQueryStatus(phone) {
  return {
    gateway: 'mock',
    total: 1,
    records: [{
      phone,
      sendStatus: 3,
      sendStatusText: '发送成功',
      errCode: '',
      content: '(模拟回执)',
      sendDate: new Date().toISOString().slice(0, 10).replace(/-/g, ''),
    }],
  }
}

// ── 网关选择与凭证状态 ─────────────────────────────────────────────────────
function pickProvider(env, requested) {
  if (requested && requested !== 'auto') return requested
  if (env.SMS_ALIYUN_ACCESS_KEY_ID && env.SMS_ALIYUN_ACCESS_KEY_SECRET) return 'aliyun'
  if (env.SMS_TENCENT_SECRET_ID && env.SMS_TENCENT_SECRET_KEY) return 'tencent'
  if (env.SMS_GENERIC_ENDPOINT) return 'generic'
  return 'none'
}

const mask = (v) => (v && v.length > 8 ? `${v.slice(0, 4)}****${v.slice(-4)}` : v ? '(已设置)' : '')

const server = new McpServer({
  name: 'sms-gateway',
  version: '0.0.1',
  instructions:
    '短信发送网关:通过阿里云/腾讯云/通用 HTTP 网关给手机号发提醒短信,并支持查询发送回执。' +
    '凭证只从进程环境变量读取(阿里云:SMS_ALIYUN_ACCESS_KEY_ID/SECRET/SIGN_NAME/TEMPLATE_CODE;' +
    '腾讯云:SMS_TENCENT_SECRET_ID/SECRET_KEY/SDKAPPID/SIGN_NAME/TEMPLATE_ID;通用网关:SMS_GENERIC_ENDPOINT)。' +
    '未配置凭证时可用 provider=mock 联调。发送详情请由 agent 自己记入台账(如 sqlite send_log 表)。',
})

// ---------------------------------------------------------------------------
// Tool 1: sms-send
// ---------------------------------------------------------------------------
server.tool(
  'sms-send',
  '通过短信网关给指定手机号发送提醒短信。provider 可选 auto(自动选择已配置网关,优先级 阿里云>腾讯云>通用)/aliyun/tencent/generic/mock。' +
    '凭证一律从进程环境变量读取,未配置时返回可行动错误(列出缺哪些变量)。返回 messageId、status、网关回执与发送时间。',
  {
    to: z.string().min(1).describe('接收手机号(11 位或 +86 开头;腾讯云自动补 +86 国际区号)'),
    content: z.string().min(1).describe('短信正文(模板短信时作为模板参数内容填入)'),
    provider: z.enum(PROVIDERS).optional().describe('网关选择,默认 auto'),
    templateParam: z.record(z.string(), z.any()).optional().describe('模板参数对象(可选;不传时正文填入模板参数 content,可用 SMS_ALIYUN_TEMPLATE_PARAM 改参数名)'),
  },
  async ({ to, content, provider, templateParam }) => {
    try {
      const env = process.env
      const chosen = pickProvider(env, provider)
      if (chosen === 'none') {
        return fail('未配置任何短信网关凭证。请配置其一:阿里云(SMS_ALIYUN_ACCESS_KEY_ID+SECRET+SIGN_NAME+TEMPLATE_CODE)、腾讯云(SMS_TENCENT_SECRET_ID+SECRET_KEY+SDKAPPID+SIGN_NAME+TEMPLATE_ID)、通用网关(SMS_GENERIC_ENDPOINT);联调可显式用 provider=mock。')
      }
      let result
      if (chosen === 'mock') result = mockSend(to, content)
      else if (chosen === 'generic') result = await genericSend(env, to, content)
      else if (chosen === 'aliyun') result = await aliyunSendSms(env, to, content, templateParam)
      else if (chosen === 'tencent') result = await tencentSendSms(env, to, content, templateParam)
      else return fail(`未知 provider:${chosen}(可选 ${PROVIDERS.join('/')})`)
      if (result.error) return fail(result.error)
      return jsonOut({ ok: true, ...result })
    } catch (err) {
      return fail(`sms-send 失败:${errText(err)}`)
    }
  }
)

// ---------------------------------------------------------------------------
// Tool 2: sms-delivery-status
// ---------------------------------------------------------------------------
server.tool(
  'sms-delivery-status',
  '查询手机号在某日期的短信发送状态(回执)。阿里云按 sendDate(yyyyMMdd) 查,腾讯云按 sendTime(yyyy-MM-dd HH:mm:ss) 查;mock 返回模拟回执;' +
    '通用 HTTP 网关不提供回执查询。返回记录列表(状态/错误码/内容/时间)。',
  {
    phone: z.string().min(1).describe('要查询的接收手机号'),
    provider: z.enum(PROVIDERS).optional().describe('网关选择,默认 auto'),
    sendDate: z.string().regex(/^\d{8}$/, 'sendDate 须为 yyyyMMdd,如 20260822').optional().describe('阿里云查询日期(默认今天)'),
    sendTime: z.string().optional().describe('腾讯云查询时刻 yyyy-MM-dd HH:mm:ss(默认当前时刻)'),
  },
  async ({ phone, provider, sendDate, sendTime }) => {
    try {
      const env = process.env
      const chosen = pickProvider(env, provider)
      if (chosen === 'none') {
        return fail('未配置任何短信网关凭证(需阿里云或腾讯云凭证才能查询回执;联调可显式用 provider=mock)。')
      }
      let result
      if (chosen === 'mock') result = mockQueryStatus(phone)
      else if (chosen === 'aliyun') {
        const d = sendDate ?? new Date().toISOString().slice(0, 10).replace(/-/g, '')
        result = await aliyunQueryStatus(env, phone, d)
      } else if (chosen === 'tencent') {
        const t = sendTime ?? new Date().toISOString().slice(0, 19).replace('T', ' ')
        result = await tencentQueryStatus(env, phone, t)
      } else if (chosen === 'generic') {
        return fail('通用 HTTP 网关不提供发送回执查询——请直接向网关方查询,或配置阿里云/腾讯云凭证。')
      } else return fail(`未知 provider:${chosen}`)
      if (result.error) return fail(result.error)
      return jsonOut({ ok: true, ...result })
    } catch (err) {
      return fail(`sms-delivery-status 失败:${errText(err)}`)
    }
  }
)

// ---------------------------------------------------------------------------
// Tool 3: sms-provider-info
// ---------------------------------------------------------------------------
server.tool(
  'sms-provider-info',
  '报告各短信网关的凭证配置状态(只显示掩码,不含明文密钥):每个网关已配置/缺失的环境变量、当前 auto 会选中的网关、mock 可用性。发送前先调用它判断可用网关。',
  {},
  async () => {
    const env = process.env
    const info = {
      autoPick: pickProvider(env, 'auto'),
      aliyun: {
        configured: mask(env.SMS_ALIYUN_ACCESS_KEY_ID),
        missing: ['SMS_ALIYUN_ACCESS_KEY_ID', 'SMS_ALIYUN_ACCESS_KEY_SECRET', 'SMS_ALIYUN_SIGN_NAME', 'SMS_ALIYUN_TEMPLATE_CODE'].filter((k) => !env[k]),
      },
      tencent: {
        configured: mask(env.SMS_TENCENT_SECRET_ID),
        missing: ['SMS_TENCENT_SECRET_ID', 'SMS_TENCENT_SECRET_KEY', 'SMS_TENCENT_SDKAPPID', 'SMS_TENCENT_SIGN_NAME', 'SMS_TENCENT_TEMPLATE_ID'].filter((k) => !env[k]),
      },
      generic: env.SMS_GENERIC_ENDPOINT ? { endpoint: env.SMS_GENERIC_ENDPOINT } : { missing: ['SMS_GENERIC_ENDPOINT'] },
      mock: { alwaysAvailable: true, note: 'provider=mock 可随时联调,不发真实短信' },
    }
    return jsonOut(info)
  }
)

// ---------------------------------------------------------------------------
const transport = new StdioServerTransport()
await server.connect(transport)
