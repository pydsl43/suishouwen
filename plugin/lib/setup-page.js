/**
 * GET /page-chat/setup 的自包含安装向导页。
 *
 * 为什么单独一个文件：页面模板有几百行 HTML / CSS / JS，塞进 index.js 会把
 * 路由分发淹掉；这里只导出一个纯函数，宿主侧一行 `sendHtml` 就接上。
 *
 * 三条硬约束（和宿主侧同源，别放松）：
 *   1) 自包含：内联 CSS / JS，不引任何 CDN、字体、图片 —— 断网也要能看。
 *   2) 页面只出骨架：第 1 步 / 第 2 步的真状态由浏览器 fetch 后填，服务端不预取
 *      （否则「装好没」会受页面缓存和渲染时刻影响，反而骗人）。
 *   3) 所有来自接口的值一律 `textContent` 写入 DOM，绝不拼 HTML 字符串。
 *
 * 页面里的下载链接与文案跟 release v0.4.5 的资产名一字不差；改版本时这两条
 * 常量与 `package.json` / `PLUGIN_VERSION` 一起改。
 */

/** Firefox / Zen 的 Mozilla 签名包（unlisted 渠道，装完重启不失效）。 */
const FIREFOX_XPI_URL =
  'https://github.com/pydsl43/suishouwen/releases/latest/download/suishouwen-0.4.5-firefox-signed.xpi';

/** Chrome / Edge 的解压加载包。 */
const CHROME_ZIP_URL =
  'https://github.com/pydsl43/suishouwen/releases/latest/download/suishouwen-0.4.5-chrome.zip';

/** HTML 转义：页面上唯一需要服务端插值的是版本号，但仍按底线转义。 */
function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * 渲染整页 HTML。
 * @param version - 插件版本（来自 index.js 的 PLUGIN_VERSION）。
 * @returns 完整 HTML 文本。
 */
export function renderSetupPage(version) {
  const safeVersion = escapeHtml(version || '');
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>随手问 · 装好没</title>
<style>
  :root {
    --bg: #f5f6f8;
    --card: #ffffff;
    --ink: #1c1f23;
    --muted: #6b7280;
    --line: #e4e7ec;
    --green: #12844a;
    --green-bg: #e8f7ef;
    --red: #c62828;
    --red-bg: #fdecec;
    --amber: #9a6700;
    --amber-bg: #fff8e1;
    --accent: #2f6fed;
    --accent-ink: #ffffff;
    --shadow: 0 1px 2px rgba(16, 24, 40, 0.05), 0 1px 3px rgba(16, 24, 40, 0.06);
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #0f1114;
      --card: #181b20;
      --ink: #e8eaed;
      --muted: #9aa0a6;
      --line: #2a2f36;
      --green: #5cd08d;
      --green-bg: #12291d;
      --red: #ff8a80;
      --red-bg: #2b1515;
      --amber: #ffd166;
      --amber-bg: #2a2210;
      --accent: #7aa7ff;
      --accent-ink: #101215;
      --shadow: none;
    }
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; }
  body {
    background: var(--bg);
    color: var(--ink);
    font-family: -apple-system, "Segoe UI", system-ui, sans-serif;
    font-size: 15px;
    line-height: 1.6;
    -webkit-font-smoothing: antialiased;
  }
  main { max-width: 760px; margin: 0 auto; padding: 32px 18px 56px; }
  header {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 16px;
    margin-bottom: 22px;
  }
  h1 { margin: 0; font-size: 26px; line-height: 1.25; letter-spacing: 0.2px; }
  .lede { margin: 6px 0 0; color: var(--muted); }
  .clock {
    flex: none;
    padding-top: 6px;
    color: var(--muted);
    font-variant-numeric: tabular-nums;
    font-size: 13px;
    white-space: nowrap;
  }
  .step {
    background: var(--card);
    border: 1px solid var(--line);
    border-radius: 14px;
    padding: 18px 20px;
    margin-bottom: 14px;
    box-shadow: var(--shadow);
  }
  .step-head {
    display: flex;
    align-items: center;
    gap: 10px;
    flex-wrap: wrap;
  }
  .step-head h2 { margin: 0; font-size: 16px; font-weight: 600; }
  .no {
    flex: none;
    width: 24px;
    height: 24px;
    border-radius: 50%;
    background: var(--bg);
    border: 1px solid var(--line);
    color: var(--muted);
    font-size: 13px;
    font-weight: 600;
    display: inline-flex;
    align-items: center;
    justify-content: center;
  }
  .dot {
    width: 9px;
    height: 9px;
    border-radius: 50%;
    background: var(--muted);
    display: inline-block;
  }
  .dot.idle { animation: pulse 1.6s ease-in-out infinite; }
  .dot.green { background: var(--green); }
  .dot.red { background: var(--red); }
  .dot.amber { background: var(--amber); }
  @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.35; } }
  .state {
    font-size: 13px;
    font-weight: 600;
    padding: 2px 9px;
    border-radius: 999px;
    color: var(--muted);
    background: var(--bg);
  }
  .state.green { color: var(--green); background: var(--green-bg); }
  .state.red { color: var(--red); background: var(--red-bg); }
  .state.amber { color: var(--amber); background: var(--amber-bg); }
  .hint { margin: 8px 0 0; color: var(--muted); font-size: 13.5px; }
  .facts { margin: 12px 0 0; display: grid; grid-template-columns: 92px 1fr; gap: 6px 12px; font-size: 13.5px; }
  .facts dt { color: var(--muted); margin: 0; }
  .facts dd { margin: 0; overflow-wrap: anywhere; }
  .browsers { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-top: 14px; }
  @media (max-width: 560px) { .browsers { grid-template-columns: 1fr; } }
  .browser { border: 1px solid var(--line); border-radius: 12px; padding: 14px; }
  .browser h3 { margin: 0 0 10px; font-size: 14px; font-weight: 600; }
  .browser p { margin: 10px 0 0; color: var(--muted); font-size: 13px; }
  .btn {
    display: inline-block;
    padding: 9px 16px;
    border-radius: 9px;
    background: var(--accent);
    color: var(--accent-ink);
    font-size: 14px;
    font-weight: 600;
    text-decoration: none;
  }
  .btn:focus-visible { outline: 3px solid var(--accent); outline-offset: 2px; }
  .ok-box {
    margin: 10px 0 0;
    padding: 10px 12px;
    border-radius: 10px;
    background: var(--green-bg);
    color: var(--green);
    font-size: 14px;
  }
  .wait-note { margin: 14px 0 0; color: var(--muted); font-size: 13px; }
  .trouble {
    margin-top: 18px;
    padding: 12px 16px;
    border: 1px dashed var(--line);
    border-radius: 12px;
    color: var(--muted);
  }
  .trouble summary { cursor: pointer; font-size: 14px; font-weight: 600; color: var(--ink); }
  .trouble ul { margin: 10px 0 0; padding-left: 20px; font-size: 13.5px; }
  .trouble li { margin: 4px 0; }
  code {
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    font-size: 12.5px;
    padding: 1px 5px;
    border-radius: 5px;
    background: var(--bg);
    border: 1px solid var(--line);
  }
  footer { margin-top: 26px; color: var(--muted); font-size: 12.5px; text-align: center; }
  [hidden] { display: none !important; }
