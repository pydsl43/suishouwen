// 页面里那个「随手问」的小框。
//
// 两条入口：右键选中文字 → 随手问；右键框选截图 → 拉一个框，图跟着问题一起发。
// 所有请求都过 background 转发（内容脚本直接连本机端口会被页面的跨域策略挡掉）。
// 小框活在 shadow DOM 里，页面的样式碰不到它。
// 记忆、云同步不在这里：那些已经搬进 DSH 自己的页面面板。
(() => {
  if (window.__dshChatInstalled) return;
  window.__dshChatInstalled = true;

  const KEY_STORE = 'dsh-chat-key';
  const POS_STORE = 'dsh-chat-pos';
  const NO_DSH = '连不上 DSH（127.0.0.1:3080 没在跑？）';

  let host = null;      // shadow host
  let root = null;      // shadow root
  let panel = null;     // 面板元素
  let busy = false;

  function chatKey() {
    let k = sessionStorage.getItem(KEY_STORE);
    if (!k) {
      k = 'tab-' + Math.random().toString(36).slice(2, 10) + '-' + Date.now().toString(36);
      sessionStorage.setItem(KEY_STORE, k);
    }
    return k;
  }

  // ---------- 面板 ----------
  function ensurePanel() {
    if (host && document.documentElement.contains(host)) return;
    host = document.createElement('div');
    host.id = '__dsh_chat_host';
    host.style.cssText = 'all:initial;position:fixed;z-index:2147483647;right:24px;bottom:24px;';
    root = host.attachShadow({ mode: 'open' });
    root.innerHTML = TEMPLATE;
    document.documentElement.appendChild(host);
    panel = root.querySelector('.panel');

    const pos = sessionStorage.getItem(POS_STORE);
    if (pos) {
      try {
        const p = JSON.parse(pos);
        if (typeof p.left === 'number' && typeof p.top === 'number') place(p.left, p.top);
      } catch {}
    }

    root.querySelector('.close').addEventListener('click', close);
    root.querySelector('.fresh').addEventListener('click', () => {
      const key = chatKey();
      sessionStorage.removeItem(KEY_STORE);
      chrome.runtime.sendMessage({ type: 'dsh-reset', key }, () => void chrome.runtime.lastError);
      root.querySelector('.log').innerHTML = '';
      systemNote('新开一段对话。');
      void key;
    });
    root.querySelector('.send').addEventListener('click', submit);
    root.querySelector('.memo').addEventListener('click', remember);
    root.querySelector('.board').addEventListener('click', toBoard);
    const box = root.querySelector('.box');
    box.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        submit();
      }
      e.stopPropagation();
    });
    // 面板里的按键、滚动、复制不要漏给页面
    for (const t of ['keydown', 'keyup', 'keypress', 'click', 'mousedown', 'wheel', 'paste', 'copy']) {
      root.addEventListener(t, (e) => e.stopPropagation());
    }
    dragByHeader();
    document.addEventListener('keydown', onGlobalKey, true);
  }

  function onGlobalKey(e) {
    if (e.key === 'Escape' && isOpen()) {
      e.stopPropagation();
      close();
    }
  }

  function dragByHeader() {
    const bar = root.querySelector('.bar');
    let sx = 0, sy = 0, ox = 0, oy = 0, dragging = false;
    bar.addEventListener('mousedown', (e) => {
      if (e.target.closest('.close, .fresh, .board')) return;
      const r = panel.getBoundingClientRect();
      sx = e.clientX; sy = e.clientY; ox = r.left; oy = r.top; dragging = true;
      e.preventDefault();
    });
    window.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      place(ox + e.clientX - sx, oy + e.clientY - sy);
    }, true);
    window.addEventListener('mouseup', () => {
      if (!dragging) return;
      dragging = false;
      const r = panel.getBoundingClientRect();
      sessionStorage.setItem(POS_STORE, JSON.stringify({ left: r.left, top: r.top }));
    }, true);
  }

  function place(left, top) {
    const r = panel.getBoundingClientRect();
    const maxLeft = Math.max(8, window.innerWidth - r.width - 8);
    const maxTop = Math.max(8, window.innerHeight - r.height - 8);
    host.style.right = 'auto';
    host.style.bottom = 'auto';
    host.style.left = Math.min(Math.max(8, left), maxLeft) + 'px';
    host.style.top = Math.min(Math.max(8, top), maxTop) + 'px';
  }

  function isOpen() {
    return !!(host && panel && panel.style.display !== 'none');
  }

  function open() {
    hideBubble();
    ensurePanel();
    panel.style.display = 'flex';
    setTimeout(() => root.querySelector('.box').focus(), 30);
  }

  function close() {
    if (panel) panel.style.display = 'none';
  }

  function setBusy(on) {
    busy = on;
    const btn = root.querySelector('.send');
    btn.disabled = on;
    btn.textContent = on ? '…' : '问';
    root.querySelector('.typing').style.display = on ? 'flex' : 'none';
  }

  // ---------- 消息 ----------
  function bubble(role, text) {
    const el = document.createElement('div');
    el.className = 'msg ' + role;
    el.textContent = text;
    const log = root.querySelector('.log');
    log.appendChild(el);
    log.scrollTop = log.scrollHeight;
    return el;
  }

  function systemNote(text) {
    const el = document.createElement('div');
    el.className = 'note';
    el.textContent = text;
    const log = root.querySelector('.log');
    log.appendChild(el);
    log.scrollTop = log.scrollHeight;
  }

  function attachQuote(text) {
    const box = root.querySelector('.quote');
    box.textContent = text;
    box.style.display = 'block';
  }

  function attachImage(dataUrl) {
    const box = root.querySelector('.shot');
    box.src = dataUrl;
    box.style.display = 'block';
    box.dataset.payload = dataUrl;
  }

  function clearAttachments() {
    const q = root.querySelector('.quote');
    q.style.display = 'none';
    q.textContent = '';
    const s = root.querySelector('.shot');
    s.style.display = 'none';
    s.src = '';
    delete s.dataset.payload;
  }

  function typeOut(el, text) {
    let i = 0;
    const step = Math.max(1, Math.round(text.length / 90));
    const timer = setInterval(() => {
      i += step;
      el.textContent = text.slice(0, i);
      root.querySelector('.log').scrollTop = root.querySelector('.log').scrollHeight;
      if (i >= text.length) {
        clearInterval(timer);
        el.textContent = text;
      }
    }, 16);
  }

  // ---------- 记住这段 ----------
  // 只有你点它才存：把这段对话压成一张卡，落到 DSH 那边的记忆库。
  // 5 秒内再点一下就是撤销（误点的情况很常见）。
  let memoId = '';
  let memoTimer = 0;

  function resetMemoBtn() {
    const btn = root.querySelector('.memo');
    clearTimeout(memoTimer);
    memoId = '';
    if (!btn) return;
    btn.disabled = false;
    btn.textContent = '记住这段';
    btn.classList.remove('on');
  }

  function remember() {
    const btn = root.querySelector('.memo');
    if (!btn || btn.disabled) return;
    if (memoId) {
      const id = memoId;
      resetMemoBtn();
      chrome.runtime.sendMessage({ type: 'dsh-memorize-undo', id }, (res) => {
        void chrome.runtime.lastError;
        systemNote(res && res.ok ? '已撤销，这段没留下。' : '撤销没成功：' + ((res && res.error) || NO_DSH));
      });
      return;
    }
    const shot = root.querySelector('.shot');
    const imageData = shot.style.display !== 'none' ? shot.dataset.payload : '';
    const images = [];
    if (imageData) {
      const b64 = imageData.split(',')[1] || '';
      if (b64) images.push({ mimeType: 'image/png', data: b64 });
    }
    btn.disabled = true;
    btn.textContent = '记住中…';
    chrome.runtime.sendMessage(
      {
        type: 'dsh-memorize',
        key: chatKey(),
        page: { url: location.href, title: document.title },
        images,
      },
      (res) => {
        void chrome.runtime.lastError;
        btn.disabled = false;
        if (!res || res.error || !res.card) {
          btn.textContent = '记住这段';
          systemNote('没记住：' + ((res && res.error) || NO_DSH));
          return;
        }
        memoId = res.card.id;
        btn.textContent = '已记住 ✓（点一下撤销）';
        btn.classList.add('on');
        memoTimer = setTimeout(resetMemoBtn, 5000);
        systemNote('已存成记忆卡：' + (res.card.title || ''));
      },
    );
  }

  // ---------- 存成看板卡 ----------
  // 把这段聊的变成看板「用户待办」里的一张卡：网页里看见的东西，一键变成要跟进的事。
  // 看板插件没装 / 没开时说清原因，不把原始堆栈甩给用户。
  let boardTimer = 0;

  function resetBoardBtn() {
    const btn = root.querySelector('.board');
    clearTimeout(boardTimer);
    if (!btn) return;
    btn.disabled = false;
    btn.textContent = '存成看板卡';
    btn.classList.remove('on');
  }

  function toBoard() {
    const btn = root.querySelector('.board');
    if (!btn || btn.disabled) return;
    const quote = root.querySelector('.quote');
    const quoted = quote.style.display !== 'none' ? quote.textContent.trim() : '';
    const box = root.querySelector('.box');
    const ask = quoted || (box ? box.value.trim() : '');
    btn.disabled = true;
    btn.textContent = '存中…';
    chrome.runtime.sendMessage(
      {
        type: 'dsh-to-board',
        key: chatKey(),
        page: { url: location.href, title: document.title },
        ask,
      },
      (res) => {
        void chrome.runtime.lastError;
        if (!res || res.error || !res.cardId) {
          resetBoardBtn();
          systemNote('没存进看板：' + ((res && res.error) || NO_DSH));
          return;
        }
        btn.disabled = false;
        btn.classList.add('on');
        btn.textContent = '已进看板 ✓（' + String(res.cardId).slice(0, 8) + '）';
        systemNote('已在看板『待你定』里');
        clearTimeout(boardTimer);
        boardTimer = setTimeout(resetBoardBtn, 3000);
      },
    );
  }

  function submit() {
    if (busy) return;
    const box = root.querySelector('.box');
    const text = box.value.trim();
    const quote = root.querySelector('.quote');
    const quoted = quote.style.display !== 'none' ? quote.textContent.trim() : '';
    const shot = root.querySelector('.shot');
    const imageData = shot.style.display !== 'none' ? shot.dataset.payload : '';
    if (!text && !imageData) return;

    const images = [];
    if (imageData) {
      const b64 = imageData.split(',')[1] || '';
      if (b64) images.push({ mimeType: 'image/png', data: b64 });
    }

    // 选中的原文是小框里的「引用条」，提问时一起带上，不然模型看不见它。
    const outgoing = quoted && text
      ? '【选中的原文】\n' + quoted + '\n\n【我的问题】\n' + text
      : text;

    const shown = text || '（这张图）';
    const u = bubble('me', shown);
    if (imageData) {
      const thumb = document.createElement('img');
      thumb.src = imageData;
      thumb.className = 'thumb';
      u.appendChild(thumb);
    }
    box.value = '';
    clearAttachments();
    setBusy(true);

    const pending = bubble('dsh', '');
    pending.classList.add('pending');
    pending.textContent = '……';

    chrome.runtime.sendMessage(
      { type: 'dsh-chat', key: chatKey(), text: outgoing, images },
      (res) => {
        void chrome.runtime.lastError;
        setBusy(false);
        pending.classList.remove('pending');
        if (!res || res.error) {
          pending.classList.add('err');
          pending.textContent = '没问成：' + ((res && res.error) || NO_DSH);
          return;
        }
        pending.textContent = '';
        typeOut(pending, res.text || '（它没说话）');
      },
    );
  }

  // ---------- 框选截图 ----------
  function pickRegion() {
    return new Promise((resolve) => {
      const layer = document.createElement('div');
      layer.style.cssText = [
        'all:initial', 'position:fixed', 'inset:0', 'z-index:2147483646',
        'cursor:crosshair', 'background:rgba(0,0,0,.18)',
      ].join(';');
      const rect = document.createElement('div');
      rect.style.cssText = [
        'all:initial', 'position:fixed', 'border:2px solid #2a6df4',
        'background:rgba(42,109,244,.12)', 'display:none', 'pointer-events:none',
      ].join(';');
      const tip = document.createElement('div');
      tip.textContent = '拉一个框，Esc 取消';
      tip.style.cssText = [
        'all:initial', 'position:fixed', 'left:50%', 'top:16px', 'transform:translateX(-50%)',
        'background:#111', 'color:#fff', 'font:13px/1.6 system-ui,sans-serif',
        'padding:6px 12px', 'border-radius:999px',
      ].join(';');
      layer.appendChild(rect);
      layer.appendChild(tip);
      document.documentElement.appendChild(layer);

      let x0 = 0, y0 = 0, drawing = false;
      const done = (value) => {
        layer.remove();
        document.removeEventListener('keydown', esc, true);
        resolve(value);
      };
      const esc = (e) => {
        if (e.key === 'Escape') {
          e.stopPropagation();
          done(null);
        }
      };
      document.addEventListener('keydown', esc, true);

      layer.addEventListener('mousedown', (e) => {
        drawing = true;
        x0 = e.clientX;
        y0 = e.clientY;
        rect.style.display = 'block';
        e.preventDefault();
      });
      layer.addEventListener('mousemove', (e) => {
        if (!drawing) return;
        const x = Math.min(x0, e.clientX);
        const y = Math.min(y0, e.clientY);
        const w = Math.abs(e.clientX - x0);
        const h = Math.abs(e.clientY - y0);
        rect.style.cssText += `;left:${x}px;top:${y}px;width:${w}px;height:${h}px;display:block`;
        rect.dataset.x = String(x);
        rect.dataset.y = String(y);
        rect.dataset.w = String(w);
        rect.dataset.h = String(h);
      });
      layer.addEventListener('mouseup', () => {
        if (!drawing) return;
        drawing = false;
        const w = Number(rect.dataset.w || 0);
        const h = Number(rect.dataset.h || 0);
        if (w < 8 || h < 8) return done(null);
        done({
          x: Number(rect.dataset.x),
          y: Number(rect.dataset.y),
          w,
          h,
          dpr: window.devicePixelRatio || 1,
        });
      });
    });
  }

  // 整页截图拿到的是整块画布，按拉框坐标裁出那一小块
  function crop(dataUrl, r) {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        const sx = Math.round(r.x * r.dpr);
        const sy = Math.round(r.y * r.dpr);
        const sw = Math.round(r.w * r.dpr);
        const sh = Math.round(r.h * r.dpr);
        const c = document.createElement('canvas');
        c.width = Math.max(1, sw);
        c.height = Math.max(1, sh);
        const ctx = c.getContext('2d');
        ctx.drawImage(img, sx, sy, sw, sh, 0, 0, sw, sh);
        try {
          resolve(c.toDataURL('image/png'));
        } catch {
          resolve(dataUrl);
        }
      };
      img.onerror = () => resolve('');
      img.src = dataUrl;
    });
  }

  function captureTabShot() {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage({ type: 'dsh-capture' }, (res) => {
        void chrome.runtime.lastError;
        resolve(res && res.dataUrl ? res.dataUrl : '');
      });
    });
  }

  function startRegion(userStroke) {
    open();
    clearAttachments();
    pickRegion()
      .then((r) => {
        if (!r) return '';
        systemNote('正在截取那一块…');
        return captureTabShot().then((shot) => {
          if (!shot) {
            systemNote('截不到图：Firefox 需要这一个标签页的临时权限，刷新页面后再试。');
            return '';
          }
          return crop(shot, r);
        });
      })
      .then((cropped) => {
        if (!cropped) return;
        attachImage(cropped);
        if (userStroke) {
          systemNote('图已放进框里，写一句你想问的，回车发出。');
        }
      });
  }

  // ---------- 划词浮标 ----------
  // 在普通网页上选中一段字，选区末端右下角冒出一个「随手问」的小胶囊。
  // 它自己一个 shadow host：层级比小框低一档（2147483645 < 2147483647），样式也不会漏到页面上。
  const BUBBLE_TEMPLATE = `
<style>
  :host { all: initial; }
  .bubble {
    display: inline-block; padding: 5px 12px; border-radius: 999px;
    background: #2a6df4; color: #fff; cursor: pointer; white-space: nowrap;
    font: 12px/1.5 -apple-system, "Segoe UI", "Microsoft YaHei", system-ui, sans-serif;
    box-shadow: 0 2px 8px rgba(0,0,0,.18);
    user-select: none; -webkit-user-select: none;
  }
  .bubble:hover { background: #1f5cd6; }
</style>
<div class="bubble" role="button" title="把选中的文字带进随手问">随手问</div>`;

  let bubbleHost = null;   // 浮标的 shadow host
  let bubbleEl = null;     // 那个胶囊
  let bubbleTimer = 0;     // 出现前的延迟
  let bubbleText = '';     // 点下去时要带走的文字

  function ensureBubble() {
    if (bubbleHost && document.documentElement.contains(bubbleHost)) return;
    bubbleHost = document.createElement('div');
    bubbleHost.id = '__dsh_bubble_host';
    bubbleHost.style.cssText = 'all:initial;position:fixed;z-index:2147483645;left:0;top:0;display:none;';
    const r = bubbleHost.attachShadow({ mode: 'open' });
    r.innerHTML = BUBBLE_TEMPLATE;
    bubbleEl = r.querySelector('.bubble');
    document.documentElement.appendChild(bubbleHost);

    // 点浮标不能先把页面上的选区清掉：mousedown 一 preventDefault 就保住了。
    bubbleEl.addEventListener('mousedown', (e) => {
      e.preventDefault();
      e.stopPropagation();
    });
    bubbleEl.addEventListener('click', onBubbleClick);
    // 浮标上的按键/点击也别漏给页面
    for (const t of ['mouseup', 'pointerdown', 'pointerup', 'click', 'keydown']) {
      r.addEventListener(t, (e) => e.stopPropagation());
    }
  }

  function hideBubble() {
    clearTimeout(bubbleTimer);
    bubbleTimer = 0;
    bubbleText = '';
    if (bubbleHost) bubbleHost.style.display = 'none';
  }

  // 这个节点是不是我们自己的框（面板或浮标）里的
  function inOurUi(node) {
    for (let n = node; n; n = n.parentNode || n.host || null) {
      if (n === host || n === bubbleHost) return true;
    }
    return false;
  }

  function hitOurUi(e) {
    let path = [];
    try {
      path = typeof e.composedPath === 'function' ? e.composedPath() : [];
    } catch {
      path = [];
    }
    for (const n of path) {
      if (n === host || n === bubbleHost) return true;
    }
    return false;
  }

  // 当前选区够长、不是空白、不在我们自己的框里，才返回文字和末端方块
  function readSelection() {
    let sel = null;
    try {
      sel = window.getSelection();
    } catch {
      return null;
    }
    if (!sel || sel.isCollapsed || !sel.rangeCount) return null;
    if (document.activeElement === host || document.activeElement === bubbleHost) return null;

    const text = String(sel.toString() || '').trim();
    if (text.length < 2) return null;

    let rect = null;
    try {
      for (let i = 0; i < sel.rangeCount; i++) {
        const range = sel.getRangeAt(i);
        if (inOurUi(range.commonAncestorContainer)) return null;
      }
      if (inOurUi(sel.anchorNode) || inOurUi(sel.focusNode)) return null;

      // 取最后一个有面积的方块：多行选区就是「末端」那一块
      const last = sel.getRangeAt(sel.rangeCount - 1);
      const rects = last.getClientRects();
      for (let i = rects.length - 1; i >= 0; i--) {
        const r = rects[i];
        if (r && (r.width || r.height)) {
          rect = r;
          break;
        }
      }
      if (!rect) rect = last.getBoundingClientRect();
    } catch {
      return null;
    }
    if (!rect) return null;
    return { text, rect };
  }

  function showBubble(text, rect) {
    ensureBubble();
    bubbleText = text;
    bubbleHost.style.visibility = 'hidden';
    bubbleHost.style.display = 'block';
    bubbleHost.style.left = '0px';
    bubbleHost.style.top = '0px';
    const br = bubbleEl.getBoundingClientRect();
    const vw = window.innerWidth || 0;
    const vh = window.innerHeight || 0;
    // 相对选区末端：偏右 4px、偏下 6px，给翻译类扩展的图标让开一点
    let left = rect.right + 4;
    let top = rect.bottom + 6;
    left = Math.min(Math.max(8, left), Math.max(8, vw - br.width - 8));
    top = Math.min(Math.max(8, top), Math.max(8, vh - br.height - 8));
    bubbleHost.style.left = left + 'px';
    bubbleHost.style.top = top + 'px';
    bubbleHost.style.visibility = 'visible';
  }

  // 延迟 180ms 再冒：拖选时不会一路闪，松手后停一下才出现
  function scheduleBubble() {
    clearTimeout(bubbleTimer);
    bubbleTimer = 0;
    if (isOpen()) {
      hideBubble();
      return;
    }
    bubbleTimer = setTimeout(() => {
      bubbleTimer = 0;
      if (isOpen()) {
        hideBubble();
        return;
      }
      const picked = readSelection();
      if (!picked) {
        hideBubble();
        return;
      }
      showBubble(picked.text, picked.rect);
    }, 180);
  }

  function onBubbleClick(e) {
    e.preventDefault();
    e.stopPropagation();
    const text = bubbleText;
    hideBubble();
    if (!text) return;
    // 先把面板建出来（attachQuote 要往它里面写），再带上文字并打开
    ensurePanel();
    attachQuote(text.length > 1200 ? text.slice(0, 1200) + '…' : text);
    open();
  }

  // 选区变了、滚了、点别处、按 Esc、面板开了 —— 浮标都该走
  document.addEventListener('selectionchange', () => {
    if (!readSelection()) {
      hideBubble();
      return;
    }
    scheduleBubble();
  });
  document.addEventListener(
    'mouseup',
    (e) => {
      if (hitOurUi(e)) return;
      scheduleBubble();
    },
    true,
  );
  document.addEventListener(
    'keyup',
    (e) => {
      if (e.key === 'Shift' || e.key.startsWith('Arrow')) scheduleBubble();
    },
    true,
  );
  window.addEventListener('scroll', hideBubble, true);
  window.addEventListener('resize', hideBubble, true);
  document.addEventListener(
    'mousedown',
    (e) => {
      if (hitOurUi(e)) return;
      hideBubble();
    },
    true,
  );
  document.addEventListener(
    'keydown',
    (e) => {
      if (e.key === 'Escape') hideBubble();
    },
    true,
  );

  // ---------- 来自 background 的指令 ----------
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || !msg.type) return;
    if (msg.type === 'dsh-open-chat') {
      open();
      clearAttachments();
      const sel = String(msg.selection || window.getSelection()?.toString() || '').trim();
      if (sel) {
        attachQuote(sel.length > 1200 ? sel.slice(0, 1200) + '…' : sel);
        systemNote('已带上你选中的 ' + sel.length + ' 个字。');
      }
      sendResponse({ ok: true });
      return true;
    }
    if (msg.type === 'dsh-open-region') {
      open();
      startRegion(true);
      sendResponse({ ok: true });
      return true;
    }
    if (msg.type === 'dsh-ping') {
      open();
      sendResponse({ ok: true });
      return true;
    }
  });

  const TEMPLATE = `
<style>
  :host { all: initial; }
  .panel {
    display: none; flex-direction: column; width: 380px; max-height: 74vh;
    background: #fff; color: #1a1a1a; border-radius: 14px;
    box-shadow: 0 18px 50px rgba(0,0,0,.28), 0 0 0 1px rgba(0,0,0,.08);
    font: 14px/1.65 -apple-system, "Segoe UI", "Microsoft YaHei", system-ui, sans-serif;
    overflow: hidden;
  }
  .bar {
    display: flex; align-items: center; gap: 8px; padding: 9px 12px;
    background: #f6f7f9; border-bottom: 1px solid #e6e8ec; cursor: move;
    user-select: none;
  }
  .dot { width: 8px; height: 8px; border-radius: 50%; background: #2a6df4; }
  .title { font-weight: 600; font-size: 13px; flex: 1; }
  .ghost {
    border: 0; background: transparent; color: #555; cursor: pointer;
    font: inherit; font-size: 12px; padding: 3px 6px; border-radius: 6px;
  }
  .ghost:hover { background: #e9ecf1; }
  .ghost.memo { color: #1a7f37; }
  .ghost.memo:hover { background: #e9f6ec; }
  .ghost.memo.on { background: #e9f6ec; }
  .ghost.board { color: #2a6df4; }
  .ghost.board:hover { background: #eaf1ff; }
  .ghost.board.on { background: #eaf1ff; }
  .ghost:disabled { opacity: .6; cursor: default; }
  .log {
    padding: 12px; overflow-y: auto; display: flex; flex-direction: column; gap: 8px;
    min-height: 90px;
  }
  .msg { max-width: 92%; padding: 8px 11px; border-radius: 10px; white-space: pre-wrap; word-break: break-word; }
  .msg.me { align-self: flex-end; background: #2a6df4; color: #fff; }
  .msg.dsh { align-self: flex-start; background: #f2f4f7; }
  .msg.dsh.pending { color: #8a8f98; }
  .msg.dsh.err { background: #fdecec; color: #a02121; }
  .msg .thumb { display: block; max-width: 100%; margin-top: 6px; border-radius: 6px; }
  .note { font-size: 12px; color: #8a8f98; align-self: center; text-align: center; }
  .quote {
    display: none; margin: 0 12px; padding: 7px 10px; border-left: 3px solid #2a6df4;
    background: #f6f8ff; color: #444; font-size: 12px; white-space: pre-wrap;
    max-height: 96px; overflow-y: auto; border-radius: 0 6px 6px 0;
  }
  .shot { display: none; max-width: calc(100% - 24px); margin: 8px 12px 0; border-radius: 8px; border: 1px solid #e6e8ec; }
  .composer { display: flex; gap: 8px; padding: 10px 12px; border-top: 1px solid #e6e8ec; align-items: flex-end; }
  .box {
    flex: 1; resize: none; border: 1px solid #d9dde3; border-radius: 9px;
    padding: 8px 10px; font: inherit; font-size: 13px; max-height: 120px; min-height: 38px;
    outline: none; box-sizing: border-box; background: #fff; color: #1a1a1a;
  }
  .box:focus { border-color: #2a6df4; }
  .send {
    border: 0; background: #2a6df4; color: #fff; border-radius: 9px; padding: 9px 14px;
    font: inherit; font-size: 13px; cursor: pointer; height: 38px;
  }
  .send:disabled { opacity: .6; cursor: default; }
  .typing { display: none; gap: 4px; padding: 0 12px 10px; align-items: center; }
  .typing i {
    width: 5px; height: 5px; border-radius: 50%; background: #b3b8c2; display: block;
    animation: b 1s infinite ease-in-out;
  }
  .typing i:nth-child(2) { animation-delay: .15s; }
  .typing i:nth-child(3) { animation-delay: .3s; }
  @keyframes b { 0%, 80%, 100% { opacity: .3; transform: translateY(0); } 40% { opacity: 1; transform: translateY(-3px); } }
</style>
<div class="panel">
  <div class="bar">
    <span class="dot"></span>
    <span class="title">随手问</span>
    <button class="ghost memo" title="把这段聊的存成记忆卡（点一下撤销）">记住这段</button>
    <button class="ghost board" title="把这段聊的存成看板上的一张卡">存成看板卡</button>
    <button class="ghost fresh" title="忘掉上面聊的">新对话</button>
    <button class="ghost close" title="Esc">关闭</button>
  </div>
  <div class="log"></div>
  <div class="quote"></div>
  <img class="shot" alt="" />
  <div class="typing"><i></i><i></i><i></i></div>
  <div class="composer">
    <textarea class="box" rows="1" placeholder="问点什么…（回车发送，Shift+回车换行）"></textarea>
    <button class="send">问</button>
  </div>
</div>`;
})();
