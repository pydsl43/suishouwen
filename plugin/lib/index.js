/**
 * @pydsl/dsh-page-chat —— 网页小框问答的宿主侧入口。
 *
 * 只注册一条 `/page-chat` 前缀路由（多条会撞「路由已存在」），内部按路径分发：
 *
 *   GET  /page-chat/health          → { ok, dshReady, sessions, version, now }
 *   POST /page-chat/ping            → 扩展启动时报到（版本 / 浏览器 / 站点），落盘
 *   GET  /page-chat/installed       → 扩展装没装 / 上次报到的版本与时间
 *   POST /page-chat/ask             → NDJSON：{ack} → {delta}* → {done} / {error}
 *   POST /page-chat/reset           → { ok, dropped }
 *   POST /page-chat/memorize        → 把这段对话压成记忆卡片
 *   POST /page-chat/memorize/undo   → 删掉刚记的那张
 *   POST /page-chat/to-board        → 把这段对话转成看板里的一张卡（转发 /pydsl/dsh-board/clip）
 *   GET  /page-chat/memory/list     → 记忆卡片列表（?site=）
 *   GET  /page-chat/memory/get      → 一张卡的原文（?id=）
 *   POST /page-chat/memory/delete   → 删一张
 *   POST /page-chat/memory/clear-site → 清一个站
 *   GET  /page-chat/sync/status     → 云同步状态（不含 token / pass）
 *   POST /page-chat/sync/config     → 改同步配置（白名单字段）
 *   POST /page-chat/sync/now        → 立刻同步一次
 *
 * 三条硬约束：
 *   1) 每个 handler 自己 try/catch —— 和宿主同进程，抛出去会连坐整个 DSH。
 *   2) 不 import 任何 `@deepseek-ai/*` 包 —— 插件装在 profile 外部目录，
 *      运行期解析不到；一切能力都从 ctx / scope 上的服务拿。
 *   3) 网页侧会话永远拿不到 memory_search / memory_open：那两个工具只挂在
 *      宿主全局，网页会话的 tools.restrict({ allow: [] }) 会把它们挡在外面。
 */

import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { PageChatSessions } from './session.js';
import { createMemory, siteOf } from './memory.js';
import { createCompressor } from './compress.js';
import { createSync } from './sync.js';
import { createSummarizer } from './summarizer.js';

/** 前缀（无尾斜杠：宿主按 `pathname === prefix || pathname.startsWith(prefix + '/')` 匹配）。 */
const PREFIX = '/page-chat';

/** 请求体上限 20MB（截图 base64 会比原图大三分之一左右）。 */
const BODY_MAX = 20 * 1024 * 1024;

/** 插件版本（健康检查里报给扩展，方便判断要不要升级）。 */
const PLUGIN_VERSION = '0.2.0';

/** 记忆注入段在系统提示里的名字 / 位置（排在工具说明之后、SDK 说明之前）。 */
const MEMORY_SECTION_NAME = 'page-chat-memory';
const MEMORY_SECTION_ORDER = 6100;

/** 注入段硬预算：连同抬头一起，总长不超过 700 字。 */
const MEMORY_TEXT_LIMIT = 700;

/** 注入段抬头：一定要说清「可能过时」和怎么查。 */
const MEMORY_HEAD = '【网页里记下的东西（可能过时；需要时用 memory_search 查、memory_open 看原文；跟当前页面冲突时以当前页面为准）】';

/** memory_search 默认返回几条 / 最多几条。 */
const SEARCH_DEFAULT_LIMIT = 5;
const SEARCH_MAX_LIMIT = 20;

/** memory_open 返回原文时的字数预算（卡片本身很短，原文才可能长）。 */
const OPEN_THREAD_BUDGET = 2000;

/** 看板落卡接口：和本插件同源（都挂在 DSH web 的同一个端口上）。 */
const BOARD_CLIP_PATH = '/pydsl/dsh-board/clip';

/** 转发给看板最多等 3 秒：看板没开时宁可快点失败，不拖着网页。 */
const BOARD_TIMEOUT_MS = 3000;

/** 带去卡片的对话原文最多 20 条（对面契约的上限）。 */
const BOARD_THREAD_LIMIT = 20;

/** 看板卡片标题最多 40 字（对面契约）。 */
const BOARD_TITLE_LIMIT = 40;


/** 统一的 CORS 头：扩展的 content script 和页面同源策略之外打过来。 */
function applyCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Max-Age', '600');
}

/** 回一个 JSON 响应（自己收尾，绝不 throw）。 */
function sendJson(res, status, payload) {
  try {
    if (res.writableEnded) return;
    const body = JSON.stringify(payload);
    res.statusCode = status;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Length', String(Buffer.byteLength(body)));
    res.end(body);
  } catch {
    /* 连接已经断了 */
  }
}

/** 取 URL 的路径部分（去掉 query）。 */
function requestPathOf(req) {
  const raw = req && typeof req.url === 'string' ? req.url : '';
  const cut = raw.indexOf('?');
  return cut === -1 ? raw : raw.slice(0, cut);
}

/** 取 URL 的 query 参数；坏编码当空表。 */
function queryOf(req) {
  const raw = req && typeof req.url === 'string' ? req.url : '';
  const cut = raw.indexOf('?');
  if (cut === -1) return new URLSearchParams();
  try {
    return new URLSearchParams(raw.slice(cut + 1));
  } catch {
    return new URLSearchParams();
  }
}

/** 去掉尾斜杠，便于 `/page-chat/ask/` 也认。 */
function normalizePath(pathname) {
  return pathname.length > 1 && pathname.endsWith('/') ? pathname.slice(0, -1) : pathname;
}

/**
 * 读 JSON 请求体，超限抛 code=body-too-large。
 * @param req - IncomingMessage。
 * @returns 解析后的对象（空体给 {}）。
 */
async function readJsonBody(req) {
  if (req && typeof req.body === 'string') return parseJson(req.body);
  if (!req || typeof req[Symbol.asyncIterator] !== 'function') return {};
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8');
    size += buf.length;
    if (size > BODY_MAX) {
      const error = new Error(`请求体超过 ${BODY_MAX} 字节`);
      error.code = 'body-too-large';
      throw error;
    }
    chunks.push(buf);
  }
  return parseJson(Buffer.concat(chunks).toString('utf8'));
}

