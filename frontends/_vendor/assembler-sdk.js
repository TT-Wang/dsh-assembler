// assembler-sdk.js — 装配器页面的固定通信层(SDK 蒸馏,2026-08-25)。
// 从 9 张手工模板里各自手写的 rpc/ws/围栏解析中抽出的公共面;模板与将来
// scaffold 车道生成的页面共用这一份。三条纪律在此一次成文,全体受益:
//   1. 会话面(wire):session.create / session.prompt / events.mux——判断流走这
//   2. 服务脸(/.service):零件直连端点发现 + SQL——确定性流走这,零模型零轮次
//   3. 失败必须出声:围栏解析失败、rpc 失败、面不可达,一律给调用方可展示的
//      错误(治 kanban:83 一类"用户拖了卡、界面装死"的静默病)
// 引用方式(与 Franken UI 同段):<script src="_vendor/assembler-sdk.js"></script>
// 全局暴露 window.AssemblerSDK;零依赖,零构建,老浏览器语法兜底不做(交付面同代)。
(function () {
  'use strict';

  // ── 会话面客户端 ──────────────────────────────────────────────────────────
  // createClient({ presetId, workdir, onToolCall?, onDelta?, onError? })
  //   .ask(text) → Promise<{ reply, fence }>:发一轮、等 turn/end、带围栏解析结果
  //   .rpc(method, payload)、.ensureSession()、.busy
  function createClient(cfg) {
    var sessionId = null, ws = null, busy = false;
    var turnWaiters = [];
    var replyBuf = '';

    function rpc(method, payload) {
      return fetch('/api/' + method, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'client-request', rpcId: 'fe-' + Date.now() + '-' + Math.random().toString(36).slice(2), method: method, payload: payload }),
      }).then(function (res) { return res.json(); }).then(function (j) {
        if (!j.result || !j.result.ok) throw new Error(method + ' 失败:' + JSON.stringify((j.result && j.result.error) || j).slice(0, 200));
        return j.result.value;
      });
    }

    function textOf(e) {
      var c = e.data && e.data.message && e.data.message.content;
      if (typeof c === 'string') return c;
      if (Array.isArray(c)) return c.map(function (b) { return b && b.type === 'text' ? b.text : ''; }).join('');
      return '';
    }

    function handle(e) {
      if (e.type === 'assistant/message') {
        var t = textOf(e);
        if (t) { replyBuf += (replyBuf === '' ? '' : '\n') + t; if (cfg.onDelta) cfg.onDelta(replyBuf); }
      } else if (e.type === 'tool/call') {
        if (cfg.onToolCall) cfg.onToolCall(String((e.data && e.data.name) || '?').replace(/^mcp__/, '').replace(/__/, ' · '));
      } else if (e.type === 'turn/end') {
        busy = false;
        var waiters = turnWaiters; turnWaiters = [];
        var out = { reply: replyBuf, fence: extractFence(replyBuf) };
        waiters.forEach(function (w) { w.resolve(out); });
      }
    }

    function openWs() {
      ws = new WebSocket(location.origin.replace(/^http/, 'ws') + '/api/events.mux');
      ws.onmessage = function (m) {
        var f; try { f = JSON.parse(String(m.data)); } catch (_) { return; }
        var p = f.payload;
        if (!p || p.type !== 'session/event' || p.sessionId !== sessionId) return;
        handle(p.event);
      };
      ws.onclose = function () { if (sessionId) setTimeout(openWs, 1500); };
    }

    function ensureSession() {
      if (sessionId) return Promise.resolve();
      return rpc('session.create', { cwd: cfg.workdir, agentPreset: cfg.presetId }).then(function (v) {
        sessionId = v.sessionId; openWs();
        return new Promise(function (r) {
          var t = setInterval(function () { if (ws && ws.readyState === 1) { clearInterval(t); r(); } }, 50);
        });
      });
    }

    function ask(text) {
      if (busy) return Promise.reject(new Error('上一轮还在进行'));
      replyBuf = ''; busy = true;
      return ensureSession().then(function () {
        return rpc('session.prompt', { sessionId: sessionId, mode: 'queue', content: [{ type: 'text', text: text }] });
      }).then(function () {
        return new Promise(function (resolve, reject) {
          turnWaiters.push({ resolve: resolve, reject: reject });
        });
      }).catch(function (err) {
        busy = false;
        if (cfg.onError) cfg.onError(String((err && err.message) || err));
        throw err;
      });
    }

    return {
      rpc: rpc,
      ensureSession: ensureSession,
      ask: ask,
      get busy() { return busy; },
      get sessionId() { return sessionId; },
    };
  }

  // ── 围栏解析(失败出声版)──────────────────────────────────────────────────
  // extractFence(text) → { ok:true, data } | { ok:false, reason }
  // 病史:模板各自 `catch { return }`,解析失败界面装死无报错(kanban 实录)。
  function extractFence(text) {
    var fences = [];
    var re = /```json\s*([\s\S]*?)```/g;
    var m;
    while ((m = re.exec(String(text || ''))) !== null) fences.push(m[1]);
    if (fences.length === 0) return { ok: false, reason: '回复末尾没有 ```json 围栏(agent 未按页面契约输出)' };
    try {
      return { ok: true, data: JSON.parse(fences[fences.length - 1]) };
    } catch (e) {
      return { ok: false, reason: 'json 围栏解析失败:' + String(e.message || e).slice(0, 120) };
    }
  }

  // ── 服务脸(确定性流直连,零模型)─────────────────────────────────────────
  // discoverServices(presetId) → Promise<{ sqlite?: {url, token}, ... } | null>
  //   (无脸/零件未挂载 → null,调用方静默降级回会话面;结果缓存本页生命周期)
  // sqliteFace(svc) → { sql(sql, params) → Promise<{rows?|changes?}>, schema() }
  var svcCache = {};
  function discoverServices(presetId) {
    if (svcCache[presetId] !== undefined) return Promise.resolve(svcCache[presetId]);
    return fetch('/assembler/ui/' + encodeURIComponent(presetId) + '/.service')
      .then(function (r) { return r.ok ? r.json() : null; })
      .catch(function () { return null; })
      .then(function (svc) { svcCache[presetId] = svc; return svc; });
  }

  // ai 服务脸:薄判断直连(ai-thin 路由)——一次补全,不开会话。
  function aiFace(svc) {
    if (!svc || !svc.ai) return null;
    var base = svc.ai.url, token = svc.ai.token;
    return {
      complete: function (req) {
        return fetch(base + '/complete', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Service-Token': token },
          body: JSON.stringify(req || {}),
        }).then(function (r) { return r.json(); }).then(function (j) {
          if (j.error) throw new Error(j.error);
          return j;
        });
      },
    };
  }

  // 公共文件通道:大字节直传/取回,不过模型(页面喂文件的正确姿势)。
  function filesFace(svc) {
    if (!svc || !svc.files) return null;
    var base = svc.files.url, token = svc.files.token;
    return {
      upload: function (name, blob) {
        return fetch(base + '/upload/' + encodeURIComponent(name), { method: 'POST', headers: { 'X-Service-Token': token }, body: blob })
          .then(function (r) { return r.json(); }).then(function (j) { if (j.error) throw new Error(j.error); return j; });
      },
      list: function () {
        return fetch(base + '/list', { headers: { 'X-Service-Token': token } })
          .then(function (r) { return r.json(); }).then(function (j) { if (j.error) throw new Error(j.error); return j; });
      },
      fileUrl: function (name) { return base + '/file/' + encodeURIComponent(name); },
    };
  }

  function sqliteFace(svc) {
    if (!svc || !svc.sqlite) return null;
    var base = svc.sqlite.url, token = svc.sqlite.token;
    function call(path, opts) {
      opts = opts || {};
      opts.headers = Object.assign({ 'X-Service-Token': token }, opts.headers || {});
      return fetch(base + path, opts).then(function (r) { return r.json(); }).then(function (j) {
        if (j.error) throw new Error(j.error);
        return j;
      });
    }
    return {
      sql: function (sql, params) {
        return call('/sql', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sql: sql, params: params || [] }) });
      },
      schema: function () { return call('/schema'); },
    };
  }

  // ── 通用 UI 原子 ──────────────────────────────────────────────────────────
  // bindEnter(el, fn):回车触发,IME 守卫内置(选字确认回车不触发——中文用户
  // 半句话被发出去的 bug 类在此一次根治,所有页面自动受益)。
  function bindEnter(el, fn) {
    el.addEventListener('keydown', function (e) {
      if (e.isComposing || e.keyCode === 229) return;
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); fn(); }
    });
  }

  // renderRowsTable(host, rows, { esc }):行数组 → uk-table(直连台账通用渲染)。
  function esc(v) { return String(v === null || v === undefined ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;'); }
  function renderRowsTable(host, rows) {
    if (!rows || rows.length === 0) { host.innerHTML = '<div class="text-muted-foreground text-sm">(空表)</div>'; return; }
    var cols = Object.keys(rows[0]);
    host.innerHTML = '<table class="uk-table uk-table-divider uk-table-sm"><thead><tr>'
      + cols.map(function (c) { return '<th>' + esc(c) + '</th>'; }).join('') + '</tr></thead><tbody>'
      + rows.map(function (r) { return '<tr>' + cols.map(function (c) { return '<td>' + esc(r[c]) + '</td>'; }).join('') + '</tr>'; }).join('')
      + '</tbody></table>';
  }

  // mountLiveLedger({ presetId, cardEl, tableSel, hostEl, refreshBtn }):
  // 直连台账标准件——服务脸在场才显示卡片,选表+渲染+手动刷新;返回 refresh()
  // 供"agent 答完一轮"后顺手调用。无脸 → 卡片保持隐藏,返回 no-op。
  function mountLiveLedger(opts) {
    var face = null, refresh = function () {};
    var p = discoverServices(opts.presetId).then(function (svc) {
      face = sqliteFace(svc);
      if (!face) return;
      return face.schema().then(function (sch) {
        var tables = (sch.tables || []).map(function (t) { return t.name; });
        if (tables.length === 0) return;
        opts.tableSel.innerHTML = tables.map(function (t) { return '<option>' + esc(t) + '</option>'; }).join('');
        opts.cardEl.style.display = '';
        refresh = function () {
          var t = opts.tableSel.value;
          if (!t) return Promise.resolve();
          return face.sql('SELECT * FROM "' + t.replace(/"/g, '""') + '" ORDER BY rowid DESC LIMIT 30')
            .then(function (r) { renderRowsTable(opts.hostEl, r.rows); })
            .catch(function (e) { opts.hostEl.innerHTML = '<div class="text-muted-foreground text-sm">直连读取失败:' + esc(e.message || e) + '</div>'; });
        };
        opts.tableSel.onchange = refresh;
        if (opts.refreshBtn) opts.refreshBtn.onclick = refresh;
        return refresh();
      });
    }).catch(function () { /* 无脸:卡片保持隐藏 */ });
    return { refresh: function () { return p.then(function () { return refresh(); }); } };
  }

  window.AssemblerSDK = {
    createClient: createClient,
    extractFence: extractFence,
    discoverServices: discoverServices,
    sqliteFace: sqliteFace,
    aiFace: aiFace,
    filesFace: filesFace,
    bindEnter: bindEnter,
    renderRowsTable: renderRowsTable,
    mountLiveLedger: mountLiveLedger,
    esc: esc,
  };
})();
