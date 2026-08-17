#!/usr/bin/env node
/**
 * First-party MCP stdio server: DNS resolution on node:dns.
 * 能力点:域名解析与邮件域检查——查 A/AAAA/MX/TXT/NS/CNAME 记录,
 * 配合 email-send(先验 MX)、http-request(连通性诊断)使用。
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { promises as dns } from 'node:dns';

const server = new McpServer({ name: 'dns-lookup', version: '0.0.1' });

/** 粗校验域名形状,把明显不是域名的输入(URL、空串)在发查询前挡下。 */
const DOMAIN_RE = /^(?=.{1,253}$)([a-z0-9¡-￿]([a-z0-9¡-￿-]{0,61}[a-z0-9¡-￿])?\.)+[a-z¡-￿]{2,}$/i;

server.registerTool('resolve-domain', {
  description:
    '解析域名的 DNS 记录。type 支持 A/AAAA/MX/TXT/NS/CNAME;返回记录列表 JSON。'
    + '域名不存在或该类型无记录时返回结构化说明(不是硬错误);输入不是域名(带协议/路径)才报错。',
  inputSchema: {
    domain: z.string().describe('裸域名,如 example.com(不要带 http:// 或路径)'),
    type: z.enum(['A', 'AAAA', 'MX', 'TXT', 'NS', 'CNAME']).optional().describe('默认 A'),
  },
}, async ({ domain, type }) => {
  const d = domain.trim().replace(/\.$/, '');
  if (!DOMAIN_RE.test(d)) {
    return { isError: true, content: [{ type: 'text', text: `resolve-domain: "${domain}" 不是合法裸域名(去掉协议与路径)` }] };
  }
  const t = type ?? 'A';
  try {
    const records = await dns.resolve(d, t);
    return { content: [{ type: 'text', text: JSON.stringify({ domain: d, type: t, records }, null, 1) }] };
  } catch (error) {
    if (error.code === 'ENOTFOUND' || error.code === 'ENODATA') {
      return { content: [{ type: 'text', text: JSON.stringify({ domain: d, type: t, records: [], note: error.code === 'ENOTFOUND' ? '域名不存在' : '该类型无记录' }) }] };
    }
    return { isError: true, content: [{ type: 'text', text: `resolve-domain: 查询失败(${error.code ?? error.message})` }] };
  }
});

server.registerTool('reverse-lookup', {
  description: 'IP 反查主机名(PTR 记录)。查不到返回空列表说明,IP 格式非法报错。',
  inputSchema: {
    ip: z.string().describe('IPv4 或 IPv6 地址'),
  },
}, async ({ ip }) => {
  try {
    const hostnames = await dns.reverse(ip.trim());
    return { content: [{ type: 'text', text: JSON.stringify({ ip: ip.trim(), hostnames }) }] };
  } catch (error) {
    if (error.code === 'EINVAL') {
      return { isError: true, content: [{ type: 'text', text: `reverse-lookup: "${ip}" 不是合法 IP` }] };
    }
    return { content: [{ type: 'text', text: JSON.stringify({ ip: ip.trim(), hostnames: [], note: `无 PTR 记录(${error.code ?? 'unknown'})` }) }] };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
