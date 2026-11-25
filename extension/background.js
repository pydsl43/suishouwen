// 后台：右键菜单、代发请求、整页截图。
// 为什么请求要从这里发：内容脚本发的请求算「页面自己发的」，会被跨域策略拦；
// 扩展后台有 host 权限，不受页面约束。
// 接口挂在 DSH web 自己的 3080 端口上（/page-chat/*），不再走老的本地桥服务。
const api = globalThis.browser || chrome;

const BASE = 'http://127.0.0.1:3080';
const NO_DSH = '连不上 DSH（127.0.0.1:3080 没在跑？）';

const setActionTitle = (title) => {
  const action = chrome.action || chrome.browserAction;
  if (action && action.setTitle) {
    try { action.setTitle({ title }); } catch {}
  }
};
setActionTitle('随手问（选中文字或右键）');

function buildMenus() {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: 'dsh-ask-selection',
      title: '随手问这段',
      contexts: ['selection'],
    });
    chrome.contextMenus.create({
      id: 'dsh-ask-region',
      title: '框选一块截图随手问',
      contexts: ['page', 'selection', 'image', 'link', 'editable'],
    });
  });
}

chrome.runtime.onInstalled.addListener(buildMenus);
chrome.runtime.onStartup.addListener(buildMenus);
buildMenus(); // 非持久后台每次被唤醒都兜一遍，菜单不会因为重启没了

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (!tab || !tab.id) return;
  const type = info.menuItemId === 'dsh-ask-region' ? 'dsh-open-region' : 'dsh-open-chat';
  chrome.tabs.sendMessage(tab.id, { type, selection: info.selectionText || '' }, () => {
    void chrome.runtime.lastError; // about:、PDF 阅读器等注入不进去的页面
  });
});

const action = chrome.action || chrome.browserAction;
if (action && action.onClicked) {
  action.onClicked.addListener((tab) => {
    if (!tab || !tab.id) return;
    chrome.tabs.sendMessage(tab.id, { type: 'dsh-open-chat' }, () => void chrome.runtime.lastError);
  });
}

async function captureTab(tabId) {
  const tabs = api.tabs || chrome.tabs;
  try {
    if (tabs.captureTab) return await tabs.captureTab(tabId, { format: 'png' });
    if (tabs.captureVisibleTab) {
      const tab = await tabs.get(tabId);
      return await tabs.captureVisibleTab(tab.windowId, { format: 'png' });
    }
  } catch (e) {
    return null;
  }
  return null;
}

