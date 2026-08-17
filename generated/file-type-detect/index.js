#!/usr/bin/env node
/**
 * MCP stdio server: 二进制文件类型探测(魔数识别),基于 file-type@22(纯 ESM)。
 * 能力点:agent 拿到一段来历不明的字节(下载物、附件、解压产物)就能判断
 * 它到底是 png/pdf/zip/gz/… 哪种格式,一轮内完成。
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { fileTypeFromBuffer } from 'file-type';

const server = new McpServer({ name: 'file-type-detect', version: '0.0.1' });

server.registerTool('detect-file-type', {
  description:
    '按魔数(magic number)探测一段字节的文件类型。输入 base64 编码的文件字节(开头几 KB 即可);'
    + '识别出时返回 { recognized:true, ext, mime };识别不出返回 recognized:false 的结构化说明'
    + '(注意:txt/csv/svg/json 等纯文本格式没有魔数,识别不出是正常结果,不是错误);'
    + 'base64 非法或内容为空时返回错误。',
  inputSchema: {
    base64: z.string().describe('文件字节的 base64 编码,含文件开头(魔数在头部,给前几 KB 足够)'),
  },
}, async ({ base64 }) => {
  const clean = base64.replace(/\s+/g, '');
  if (clean === '' || clean.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(clean)) {
    return { isError: true, content: [{ type: 'text', text: 'detect-file-type: base64 无法解码(非法字符、长度不对或为空)' }] };
  }
  const bytes = Buffer.from(clean, 'base64');
  if (bytes.length === 0) {
    return { isError: true, content: [{ type: 'text', text: 'detect-file-type: 解码后内容为空,无从探测' }] };
  }
  let ft;
  try {
    ft = await fileTypeFromBuffer(bytes);
  } catch (e) {
    return { isError: true, content: [{ type: 'text', text: `detect-file-type: 探测失败: ${e.message}` }] };
  }
  if (!ft) {
    const out = {
      recognized: false,
      byteLength: bytes.length,
      note: '无法识别:没有匹配的二进制魔数。纯文本类格式(txt/csv/svg/json 等)本就不在识别范围,这是正常结果。',
    };
    return { content: [{ type: 'text', text: JSON.stringify(out, null, 2) }] };
  }
  const out = { recognized: true, ext: ft.ext, mime: ft.mime, byteLength: bytes.length };
  return { content: [{ type: 'text', text: JSON.stringify(out, null, 2) }] };
});

const transport = new StdioServerTransport();
await server.connect(transport);
