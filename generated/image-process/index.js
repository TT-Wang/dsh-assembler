// MCP stdio server wrapping sharp v0.33.4 (Apache-2.0, https://github.com/lovell/sharp)
// Tools: image-info / image-resize / image-convert / image-thumbnail
// 所有图片输入输出均使用 base64 编码（输出图片为 base64 字符串，需解码后使用）。
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import sharp from 'sharp';

const server = new McpServer({
  name: 'image-process',
  version: '0.0.1',
});

// ---------------------------------------------------------------- constants
const FORMATS = ['jpeg', 'png', 'webp', 'avif', 'tiff', 'gif'];
const FITS = ['cover', 'contain', 'fill', 'inside', 'outside'];
const POSITIONS = [
  'centre', 'center', 'north', 'east', 'south', 'west',
  'northwest', 'northeast', 'southwest', 'southeast',
  'top', 'right', 'bottom', 'left', 'entropy', 'attention'
];
const MIME = {
  jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp',
  avif: 'image/avif', tiff: 'image/tiff', gif: 'image/gif'
};
// 输入 base64 长度上限（约 30MB 解码后二进制），防止内存耗尽
const MAX_B64_LEN = 40_000_000;

// ---------------------------------------------------------------- helpers
const text = (str) => ({ content: [{ type: 'text', text: str }], isError: false });
const error = (str) => ({ content: [{ type: 'text', text: str }], isError: true });

/** 统一异常处理：sharp/参数错误都转为清晰错误文本（isError=true） */
async function guard(fn) {
  try {
    return await fn();
  } catch (err) {
    const msg = err && err.message ? err.message : String(err);
    return error(`ERROR: ${msg}`);
  }
}

/** 校验并解码 base64 输入图片 */
function decodeImage(imageB64) {
  if (typeof imageB64 !== 'string' || imageB64.trim().length === 0) {
    throw new Error('image 参数必须是有效的 base64 字符串（原始二进制，不含 data:image/...;base64, 前缀）');
  }
  if (imageB64.length > MAX_B64_LEN) {
    throw new Error(`image 过大：base64 长度 ${imageB64.length} 超过上限 ${MAX_B64_LEN}（约 30MB 二进制），请先裁剪/压缩输入`);
  }
  const buf = Buffer.from(imageB64, 'base64');
  if (buf.length === 0) {
    throw new Error('image base64 解码结果为空：输入不是有效的 base64 图片数据');
  }
  return buf;
}

/** 输出图片结果：base64 + 实际尺寸/格式信息 */
function imageResult(data, info) {
  const payload = {
    image: data.toString('base64'), // 二进制输出，base64 编码
    format: info.format,
    width: info.width,
    height: info.height,
    sizeBytes: info.size,
    mimeType: MIME[info.format] || 'application/octet-stream'
  };
  return text(JSON.stringify(payload, null, 2));
}

// ---------------------------------------------------------------- tools

// 1. image-info：读元信息，无二进制输出
server.tool(
  'image-info',
  '读取 base64 图片的元信息（不输出图片）：返回 JSON，含 format（格式）、width/height（像素）、space（色彩空间 sRGB/CMYK 等）、channels（通道数）、hasAlpha、hasProfile（ICC 配置）、density（DPI）、orientation（EXIF 方向）、isProgressive、pages/pageHeight/delay/loop（动图帧信息）、size（原始字节数）。' +
  '参数：image（必填，输入图片 base64，原始二进制，无 data: 前缀；支持 JPEG/PNG/WebP/GIF/AVIF/TIFF/SVG/HEIF，按文件头自动探测）。' +
  '适合在处理前先确认图片格式与尺寸、判断是否动图/透明通道，或作为其它 image-* 工具的输入校验。',
  {
    image: z.string().describe('输入图片的 base64 编码数据（原始二进制，不含 data:image/...;base64, 前缀）')
  },
  async ({ image }) => guard(async () => {
    const buf = decodeImage(image);
    const m = await sharp(buf).metadata();
    return text(JSON.stringify({
      format: m.format,
      width: m.width,
      height: m.height,
      space: m.space,
      channels: m.channels,
      depth: m.depth,
      density: m.density ?? null,
      chromaSubsampling: m.chromaSubsampling ?? null,
      isProgressive: m.isProgressive ?? null,
      hasProfile: !!m.icc,
      hasAlpha: !!m.hasAlpha,
      orientation: m.orientation ?? null,
      pages: m.pages ?? null,
      pageHeight: m.pageHeight ?? null,
      pagePrimary: m.pagePrimary ?? null,
      delay: m.delay ?? null,
      loop: m.loop ?? null,
      size: m.size,
      hasExif: !!m.exif
    }, null, 2));
  })
);

