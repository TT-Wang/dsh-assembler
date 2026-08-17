#!/usr/bin/env node
/**
 * MCP stdio server: YAML/JSON 互转工具,基于 yaml(yaml@2)。
 * 能力点:YAML 文本解析为 JSON、JSON 序列化为 YAML——agent 读写配置文件、
 * 核对 YAML 语法、在两种格式之间搬运数据,一轮内完成。
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { parseDocument, stringify } from 'yaml';

const server = new McpServer({ name: 'yaml-convert', version: '0.0.1' });

server.registerTool('yaml-to-json', {
  description:
    '把 YAML 文本解析为 JSON 字符串(默认缩进 2 空格,compact=true 时单行)。只处理单文档 YAML;'
    + '解析失败时返回带行号/列号定位的错误信息而不是产出半截结果。',
  inputSchema: {
    yamlText: z.string().describe('要解析的 YAML 文本'),
    compact: z.boolean().optional().describe('true 时输出单行紧凑 JSON(默认缩进 2 空格)'),
  },
}, async ({ yamlText, compact }) => {
  const doc = parseDocument(yamlText);
  if (doc.errors.length > 0) {
    const detail = doc.errors
      .map((e) => (e.linePos?.[0] ? `第 ${e.linePos[0].line} 行第 ${e.linePos[0].col} 列: ${e.message}` : e.message))
      .join('\n');
    return { isError: true, content: [{ type: 'text', text: `yaml-to-json: YAML 解析失败\n${detail}` }] };
  }
  return { content: [{ type: 'text', text: JSON.stringify(doc.toJS(), null, compact ? 0 : 2) }] };
});

server.registerTool('json-to-yaml', {
  description:
    '把 JSON 字符串序列化为 YAML 文本(块风格,缩进 2 空格)。输入必须是合法 JSON;'
    + '解析失败时返回错误信息而不是产出损坏结果。',
  inputSchema: {
    jsonText: z.string().describe('要转换的 JSON 字符串'),
  },
}, async ({ jsonText }) => {
  let value;
  try {
    value = JSON.parse(jsonText);
  } catch (err) {
    return { isError: true, content: [{ type: 'text', text: `json-to-yaml: JSON 解析失败: ${err.message}` }] };
  }
  return { content: [{ type: 'text', text: stringify(value) }] };
});

const transport = new StdioServerTransport();
await server.connect(transport);
