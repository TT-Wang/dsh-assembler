#!/usr/bin/env node
/**
 * MCP stdio server: IPv4/IPv6 地址解析与网段匹配,基于 ipaddr.js@2。
 * 能力点:解析地址(版本/规范形式/范围分类/IPv6 展开)、CIDR 网段匹配——
 * agent 排查网络配置、判断地址归属,一轮内完成。
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import ipaddr from 'ipaddr.js';

const server = new McpServer({ name: 'ip-utils', version: '0.0.1' });

const fail = (msg) => ({ isError: true, content: [{ type: 'text', text: msg }] });
const ok = (obj) => ({ content: [{ type: 'text', text: JSON.stringify(obj, null, 2) }] });

server.registerTool('parse-ip', {
  description:
    '解析 IPv4/IPv6 地址字符串,返回 JSON:版本(ipv4/ipv6)、规范形式、范围分类'
    + '(private/loopback/multicast/linkLocal/uniqueLocal/reserved 等,无特殊范围则 unicast)。'
    + 'IPv4 附八位组数组;IPv6 附全展开形式(8 组 4 位十六进制)与 zone ID,'
    + 'IPv4-mapped 地址(::ffff:x.x.x.x)附对应的 IPv4。非法地址返回错误。',
  inputSchema: {
    ip: z.string().describe('IP 地址字符串,如 192.168.1.1 或 2001:db8::1'),
  },
}, async ({ ip }) => {
  if (!ipaddr.isValid(ip)) {
    return fail(`parse-ip: 非法 IP 地址:${JSON.stringify(ip)}`);
  }
  const addr = ipaddr.parse(ip);
  const info = {
    input: ip,
    kind: addr.kind(),
    canonical: addr.toString(),
    range: addr.range(),
  };
  if (addr.kind() === 'ipv4') {
    info.octets = addr.octets;
  } else {
    info.expanded = addr.toFixedLengthString();
    if (addr.zoneId) info.zoneId = addr.zoneId;
    if (addr.isIPv4MappedAddress()) info.ipv4 = addr.toIPv4Address().toString();
  }
  return ok(info);
});

server.registerTool('cidr-match', {
  description:
    '判断 IP 地址是否落在 CIDR 网段内(如 192.168.0.0/16),返回 JSON { ip, cidr, match }。'
    + 'IP 或 CIDR 非法、或两者 IP 版本不一致(IPv4 地址对 IPv6 网段)时返回错误。',
  inputSchema: {
    ip: z.string().describe('要判断的 IP 地址,如 192.168.1.1'),
    cidr: z.string().describe('CIDR 网段,如 192.168.0.0/16 或 2001:db8::/32'),
  },
}, async ({ ip, cidr }) => {
  if (!ipaddr.isValid(ip)) {
    return fail(`cidr-match: 非法 IP 地址:${JSON.stringify(ip)}`);
  }
  if (!ipaddr.isValidCIDR(cidr)) {
    return fail(`cidr-match: 非法 CIDR 网段:${JSON.stringify(cidr)}(格式应为 地址/前缀长度,前缀不超过 32/128)`);
  }
  const addr = ipaddr.parse(ip);
  const range = ipaddr.parseCIDR(cidr);
  if (addr.kind() !== range[0].kind()) {
    return fail(`cidr-match: IP 版本不一致:${addr.kind()} 地址不能与 ${range[0].kind()} 网段比较`);
  }
  return ok({ ip: addr.toString(), cidr, match: addr.match(range) });
});

const transport = new StdioServerTransport();
await server.connect(transport);