// 2. image-resize：按目标宽高缩放（可选裁剪/格式），输出 base64 图片
server.tool(
  'image-resize',
  '按目标尺寸缩放图片，返回 base64 编码的结果图片（JSON：{image, format, width, height, sizeBytes, mimeType}，image 为 base64 字符串，调用方需解码保存/使用）。' +
  '参数：image（必填，输入图片 base64）；width/height（可选正整数，至少提供一个，只给一个时另一边按原图宽高比自动计算）；fit（可选，默认 cover：cover=裁剪填满可裁边、contain=完整容纳留边、fill=拉伸变形、inside=等比缩小不放大、outside=等比放大到至少一边达目标）；position（可选，fit=cover/outside 时的裁剪焦点，默认 centre，可用 north/south/east/west/entropy/attention 等）；withoutEnlargement（可选布尔，默认 false，true 时禁止把小图放大）；format（可选，输出格式，默认与原图一致；支持 jpeg/png/webp/avif/tiff）；quality（可选 1-100，输出质量，jpeg/webp 默认 80、avif 默认 50，png 忽略）。' +
  '适合调整图片到指定尺寸用于展示、上传或进一步处理。',
  {
    image: z.string().describe('输入图片的 base64 编码数据（原始二进制，不含 data: 前缀）'),
    width: z.number().int().positive().max(20000).optional().describe('目标宽度（像素），与 height 至少提供一个'),
    height: z.number().int().positive().max(20000).optional().describe('目标高度（像素），与 width 至少提供一个'),
    fit: z.enum(FITS).optional().describe('尺寸适配策略，默认 cover（裁剪填满）'),
    position: z.enum(POSITIONS).optional().describe('裁剪焦点/重力方向，默认 centre；entropy/attention 按内容自动选焦点'),
    withoutEnlargement: z.boolean().optional().describe('true 时禁止把小图放大，默认 false'),
    format: z.enum(FORMATS).optional().describe('输出格式，默认与原图一致'),
    quality: z.number().int().min(1).max(100).optional().describe('输出质量 1-100（jpeg/webp/avif/tiff）')
  },
  async (args) => guard(async () => {
    const buf = decodeImage(args.image);
    if (!args.width && !args.height) {
      throw new Error('width 与 height 至少提供一个目标尺寸');
    }
    let img = sharp(buf);
    if (args.format === 'gif') {
      img = img.animated(true); // GIF 输出要求以动图方式加载输入
    }
    const resizeOpts = {
      fit: args.fit ?? 'cover',
      position: args.position ?? 'centre',
      withoutEnlargement: args.withoutEnlargement ?? false
    };
    let out = img.resize(args.width, args.height, resizeOpts);
    if (args.format) {
      const outOpts = {};
      if (args.quality !== undefined) outOpts.quality = args.quality;
      out = out.toFormat(args.format, outOpts);
    }
    const { data, info } = await out.toBuffer({ resolveWithObject: true });
    return imageResult(data, info);
  })
);

