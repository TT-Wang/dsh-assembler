/**
 * @dsh-index/email-send — MCP stdio server wrapping nodemailer@6.9.13.
 *
 * Tools (mcp__email-send__<tool>):
 *   - send-email            : 发送邮件（SMTP / jsonTransport / streamTransport）
 *   - verify-smtp-config    : 验证 SMTP 服务器连通性与认证
 *   - parse-email-addresses : 解析 RFC 5322 地址列表字符串
 *   - create-test-account   : 在 Ethereal 创建临时测试邮箱（需外网）
 *
 * 只读使用上游库，不修改上游代码。实现为 ESM，stdio 通信。
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import nodemailer from 'nodemailer';
import addressparser from 'nodemailer/lib/addressparser/index.js';

const server = new McpServer({
  name: 'email-send',
  version: '0.0.1'
});

/** 把用户可读的异常转成 MCP 文本错误内容 */
function errContent(label, err) {
  const msg = err && err.message ? err.message : String(err);
  return { content: [{ type: 'text', text: `${label}: ${msg}` }], isError: true };
}

/** 校验 sendMail 所需的最小业务字段 */
function requireMailFields(args) {
  if (!args.from || (typeof args.from === 'string' && !args.from.trim())) {
    return '缺少必填参数 from（发件人地址）';
  }
  if (!args.to || (Array.isArray(args.to) && args.to.length === 0)) {
    return '缺少必填参数 to（收件人地址）';
  }
  if (Array.isArray(args.to) && args.to.some((t) => !t || !t.trim())) {
    return '参数 to 中含有空地址';
  }
  return null;
}

/** 根据参数构造 nodemailer transporter（不联网，仅构造） */
function buildTransporter(args) {
  const mode = args.transport ?? 'smtp';
  if (mode === 'json') {
    return nodemailer.createTransport({ jsonTransport: true });
  }
  if (mode === 'stream') {
    return nodemailer.createTransport({ streamTransport: true, buffer: true });
  }
  if (mode === 'smtp') {
    if (!args.host || !String(args.host).trim()) {
      throw new Error('transport=smtp 时必须提供 host（SMTP 服务器地址）');
    }
    const port = args.port ?? (args.secure ? 465 : 587);
    const options = {
      host: args.host,
      port,
      secure: !!args.secure
    };
    if (args.authUser) {
      options.auth = { user: args.authUser, pass: args.authPass ?? '' };
    }
    if (typeof args.tlsRejectUnauthorized === 'boolean') {
      options.tls = { rejectUnauthorized: args.tlsRejectUnauthorized };
    }
    if (args.connectionTimeout) {
      options.connectionTimeout = args.connectionTimeout;
    }
    return nodemailer.createTransport(options);
  }
  throw new Error(`不支持的 transport 类型: ${mode}（可选 smtp | json | stream）`);
}

// ---------------------------------------------------------------------------
// 工具 1: send-email
// ---------------------------------------------------------------------------
server.tool(
  'send-email',
  '发送一封邮件。transport=smtp（默认）时通过真实 SMTP 服务器发送，需要 host/port/authUser/authPass；' +
    'transport=json 时不连接任何服务器，直接返回 RFC822 消息体与 messageId（适合开发/冒烟）；' +
    'transport=stream 时返回渲染后的消息 buffer（同样无需服务器）。返回 messageId、envelope、accepted/rejected 等信息。',
  {
    transport: z
      .enum(['smtp', 'json', 'stream'])
      .optional()
      .describe('传输方式：smtp（默认，真实发送）/ json（不联网，返回消息体）/ stream（不联网，返回 buffer）'),
    host: z.string().optional().describe('SMTP 服务器主机名，transport=smtp 时必填，如 smtp.gmail.com'),
    port: z.number().int().positive().optional().describe('SMTP 端口，默认 465(secure) 或 587'),
    secure: z.boolean().optional().describe('是否使用 SSL/TLS 直连（端口 465 通常为 true）'),
    authUser: z.string().optional().describe('SMTP 认证用户名（邮箱地址）'),
    authPass: z.string().optional().describe('SMTP 认证密码或应用专用密码'),
    tlsRejectUnauthorized: z
      .boolean()
      .optional()
      .describe('是否校验证书，内网自签证书环境可设为 false'),
    from: z.string().describe('发件人，如 "Sender Name <sender@example.com>" 或纯地址'),
    to: z.union([z.string(), z.array(z.string())]).describe('收件人，单个地址字符串或地址数组'),
    cc: z.union([z.string(), z.array(z.string())]).optional().describe('抄送地址'),
    bcc: z.union([z.string(), z.array(z.string())]).optional().describe('密送地址'),
    replyTo: z.string().optional().describe('回复地址'),
    subject: z.string().optional().describe('邮件主题'),
    text: z.string().optional().describe('纯文本正文'),
    html: z.string().optional().describe('HTML 正文'),
    attachments: z
      .array(
        z.object({
          filename: z.string().optional().describe('附件文件名'),
          content: z.string().optional().describe('附件文本内容'),
          path: z.string().optional().describe('附件本地文件路径'),
          contentType: z.string().optional().describe('MIME 类型')
        })
      )
      .optional()
      .describe('附件列表，每项提供 filename + content 或 filename + path')
  },
  async (args) => {
    try {
      const missing = requireMailFields(args);
      if (missing) {
        return { content: [{ type: 'text', text: `参数校验失败: ${missing}` }], isError: true };
      }
      const transporter = buildTransporter(args);
      const mailOptions = {
        from: args.from,
        to: args.to,
        cc: args.cc,
        bcc: args.bcc,
        replyTo: args.replyTo,
        subject: args.subject,
        text: args.text,
        html: args.html,
        attachments: args.attachments
      };
      const info = await transporter.sendMail(mailOptions);
      // 避免 SMTP 空闲连接挂住进程
      try {
        transporter.close();
      } catch (e) {
        /* 忽略关闭错误 */
      }
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                ok: true,
                messageId: info.messageId,
                envelope: info.envelope || null,
                accepted: info.accepted || [],
                rejected: info.rejected || [],
                response: info.response || null,
                raw: args.transport === 'json' && info.message ? String(info.message) : undefined
              },
              null,
              2
            )
          }
        ]
      };
    } catch (err) {
      return errContent('send-email 失败', err);
    }
  }
);