/** 宽容解析：空串当 {}，坏 JSON 给出可读错误。 */
function parseJson(text) {
  const raw = typeof text === 'string' ? text.trim() : '';
  if (!raw) return {};
  try {
    const value = JSON.parse(raw);
    return value && typeof value === 'object' ? value : {};
  } catch {
    throw new Error('请求体不是合法 JSON');
  }
}

/** 错误文案统一取一条字符串。 */
function messageOf(error) {
  if (!error) return '未知错误';
  return error && error.message ? String(error.message) : String(error);
}

/** 从请求体里取 key：非空字符串才算数。 */
function keyOf(body) {
  const key = body && typeof body.key === 'string' ? body.key.trim() : '';
  return key.length > 0 ? key : '';
}

/** DSH 家目录：优先 $DSH_HOME（探针 profile 会改它），否则 ~/.dsh。 */
function dshHomeDir() {
  const raw = typeof process.env.DSH_HOME === 'string' ? process.env.DSH_HOME.trim() : '';
  return raw ? path.resolve(raw) : path.join(os.homedir(), '.dsh');
}

/** 把配置里的目录变成绝对路径；没配就落到 DSH 家目录下的同名目录。 */
function resolveDir(value, fallback) {
  const raw = typeof value === 'string' ? value.trim() : '';
  return raw ? path.resolve(raw) : fallback;
}