// 3. image-convert：格式转换 + 压缩参数，输出 base64 图片
server.tool(
  'image-convert',
  '把图片转换成指定格式并应用压缩参数，返回 base64 编码的结果图片（JSON：{image, format, width, height, sizeBytes, mimeType}）。' +
  '参数：image（必填，输入图片 base64）；format（必填，目标格式 jpeg/png/webp/avif/tiff/gif，其中 gif 输出要求输入为动图，转换后尺寸不变）；quality（可选 1-100，jpeg/webp 默认 80、avif 默认 50）；lossless（可选布尔，webp/avif 无损模式，默认 false）；effort（可选整数 0-9，webp/avif 压缩努力程度，默认 4，越大越慢越小）；compressionLevel（可选整数 0-9，png 压缩级别，默认 6）；progressive（可选布尔，jpeg 渐进式编码，默认 false）。' +
  '适合把图片统一转成目标格式以减小体积（如 jpeg→webp）、生成透明 PNG 或归档为 tiff。',
  {
    image: z.string().describe('输入图片的 base64 编码数据（原始二进制，不含 data: 前缀）'),
    format: z.enum(FORMATS).describe('目标输出格式：jpeg/png/webp/avif/tiff/gif'),
    quality: z.number().int().min(1).max(100).optional().describe('输出质量 1-100，jpeg/webp 默认 80，avif 默认 50'),
    lossless: z.boolean().optional().describe('webp/avif 无损压缩，默认 false'),
    effort: z.number().int().min(0).max(9).optional().describe('webp/avif 压缩努力程度 0-9，默认 4'),
    compressionLevel: z.number().int().min(0).max(9).optional().describe('png 压缩级别 0-9，默认 6'),
    progressive: z.boolean().optional().describe('jpeg 渐进式编码，默认 false')
  },
  async (args) => guard(async () => {
    const buf = decodeImage(args.image);
    let img = sharp(buf);
    if (args.format === 'gif') img = img.animated(true);
    const opts = {};
    if (args.quality !== undefined) opts.quality = args.quality;
    if (args.lossless !== undefined) opts.lossless = args.lossless;
    if (args.effort !== undefined) opts.effort = args.effort;
    if (args.compressionLevel !== undefined) opts.compressionLevel = args.compressionLevel;
    if (args.progressive !== undefined) opts.progressive = args.progressive;
    const { data, info } = await img.toFormat(args.format, opts).toBuffer({ resolveWithObject: true });
    return imageResult(data, info);
  })
);

// 4. image-thumbnail：缩略图（默认 cover 裁剪 + 不放大）
server.tool(
  'image-thumbnail',
  '生成图片缩略图，返回 base64 编码的结果图片（JSON：{image, format, width, height, sizeBytes, mimeType}）。' +
  '与 image-resize 的区别：默认 fit=cover 且 withoutEnlargement=true（小图不会被放大），适合生成预览/列表小图。' +
  '参数：image（必填，输入图片 base64）；width/height（可选正整数，至少提供一个，缺省时按原图宽高比推算；只给一个时另一边等比缩放）；fit（可选，默认 cover：cover=居中裁剪填满、contain=完整容纳留边、fill=拉伸变形、inside=等比缩小不放大、outside=等比放大到至少一边达目标）；position（可选，fit=cover/outside 时的裁剪焦点，默认 centre）；format（可选，输出格式，默认与原图一致）。',
  {
    image: z.string().describe('输入图片的 base64 编码数据（原始二进制，不含 data: 前缀）'),
    width: z.number().int().positive().max(20000).optional().describe('缩略图宽度（像素），与 height 至少提供一个'),
    height: z.number().int().positive().max(20000).optional().describe('缩略图高度（像素），与 width 至少提供一个'),
    fit: z.enum(FITS).optional().describe('适配策略，默认 cover（居中裁剪填满）'),
    position: z.enum(POSITIONS).optional().describe('裁剪焦点，默认 centre'),
    format: z.enum(FORMATS).optional().describe('输出格式，默认与原图一致')
  },
  async (args) => guard(async () => {
    const buf = decodeImage(args.image);
    if (!args.width && !args.height) {
      throw new Error('width 与 height 至少提供一个目标尺寸');
    }
    let img = sharp(buf);
    if (args.format === 'gif') img = img.animated(true);
    // sharp 无 .thumbnail() 方法：缩略图即 resize + fit + withoutEnlargement:true
    img = img.resize(args.width, args.height, {
      fit: args.fit ?? 'cover',
      position: args.position ?? 'centre',
      withoutEnlargement: true
    });
    if (args.format) img = img.toFormat(args.format);
    const { data, info } = await img.toBuffer({ resolveWithObject: true });
    return imageResult(data, info);
  })
);

// ---------------------------------------------------------------- run
const transport = new StdioServerTransport();
await server.connect(transport);