async function postJson(path, body) {
  return fetch(BASE + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

// ── 装好就报到 ────────────────────────────────────────────────────────────
// 每次后台启动（MV3 唤醒 / MV2 开机）与安装 / 升级时，往 DSH 报一次版本。
// DSH 没在跑时请求必然失败 —— 全部静默：不弹错、不写 console，免得每次开浏览器都吵。

function browserNameOf() {
  const ua = (globalThis.navigator && navigator.userAgent) || '';
  if (/Firefox\//i.test(ua)) return 'firefox';
  if (/Chrome\//i.test(ua) && !/Edg\//i.test(ua)) return 'chrome';
  return 'chromium'; // Edge / 其它 Chromium：分不清就报 chromium
}

// 当前活动标签的站点名。拿不到（只有 activeTab 权限、页面是 about: 等）就返回空串。
function activeHostOf() {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const pick = (list) => {
      const tab = Array.isArray(list) ? list[0] : null;
      const url = tab && (tab.url || tab.pendingUrl);
      if (!url) return finish('');
      try {
        finish(new URL(url).hostname || '');
      } catch {
        finish('');
      }
    };
    try {
      const tabs = api.tabs || chrome.tabs;
      if (!tabs || typeof tabs.query !== 'function') return finish('');
      // Chrome 走回调、Firefox 走 Promise：两边都接，谁先到算谁的。
      const ret = tabs.query({ active: true, lastFocusedWindow: true }, (list) => {
        void chrome.runtime.lastError;
        pick(list);
      });
      if (ret && typeof ret.then === 'function') ret.then(pick, () => finish(''));
      setTimeout(() => finish(''), 1000);
    } catch {
      finish('');
    }
  });
}

async function reportInstalled() {
  try {
    const version = chrome.runtime.getManifest().version;
    const page = await activeHostOf();
    await postJson('/page-chat/ping', { version, browser: browserNameOf(), page });
  } catch {
    /* DSH 没在跑 / 权限不够：静默 */
  }
}

chrome.runtime.onInstalled.addListener(() => {
  reportInstalled();
});
reportInstalled(); // service worker 每次启动（MV2 每次开浏览器）都报一次


// 服务回的是 NDJSON（一行一个 JSON）：ack / delta / done / error。
// delta 是分段文字，done 只带轮数；这里攒成完整一段再交给小框。
function readNdjson(raw) {
  let text = '';
  let error = '';
  let turns = 0;
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const ev = JSON.parse(line);
      if (ev.type === 'delta') text += ev.text || '';
      else if (ev.type === 'done') {
        if (typeof ev.text === 'string') text = ev.text;
        turns = ev.turns || 0;
      } else if (ev.type === 'error') error = ev.message || 'DSH 报了错';
    } catch {}
  }
  return { text, error, turns };
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !msg.type) return;

  if (msg.type === 'dsh-chat') {
    postJson('/page-chat/ask', { key: msg.key, text: msg.text, images: msg.images || [] })
      .then(async (res) => {
        const { text, error, turns } = readNdjson(await res.text());
        if (error) return sendResponse({ error });
        if (!text) {
          return sendResponse({
            error: res.ok ? 'DSH 没回话（HTTP ' + res.status + '）' : 'DSH 那边出错了（HTTP ' + res.status + '）',
          });
        }
        sendResponse({ text, turns });
      })
      .catch(() => sendResponse({ error: NO_DSH }));
    return true;
  }

  if (msg.type === 'dsh-reset') {
    postJson('/page-chat/reset', { key: msg.key })
      .then((res) => sendResponse({ ok: res.ok }))
      .catch(() => sendResponse({ ok: false, error: NO_DSH }));
    return true;
  }

  if (msg.type === 'dsh-memorize') {
    postJson('/page-chat/memorize', { key: msg.key, page: msg.page || {}, images: msg.images || [] })
      .then(async (res) => {
        const raw = await res.text();
        let data = {};
        try { data = JSON.parse(raw); } catch {}
        if (!res.ok || !data || data.ok !== true) {
          return sendResponse({ error: (data && data.error) || '记住失败（HTTP ' + res.status + '）' });
        }
        sendResponse({ card: data.card });
      })
      .catch(() => sendResponse({ error: NO_DSH }));
    return true;
  }

  if (msg.type === 'dsh-memorize-undo') {
    postJson('/page-chat/memorize/undo', { id: msg.id })
      .then(async (res) => {
        const raw = await res.text();
        let data = {};
        try { data = JSON.parse(raw); } catch {}
        sendResponse({ ok: res.ok && !!data && data.ok === true, error: data && data.error });
      })
      .catch(() => sendResponse({ ok: false, error: NO_DSH }));
    return true;
  }

  if (msg.type === 'dsh-to-board') {
    const page = msg.page || {};
    postJson('/page-chat/to-board', {
      key: msg.key,
      page,
      ask: msg.ask || '',
      // source 由这里补全（网页侧只给 url / title，站点名让插件按 URL 推）
      source: { url: page.url || '', title: page.title || '' },
    })
      .then(async (res) => {
        const raw = await res.text();
        let data = {};
        try { data = JSON.parse(raw); } catch {}
        if (!res.ok || !data || data.ok !== true) {
          return sendResponse({ error: (data && data.error) || '存进看板失败（HTTP ' + res.status + '）' });
        }
        sendResponse({ cardId: data.cardId, project: data.project || '' });
      })
      .catch(() => sendResponse({ error: NO_DSH }));
    return true;
  }

  if (msg.type === 'dsh-capture') {
    const tabId = sender && sender.tab ? sender.tab.id : null;
    if (!tabId) return sendResponse({ dataUrl: '' });
    captureTab(tabId).then((dataUrl) => sendResponse({ dataUrl: dataUrl || '' }));
    return true;
  }
});