/** 把数字限制在 [min, max] 之间，坏值用 fallback。 */
function clampNumber(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

/** 卡片对外的统一形状（列表 / 工具都用它，只是工具那边会拼成文字）。 */
function cardView(card) {
  return {
    id: card.id,
    title: card.title,
    summary: card.summary,
    tags: Array.isArray(card.tags) ? card.tags : [],
    category: card.category,
    site: card.site,
    at: card.createdAt,
    hasImage: !!card.hasImage,
  };
}

/**
 * 把浏览器传来的第一张图归一成 memory.saveCard 认的 {mimeType, data}。
 * @param images - 请求体里的 images。
 * @returns 最多一项的数组。
 */
function firstImageOf(images) {
  if (!Array.isArray(images) || images.length === 0) return [];
  const item = images[0];
  if (typeof item === 'string' && item.trim()) {
    const match = /^data:([^;,]+)?(?:;[^,]*)?;base64,/.exec(item);
    return [{ mimeType: match ? (match[1] || '') : '', data: item }];
  }
  if (item && typeof item === 'object') {
    const data = typeof item.data === 'string' ? item.data : '';
    if (!data) return [];
    return [{ mimeType: typeof item.mimeType === 'string' ? item.mimeType : '', data }];
  }
  return [];
}

/**
 * 记忆注入段：抬头 + buildInjection 的结果，总长 ≤700 字。
 * 每轮重新读卡片；没有卡片就返回空串（不给系统提示添噪音）。
 * @param memory - createMemory 的返回值。
 * @returns 系统提示里的一段文字。
 */
function memorySectionText(memory) {
  try {
    if (!memory) return '';
    const cards = memory.listCards({ limit: 20 });
    if (!cards.length) return '';
    const injection = memory.buildInjection(cards);
    if (!injection) return '';
    // buildInjection 自带一句「以前记的…」抬头；这里换成带 memory_search 提示的抬头。
    const lines = String(injection).split('\n');
    if (lines.length > 0 && lines[0].startsWith('【')) lines.shift();
    const body = lines.join('\n').trim();
    if (!body) return '';
    const text = MEMORY_HEAD + '\n' + body;
    if (text.length <= MEMORY_TEXT_LIMIT) return text;
    const cut = text.lastIndexOf('\n', MEMORY_TEXT_LIMIT);
    return cut > 0 ? text.slice(0, cut) : text.slice(0, MEMORY_TEXT_LIMIT);
  } catch {
    return '';
  }
}

/**
 * 可选服务：tools 缺席（测试桩 / 精简运行时）时返回 undefined，不抛。
 * @param scope - 注入拿到的 scope。
 */
function optionalTools(scope) {
  try {
    const value = Reflect.get(scope, 'tools');
    return value && typeof value.register === 'function' ? value : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 可选服务：systemPrompt 缺席（测试桩 / 精简运行时）时返回 undefined，不抛。
 * @param scope - 注入拿到的 scope。
 */
function optionalSystemPrompt(scope) {
  try {
    const value = Reflect.get(scope, 'systemPrompt');
    return value && typeof value.section === 'function' ? value : undefined;
  } catch {
    return undefined;
  }
}

/** 记忆库没打开时，路由统一回 503（不让空指针冒成 500）。 */
function memoryMissing(res, deps) {
  sendJson(res, 503, { ok: false, error: `记忆库没打开：${deps.memoryError || '未知原因'}` });
}

/**
 * 健康检查：扩展用它判断「后端在不在、能不能建会话」。
 * @param res - ServerResponse。
 * @param sessions - 会话池。
 */
function healthHandler(res, sessions) {
  const ready = sessions.canRun();
  sendJson(res, 200, {
    ok: true,
    dshReady: ready,
    sessions: sessions.size,
    version: PLUGIN_VERSION,
    now: new Date().toISOString(),
  });
}

/** 安装记录文件名：放在记忆目录同级，重启 DSH 后还能回答「上次装的是哪个版本」。 */
const INSTALLED_FILE = 'page-chat-installed.json';

/** 从请求体里取一个短字符串字段（非字符串一律当空）。 */
function textFieldOf(value, limit = 200) {
  const raw = typeof value === 'string' ? value.trim() : '';
  return raw.length > limit ? raw.slice(0, limit) : raw;
}

/**
 * 扩展报到记录：内存 + 落盘。写盘走「先写 .tmp 再 rename」，半截文件不会顶替好文件。
 * @param dir - 放 page-chat-installed.json 的目录（记忆目录的同级）。
 */
function createInstalledStore(dir) {
  const file = path.join(dir, INSTALLED_FILE);
  let last = null;
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (value && typeof value.at === 'string' && value.at) {
      last = {
        at: value.at,
        version: textFieldOf(value.version),
        browser: textFieldOf(value.browser),
        page: textFieldOf(value.page),
      };
    }
  } catch {
    /* 没有记录 / 文件坏了：都当「还没装」 */
  }

  return {
    file,
    /** 记一次报到；落盘失败也不影响回 200（内存里仍然有）。 */
    record(body) {
      last = {
        at: new Date().toISOString(),
        version: textFieldOf(body && body.version),
        browser: textFieldOf(body && body.browser),
        page: textFieldOf(body && body.page),
      };
      try {
        fs.mkdirSync(dir, { recursive: true });
        const tmp = `${file}.tmp`;
        fs.writeFileSync(tmp, `${JSON.stringify(last, null, 2)}\n`, 'utf8');
        fs.renameSync(tmp, file);
      } catch {
        /* 落盘失败：内存记录照样能回答本次运行的 GET */
      }
      return last;
    },
    /** 对外形状：没记录时 installed:false。 */
    view() {
      if (!last) return { installed: false, version: '', browser: '', page: '', at: '', agoSeconds: null };
      const at = Date.parse(last.at);
      return {
        installed: true,
        version: last.version,
        browser: last.browser,
        page: last.page,
        at: last.at,
        agoSeconds: Number.isFinite(at) ? Math.max(0, Math.round((Date.now() - at) / 1000)) : null,
      };
    },
  };
}

/**
 * /ping：扩展每次启动报一次到（版本 / 浏览器 / 当前站点），落盘供重启后核对。
 * 错误一律 400 —— 这个接口只用来记「装上了」，不该抛 500。
 */
async function pingHandler(req, res, deps) {
  let body;
  try {
    body = await readJsonBody(req);
  } catch (error) {
    sendJson(res, 400, { ok: false, error: messageOf(error) });
    return;
  }
  const version = textFieldOf(body && body.version);
  const browser = textFieldOf(body && body.browser);
  const page = textFieldOf(body && body.page);
  // 三个字段全空 = 一条什么信息都没有的报到；记下来只会把上一次真记录擦成空，所以当坏 body 拒掉。
  if (!version && !browser && !page) {
    sendJson(res, 400, { ok: false, error: 'ping 至少要带 version' });
    return;
  }
  const store = deps.installed || createInstalledStore(dshHomeDir());
  store.record({ version, browser, page });
  sendJson(res, 200, { ok: true });
}

/** /installed：给安装脚本 / 助手自检用（不依赖扩展实时在线）。 */
function installedHandler(res, deps) {
  const store = deps.installed || createInstalledStore(dshHomeDir());
  sendJson(res, 200, { ok: true, ...store.view() });
}

/**
 * /ask：NDJSON 一行一个 JSON，先 ack，再若干 delta，最后 done 或 error。
 * @param req - IncomingMessage。
 * @param res - ServerResponse。
 * @param sessions - 会话池。
 */
async function askHandler(req, res, sessions) {
  let body;
  try {
    body = await readJsonBody(req);
  } catch (error) {
    const status = error && error.code === 'body-too-large' ? 413 : 400;
    sendJson(res, status, { ok: false, type: 'error', error: messageOf(error) });
    return;
  }
  const key = keyOf(body);
  if (!key) {
    sendJson(res, 400, { ok: false, type: 'error', error: '缺少 key' });
    return;
  }

  // 从这里开始变成流：头一旦写出就不能再改状态码。
  let closed = false;
  const write = (payload) => {
    if (closed) return;
    try {
      res.write(`${JSON.stringify(payload)}\n`);
    } catch {
      closed = true;
    }
  };
  try {
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    write({ type: 'ack', key });
  } catch {
    closed = true;
    return;
  }

  try {
    const result = await sessions.ask(
      key,
      { text: typeof body.text === 'string' ? body.text : '', images: body.images },
      (event) => {
        if (event && event.type === 'delta' && event.text) write({ type: 'delta', text: event.text });
      },
    );
    write({ type: 'done', text: result.text || '' });
  } catch (error) {
    write({ type: 'error', error: messageOf(error) });
  } finally {
    closed = true;
    try {
      if (!res.writableEnded) res.end();
    } catch {
      /* 客户端已断开 */
    }
  }
}

/**
 * /reset：丢掉这个 key 的会话，下一问是全新的。
 * @param req - IncomingMessage。
 * @param res - ServerResponse。
 * @param sessions - 会话池。
 */
async function resetHandler(req, res, sessions) {
  let body;
  try {
    body = await readJsonBody(req);
  } catch (error) {
    const status = error && error.code === 'body-too-large' ? 413 : 400;
    sendJson(res, status, { ok: false, error: messageOf(error) });
    return;
  }
  const key = keyOf(body);
  if (!key) {
    sendJson(res, 400, { ok: false, error: '缺少 key' });
    return;
  }
  let dropped = false;
  try {
    // forget 会连对话原文一起清掉；老版本会话池没有 forget 就退回 drop。
    dropped = typeof sessions.forget === 'function' ? await sessions.forget(key) : await sessions.drop(key);
  } catch (error) {
    sendJson(res, 500, { ok: false, error: messageOf(error) });
    return;
  }
  sendJson(res, 200, { ok: true, dropped });
}

/**
 * /memorize：把某个 key 的对话压成一张记忆卡片，落盘后顺手后台同步。
 * @param req - IncomingMessage。
 * @param res - ServerResponse。
 * @param sessions - 会话池。
 * @param deps - { memory, sync, compressor, memoryError }。
 */
async function memorizeHandler(req, res, sessions, deps) {
  if (!deps.memory) {
    memoryMissing(res, deps);
    return;
  }
  let body;
  try {
    body = await readJsonBody(req);
  } catch (error) {
    const status = error && error.code === 'body-too-large' ? 413 : 400;
    sendJson(res, status, { ok: false, error: messageOf(error) });
    return;
  }
  const key = keyOf(body);
  if (!key) {
    sendJson(res, 400, { ok: false, error: '缺少 key' });
    return;
  }
  const thread = typeof sessions.threadOf === 'function' ? sessions.threadOf(key) : [];
  if (!thread.length) {
    sendJson(res, 400, { ok: false, error: '这段还没聊过什么，先问一句再记' });
    return;
  }
  if (!deps.compressor || typeof deps.compressor.summarizeThread !== 'function') {
    sendJson(res, 503, { ok: false, error: '压卡片的模型还没接上' });
    return;
  }

  // 用户点「记住这段」时可以补一句；把它当最后一条「我」的话一起压。
  const note = typeof body.text === 'string' ? body.text.trim() : '';
  const input = note ? thread.concat([{ role: 'me', text: note, hasImage: false }]) : thread;

  let cardText;
  try {
    cardText = await deps.compressor.summarizeThread(input);
  } catch (error) {
    sendJson(res, 500, { ok: false, error: `压成卡片失败：${messageOf(error)}` });
    return;
  }

  const page = body.page && typeof body.page === 'object' ? body.page : {};
  const url = typeof page.url === 'string' ? page.url : '';
  const title = typeof page.title === 'string' ? page.title : '';
  let card;
  try {
    card = deps.memory.saveCard(thread, cardText, {
      site: siteOf(url),
      sourceUrl: url,
      sourceTitle: title,
      images: firstImageOf(body.images),
    });
  } catch (error) {
    sendJson(res, 500, { ok: false, error: `记忆没存下去：${messageOf(error)}` });
    return;
  }

  // 同步是锦上添花：配置没开、网断了都不影响这张卡已经存好。
  try {
    if (deps.sync && typeof deps.sync.syncInBackground === 'function') deps.sync.syncInBackground();
  } catch {
    /* 同步失败不影响保存 */
  }

  sendJson(res, 200, {
    ok: true,
    card: {
      id: card.id,
      title: card.title,
      summary: card.summary,
      tags: card.tags,
      category: card.category,
      hasImage: !!card.hasImage,
    },
  });
}

/**
 * /memorize/undo：删掉刚记的那张。
 * @param req - IncomingMessage。
 * @param res - ServerResponse。
 * @param deps - { memory, memoryError }。
 */
async function undoHandler(req, res, deps) {
  if (!deps.memory) {
    memoryMissing(res, deps);
    return;
  }
  let body;
  try {
    body = await readJsonBody(req);
  } catch (error) {
    const status = error && error.code === 'body-too-large' ? 413 : 400;
    sendJson(res, status, { ok: false, error: messageOf(error) });
    return;
  }
  const id = typeof body.id === 'string' ? body.id.trim() : '';
  if (!id) {
    sendJson(res, 400, { ok: false, error: '缺少 id' });
    return;
  }
  let deleted = false;
  try {
    deleted = deps.memory.deleteCard(id) === true;
  } catch (error) {
    sendJson(res, 500, { ok: false, error: messageOf(error) });
    return;
  }
  if (!deleted) {
    sendJson(res, 404, { ok: false, error: '没有这张记忆（可能已经删了）' });
    return;
  }
  sendJson(res, 200, { ok: true, deleted: true, id });
}

/**
 * GET /memory/list?site=：列出记忆卡片（只列没删的）。
 * @param req - IncomingMessage。
 * @param res - ServerResponse。
 * @param deps - { memory, memoryError }。
 */
function memoryListHandler(req, res, deps) {
  if (!deps.memory) {
    memoryMissing(res, deps);
    return;
  }
  const query = queryOf(req);
  const site = (query.get('site') || '').trim();
  try {
    const cards = deps.memory.listCards({ site, limit: 200 }).map(cardView);
    sendJson(res, 200, { ok: true, site, cards });
  } catch (error) {
    sendJson(res, 500, { ok: false, error: messageOf(error) });
  }
}

/**
 * GET /memory/get?id=：取一张卡 + 原文。
 * @param req - IncomingMessage。
 * @param res - ServerResponse。
 * @param deps - { memory, memoryError }。
 */
function memoryGetHandler(req, res, deps) {
  if (!deps.memory) {
    memoryMissing(res, deps);
    return;
  }
  const id = (queryOf(req).get('id') || '').trim();
  if (!id) {
    sendJson(res, 400, { ok: false, error: '缺少 id' });
    return;
  }
  let card;
  try {
    card = deps.memory.getCard(id);
  } catch (error) {
    sendJson(res, 500, { ok: false, error: messageOf(error) });
    return;
  }
  if (!card || card.status !== 'active') {
    sendJson(res, 404, { ok: false, error: '没有这张记忆（id 不对，或者已经删了）' });
    return;
  }
  const { thread, ...rest } = card;
  sendJson(res, 200, {
    ok: true,
    card: { ...cardView(rest), points: rest.points || [], sourceUrl: rest.sourceUrl || '', sourceTitle: rest.sourceTitle || '', turns: rest.turns || 0 },
    thread: Array.isArray(thread) ? thread : [],
  });
}

/**
 * POST /memory/delete：删一张卡。
 * @param req - IncomingMessage。
 * @param res - ServerResponse。
 * @param deps - { memory, memoryError }。
 */
async function memoryDeleteHandler(req, res, deps) {
  if (!deps.memory) {
    memoryMissing(res, deps);
    return;
  }
  let body;
  try {
    body = await readJsonBody(req);
  } catch (error) {
    const status = error && error.code === 'body-too-large' ? 413 : 400;
    sendJson(res, status, { ok: false, error: messageOf(error) });
    return;
  }
  const id = typeof body.id === 'string' ? body.id.trim() : '';
  if (!id) {
    sendJson(res, 400, { ok: false, error: '缺少 id' });
    return;
  }
  let deleted = false;
  try {
    deleted = deps.memory.deleteCard(id) === true;
  } catch (error) {
    sendJson(res, 500, { ok: false, error: messageOf(error) });
    return;
  }
  if (!deleted) {
    sendJson(res, 404, { ok: false, error: '没有这张记忆（可能已经删了）' });
    return;
  }
  sendJson(res, 200, { ok: true, deleted: true, id });
}

/**
 * POST /memory/clear-site：清掉一个站记的所有卡片。
 * @param req - IncomingMessage。
 * @param res - ServerResponse。
 * @param deps - { memory, memoryError }。
 */
async function memoryClearSiteHandler(req, res, deps) {
  if (!deps.memory) {
    memoryMissing(res, deps);
    return;
  }
  let body;
  try {
    body = await readJsonBody(req);
  } catch (error) {
    const status = error && error.code === 'body-too-large' ? 413 : 400;
    sendJson(res, status, { ok: false, error: messageOf(error) });
    return;
  }
  const site = typeof body.site === 'string' ? body.site.trim() : '';
  if (!site) {
    sendJson(res, 400, { ok: false, error: '缺少 site' });
    return;
  }
  let removed = 0;
  try {
    removed = deps.memory.clearSite(site);
  } catch (error) {
    sendJson(res, 500, { ok: false, error: messageOf(error) });
    return;
  }
  sendJson(res, 200, { ok: true, removed, site });
}

/**
 * GET /sync/status：同步状态（publicConfig，不含 token / pass）。
 * @param res - ServerResponse。
 * @param deps - { sync }。
 */
function syncStatusHandler(res, deps) {
  if (!deps.sync) {
    sendJson(res, 503, { ok: false, error: '同步没打开' });
    return;
  }
  try {
    sendJson(res, 200, { ok: true, config: deps.sync.status() });
  } catch (error) {
    sendJson(res, 500, { ok: false, error: messageOf(error) });
  }
}

/**
 * 只挑白名单字段：别让请求体把内部字段（比如 lastResult）塞进来。
 * @param body - 请求体。
 * @returns 可以交给 saveConfig 的 patch。
 */
function pickSyncPatch(body) {
  const patch = {};
  for (const key of ['kind', 'device', 'branch']) {
    if (typeof body[key] === 'string') patch[key] = body[key];
  }
  for (const key of ['enabled', 'syncShots']) {
    if (typeof body[key] === 'boolean') patch[key] = body[key];
  }
  const github = body.github;
  if (github && typeof github === 'object') {
    const picked = {};
    for (const key of ['owner', 'repo', 'token', 'apiBase']) {
      if (typeof github[key] === 'string') picked[key] = github[key];
    }
    if (Object.keys(picked).length > 0) patch.github = picked;
  }
  const webdav = body.webdav;
  if (webdav && typeof webdav === 'object') {
    const picked = {};
    for (const key of ['url', 'user', 'pass']) {
      if (typeof webdav[key] === 'string') picked[key] = webdav[key];
    }
    if (Object.keys(picked).length > 0) patch.webdav = picked;
  }
  return patch;
}

/**
 * POST /sync/config：改同步配置，返回 publicConfig（不回显 token / pass）。
 * @param req - IncomingMessage。
 * @param res - ServerResponse。
 * @param deps - { sync }。
 */
async function syncConfigHandler(req, res, deps) {
  if (!deps.sync) {
    sendJson(res, 503, { ok: false, error: '同步没打开' });
    return;
  }
  let body;
  try {
    body = await readJsonBody(req);
  } catch (error) {
    const status = error && error.code === 'body-too-large' ? 413 : 400;
    sendJson(res, status, { ok: false, error: messageOf(error) });
    return;
  }
  try {
    const config = deps.sync.saveConfig(pickSyncPatch(body));
    sendJson(res, 200, { ok: true, config });
  } catch (error) {
    sendJson(res, 500, { ok: false, error: messageOf(error) });
  }
}

/**
 * POST /sync/now：立刻同步一次（失败也回 200 + ok:false，前端能读到原因）。
 * @param res - ServerResponse。
 * @param deps - { sync }。
 */
async function syncNowHandler(res, deps) {
  if (!deps.sync) {
    sendJson(res, 503, { ok: false, error: '同步没打开' });
    return;
  }
  try {
    const result = await deps.sync.syncNow();
    sendJson(res, 200, {
      ok: result && result.ok === true,
      pushed: (result && result.pushed) || [],
      pulled: (result && result.pulled) || [],
      removed: (result && result.removed) || [],
      conflicts: (result && result.conflicts) || [],
      detail: (result && result.detail) || '',
      ms: (result && result.ms) || 0,
      config: deps.sync.status(),
    });
  } catch (error) {
    sendJson(res, 500, { ok: false, error: messageOf(error) });
  }
}

// ---------- 看板联动：把这段对话存成看板上的一张卡 ----------

/** 取一段可用的文本：非字符串给空串，多余空白压成一个空格。 */
function textOf(value) {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
}

/**
 * 看板在哪个地址。
 * 看板插件和本插件挂在同一个 DSH web 上，所以默认用本次请求的 Host 同源推理
 * （即 `/page-chat/health` 的那个服务）；config.boardBase 可以覆盖（测试 / 反代）。
 * @param req - IncomingMessage。
 * @param deps - 可能有 boardBase。
 * @returns 形如 `http://127.0.0.1:3080` 的基址（无尾斜杠）。
 */
function boardBaseOf(req, deps) {
  const configured = deps && typeof deps.boardBase === 'string' ? deps.boardBase.trim() : '';
  if (configured) return configured.replace(/\/+$/, '');
  const headers = req && req.headers && typeof req.headers === 'object' ? req.headers : {};
  const raw = String(headers['x-forwarded-host'] || headers.host || '').trim();
  const host = raw.split(',')[0].trim();
  if (host && /^[A-Za-z0-9.\-:[\]]+$/.test(host)) return `http://${host}`;
  return 'http://127.0.0.1:3080';
}

/**
 * 把请求体 + 会话原文拼成看板 /clip 的 body。
 * 标题/问题/摘要缺省时自己补：标题取第一句「我」的话前 40 字，why 取第一段回答的前半段。
 * @param body - 请求体 { key, memoryId?, title?, ask?, why?, project?, source? }。
 * @param thread - 会话原文 [{ role, text }]。
 * @returns clip 契约里的 body。
 */
function clipBodyOf(body, thread) {
  const list = Array.isArray(thread) ? thread.slice(-BOARD_THREAD_LIMIT) : [];
  const firstMe = list.find((m) => m && m.role === 'me' && textOf(m.text));
  const firstDsh = list.find((m) => m && m.role === 'dsh' && textOf(m.text));
  const ask = textOf(body.ask) || (firstMe ? textOf(firstMe.text) : '');
  const answer = firstDsh ? textOf(firstDsh.text) : '';
  const half = answer ? answer.slice(0, Math.max(60, Math.min(200, Math.ceil(answer.length / 2)))) : '';
  const title = textOf(body.title).slice(0, BOARD_TITLE_LIMIT) || ask.slice(0, BOARD_TITLE_LIMIT) || '网页里的一段';
  const why = textOf(body.why) || half || ask.slice(0, 200);
  const sourceIn = body.source && typeof body.source === 'object' ? body.source : {};
  const page = body.page && typeof body.page === 'object' ? body.page : {};
  const url = textOf(sourceIn.url) || textOf(page.url);
  const sourceTitle = textOf(sourceIn.title) || textOf(page.title);
  const threadOut = list
    .map((m) => ({ role: m && m.role === 'me' ? 'me' : 'dsh', text: textOf(m && m.text) }))
    .filter((m) => m.text.length > 0);
  return {
    title: title.slice(0, BOARD_TITLE_LIMIT),
    ask: ask.slice(0, 2000),
    why: why.slice(0, 500),
    project: textOf(body.project),
    // 浏览器传来的 source 原样带上（认识的三个字段归一化，其余字段一个不丢）
    source: { ...sourceIn, url, title: sourceTitle, site: textOf(sourceIn.site) || siteOf(url) },
    memoryId: textOf(body.memoryId),
    thread: threadOut,
  };
}

/**
 * 把卡片转发给看板插件。
 * 看板没开 / 端口不通时不能抛出去（会连坐 DSH），一律折成结果对象。
 * @param base - 看板基址。
 * @param payload - clip 契约 body。
 * @param timeoutMs - 超时（默认 3 秒）。
 * @returns { ok, status, cardId, project, error }。
 */
async function postBoardClip(base, payload, timeoutMs = BOARD_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${base}${BOARD_CLIP_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    const raw = await res.text().catch(() => '');
    let data = {};
    try {
      data = raw ? JSON.parse(raw) : {};
    } catch {
      data = {};
    }
    const view = data && typeof data === 'object' ? data : {};
    return {
      ok: !!res.ok && view.ok === true,
      status: Number(res.status) || 0,
      cardId: typeof view.cardId === 'string' ? view.cardId : '',
      project: typeof view.project === 'string' ? view.project : '',
      error: typeof view.error === 'string' ? view.error : '',
    };
  } catch (error) {
    return { ok: false, status: 0, cardId: '', project: '', error: messageOf(error) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * POST /page-chat/to-board：把这段对话变成看板里的一张卡。
 * @param req - IncomingMessage。
 * @param res - ServerResponse。
 * @param sessions - 会话池（要 threadOf）。
 * @param deps - 可能带 boardBase。
 */
async function toBoardHandler(req, res, sessions, deps) {
  let body;
  try {
    body = await readJsonBody(req);
  } catch (error) {
    const status = error && error.code === 'body-too-large' ? 413 : 400;
    sendJson(res, status, { ok: false, error: messageOf(error) });
    return;
  }
  const key = keyOf(body);
  if (!key) {
    sendJson(res, 400, { ok: false, error: '缺少 key（不知道是哪段对话）' });
    return;
  }
  const thread = sessions && typeof sessions.threadOf === 'function' ? sessions.threadOf(key) : [];
  const payload = clipBodyOf(body, thread);
  if (!payload.ask && payload.thread.length === 0) {
    sendJson(res, 400, { ok: false, error: '这段还没聊过什么，先问一句再存' });
    return;
  }
  const result = await postBoardClip(boardBaseOf(req, deps), payload);
  if (!result.ok) {
    // 连不上 / 看板插件没装（404）——对网页小框来说是同一件事：这台 DSH 上没有看板。
    if (result.status === 0 || result.status === 404 || result.status === 405 || result.status === 501) {
      sendJson(res, 503, { ok: false, error: '看板插件没装或没开' });
      return;
    }
    if (result.status >= 400 && result.status < 500) {
      sendJson(res, result.status, { ok: false, error: result.error || '看板没收下这张卡' });
      return;
    }
    sendJson(res, 502, { ok: false, error: result.error || '看板那边出错了' });
    return;
  }
  if (!result.cardId) {
    sendJson(res, 502, { ok: false, error: '看板说存好了，但没回卡片编号' });
    return;
  }
  sendJson(res, 200, { ok: true, cardId: result.cardId, project: result.project });
}

/**
 * 造一个前缀 handler：按路径 + 方法分发，其它路径 404。
 * @param sessions - 会话池。
 * @param deps - { memory, sync, compressor, memoryError, boardBase }。
 * @returns WebRoute handler。
 */
export function createHandler(sessions, deps = {}) {
  return async function pageChatHandler(req, res) {
    try {
      applyCors(res);
      const method = String((req && req.method) || 'GET').toUpperCase();
      const pathname = normalizePath(requestPathOf(req));

      if (method === 'OPTIONS') {
        if (!res.writableEnded) {
          res.statusCode = 204;
          res.setHeader('Content-Length', '0');
          res.end();
        }
        return;
      }

      if (pathname === `${PREFIX}/health`) {
        if (method !== 'GET') {
          sendJson(res, 405, { ok: false, error: 'health 只认 GET' });
          return;
        }
        healthHandler(res, sessions);
        return;
      }

      if (pathname === `${PREFIX}/ping`) {
        if (method !== 'POST') {
          sendJson(res, 405, { ok: false, error: 'ping 只认 POST' });
          return;
        }
        await pingHandler(req, res, deps);
        return;
      }

      if (pathname === `${PREFIX}/installed`) {
        if (method !== 'GET') {
          sendJson(res, 405, { ok: false, error: 'installed 只认 GET' });
          return;
        }
        installedHandler(res, deps);
        return;
      }

      if (pathname === `${PREFIX}/ask`) {
        if (method !== 'POST') {
          sendJson(res, 405, { ok: false, error: 'ask 只认 POST' });
          return;
        }
        await askHandler(req, res, sessions);
        return;
      }

      if (pathname === `${PREFIX}/reset`) {
        if (method !== 'POST') {
          sendJson(res, 405, { ok: false, error: 'reset 只认 POST' });
          return;
        }
        await resetHandler(req, res, sessions);
        return;
      }

      if (pathname === `${PREFIX}/memorize`) {
        if (method !== 'POST') {
          sendJson(res, 405, { ok: false, error: 'memorize 只认 POST' });
          return;
        }
        await memorizeHandler(req, res, sessions, deps);
        return;
      }

      if (pathname === `${PREFIX}/memorize/undo`) {
        if (method !== 'POST') {
          sendJson(res, 405, { ok: false, error: 'memorize/undo 只认 POST' });
          return;
        }
        await undoHandler(req, res, deps);
        return;
      }

      if (pathname === `${PREFIX}/to-board`) {
        if (method !== 'POST') {
          sendJson(res, 405, { ok: false, error: 'to-board 只认 POST' });
          return;
        }
        await toBoardHandler(req, res, sessions, deps);
        return;
      }

      if (pathname === `${PREFIX}/memory/list`) {
        if (method !== 'GET') {
          sendJson(res, 405, { ok: false, error: 'memory/list 只认 GET' });
          return;
        }
        memoryListHandler(req, res, deps);
        return;
      }

      if (pathname === `${PREFIX}/memory/get`) {
        if (method !== 'GET') {
          sendJson(res, 405, { ok: false, error: 'memory/get 只认 GET' });
          return;
        }
        memoryGetHandler(req, res, deps);
        return;
      }

      if (pathname === `${PREFIX}/memory/delete`) {
        if (method !== 'POST') {
          sendJson(res, 405, { ok: false, error: 'memory/delete 只认 POST' });
          return;
        }
        await memoryDeleteHandler(req, res, deps);
        return;
      }

      if (pathname === `${PREFIX}/memory/clear-site`) {
        if (method !== 'POST') {
          sendJson(res, 405, { ok: false, error: 'memory/clear-site 只认 POST' });
          return;
        }
        await memoryClearSiteHandler(req, res, deps);
        return;
      }

      if (pathname === `${PREFIX}/sync/status`) {
        if (method !== 'GET') {
          sendJson(res, 405, { ok: false, error: 'sync/status 只认 GET' });
          return;
        }
        syncStatusHandler(res, deps);
        return;
      }

      if (pathname === `${PREFIX}/sync/config`) {
        if (method !== 'POST') {
          sendJson(res, 405, { ok: false, error: 'sync/config 只认 POST' });
          return;
        }
        await syncConfigHandler(req, res, deps);
        return;
      }

      if (pathname === `${PREFIX}/sync/now`) {
        if (method !== 'POST') {
          sendJson(res, 405, { ok: false, error: 'sync/now 只认 POST' });
          return;
        }
        await syncNowHandler(res, deps);
        return;
      }

      sendJson(res, 404, { ok: false, error: `没有这个接口：${pathname}` });
    } catch (error) {
      // 最后一道闸：绝不让异常冒到宿主进程。
      try {
        if (res.headersSent) {
          if (!res.writableEnded) res.end();
        } else {
          sendJson(res, 500, { ok: false, error: messageOf(error) });
        }
      } catch {
        /* 连接已经没了 */
      }
    }
  };
}

/**
 * memory_search 工具：按关键词查本地卡片（用 memory.pickFor，纯本地不调模型）。
 * @param deps - { memory, memoryError }。
 * @returns 工具定义（形状同 dsh-tools 的 defineTool 返回值）。
 */
function createMemorySearchTool(deps) {
  return {
    name: 'memory_search',
    description:
      '在「网页小框里记下的记忆卡片」里按关键词搜（标题 / 摘要 / 标签）。只读本地文件，不调模型、不联网。\n' +
      '返回若干行「id｜标题｜摘要｜站点」，要原文再用 memory_open。\n' +
      '什么时候用：用户提到以前在网页里问过 / 记过的事，或需要确认某段旧结论时先搜一下。',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '要搜的关键词（中文直接用）' },
        site: { type: 'string', description: '只搜这个站（可选，例如 example.com；不填就跨站搜）' },
        limit: { type: 'number', description: '最多返回几条，默认 5，上限 20' },
      },
      required: ['query'],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: String(value) }],
    },
    async execute(args) {
      try {
        if (!deps.memory) return `记忆库没打开：${deps.memoryError || '未知原因'}`;
        const query = typeof args.query === 'string' ? args.query.trim() : '';
        if (!query) return '需要 query（要搜什么关键词）';
        const site = typeof args.site === 'string' ? args.site.trim() : '';
        const limit = clampNumber(args.limit, 1, SEARCH_MAX_LIMIT, SEARCH_DEFAULT_LIMIT);
        const cards = site
          ? deps.memory.pickFor({ site, question: query, limit })
          : deps.memory.pickFor({ question: query, limit, crossSite: true });
        if (!cards.length) return '没搜到相关的记忆（可以换个说法再搜，或先问用户记的是哪一段）';
        try {
          deps.memory.markUsed(cards.map((card) => card.id));
        } catch {
          /* 记使用次数失败不影响搜索 */
        }
        return cards.map((card) => {
          const tags = Array.isArray(card.tags) && card.tags.length ? `（标签：${card.tags.join('、')}）` : '';
          const siteText = card.site ? `｜${card.site}` : '';
          return `${card.id}｜《${card.title}》｜${card.summary}${tags}${siteText}`;
        }).join('\n');
      } catch (error) {
        return `搜记忆失败：${messageOf(error)}`;
      }
    },
  };
}

