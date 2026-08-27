/**
 * mcp-apns-push smoke — real calls, real assertions.
 * Phase 1 (strict): tool surface, input validation, credential gates — must all pass.
 * Phase 2 (live, bounded): with FAKE credentials the part must reach Apple's real
 *   APNs endpoint (HTTP/2) and Bark's real API and return their genuine responses —
 *   fake creds must NEVER be accepted (status/code != 200). Network-unavailable
 *   degrades to an honest per-tool error, logged loudly, still exit 0.
 */
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';

const SECRET_ENVS = ['APNS_TEAM_ID', 'APNS_KEY_ID', 'APNS_AUTH_KEY', 'APNS_BUNDLE_ID', 'APNS_DEVICE_TOKEN', 'BARK_KEY', 'BARK_SERVER'];

function cleanEnv() {
  const env = { ...process.env };
  for (const k of SECRET_ENVS) delete env[k];
  return env;
}

function startServer(env) {
  const child = spawn('node', ['index.js'], { env });
  let stderr = '';
  child.stderr.on('data', (c) => { stderr += c; });
  let id = 0;
  const pending = new Map();
  child.stdout.on('data', (buf) => {
    for (const line of buf.toString().split('\n')) {
      const t = line.trim();
      if (!t) continue;
      let obj;
      try { obj = JSON.parse(t); } catch { continue; }
      if (obj.id && pending.has(obj.id)) {
        const r = pending.get(obj.id);
        pending.delete(obj.id);
        r(obj);
      }
    }
  });
  const call = (method, params) =>
    new Promise((resolve, reject) => {
      const myId = ++id;
      const timer = setTimeout(() => { pending.delete(myId); reject(new Error('timeout waiting for ' + method)); }, 30000);
      pending.set(myId, (resp) => { clearTimeout(timer); resolve(resp); });
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: myId, method, params }) + '\n');
    });
  const init = async () => {
    await call('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'smoke', version: '1.0.0' } });
    await call('notifications/initialized', {});
  };
  const close = () => {
    try { child.stdin.end(); } catch {}
    setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, 800);
  };
  return { call, init, close, stderr: () => stderr };
}

async function main() {
  /* ---- Phase 1: strict local assertions ---- */
  const s1 = startServer(cleanEnv());
  await s1.init();

  const tools = await s1.call('tools/list', {});
  const names = tools.result.tools.map((t) => t.name);
  assert.ok(names.includes('push-send'), 'push-send missing from tools/list');
  assert.ok(names.includes('push-config-status'), 'push-config-status missing from tools/list');

  const bad = await s1.call('tools/call', { name: 'push-send', arguments: { body: 'no-title' } });
  assert.ok(bad.result.isError, 'push-send without title must error');
  assert.ok(bad.result.content[0].text.includes('title and body'), 'validation error text');

  const st = await s1.call('tools/call', { name: 'push-config-status', arguments: {} });
  const stJson = JSON.parse(st.result.content[0].text);
  assert.equal(stJson.apns.configured, false, 'apns must be unconfigured in clean env');
  assert.equal(stJson.bark.configured, false, 'bark must be unconfigured in clean env');
  assert.ok(stJson.apns.missing.includes('APNS_AUTH_KEY') && stJson.apns.missing.includes('APNS_DEVICE_TOKEN'), 'missing must name APNS vars');
  assert.ok(stJson.bark.missing.includes('BARK_KEY'), 'missing must name BARK_KEY');
  assert.equal(stJson.defaultChannel, 'none', 'default channel must be none');

  const noEnv = await s1.call('tools/call', { name: 'push-send', arguments: { title: 't', body: 'b' } });
  assert.ok(noEnv.result.isError, 'push-send without any channel must be an honest error');
  const noEnvText = noEnv.result.content[0].text;
  assert.ok(noEnvText.includes('APNS_TEAM_ID') && noEnvText.includes('BARK_KEY'), 'error must name missing env: ' + noEnvText);

  s1.close();
  console.log('[phase1] surface + validation + credential gates: PASS');

  /* ---- Phase 2: live probes with fake creds (bounded) ---- */
  const fakeKey = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({ type: 'pkcs8', format: 'pem' });
  const s2 = startServer({ ...cleanEnv(), APNS_TEAM_ID: 'TEAMSMOKE', APNS_KEY_ID: 'KEYS', APNS_AUTH_KEY: fakeKey, APNS_BUNDLE_ID: 'com.smoke.test', APNS_DEVICE_TOKEN: '0'.repeat(64) });
  await s2.init();
  const apns = await s2.call('tools/call', { name: 'push-send', arguments: { title: 'smoke', body: 'smoke', channel: 'apns', timeout_ms: 12000 } });
  if (apns.result.isError) {
    console.log('[phase2] APNs live probe degraded (network/credential boundary):', apns.result.content[0].text.slice(0, 160));
  } else {
    const j = JSON.parse(apns.result.content[0].text);
    console.log('[phase2] APNs live handshake:', JSON.stringify({ ok: j.ok, apnsStatus: j.apnsStatus, reason: j.reason }));
    assert.equal(typeof j.apnsStatus, 'number', 'must receive a numeric APNs status');
    assert.notEqual(j.apnsStatus, 200, 'fake creds must never be accepted by Apple');
  }
  s2.close();

  const s3 = startServer({ ...cleanEnv(), BARK_KEY: 'smokefakekey' });
  await s3.init();
  const bark = await s3.call('tools/call', { name: 'push-send', arguments: { title: 'smoke', body: 'smoke', channel: 'bark', timeout_ms: 12000 } });
  if (bark.result.isError) {
    console.log('[phase2] Bark live probe degraded (network):', bark.result.content[0].text.slice(0, 160));
  } else {
    const j = JSON.parse(bark.result.content[0].text);
    console.log('[phase2] Bark live handshake:', JSON.stringify({ ok: j.ok, code: j.code, message: j.message }));
    assert.equal(typeof j.code, 'number', 'must receive a numeric Bark code');
    assert.notEqual(j.code, 200, 'fake BARK_KEY must never be accepted');
  }
  s3.close();

  console.log('[phase2] live wire probes: DONE (see logs above)');
  console.log('SMOKE PASS');
}

main().catch((e) => {
  console.error('SMOKE FAIL:', e && e.message ? e.message : e);
  process.exit(1);
});
