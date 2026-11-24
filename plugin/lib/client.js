/**
 * 网页记忆面板 · client 侧（浏览器 bundle，宿主按 package.json 的 exports["./client"] 加载）
 *
 * 加载约定（照 plugin-dsh-board 的产物抄的，别改成 ESM import）：
 *   window.__ModuleLoader__.load({ id: "<包名>", factory: (require) => {...} })
 *   - id 必须等于 package.json 的 name，否则宿主对不上号；
 *   - 只能 require("react")，宿主 client 包不要当模块 require（会把别人的内部实现锁死）；
 *   - 返回值是模块 exports：{ apply, inject }。
 *
 * 槽位（dsh-cordis-client-runner 的 slot-catalog）：
 *   main                 keyed root，key 由侧栏入口 id 选中 → 注册 key=PANEL_ID 的中央面板
 *   sidebar.panellist    list root，id 必须与 main 的 key 一字不差，点它才切到本面板
 *
 * 文案：宿主只从 locale service 取文案，插件包里的 locale/*.json 只喂插件列表的 meta，
 * 浏览器 bundle 读不到它（没有 HTTP 暴露），所以正文双语文案内联在下面的 DICT 里。
 *
 * 数据：全部走 lib/index.js 已有的 /page-chat/* 接口（不改后端）。
 *   列表 / 详情 / 删除 / 清站点 / 同步状态 / 立刻同步。
 */

