#!/usr/bin/env node
/**
 * 冒烟:listTools → 三个工具各打一次真实网络 → 错误路径(本地拦截,不发请求)。
 *
 * 断言只压"结构 + 量纲 + 语义",不压具体值:这是**公开可写**的演示库,
 * 宠物是谁、有几只、叫什么名字随时被别人改,任何写死的 id / name / 数量都会自己烂掉。
 *
 * === 上游故障容忍(重要,别简化成"直接断言成功")===
 * 实测 2026-08-17:findByStatus / store/inventory 在服务端整体 500(公共库被写进脏数据),
 * 且该部署用 500 代替 404。冒烟要测的是**零件**,不是对方今天心情好不好,所以这两个工具
 * 接受两种结局中的任意一种,但两种都要求零件守住自己的合同:
 *   ① 成功 → 断言裁剪后的结构、条数上限、字段类型;
 *   ② 上游 5xx → 断言零件把它转成了 isError,且错误文案点名了是哪个接口、什么状态码。
 * 这样"对方挂了"不会变成假红,而"零件自己坏了"(崩溃 / 吐不出 JSON / 该有的字段没有 /
 * 把 5xx 当成功)照样会红。
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

// 网络零件冒烟:必须把代理环境显式传给零件子进程。MCP SDK 的
// StdioClientTransport 默认只透传白名单 env(HOME/PATH/USER…),
// HTTPS_PROXY / NODE_USE_ENV_PROXY 都不在其中——不传的话零件在代理网络下
// 只会报 "fetch failed",看起来像零件坏了,其实是网络路径断了。
const NETWORK_ENV = (() => {
  const e = { ...process.env };
  if ((e.HTTPS_PROXY || e.https_proxy || e.HTTP_PROXY || e.http_proxy) && e.NODE_USE_ENV_PROXY === undefined) {
    e.NODE_USE_ENV_PROXY = '1';
  }
  return e;
})();


let failures = 0;
const check = (label, cond, extra = '') => {
  console.log(`${cond ? '  ✓' : '  ✗ FAIL'} ${label}${extra ? ` — ${extra}` : ''}`);
  if (!cond) failures += 1;
};
/** 跳过一条断言并说明原因——不计失败,但必须留下痕迹,不能悄悄没测。 */
const skip = (label, why) => console.log(`  ↷ SKIP ${label} — ${why}`);
const text = (r) => r.content.map((b) => b.text ?? '').join('');
const json = (r) => { try { return JSON.parse(text(r)); } catch { return null; } };
/** 零件把上游 5xx 转成了 isError,且文案点名了状态码 —— 这是"对方挂了"的合格表现。 */
const upstreamDown = (r) => r.isError === true && /HTTP 5\d\d/.test(text(r));

const transport = new StdioClientTransport({ command: 'node', args: [new URL('./index.js', import.meta.url).pathname], env: NETWORK_ENV });
const client = new Client({ name: 'smoke', version: '0.0.1' });
await client.connect(transport);

const call = async (name, args) => {
  try {
    return await client.callTool({ name, arguments: args });
  } catch (e) {
    return { isError: true, content: [{ type: 'text', text: `callTool 抛出:${e?.message ?? String(e)}` }] };
  }
};

const tools = await client.listTools();
const names = tools.tools.map((t) => t.name).sort().join(',');
check('listTools 返回 3 个工具', tools.tools.length === 3, names);
check('工具名与预期一致', names === 'find-pets-by-status,get-inventory,get-pet', names);
check('每个工具都有非空 description', tools.tools.every((t) => typeof t.description === 'string' && t.description.length > 20));
// 只读零件:一个写工具都不该有(公共演示库,写操作会污染他人数据)。
check('没有任何写工具(只读零件)', !tools.tools.some((t) => /^(add|create|update|delete|place|upload|remove)-/.test(t.name)), names);

// ---- find-pets-by-status:真实调用 ------------------------------------------
const r1 = await call('find-pets-by-status', { status: 'available', limit: 5 });
const list = json(r1);
check('find-pets-by-status 有响应且形态可判定', list !== null || upstreamDown(r1), text(r1).slice(0, 100));

let discoveredId = null;
if (upstreamDown(r1)) {
  skip('find-pets-by-status 成功路径断言', `上游 5xx(已知故障):${text(r1).slice(0, 70)}…`);
  check('上游 5xx 被转成可行动的 isError(点名接口与成因)', r1.isError === true && /findByStatus|状态/.test(text(r1)), 'isError=true');
} else {
  check('find-pets-by-status 非错误', r1.isError !== true, text(r1).slice(0, 100));
  check('status 回显为 available', list?.status === 'available', String(list?.status));
  check('pets 是数组且不超过 limit=5', Array.isArray(list?.pets) && list.pets.length <= 5, String(list?.pets?.length));
  check('count 与 pets 长度自洽', list?.count === list?.pets?.length, `${list?.count} vs ${list?.pets?.length}`);
  if (list?.pets?.length) {
    const p = list.pets[0];
    check('每条记录带数字 id', list.pets.every((x) => typeof x.id === 'number'), String(p.id));
    check('每条记录带 name 字符串', list.pets.every((x) => typeof x.name === 'string'), String(p.name));
    check('photoUrls 已裁剪成计数+样本(不整包透传)', typeof p.photoCount === 'number' && Array.isArray(p.photoSample) && p.photoSample.length <= 3, `${p.photoCount}/${p.photoSample?.length}`);
    check('tags 被拍平成字符串数组', Array.isArray(p.tags) && p.tags.every((t) => typeof t === 'string'), JSON.stringify(p.tags));
    discoveredId = p.id;
  } else {
    skip('单条记录字段断言', '本次查询返回 0 只宠物(公共库随时被清空,属正常)');
  }
}