/**
 * memory_open 工具：按 id 取一张卡的原文（截断到合理长度）。
 * @param deps - { memory, memoryError }。
 * @returns 工具定义。
 */
function createMemoryOpenTool(deps) {
  return {
    name: 'memory_open',
    description:
      '按 id 打开一张记忆卡片，返回卡片内容 + 当时对话原文（原文会截断）。\n' +
      'id 从 memory_search 的结果里拿（形如 m_xxxxxx）。',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '卡片 id（memory_search 返回的第一段）' },
      },
      required: ['id'],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: String(value) }],
    },
    async execute(args) {
      try {
        if (!deps.memory) return `记忆库没打开：${deps.memoryError || '未知原因'}`;
        const id = typeof args.id === 'string' ? args.id.trim() : '';
        if (!id) return '需要 id（就是 memory_search 结果里开头 m_ 的那一段）';
        const card = deps.memory.getCard(id);
        if (!card) return '没找到这张记忆（id 不对，或者已经删了）';
        if (card.status !== 'active') return '这张记忆已经删了';
        const lines = [`《${card.title}》`];
        const day = String(card.createdAt || '').slice(0, 10);
        const meta = [day, card.category, card.site].filter(Boolean).join('｜');
        if (meta) lines.push(meta);
        if (card.summary) lines.push(card.summary);
        if (Array.isArray(card.points) && card.points.length) {
          lines.push('要点：');
          for (const point of card.points) lines.push(`· ${point}`);
        }
        const thread = Array.isArray(card.thread) ? card.thread : [];
        if (thread.length) {
          lines.push('原文：');
          let budget = OPEN_THREAD_BUDGET;
          for (const message of thread) {
            const who = message && message.role === 'me' ? '我' : '小助手';
            const body = String((message && message.text) || '');
            const suffix = message && message.hasImage ? '（带了张截图）' : '';
            const line = `${who}：${body}${suffix}`;
            if (line.length > budget) {
              lines.push(`${line.slice(0, Math.max(0, budget))}…`);
              break;
            }
            budget -= line.length;
            lines.push(line);
          }
        }
        return lines.join('\n');
      } catch (error) {
        return `打开记忆失败：${messageOf(error)}`;
      }
    },
  };
}