window.__ModuleLoader__.load({
  id: "@pydsl/dsh-page-chat",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    const React = require("react");
    const h = React.createElement;

    // ===== ① 常量与文案 =====
    const PANEL_ID = "page-chat-memory";
    const NS = "page-chat";
    const BASE = "/page-chat";
    // 「3 分钟前」这类相对时间自己走字，不靠数据变化
    const CLOCK_MS = 30 * 1000;

    const DICT = {
      zh: {
        "panel.title": "网页记忆",
        "panel.subtitle": "浏览器里问过、被记住的页面内容。这里删掉就找不回来了。",
        "list.count": "{count} 张",
        "list.siteLabel": "站点",
        "list.siteAll": "全部站点",
        "list.refresh": "刷新",
        "list.reading": "正在读记忆…",
        "list.failed": "列表没取到：{message}",
        "list.empty": "还没有记忆卡。先在浏览器里选中文字问 DSH 一次，这里就会出现第一张。",
        "list.emptySite": "「{site}」下还没有卡。",
        "list.retry": "重试",
        "detail.idle": "点左边的卡，看它记下的原文。",
        "detail.reading": "正在读原文…",
        "detail.failed": "原文没取到：{message}",
        "detail.points": "要点",
        "detail.thread": "原文",
        "detail.source": "来源页面",
        "detail.metaTime": "记于 {time}",
        "detail.turns": "{count} 轮对话",
        "detail.delete": "删除这张",
        "action.clearSite": "清空这个站点",
        "detail.roleMe": "你",
        "detail.roleDsh": "DSH",
        "detail.image": "带截图",
        "confirm.delete": "删掉「{title}」？对话原文也会一起没。",
        "confirm.clear": "清空「{site}」下的 {count} 张卡？删了找不回来。",
        "confirm.ok": "确定",
        "confirm.cancel": "取消",
        "notice.deleted": "已删掉 1 张。",
        "notice.cleared": "已清空「{site}」：{count} 张。",
        "error.delete": "没删掉：{message}",
        "error.clear": "没清掉：{message}",
        "sync.title": "云同步",
        "sync.reading": "正在读同步状态…",
        "sync.unavailable": "同步没打开",
        "sync.unavailableHint": "插件没装同步模块，只能看本机记忆。",
        "sync.unconfigured": "未配置",
        "sync.unconfiguredHint": "在浏览器扩展里配好 GitHub 或 WebDAV，这里就会显示已连接。",
        "sync.incomplete": "配置不完整",
        "sync.incompleteHint": "缺必填项（比如 token），去扩展里补一下。",
        "sync.paused": "已暂停",
        "sync.pausedHint": "地址都在，只是同步开关关着。",
        "sync.ready": "已连接 · {where}",
        "sync.never": "还没同步过",
        "sync.lastAt": "上次同步 {time}",
        "sync.now": "现在同步",
        "sync.running": "同步中…",
        "sync.done": "同步完成：上传 {pushed}，拉取 {pulled}，清理 {removed}。",
        "sync.failed": "这次没同步成：{detail}",
        "sync.error": "同步没跑起来：{message}",
        "sync.statusError": "同步状态没取到：{message}",
        "card.untitled": "（没有标题）",
        "card.turns": "{count} 轮",
        "card.image": "带截图",
        "time.justNow": "刚刚",
        "time.minutes": "{count} 分钟前",
        "time.hours": "{count} 小时前",
        "time.days": "{count} 天前"
      },
      en: {
        "panel.title": "Web memory",
        "panel.subtitle": "Pages you asked DSH about in the browser. Deleting here is permanent.",
        "list.count": "{count} cards",
        "list.siteLabel": "Site",
        "list.siteAll": "All sites",
        "list.refresh": "Refresh",
        "list.reading": "Reading memory…",
        "list.failed": "Could not load the list: {message}",
        "list.empty": "No memory cards yet. Select text in the browser and ask DSH once; the first card shows up here.",
        "list.emptySite": "No cards under “{site}” yet.",
        "list.retry": "Retry",
        "detail.idle": "Pick a card on the left to read what was remembered.",
        "detail.reading": "Reading the transcript…",
        "detail.failed": "Could not load the transcript: {message}",
        "detail.points": "Key points",
        "detail.thread": "Transcript",
        "detail.source": "Source page",
        "detail.metaTime": "Saved {time}",
        "detail.turns": "{count} turns",
        "detail.delete": "Delete this one",
        "action.clearSite": "Clear this site",
        "detail.roleMe": "You",
        "detail.roleDsh": "DSH",
        "detail.image": "Screenshot",
        "confirm.delete": "Delete “{title}”? The transcript goes away too.",
        "confirm.clear": "Clear all {count} cards under “{site}”? This cannot be undone.",
        "confirm.ok": "Confirm",
        "confirm.cancel": "Cancel",
        "notice.deleted": "Deleted 1 card.",
        "notice.cleared": "Cleared “{site}”: {count} cards.",
        "error.delete": "Not deleted: {message}",
        "error.clear": "Not cleared: {message}",
        "sync.title": "Cloud sync",
        "sync.reading": "Reading sync status…",
        "sync.unavailable": "Sync is off",
        "sync.unavailableHint": "The sync module is not installed; local memory only.",
        "sync.unconfigured": "Not configured",
        "sync.unconfiguredHint": "Set up GitHub or WebDAV in the browser extension and this row turns into “connected”.",
        "sync.incomplete": "Configuration incomplete",
        "sync.incompleteHint": "A required field (for example a token) is missing; finish it in the extension.",
        "sync.paused": "Paused",
        "sync.pausedHint": "Addresses are set, but the sync switch is off.",
        "sync.ready": "Connected · {where}",
        "sync.never": "Never synced",
        "sync.lastAt": "Last sync {time}",
        "sync.now": "Sync now",
        "sync.running": "Syncing…",
        "sync.done": "Synced: {pushed} pushed, {pulled} pulled, {removed} removed.",
        "sync.failed": "This sync did not go through: {detail}",
        "sync.error": "Sync did not start: {message}",
        "sync.statusError": "Could not read sync status: {message}",
        "card.untitled": "(untitled)",
        "card.turns": "{count} turns",
        "card.image": "Screenshot",
        "time.justNow": "just now",
        "time.minutes": "{count} min ago",
        "time.hours": "{count} h ago",
        "time.days": "{count} d ago"
      }
    };

    /** 没接上 locale service 时的兜底：永远出中文，至少不空白。 */
    function fallbackTranslate(key, params) {
      return fill(DICT.zh[key] !== undefined ? DICT.zh[key] : key, params);
    }

    function fill(template, params) {
      if (!params) return template;
      return String(template).replace(/\{(\w+)\}/g, (whole, name) =>
        Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : whole
      );
    }

    // ===== ② 颜色与样式（只用主题 token，跟看板同一套变量） =====
    function tint(color, percent) {
      return "color-mix(in srgb, " + color + " " + percent + "%, transparent)";
    }

    const C = {
      text: "var(--dsw-alias-label-primary)",
      text2: "var(--dsw-alias-label-secondary)",
      text3: "var(--dsw-alias-label-tertiary)",
      bg: "var(--dsw-alias-bg-base)",
      layer: "var(--dsw-alias-bg-layer-2)",
      border: "var(--dsw-alias-border-l1)",
      brand: "var(--dsw-alias-brand-primary)",
      ok: "var(--dsw-static-green-500)",
      warn: "var(--dsw-static-amber-500)",
      bad: "var(--dsw-static-red-500)"
    };

    const S = {
      page: {
        display: "flex",
        flexDirection: "column",
        height: "100%",
        minHeight: 0,
        overflow: "hidden",
        boxSizing: "border-box",
        padding: "20px 24px 22px",
        background: C.bg,
        color: C.text,
        font: "inherit",
        fontSize: "14px"
      },
      head: {
        display: "flex",
        alignItems: "baseline",
        justifyContent: "space-between",
        flexWrap: "wrap",
        gap: "6px 12px"
      },
      titleWrap: { display: "flex", alignItems: "center", gap: "8px", minWidth: 0 },
      h1: { fontSize: "18px", lineHeight: 1.4, fontWeight: 600, letterSpacing: "-0.01em", margin: 0 },
      sub: { fontSize: "12px", color: C.text3, margin: "4px 0 0", lineHeight: 1.5 },
      count: {
        display: "inline-flex",
        alignItems: "center",
        fontSize: "11.5px",
        lineHeight: "18px",
        padding: "1px 8px",
        borderRadius: "999px",
        background: C.layer,
        color: C.text3,
        fontVariantNumeric: "tabular-nums",
        whiteSpace: "nowrap"
      },
      toolbar: {
        display: "flex",
        alignItems: "center",
        gap: "8px",
        flexWrap: "wrap",
        margin: "12px 0 0"
      },
      label: { fontSize: "12px", color: C.text3 },
      select: {
        font: "inherit",
        fontSize: "13px",
        lineHeight: "18px",
        padding: "4px 8px",
        borderRadius: "var(--dsw-radius-md)",
        border: "1px solid " + C.border,
        background: C.layer,
        color: C.text,
        maxWidth: "240px",
        cursor: "pointer"
      },
      syncBar: {
        display: "flex",
        alignItems: "center",
        gap: "8px",
        flexWrap: "wrap",
        margin: "12px 0 0",
        padding: "8px 10px",
        borderRadius: "var(--dsw-radius-lg)",
        border: "1px solid " + C.border,
        background: C.layer
      },
      syncText: { fontSize: "13px", color: C.text, lineHeight: 1.5 },
      syncHint: { fontSize: "11.5px", color: C.text3, lineHeight: 1.5, flex: "1 1 180px", minWidth: 0 },
      syncRight: { display: "flex", alignItems: "center", gap: "8px", marginLeft: "auto" },
      dot: { width: "6px", height: "6px", borderRadius: "50%", flex: "0 0 auto" },
      body: {
        display: "flex",
        alignItems: "stretch",
        gap: "14px",
        flex: "1 1 auto",
        minHeight: 0,
        margin: "14px 0 0",
        flexWrap: "wrap"
      },
      listPane: {
        display: "flex",
        flexDirection: "column",
        gap: "8px",
        flex: "1 1 320px",
        minWidth: 0,
        minHeight: 0,
        overflowY: "auto",
        paddingRight: "2px"
      },
      detailPane: {
        flex: "1 1 360px",
        minWidth: 0,
        minHeight: "160px",
        maxHeight: "100%",
        overflowY: "auto",
        boxSizing: "border-box",
        padding: "12px 14px 16px",
        borderRadius: "var(--dsw-radius-lg)",
        border: "1px solid " + C.border,
        background: C.layer
      },
      card: {
        display: "flex",
        flexDirection: "column",
        gap: "5px",
        padding: "10px 12px",
        borderRadius: "var(--dsw-radius-lg)",
        border: "1px solid " + C.border,
        background: "transparent",
        cursor: "pointer",
        textAlign: "left",
        boxSizing: "border-box",
        outline: "none"
      },
      cardOn: {
        borderColor: C.brand,
        background: tint(C.brand, 10)
      },
      cardTitle: {
        fontSize: "13.5px",
        lineHeight: 1.45,
        fontWeight: 600,
        color: C.text,
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap"
      },
      cardTime: { fontSize: "11.5px", color: C.text3, whiteSpace: "nowrap", flex: "0 0 auto" },
      cardSummary: {
        fontSize: "12.5px",
        lineHeight: 1.55,
        color: C.text2,
        display: "-webkit-box",
        WebkitLineClamp: 2,
        WebkitBoxOrient: "vertical",
        overflow: "hidden"
      },
      cardFoot: { display: "flex", alignItems: "center", gap: "6px", flexWrap: "wrap" },
      chip: {
        fontSize: "11px",
        lineHeight: "16px",
        padding: "0 6px",
        borderRadius: "999px",
        border: "1px solid " + C.border,
        color: C.text3,
        whiteSpace: "nowrap"
      },
      hint: { fontSize: "12.5px", color: C.text3, lineHeight: 1.6, padding: "10px 2px" },
      note: { fontSize: "12px", color: C.text2, lineHeight: 1.6, margin: "8px 0 0" },
      noteBad: { fontSize: "12px", color: C.bad, lineHeight: 1.6, margin: "8px 0 0" },
      detailHead: {
        display: "flex",
        alignItems: "flex-start",
        justifyContent: "space-between",
        gap: "10px",
        flexWrap: "wrap"
      },
      detailTitle: { fontSize: "15px", lineHeight: 1.45, fontWeight: 600, margin: 0, minWidth: 0 },
      detailMeta: { fontSize: "11.5px", color: C.text3, lineHeight: 1.6, margin: "4px 0 0" },
      section: { margin: "14px 0 0" },
      sectionTitle: {
        fontSize: "11.5px",
        lineHeight: "16px",
        letterSpacing: "0.02em",
        color: C.text3,
        textTransform: "uppercase",
        margin: "0 0 6px"
      },
      bullet: { margin: "0 0 4px", paddingLeft: "16px", fontSize: "12.5px", lineHeight: 1.6, color: C.text2 },
      bubble: {
        fontSize: "12.5px",
        lineHeight: 1.65,
        padding: "7px 10px",
        borderRadius: "var(--dsw-radius-md)",
        border: "1px solid " + C.border,
        whiteSpace: "pre-wrap",
        wordBreak: "break-word",
        margin: "0 0 6px"
      },
      bubbleMe: { background: tint(C.brand, 12), borderColor: tint(C.brand, 30) },
      bubbleDsh: { background: C.bg },
      role: { fontSize: "11px", color: C.text3, margin: "0 0 2px" },
      link: { color: C.brand, fontSize: "12.5px", wordBreak: "break-all" },
      confirm: {
        display: "flex",
        alignItems: "center",
        gap: "8px",
        flexWrap: "wrap",
        margin: "8px 0 0",
        padding: "8px 10px",
        borderRadius: "var(--dsw-radius-md)",
        border: "1px solid " + C.bad,
        background: tint(C.bad, 8)
      },
      confirmText: { fontSize: "12px", color: C.text, lineHeight: 1.55, flex: "1 1 160px", minWidth: 0 }
    };

    // ===== ③ 小控件 =====
    function Button(props) {
      const kind = props.kind || "plain";
      const disabled = props.disabled === true;
      const style = {
        font: "inherit",
        fontSize: "12.5px",
        lineHeight: "18px",
        padding: "3px 10px",
        borderRadius: "999px",
        border: "1px solid " + C.border,
        background: "transparent",
        color: C.text2,
        cursor: disabled ? "default" : "pointer",
        opacity: disabled ? 0.45 : 1,
        whiteSpace: "nowrap",
        display: "inline-flex",
        alignItems: "center",
        gap: "5px"
      };
      if (kind === "brand") {
        style.background = C.brand;
        style.borderColor = C.brand;
        style.color = "var(--dsw-alias-bg-base)";
        style.fontWeight = 600;
      } else if (kind === "danger") {
        style.color = C.bad;
        style.borderColor = tint(C.bad, 45);
      }
      const merged = Object.assign(style, props.style || {});
      return h(
        "button",
        {
          type: "button",
          disabled: disabled,
          title: props.title || undefined,
          onClick: disabled ? undefined : props.onClick,
          style: merged
        },
        props.children
      );
    }

    function Dot(props) {
      return h("span", { style: Object.assign({}, S.dot, { background: props.color }) });
    }

    // ===== ④ 接口：直接用 /page-chat/* 的既有形状，不猜第二套 =====
    async function requestJson(path, init) {
      const response = await fetch(BASE + path, Object.assign(
        { credentials: "same-origin", headers: { accept: "application/json" } },
        init || {}
      ));
      let payload = null;
      try {
        payload = await response.json();
      } catch (error) {
        payload = null;
      }
      if (!response.ok || !payload || payload.ok !== true) {
        const message =
          payload && typeof payload.error === "string" && payload.error
            ? payload.error
            : "HTTP " + response.status;
        const failure = new Error(message);
        failure.status = response.status;
        failure.payload = payload;
        throw failure;
      }
      return payload;
    }

    function postJson(path, body) {
      return requestJson(path, {
        method: "POST",
        headers: { accept: "application/json", "content-type": "application/json" },
        body: JSON.stringify(body || {})
      });
    }

    const api = {
      list: () => requestJson("/memory/list"),
      get: (id) => requestJson("/memory/get?id=" + encodeURIComponent(id)),
      remove: (id) => postJson("/memory/delete", { id }),
      clearSite: (site) => postJson("/memory/clear-site", { site }),
      syncStatus: () => requestJson("/sync/status"),
      syncNow: () => postJson("/sync/now", {})
    };

    // ===== ⑤ 时间与文案拼装 =====
    function relTime(t, at, now) {
      const ms = typeof at === "string" ? Date.parse(at) : NaN;
      if (!Number.isFinite(ms)) return typeof at === "string" ? at.slice(0, 10) : "";
      const minutes = Math.floor(Math.max(0, now - ms) / 60000);
      if (minutes < 1) return t("time.justNow");
      if (minutes < 60) return t("time.minutes", { count: minutes });
      const hours = Math.floor(minutes / 60);
      if (hours < 24) return t("time.hours", { count: hours });
      const days = Math.floor(hours / 24);
      if (days < 30) return t("time.days", { count: days });
      return absTime(ms);
    }

    function absTime(ms) {
      const date = new Date(ms);
      const pad = (value) => (value < 10 ? "0" + value : String(value));
      return date.getFullYear() + "-" + pad(date.getMonth() + 1) + "-" + pad(date.getDate()) +
        " " + pad(date.getHours()) + ":" + pad(date.getMinutes());
    }

    /** 未配置 / 配置不完整 / 已暂停 / 已连接 —— 四种情况都用同一行，不弹窗。 */
    function describeSync(t, state, now) {
      const config = state.config;
      if (state.phase === "loading") return { color: C.text3, text: t("sync.reading"), hint: "" };
      if (state.phase === "off") return { color: C.text3, text: t("sync.unavailable"), hint: t("sync.unavailableHint") };
      if (state.phase === "error") return { color: C.bad, text: t("sync.statusError", { message: state.error }), hint: "" };
      if (!config || !config.kind) return { color: C.text3, text: t("sync.unconfigured"), hint: t("sync.unconfiguredHint") };
      if (!config.ready) return { color: C.warn, text: t("sync.incomplete"), hint: t("sync.incompleteHint") };
      let where = "";
      if (config.kind === "github" && config.github) {
        where = "GitHub " + [config.github.owner, config.github.repo].filter(Boolean).join("/");
      } else if (config.kind === "webdav" && config.webdav) {
        where = "WebDAV " + String(config.webdav.url || "");
      } else {
        where = String(config.kind);
      }
      const paused = config.enabled === false;
      const last = config.lastSyncAt
        ? t("sync.lastAt", { time: relTime(t, config.lastSyncAt, now) })
        : t("sync.never");
      return {
        color: paused ? C.warn : C.ok,
        text: paused ? t("sync.paused") : t("sync.ready", { where }),
        hint: (paused ? t("sync.pausedHint") : where) + " · " + last
      };
    }

    function syncCanRun(state) {
      const config = state.config;
      return state.phase === "ready" && !!config && !!config.kind && config.ready === true && config.enabled !== false;
    }

    // ===== ⑥ locale：注册字典 + 订阅切语言（main 槽不帮你重渲染，自己订阅） =====
    let localeRuntime = null;
    let translate = fallbackTranslate;

    function useLocaleRevision() {
      const [revision, setRevision] = React.useState(0);
      React.useEffect(() => {
        const runtime = localeRuntime;
        if (!runtime || typeof runtime.subscribe !== "function") return undefined;
        const read = typeof runtime.getSnapshot === "function" ? () => runtime.getSnapshot().revision : () => 0;
        let seen = read();
        return runtime.subscribe(() => {
          const next = read();
          if (next === seen) return;
          seen = next;
          setRevision(next);
        });
      }, []);
      return revision;
    }

    // ===== ⑦ 列表一张卡 =====
    function CardRow(props) {
      const card = props.card || {};
      const t = props.t;
      const rows = [
        h(
          "div",
          { key: "head", style: { display: "flex", alignItems: "baseline", gap: "8px", minWidth: 0 } },
          h("div", { style: Object.assign({}, S.cardTitle, { flex: "1 1 auto" }) }, card.title || t("card.untitled")),
          h("span", { style: S.cardTime }, relTime(t, card.at, props.now))
        )
      ];
      if (card.summary) rows.push(h("div", { key: "summary", style: S.cardSummary }, card.summary));
      const foot = [];
      const tags = Array.isArray(card.tags) ? card.tags.slice(0, 4) : [];
      for (const tag of tags) foot.push(h("span", { key: "tag:" + tag, style: S.chip }, "#" + tag));
      if (card.site) foot.push(h("span", { key: "site", style: S.chip }, card.site));
      if (card.hasImage) foot.push(h("span", { key: "img", style: S.chip }, t("card.image")));
      if (typeof card.turns === "number" && card.turns > 0) {
        foot.push(h("span", { key: "turns", style: S.chip }, t("card.turns", { count: card.turns })));
      }
      if (foot.length > 0) rows.push(h("div", { key: "foot", style: S.cardFoot }, foot));
      return h(
        "div",
        {
          role: "button",
          tabIndex: 0,
          "aria-pressed": props.selected ? "true" : "false",
          onClick: () => props.onSelect(card.id),
          onKeyDown: (event) => {
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              props.onSelect(card.id);
            }
          },
          style: props.selected ? Object.assign({}, S.card, S.cardOn) : S.card
        },
        rows
      );
    }

    // ===== ⑧ 详情：要点 + 原文（谁说 / 说了什么）+ 来源 =====
    function DetailPane(props) {
      const t = props.t;
      const state = props.state || {};
      if (state.phase === "idle") return h("div", { style: S.detailPane }, h("p", { style: S.hint }, t("detail.idle")));
      if (state.phase === "loading") return h("div", { style: S.detailPane }, h("p", { style: S.hint }, t("detail.reading")));
      if (state.phase === "error") {
        return h("div", { style: S.detailPane }, h("p", { style: S.noteBad }, t("detail.failed", { message: state.error })));
      }
      const card = state.card || {};
      const blocks = [];

      blocks.push(
        h(
          "div",
          { key: "head", style: S.detailHead },
          h(
            "div",
            { style: { minWidth: 0 } },
            h("h2", { style: S.detailTitle }, card.title || t("card.untitled")),
            h(
              "p",
              { style: S.detailMeta },
              [
                card.site ? card.site + " · " : "",
                t("detail.metaTime", { time: relTime(t, card.at, props.now) }),
                typeof card.turns === "number" ? " · " + t("detail.turns", { count: card.turns }) : ""
              ].join("")
            )
          ),
          props.confirm && props.confirm.kind === "delete"
            ? null
            : h(
                Button,
                { kind: "danger", disabled: !!props.busy, onClick: () => props.onAskDelete(card), title: t("detail.delete") },
                t("detail.delete")
              )
        )
      );

      if (props.confirm && props.confirm.kind === "delete") {
        blocks.push(
          h(
            "div",
            { key: "confirm", style: S.confirm },
            h("span", { style: S.confirmText }, t("confirm.delete", { title: card.title || t("card.untitled") })),
            h(Button, { kind: "danger", disabled: !!props.busy, onClick: props.onConfirmDelete }, t("confirm.ok")),
            h(Button, { onClick: props.onCancelAsk }, t("confirm.cancel"))
          )
        );
      }

      const points = Array.isArray(card.points) ? card.points : [];
      if (points.length > 0) {
        blocks.push(
          h(
            "div",
            { key: "points", style: S.section },
            h("p", { style: S.sectionTitle }, t("detail.points")),
            h("ul", { style: { margin: 0, padding: 0, listStyle: "none" } },
              points.map((point, index) => h("li", { key: "point:" + index, style: S.bullet }, "· " + String(point))))
          )
        );
      }

      const thread = Array.isArray(state.thread) ? state.thread : [];
      if (thread.length > 0) {
        const bubbles = [];
        thread.forEach((turn, index) => {
          const mine = turn && turn.role === "me";
          bubbles.push(
            h(
              "div",
              { key: "turn:" + index },
              h("p", { style: S.role }, mine ? t("detail.roleMe") : t("detail.roleDsh")),
              h(
                "p",
                { style: mine ? Object.assign({}, S.bubble, S.bubbleMe) : Object.assign({}, S.bubble, S.bubbleDsh) },
                String((turn && turn.text) || "") + (turn && turn.hasImage ? "\n" + t("detail.image") : "")
              )
            )
          );
        });
        blocks.push(
          h(
            "div",
            { key: "thread", style: S.section },
            h("p", { style: S.sectionTitle }, t("detail.thread")),
            bubbles
          )
        );
      }

      if (card.sourceUrl) {
        blocks.push(
          h(
            "div",
            { key: "source", style: S.section },
            h("p", { style: S.sectionTitle }, t("detail.source")),
            h(
              "a",
              { href: card.sourceUrl, target: "_blank", rel: "noreferrer noopener", style: S.link },
              card.sourceTitle || card.sourceUrl
            )
          )
        );
      }

      return h("div", { style: S.detailPane }, blocks);
    }

    // ===== ⑨ 主面板 =====
    function PageChatMemoryPanel() {
      useLocaleRevision();
      const t = translate;

      const [now, setNow] = React.useState(Date.now());
      const [listPhase, setListPhase] = React.useState("loading");
      const [cards, setCards] = React.useState([]);
      const [listError, setListError] = React.useState("");
      const [site, setSite] = React.useState("");
      const [selectedId, setSelectedId] = React.useState("");
      const [detail, setDetail] = React.useState({ phase: "idle", card: null, thread: [], error: "" });
      const [confirm, setConfirm] = React.useState(null);
      const [busy, setBusy] = React.useState("");
      // 操作回音：{ text, bad } 或 null。删除失败这类也走这一行，不弹 alert。
      const [notice, setNotice] = React.useState(null);
      const [syncState, setSyncState] = React.useState({ phase: "loading", config: null, error: "" });
      const [syncNote, setSyncNote] = React.useState("");

      // 相对时间自己走字
      React.useEffect(() => {
        if (typeof setInterval !== "function") return undefined;
        const timer = setInterval(() => setNow(Date.now()), CLOCK_MS);
        return () => clearInterval(timer);
      }, []);

      const loadList = () => {
        setListPhase((current) => (current === "ready" ? "refreshing" : "loading"));
        api.list().then(
          (payload) => {
            setCards(Array.isArray(payload.cards) ? payload.cards : []);
            setListError("");
            setListPhase("ready");
          },
          (error) => {
            setListError(error && error.message ? error.message : String(error));
            setListPhase("error");
          }
        );
      };

      const loadSync = () => {
        api.syncStatus().then(
          (payload) => {
            setSyncState({ phase: "ready", config: payload.config || null, error: "" });
          },
          (error) => {
            // 503「同步没打开」不是故障：面板只写「同步没打开」，不弹错。
            const off = error && error.status === 503;
            setSyncState({ phase: off ? "off" : "error", config: null, error: error && error.message ? error.message : String(error) });
          }
        );
      };

      React.useEffect(() => {
        loadList();
        loadSync();
      }, []);

      // 选中哪张就读哪张；读完再点别的，旧请求的返回直接丢掉（比对 id）
      React.useEffect(() => {
        if (!selectedId) {
          setDetail({ phase: "idle", card: null, thread: [], error: "" });
          return undefined;
        }
        let alive = true;
        setDetail({ phase: "loading", card: null, thread: [], error: "" });
        api.get(selectedId).then(
          (payload) => {
            if (!alive) return;
            setDetail({
              phase: "ready",
              card: payload.card || null,
              thread: Array.isArray(payload.thread) ? payload.thread : [],
              error: ""
            });
          },
          (error) => {
            if (!alive) return;
            setDetail({ phase: "error", card: null, thread: [], error: error && error.message ? error.message : String(error) });
          }
        );
        return () => {
          alive = false;
        };
      }, [selectedId]);

      const runSync = () => {
        if (busy) return;
        setBusy("sync");
        setSyncNote("");
        api.syncNow().then(
          (result) => {
            setBusy("");
            setSyncNote(
              result.ok === true
                ? t("sync.done", {
                    pushed: (result.pushed || []).length,
                    pulled: (result.pulled || []).length,
                    removed: (result.removed || []).length
                  })
                : t("sync.failed", { detail: result.detail || t("sync.unconfigured") })
            );
            loadList();
            loadSync();
          },
          (error) => {
            setBusy("");
            setSyncNote(t("sync.error", { message: error && error.message ? error.message : String(error) }));
            loadSync();
          }
        );
      };

      const doDelete = (id) => {
        setBusy("delete:" + id);
        api.remove(id).then(
          () => {
            setBusy("");
            setConfirm(null);
            setNotice({ text: t("notice.deleted"), bad: false });
            if (selectedId === id) setSelectedId("");
            loadList();
          },
          (error) => {
            setBusy("");
            setConfirm(null);
            setNotice({ text: t("error.delete", { message: error && error.message ? error.message : String(error) }), bad: true });
          }
        );
      };

      const doClearSite = (target) => {
        setBusy("clear:" + target);
        api.clearSite(target).then(
          (payload) => {
            setBusy("");
            setConfirm(null);
            setNotice({
              text: t("notice.cleared", { site: target, count: typeof payload.removed === "number" ? payload.removed : 0 }),
              bad: false
            });
            setSelectedId("");
            loadList();
          },
          (error) => {
            setBusy("");
            setConfirm(null);
            setNotice({ text: t("error.clear", { message: error && error.message ? error.message : String(error) }), bad: true });
          }
        );
      };

      // 站点下拉：从现有卡里现算，顺手带每站数量；某一站的卡删光后自动落回「全部站点」
      const siteCounts = {};
      for (const card of cards) {
        const key = card && typeof card.site === "string" ? card.site : "";
        siteCounts[key] = (siteCounts[key] || 0) + 1;
      }
      const siteKeys = Object.keys(siteCounts).filter((key) => key !== "").sort((a, b) => a.localeCompare(b));
      const activeSite = siteKeys.indexOf(site) >= 0 ? site : "";
      const visible = activeSite ? cards.filter((card) => card && card.site === activeSite) : cards;
      const syncInfo = describeSync(t, syncState, now);
      const canSync = syncCanRun(syncState) && busy !== "sync";

      const head = h(
        "div",
        { style: S.head, key: "head" },
        h(
          "div",
          { style: { minWidth: 0 } },
          h("div", { style: S.titleWrap }, h("h1", { style: S.h1 }, t("panel.title"))),
          h("p", { style: S.sub }, t("panel.subtitle"))
        ),
        h(
          "div",
          { style: { display: "flex", alignItems: "center", gap: "8px" } },
          h("span", { style: S.count }, t("list.count", { count: visible.length })),
          h(Button, { onClick: loadList, disabled: listPhase === "loading", title: t("list.refresh") }, t("list.refresh"))
        )
      );

      const toolbar = h(
        "div",
        { style: S.toolbar, key: "toolbar" },
        h("span", { style: S.label }, t("list.siteLabel")),
        h(
          "select",
          {
            value: activeSite,
            onChange: (event) => {
              setSite(event.target.value);
              setConfirm(null);
            },
            style: S.select,
            "aria-label": t("list.siteLabel")
          },
          [
            h("option", { key: "__all", value: "" }, t("list.siteAll") + " · " + cards.length),
            ...siteKeys.map((key) => h("option", { key: key, value: key }, key + " · " + siteCounts[key]))
          ]
        ),
        activeSite
          ? h(
              Button,
              {
                kind: "danger",
                disabled: !!busy,
                onClick: () => setConfirm({ kind: "clear", site: activeSite, count: siteCounts[activeSite] || 0 })
              },
              t("action.clearSite")
            )
          : null,
        confirm && confirm.kind === "clear"
          ? h(
              "div",
              { style: Object.assign({}, S.confirm, { margin: 0 }) },
              h("span", { style: S.confirmText }, t("confirm.clear", { site: confirm.site, count: confirm.count })),
              h(Button, { kind: "danger", disabled: !!busy, onClick: () => doClearSite(confirm.site) }, t("confirm.ok")),
              h(Button, { onClick: () => setConfirm(null) }, t("confirm.cancel"))
            )
          : null
      );

      const syncBar = h(
        "div",
        { style: S.syncBar, key: "sync" },
        h(Dot, { color: syncInfo.color }),
        h("span", { style: S.syncText }, h("strong", { style: { fontWeight: 600 } }, t("sync.title") + " · " + syncInfo.text)),
        syncInfo.hint ? h("span", { style: S.syncHint }, syncInfo.hint) : h("span", { style: S.syncHint }),
        h(
          "div",
          { style: S.syncRight },
          h(
            Button,
            { kind: "brand", disabled: !canSync, onClick: runSync, title: canSync ? t("sync.now") : undefined },
            busy === "sync" ? t("sync.running") : t("sync.now")
          )
        )
      );

      const listBody = [];
      if (listPhase === "loading" && cards.length === 0) {
        listBody.push(h("p", { key: "loading", style: S.hint }, t("list.reading")));
      } else if (listPhase === "error") {
        listBody.push(
          h(
            "div",
            { key: "error" },
            h("p", { style: S.noteBad }, t("list.failed", { message: listError })),
            h(Button, { onClick: loadList, style: { marginTop: "6px" } }, t("list.retry"))
          )
        );
      } else if (visible.length === 0) {
        listBody.push(h("p", { key: "empty", style: S.hint }, activeSite ? t("list.emptySite", { site: activeSite }) : t("list.empty")));
      } else {
        visible.forEach((card) => {
          listBody.push(
            h(CardRow, {
              key: card.id,
              card,
              now,
              t,
              selected: card.id === selectedId,
              onSelect: (id) => {
                setSelectedId(id);
                setConfirm(null);
                setNotice(null);
              }
            })
          );
        });
      }

      if (notice) listBody.push(h("p", { key: "notice", style: notice.bad ? S.noteBad : S.note }, notice.text));
      if (syncNote) listBody.push(h("p", { key: "syncNote", style: S.note }, syncNote));

      const body = h(
        "div",
        { style: S.body, key: "body" },
        h("div", { style: S.listPane }, listBody),
        h(DetailPane, {
          t,
          now,
          state: detail,
          confirm,
          busy,
          onAskDelete: (card) => setConfirm({ kind: "delete", id: card.id, title: card.title || "" }),
          onConfirmDelete: () => {
            const target = confirm && confirm.kind === "delete" ? confirm.id : selectedId;
            if (target) doDelete(target);
          },
          onCancelAsk: () => setConfirm(null)
        })
      );

      return h("div", { style: S.page }, [head, toolbar, syncBar, body]);
    }

    // ===== ⑩ 侧栏图标（currentColor，跟随主题；active 时提亮） =====
    function PageChatIcon(props) {
      const size = (props && props.size) || 18;
      const active = !!(props && props.active);
      return h(
        "svg",
        {
          width: size,
          height: size,
          viewBox: "0 0 20 20",
          fill: "none",
          "aria-hidden": "true",
          style: { opacity: active ? 1 : 0.72 }
        },
        // 一页纸 + 右下角的对话气泡
        h("path", {
          d: "M5.2 2.8h6.1l3.9 3.9v3.4",
          stroke: "currentColor",
          strokeWidth: 1.3,
          strokeLinecap: "round",
          strokeLinejoin: "round"
        }),
        h("path", {
          d: "M5.2 2.8v14.4h4.4",
          stroke: "currentColor",
          strokeWidth: 1.3,
          strokeLinecap: "round",
          strokeLinejoin: "round"
        }),
        h("path", {
          d: "M11.3 2.8v3.9h3.9",
          stroke: "currentColor",
          strokeWidth: 1.3,
          strokeLinecap: "round",
          strokeLinejoin: "round"
        }),
        h("path", {
          d: "M11.6 11.7h5.1c.6 0 1.1.5 1.1 1.1v2.6c0 .6-.5 1.1-1.1 1.1h-1.5l-1.9 1.5v-1.5h-1.7c-.6 0-1.1-.5-1.1-1.1v-2.6c0-.6.5-1.1 1.1-1.1z",
          stroke: "currentColor",
          strokeWidth: 1.3,
          strokeLinejoin: "round"
        })
      );
    }

    // ===== ⑪ 挂载 =====
    const inject = ["slots", "locale"];

    function apply(ctx) {
      if (ctx && ctx.locale) {
        localeRuntime = ctx.locale;
        const mountDictionaries = () => {
          try {
            return ctx.locale.register(NS, { zh: DICT.zh, en: DICT.en });
          } catch (error) {
            // 重复 apply（HMR / 同一页面装载两次）时字典已经在，继续用旧的即可
            return undefined;
          }
        };
        if (typeof ctx.effect === "function") ctx.effect(mountDictionaries, "page-chat: client dictionaries");
        else mountDictionaries();
        if (typeof ctx.locale.bind === "function") translate = ctx.locale.bind(NS);
      }

      const slots = ctx && ctx.slots;
      if (!slots || typeof slots.inject !== "function" || typeof slots.register !== "function") return;

      // 中央面板：key 与侧栏入口 id 必须一致，否则点图标切不过来。
      // locale: NS 让槽位系统在切语言时重投影一次（面板自己也订阅了，双保险）。
      slots.inject("main", () =>
        slots.register({ name: "main", key: PANEL_ID, locale: NS }, PageChatMemoryPanel)
      );
      slots.inject("sidebar.panellist", () =>
        slots.register(
          { name: "sidebar.panellist", id: PANEL_ID, order: 9, locale: NS, label: () => translate("panel.title") },
          PageChatIcon
        )
      );
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  }
});