</style>
</head>
<body>
<main>
  <header>
    <div>
      <h1>随手问 · 装好没</h1>
      <p class="lede">这一页会自己检查，不用你判断。</p>
    </div>
    <div class="clock" id="clock" aria-hidden="true">--:--:--</div>
  </header>

  <section class="step" aria-labelledby="brain-title">
    <div class="step-head">
      <span class="no" aria-hidden="true">1</span>
      <h2 id="brain-title">脑子（DSH 插件）</h2>
      <span class="dot idle" id="brain-dot" aria-hidden="true"></span>
      <span class="state" id="brain-state" role="status" aria-live="polite">检查中…</span>
    </div>
    <p class="hint" id="brain-hint">正在问本机 DSH：插件在不在、能不能干活。</p>
    <dl class="facts" id="brain-facts" hidden>
      <dt>健康</dt><dd id="f-ok">—</dd>
      <dt>能干活</dt><dd id="f-ready">—</dd>
      <dt>插件版本</dt><dd id="f-version">—</dd>
    </dl>
  </section>

  <section class="step" aria-labelledby="eyes-title">
    <div class="step-head">
      <span class="no" aria-hidden="true">2</span>
      <h2 id="eyes-title">眼睛（浏览器扩展）</h2>
      <span class="dot red" id="eyes-dot" aria-hidden="true"></span>
      <span class="state red" id="eyes-state" role="status" aria-live="polite">未连上</span>
    </div>

    <div id="eyes-missing">
      <p class="hint">浏览器扩展还没报到。选你用的浏览器，装一次就好：</p>
      <div class="browsers">
        <article class="browser">
          <h3>Firefox / Zen</h3>
          <a class="btn" href="${FIREFOX_XPI_URL}" target="_blank" rel="noopener">下载签名包</a>
          <p>打开 about:addons → 右上齿轮 → 从文件安装附加组件</p>
        </article>
        <article class="browser">
          <h3>Chrome / Edge</h3>
          <a class="btn" href="${CHROME_ZIP_URL}" target="_blank" rel="noopener">下载 Chrome 包</a>
          <p>解压 → chrome://extensions → 开发者模式 → 加载已解压的扩展程序</p>
        </article>
      </div>
      <p class="wait-note">装好后不用刷新：这一栏每 2 秒自己看一眼，装上了就变绿。</p>
    </div>

    <div id="eyes-ok" hidden>
      <dl class="facts">
        <dt>版本</dt><dd id="e-version">—</dd>
        <dt>浏览器</dt><dd id="e-browser">—</dd>
        <dt>最后报到</dt><dd id="e-ago">—</dd>
        <dt>报到时刻</dt><dd id="e-at">—</dd>
      </dl>
    </div>
  </section>

  <section class="step" aria-labelledby="try-title">
    <div class="step-head">
      <span class="no" aria-hidden="true">3</span>
      <h2 id="try-title">试一下</h2>
    </div>
    <p class="ok-box">随便打开一个网页，选中 2 个字以上，选区右下角会出现「随手问」小胶囊。</p>
  </section>

  <details class="trouble">
    <summary>还是不行</summary>
    <ul>
      <li>dsh web 没跑：命令行里跑 <code>dsh web</code>，再打开 <code>http://127.0.0.1:3080</code>。</li>
      <li>装完没重启：扩展装好后，把浏览器完全退出再打开一次。</li>
      <li>Chrome 用了解压前的位置：要选解压出来的那个文件夹，不要选 zip。</li>
    </ul>
  </details>

  <footer>安装向导 · 插件版本 <span id="pv">${safeVersion}</span></footer>