export const name = 'page-chat';

/**
 * 插件入口：等 webServer 与 agents 都就绪后注册路由，再把记忆接进注入面。
 * @param ctx - 插件上下文。
 * @param config - { cwd, maxTurns, memoryDir }。
 */
export function apply(ctx, config = {}) {
  const settings = {
    cwd: typeof config.cwd === 'string' && config.cwd ? config.cwd : process.cwd(),
    maxTurns: config.maxTurns,
  };

  // 记忆库 / 同步器在 apply 时就建好：路由、系统提示、工具三处共用同一个实例。
  const memoryDir = resolveDir(config.memoryDir, path.join(dshHomeDir(), 'page-chat-memory'));
  const syncDir = resolveDir(config.syncDir, path.join(path.dirname(memoryDir), 'page-chat-sync'));
  // 扩展报到记录：和记忆目录同级（<DSH_HOME>/page-chat-installed.json）。
  const installed = createInstalledStore(path.dirname(memoryDir));
  let memory = null;
  let sync = null;
  let memoryError = '';
  try {
    memory = createMemory({ dir: memoryDir });
  } catch (error) {
    memoryError = messageOf(error);
  }
  try {
    sync = createSync({ dir: syncDir });
  } catch (error) {
    if (!memoryError) memoryError = messageOf(error);
  }
  let summarizer = null;
  let compressor = null;
  try {
    summarizer = createSummarizer(ctx, { cwd: settings.cwd });
    compressor = createCompressor({ ask: summarizer.ask });
  } catch (error) {
    if (!memoryError) memoryError = messageOf(error);
  }
  const deps = {
    memory,
    sync,
    compressor,
    installed,
    memoryError,
    // 看板基址：默认空 = 按请求 Host 同源推理（一起跑在 DSH web 上）；反代 / 测试时可覆盖。
    boardBase: typeof config.boardBase === 'string' ? config.boardBase : '',
  };

  /** 网页侧会话池：由 webServer 注入建出来，系统提示段靠它排除网页会话。 */
  let sessions = null;

  ctx.inject(['webServer', 'agents'], (scope) => {
    const pool = new PageChatSessions(scope, settings);
    sessions = pool;
    scope.effect(() => {
      const off = scope.webServer.register({
        kind: 'prefix',
        path: PREFIX,
        handler: createHandler(pool, deps),
      });
      return () => {
        try {
          off();
        } catch {
          /* 已经注册表清过了 */
        }
        pool.dispose();
      };
    }, 'page-chat: /page-chat/*');
  });

  // 记忆进系统提示：每轮重算（读当时的卡片），网页侧会话返回空。
  ctx.inject(['systemPrompt'], (scope) => {
    const systemPrompt = optionalSystemPrompt(scope);
    if (!systemPrompt) return;
    scope.effect(
      () =>
        systemPrompt.section({
          name: MEMORY_SECTION_NAME,
          order: MEMORY_SECTION_ORDER,
          text: (context) => {
            try {
              if (sessions && typeof sessions.isWebScope === 'function' && sessions.isWebScope(context && context.scope)) {
                return '';
              }
              return memorySectionText(memory);
            } catch {
              return '';
            }
          },
        }),
      'page-chat: 记忆注入（系统提示）',
    );
  });

  // 两个只读记忆工具：只挂在宿主全局。网页会话靠 tools.restrict({ allow: [] })
  // 把全局工具全部挡掉，所以它永远看不到、也调不到这两个。
  ctx.inject(['tools'], (scope) => {
    const tools = optionalTools(scope);
    if (!tools) return;
    scope.effect(() => {
      const offSearch = tools.register(createMemorySearchTool(deps));
      const offOpen = tools.register(createMemoryOpenTool(deps));
      return () => {
        try {
          offOpen();
        } catch {
          /* 已经注册表清过了 */
        }
        try {
          offSearch();
        } catch {
          /* 已经注册表清过了 */
        }
      };
    }, 'page-chat: memory_search + memory_open');
  });
}