// ---------------------------------------------------------------------------
// 工具 2: verify-smtp-config
// ---------------------------------------------------------------------------
server.tool(
  'verify-smtp-config',
  '验证 SMTP 服务器是否可连接、认证是否通过（nodemailer transporter.verify()）。' +
    '用于排查 host/port/secure/auth 配置是否正确，返回连接结果或具体错误信息。',
  {
    host: z.string().describe('SMTP 服务器主机名，如 smtp.gmail.com'),
    port: z.number().int().positive().optional().describe('SMTP 端口，默认 465(secure) 或 587'),
    secure: z.boolean().optional().describe('是否使用 SSL/TLS 直连'),
    authUser: z.string().optional().describe('SMTP 认证用户名'),
    authPass: z.string().optional().describe('SMTP 认证密码'),
    tlsRejectUnauthorized: z.boolean().optional().describe('是否校验证书'),
    connectionTimeout: z.number().int().positive().optional().describe('连接超时毫秒数')
  },
  async (args) => {
    try {
      const transporter = buildTransporter({ ...args, transport: 'smtp' });
      await transporter.verify();
      try {
        transporter.close();
      } catch (e) {
        /* ignore */
      }
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              { ok: true, message: `SMTP 连接验证通过: ${args.host}:${args.port ?? (args.secure ? 465 : 587)}` },
              null,
              2
            )
          }
        ]
      };
    } catch (err) {
      return errContent('SMTP 验证失败', err);
    }
  }
);

// ---------------------------------------------------------------------------
// 工具 3: parse-email-addresses
// ---------------------------------------------------------------------------
server.tool(
  'parse-email-addresses',
  '解析 RFC 5322 邮件地址列表字符串（nodemailer 内置 addressparser）。' +
    '支持 "Name <addr@example.com>"、"addr@example.com"、逗号分隔列表与分组语法，' +
    '返回结构化地址对象数组（name/address/group 等字段）。纯本地解析，无网络依赖。',
  {
    addresses: z.string().describe('地址列表字符串，如 "John Doe <john@example.com>, jane@example.com"'),
    flatten: z
      .boolean()
      .optional()
      .describe('是否展开分组为扁平地址数组（默认 false，保留 group 结构）')
  },
  async (args) => {
    try {
      const parsed = addressparser(args.addresses, { flatten: !!args.flatten });
      return {
        content: [{ type: 'text', text: JSON.stringify(parsed, null, 2) }]
      };
    } catch (err) {
      return errContent('解析地址失败', err);
    }
  }
);

// ---------------------------------------------------------------------------
// 工具 4: create-test-account
// ---------------------------------------------------------------------------
server.tool(
  'create-test-account',
  '在 Ethereal（ethereal.email）创建一个临时测试邮箱账户（nodemailer.createTestAccount），' +
    '返回可直接用于 send-email 的 SMTP 配置（host/port/user/pass）。需要外网访问 api.nodemailer.com；' +
    '也可与 getTestMessageUrl 配合查看发出的邮件。',
  {
    apiUrl: z
      .string()
      .optional()
      .describe('Ethereal API 地址，默认 https://api.nodemailer.com，一般无需指定')
  },
  async (args) => {
    try {
      const account = await nodemailer.createTestAccount(args.apiUrl || undefined);
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                ok: true,
                user: account.user,
                pass: account.pass,
                smtp: account.smtp || null,
                imap: account.imap || null,
                provider: account.provider || null
              },
              null,
              2
            )
          }
        ]
      };
    } catch (err) {
      return errContent('创建测试账户失败（需外网访问 api.nodemailer.com）', err);
    }
  }
);

// ---------------------------------------------------------------------------
const transport = new StdioServerTransport();
await server.connect(transport);