// ---- get-pet:先拿到真实存在的 id 再查 ---------------------------------------
// 优先用 find-pets-by-status 发现 id(不硬编码)。该端点当前上游 500,退化方案是
// 通过零件自身逐个探测候选 id,取第一个真的能查通的 —— 仍然是"先验证再断言",
// 而不是假设某个 id 一定存在;全都查不通就跳过并说明。
let petId = discoveredId;
if (petId === null) {
  skip('用 find-pets-by-status 发现 id', '发现通道不可用,改为逐个探测候选 id');
  for (const cand of [1, 3, 5, 10, 100]) {
    const probe = await call('get-pet', { petId: cand });
    const pj = json(probe);
    if (probe.isError !== true && pj?.found === true) { petId = cand; break; }
  }
}

if (petId === null) {
  skip('get-pet 成功路径断言', '候选 id 全部查不通(上游故障),无法取得任何真实存在的宠物');
  // 工具仍必须被真实调用过一次,并且失败得体面。
  const probe = await call('get-pet', { petId: 1 });
  check('get-pet 真实调用后返回结构化结果或可行动错误', json(probe) !== null || upstreamDown(probe), text(probe).slice(0, 90));
} else {
  const r2 = await call('get-pet', { petId });
  const pet = json(r2);
  check(`get-pet(id=${petId}) 命中且非错误`, pet?.found === true && r2.isError !== true, text(r2).slice(0, 90));
  check('返回的 id 与查询的 id 一致', pet?.pet?.id === petId, `${pet?.pet?.id} vs ${petId}`);
  check('详情带 name 字符串', typeof pet?.pet?.name === 'string' && pet.pet.name.length > 0, String(pet?.pet?.name));
  check('详情 photoUrls 已裁剪', typeof pet?.pet?.photoCount === 'number' && (pet.pet.photoSample?.length ?? 0) <= 3, String(pet?.pet?.photoCount));
  check('status 缺失时为 undefined 而非崩溃', !('status' in (pet?.pet ?? {})) || pet.pet.status === undefined || typeof pet.pet.status === 'string', String(pet?.pet?.status));
}

// ---- get-inventory:真实调用 ------------------------------------------------
const r3 = await call('get-inventory', {});
const inv = json(r3);
check('get-inventory 有响应且形态可判定', inv !== null || upstreamDown(r3), text(r3).slice(0, 100));
if (upstreamDown(r3)) {
  skip('get-inventory 成功路径断言', `上游 5xx(已知故障):${text(r3).slice(0, 70)}…`);
  check('上游 5xx 被转成可行动的 isError(点名接口)', r3.isError === true && /inventory|库存/.test(text(r3)), 'isError=true');
} else {
  check('get-inventory 非错误', r3.isError !== true, text(r3).slice(0, 100));
  check('statuses 是对象', inv?.statuses !== null && typeof inv?.statuses === 'object' && !Array.isArray(inv.statuses), typeof inv?.statuses);
  check('每个状态的计数都是非负数字', Object.values(inv?.statuses ?? {}).every((v) => typeof v === 'number' && v >= 0), JSON.stringify(inv?.statuses).slice(0, 80));
  check('totalCount 等于各状态之和', inv?.totalCount === Object.values(inv?.statuses ?? {}).reduce((a, b) => a + b, 0), String(inv?.totalCount));
}

// ---- 错误路径(本地拦截,不发请求,与上游死活无关)---------------------------
const e1 = await call('find-pets-by-status', { status: 'bogus' });
check('非法 status 被拒(isError)', e1.isError === true && text(e1).includes('status'), text(e1).slice(0, 80));

const e2 = await call('find-pets-by-status', { status: 'available', limit: 999 });
check('limit=999 被拒(isError)', e2.isError === true && text(e2).includes('limit'), text(e2).slice(0, 80));

const e3 = await call('get-pet', { petId: -1 });
check('负数 petId 被拒(isError)', e3.isError === true && text(e3).includes('petId'), text(e3).slice(0, 80));

const e4 = await call('get-pet', { petId: 1.5 });
check('小数 petId 被拒(isError)', e4.isError === true && text(e4).includes('petId'), text(e4).slice(0, 80));

await client.close();
console.log(failures === 0 ? '\nsmoke: ALL PASS' : `\nsmoke: ${failures} FAIL`);
process.exit(failures);
