// 设置页：填 DSH 地址、点「测试连接」、保存到 storage.local。
// 归一化规则和 background.js / content.js 里那两份保持一致（默认地址也各写一处常量）。
(() => {
  const DEFAULT_BASE = 'http://127.0.0.1:3080';
  const BASE_KEY = 'baseUrl';
  const TEST_TIMEOUT_MS = 3000;
  const TEST_PATH = '/page-chat/health';

  const api = globalThis.browser || chrome;
  const el = (id) => document.getElementById(id);
  const input = el('base');
  const btnTest = el('test');
  const btnSave = el('save');
  const status = el('status');
  const saved = el('saved');
  const hint = el('hint');

  // 空 = 用默认；缺 http:// 自动补；去掉结尾斜杠；非 http(s) 视为非法（回退默认）。
  function normalizeBase(raw) {
    const text = typeof raw === 'string' ? raw.trim() : '';
    if (!text) return { base: DEFAULT_BASE, ok: true, empty: true };
    const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : 'http://' + text;
    try {
      const u = new URL(withScheme);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return { base: DEFAULT_BASE, ok: false };
      if (!u.hostname) return { base: DEFAULT_BASE, ok: false };
      return { base: u.protocol + '//' + u.host + u.pathname.replace(/\/+$/, ''), ok: true };
    } catch {
      return { base: DEFAULT_BASE, ok: false };
    }
  }

  function clearLastError() {
    try {
      const rt = api.runtime || (globalThis.chrome && chrome.runtime);
      if (rt) void rt.lastError;
    } catch {}
  }

  // Chrome 走回调 / Firefox 走 Promise：两边都接，用 once 防止回调被叫两次。
  function once(fn) {
    let done = false;
    return (value) => {
      if (done) return;
      done = true;
      fn(value);
    };
  }

  function storageGet(done) {
    const cb = once(done);
    try {
      const st = api.storage;
      if (!st || !st.local || typeof st.local.get !== 'function') return cb(undefined);
      const ret = st.local.get(BASE_KEY, (obj) => {
        clearLastError();
        cb(obj && obj[BASE_KEY]);
      });
      if (ret && typeof ret.then === 'function') {
        ret.then((obj) => cb(obj && obj[BASE_KEY]), () => cb(undefined));
      }
    } catch {
      cb(undefined);
    }
  }

  function storageSet(value, done) {
    const cb = once(done);
    try {
      const st = api.storage;
      if (!st || !st.local || typeof st.local.set !== 'function') return cb(false);
      const ret = st.local.set({ [BASE_KEY]: value }, () => {
        clearLastError();
        cb(true);
      });
      if (ret && typeof ret.then === 'function') ret.then(() => cb(true), () => cb(false));
    } catch {
      cb(false);
    }
  }

  function setStatus(text, kind) {
    status.textContent = text;
    status.className = 'status' + (kind ? ' ' + kind : '');
  }

  function showSaved(text) {
    saved.textContent = text;
    saved.className = 'saved show';
  }

  // 把 fetch 的各种失败翻成人话，别把 "Failed to fetch" 直接甩给用户。
  function reasonOf(error) {
    if (!error) return '未知原因';
    if (error.name === 'AbortError') return '3 秒没有回应';
    const msg = String(error.message || error);
    if (/Failed to fetch|NetworkError|Load failed/i.test(msg)) return '这个地址上没有服务在应答';
    return msg;
  }

  function hintOffline() {
    hint.textContent = '先确认 dsh web 在跑，端口看它启动时打印的地址。';
  }

  function hintNormal() {
    hint.textContent = '只填 127.0.0.1:3081 也行，会自动补成 http://。';
  }

  async function testConnection() {
    const n = normalizeBase(input.value);
    if (!n.ok) {
      setStatus('这不像一个网址（要以 http:// 或 https:// 开头），改一下再测。', 'bad');
      return;
    }
    btnTest.disabled = true;
    btnTest.textContent = '测试中…';
    setStatus('正在连 ' + n.base + ' …', '');
    hintNormal();
    const ctl = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = ctl ? setTimeout(() => ctl.abort(), TEST_TIMEOUT_MS) : 0;
    try {
      const res = await fetch(n.base + TEST_PATH, { cache: 'no-store', signal: ctl ? ctl.signal : undefined });
      const raw = await res.text();
      let data = null;
      try {
        data = JSON.parse(raw);
      } catch {}
      if (!res.ok) {
        setStatus('连不上：那台服务回了 HTTP ' + res.status + '，可能不是 DSH。', 'bad');
      } else if (!data) {
        setStatus('连上了，但那边回的不是 DSH 的健康检查。地址对吗？', 'bad');
      } else if (data.version) {
        setStatus('连上了 · 插件版本 ' + data.version, 'ok');
      } else {
        setStatus('连上了 · 插件在，但没读到版本号', 'ok');
      }
    } catch (error) {
      setStatus('连不上：' + reasonOf(error), 'bad');
      hintOffline();
    } finally {
      if (timer) clearTimeout(timer);
      btnTest.disabled = false;
      btnTest.textContent = '测试连接';
    }
  }

  function save() {
    const n = normalizeBase(input.value);
    btnSave.disabled = true;
    storageSet(n.base, (ok) => {
      btnSave.disabled = false;
      if (!ok) {
        setStatus('保存失败：这个页面没有写存储的权限。', 'bad');
        return;
      }
      input.value = n.base; // 把归一化后的地址回填，用户看得到最终生效的是什么
      if (!n.ok) {
        showSaved('这不像一个网址，已按默认地址保存 · 回到网页刷新一下');
      } else {
        showSaved('已保存 · 回到网页刷新一下');
      }
      setStatus('现在生效：' + n.base, '');
      hintNormal();
    });
  }

  btnTest.addEventListener('click', testConnection);
  btnSave.addEventListener('click', save);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      save();
    }
  });

  // 打开页面先把已存的地址填上（没存过就显示默认地址，并说明「现在生效」）。
  storageGet((raw) => {
    const n = normalizeBase(raw);
    input.value = n.base;
    setStatus('现在生效：' + n.base, '');
  });
})();