</main>

<script>
(function () {
  'use strict';

  function byId(id) { return document.getElementById(id); }

  /** 只走 textContent：接口给什么字就显示什么字，绝不拼 HTML。 */
  function setText(id, value) {
    var el = byId(id);
    if (el) el.textContent = value == null ? '' : String(value);
  }

  function setTone(el, tone) {
    if (!el) return;
    el.classList.remove('idle', 'green', 'red', 'amber');
    if (tone) el.classList.add(tone);
  }

  function pad(n) { return n < 10 ? '0' + n : String(n); }

  function clock() {
    var d = new Date();
    setText('clock', pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds()));
  }
  clock();
  setInterval(clock, 1000);

  /** 秒数翻成人话：刚刚 / N 分钟前 / N 小时前。 */
  function agoText(seconds) {
    if (typeof seconds !== 'number' || !isFinite(seconds) || seconds < 0) return '刚刚';
    if (seconds < 60) return '刚刚';
    var minutes = Math.floor(seconds / 60);
    if (minutes < 60) return minutes + ' 分钟前';
    var hours = Math.floor(minutes / 60);
    if (hours < 24) return hours + ' 小时前';
    return Math.floor(hours / 24) + ' 天前';
  }

  function timeText(iso) {
    if (!iso) return '—';
    var d = new Date(iso);
    if (isNaN(d.getTime())) return '—';
    return pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
  }

  /** 第 1 步：插件在不在。 */
  function showBrain(tone, title, hint, data) {
    setTone(byId('brain-dot'), tone);
    var state = byId('brain-state');
    setTone(state, tone);
    setText('brain-state', title);
    setText('brain-hint', hint);
    if (data) {
      var facts = byId('brain-facts');
      if (facts) facts.hidden = false;
      setText('f-ok', data.ok ? '是' : '否');
      setText('f-ready', data.dshReady ? '能' : '暂时不能');
      setText('f-version', data.version || '—');
      if (data.version) setText('pv', data.version);
    }
  }

  function loadHealth() {
    fetch('/page-chat/health', { cache: 'no-store' })
      .then(function (res) {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.json();
      })
      .then(function (data) {
        data = data || {};
        if (!data.ok) {
          showBrain('red', '没通', 'dsh web 没在跑，或插件没被加载', data);
        } else if (!data.dshReady) {
          showBrain('amber', '在，但还没就绪', '插件加载了，会话暂时建不起来（dsh web 可能刚起，等几秒）', data);
        } else {
          showBrain('green', '已就位', '插件加载好了，能建会话。', data);
        }
      })
      .catch(function () {
        showBrain('red', '没通', 'dsh web 没在跑，或插件没被加载', null);
      });
  }

  /** 第 2 步：扩展报到了没。 */
  function showEyes(installed, data) {
    var dot = byId('eyes-dot');
    var state = byId('eyes-state');
    var missing = byId('eyes-missing');
    var okBox = byId('eyes-ok');
    if (installed) {
      setTone(dot, 'green');
      setTone(state, 'green');
      setText('eyes-state', '已连上');
      if (missing) missing.hidden = true;
      if (okBox) okBox.hidden = false;
      setText('e-version', data.version || '—');
      setText('e-browser', data.browser || '—');
      setText('e-ago', agoText(data.agoSeconds));
      setText('e-at', timeText(data.at));
    } else {
      setTone(dot, 'red');
      setTone(state, 'red');
      setText('eyes-state', '未连上');
      if (missing) missing.hidden = false;
      if (okBox) okBox.hidden = true;
    }
  }

  function loadInstalled() {
    fetch('/page-chat/installed', { cache: 'no-store' })
      .then(function (res) {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.json();
      })
      .then(function (data) {
        data = data || {};
        if (data.installed) showEyes(true, data);
        else showEyes(false, data);
      })
      .catch(function () {
        showEyes(false, {});
      });
  }

  loadHealth();
  loadInstalled();
  // 装好后不刷新：每 2 秒再看一眼报到记录。
  setInterval(loadInstalled, 2000);
})();
</script>
</body>
</html>
`;
}
