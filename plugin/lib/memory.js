// 记忆库：只有用户点「记住这段」才会写进来。
//
// 一条记忆 = 一段对话。存两样东西：卡片（模型压缩过的标题/摘要/要点/标签）和原文（整段对话），
// 外加截图。卡片用来在提问时「一眼认出来 + 预算内塞得进去」，原文用来点开看细节。
//
// 全部落在 <dir> 下，纯文本、可 grep、可打包带走；不碰 DSH 画像，也不碰项目里别的东西。
//
// 移植差异（只改接线方式）：不再是模块级单例——目录由 createMemory({ dir }) 从插件 config 传进来，
// 不再读 ANNOTATOR_MEMORY_DIR，也不再按文件位置猜。
import fs from 'node:fs';
import path from 'node:path';

export const INJECT_BUDGET = 700;   // 注入的硬上限（字）
export const MAX_CARDS_INJECTED = 2;

export function siteOf(url) {
  try {
    return new URL(String(url || '')).host.replace(/^www\./, '');
  } catch {
    return '';
  }
}

// ---------- 挑卡：相关度 0.6 + 新鲜度 0.3 + 用过几次 0.1 ----------
const STOP = new Set(['什么', '怎么', '这个', '那个', '我们', '你们', '他们', '可以', '一个', '这个', '的话', '问题', '一下', '帮我', '请问', '现在', '就是', '还是', '以及', '然后', '因为', '所以', '如果', '但是']);

export function keywords(text) {
  const s = String(text || '');
  const keys = new Set();
  for (const w of s.toLowerCase().match(/[a-z][a-z0-9_+.-]{2,}/g) || []) keys.add(w);
  for (const run of s.match(/[\u4e00-\u9fa5]+/g) || []) {
    if (run.length === 1) continue;
    for (let i = 0; i + 2 <= run.length && i < 40; i++) {
      const g = run.slice(i, i + 2);
      if (!STOP.has(g)) keys.add(g);
    }
  }
  return [...keys].slice(0, 60);
}

function hits(hay, keys) {
  let n = 0;
  for (const k of keys) if (hay.includes(k)) n++;
  return n;
}

function clip(s, n) {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n) + '…' : t;
}

/** 记忆目录必须是调用方给的绝对路径：不给或给相对路径就直接报错，免得悄悄写到某个猜出来的地方 */
function requireAbsDir(dir) {
  const d = String(dir || '');
  if (!d || !path.isAbsolute(d)) {
    throw new Error('createMemory 需要绝对路径 dir（拿到的是「' + d + '」）');
  }
  return path.resolve(d);
}

/**
 * 记忆库工厂。dir 是绝对路径（将来由调用方从插件 config 传进来），内部所有路径都基于它。
 * 返回的对象在同一个 dir 上共享同一套文件，互不干扰。
 */
export function createMemory({ dir } = {}) {
  const MEM_DIR = requireAbsDir(dir);
  const CARDS_DIR = path.join(MEM_DIR, 'cards');

  function ensure() {
    fs.mkdirSync(CARDS_DIR, { recursive: true });
  }

  function cardPath(id) {
    return path.join(CARDS_DIR, id + '.json');
  }

  function threadPath(id) {
    return path.join(CARDS_DIR, id + '.thread.jsonl');
  }

  function imagePath(id) {
    return path.join(CARDS_DIR, id + '.png');
  }

  // 原子写：先写 .tmp 再改名，半路断电也不会留半个文件
  function writeAtomic(file, data) {
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, data, 'utf8');
    fs.renameSync(tmp, file);
  }

  function newId() {
    const t = Date.now().toString(36);
    const r = Math.random().toString(36).slice(2, 8);
    return 'm_' + t + r;
  }

  function readCard(id) {
    try {
      return JSON.parse(fs.readFileSync(cardPath(id), 'utf8'));
    } catch {
      return null;
    }
  }

  /** 存一段对话。meta: {site, sourceUrl, sourceTitle, text:{title,summary,points,tags,category}, images:[{mimeType,data}]} */
  function saveCard(thread, text, meta = {}) {
    ensure();
    const id = newId();
    const now = new Date().toISOString();
    const firstImage = (meta.images || [])[0] || null;
    const card = {
      id,
      title: clip(text.title || '', 40) || '没起标题的一段对话',
      summary: clip(text.summary || '', 200),
      points: (text.points || []).slice(0, 3).map((p) => clip(p, 90)),
      tags: (text.tags || []).slice(0, 4).map((t) => clip(t, 12)),
      category: text.category || '其他',
      site: meta.site || '',
      sourceUrl: meta.sourceUrl || '',
      sourceTitle: clip(meta.sourceTitle || '', 80),
      createdAt: now,
      turns: (thread || []).filter((m) => m.role === 'me').length,
      hasImage: !!firstImage,
      uses: 0,
      lastUsedAt: null,
      status: 'active',
    };
    writeAtomic(cardPath(id), JSON.stringify(card, null, 2));
    writeAtomic(threadPath(id), (thread || []).map((m) => JSON.stringify(m)).join('\n') + '\n');
    if (firstImage) {
      try {
        fs.writeFileSync(imagePath(id), Buffer.from(String(firstImage.data).split(',')[1] || firstImage.data, 'base64'));
      } catch {}
    }
    return card;
  }

  function getCard(id) {
    const card = readCard(id);
    if (!card) return null;
    let thread = [];
    try {
      thread = fs
        .readFileSync(threadPath(id), 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => {
          try { return JSON.parse(l); } catch { return null; }
        })
        .filter(Boolean);
    } catch {}
    const hasImg = fs.existsSync(imagePath(id));
    return { ...card, thread, hasImage: hasImg };
  }

  function listCards({ site = '', limit = 100 } = {}) {
    ensure();
    const out = [];
    for (const f of fs.readdirSync(CARDS_DIR)) {
      if (!f.endsWith('.json')) continue;
      const card = readCard(f.slice(0, -5));
      if (!card || card.status !== 'active') continue;
      if (site && card.site !== site) continue;
      out.push({
        id: card.id,
        title: card.title,
        summary: card.summary,
        tags: card.tags,
        category: card.category,
        site: card.site,
        sourceTitle: card.sourceTitle,
        createdAt: card.createdAt,
        turns: card.turns,
        hasImage: card.hasImage,
      });
    }
    out.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
    return out.slice(0, limit);
  }

  /** 删除：留一行痕（status=deleted），原文和图一起清掉 */
  function deleteCard(id) {
    const card = readCard(id);
    if (!card) return false;
    card.status = 'deleted';
    card.deletedAt = new Date().toISOString();
    writeAtomic(cardPath(id), JSON.stringify(card, null, 2));
    for (const f of [threadPath(id), imagePath(id)]) {
      try { fs.unlinkSync(f); } catch {}
    }
    return true;
  }

  function clearSite(site) {
    let n = 0;
    for (const c of listCards({ site })) {
      if (deleteCard(c.id)) n++;
    }
    return n;
  }

  function stats() {
    const all = listCards({ limit: 100000 });
    const sites = new Set(all.map((c) => c.site).filter(Boolean));
    return { total: all.length, sites: sites.size, dir: MEM_DIR };
  }

  function pickFor({ site = '', question = '', limit = MAX_CARDS_INJECTED, exclude = [], crossSite = false } = {}) {
    const keys = keywords(question);
    const now = Date.now();
    const scored = [];
    for (const c of listCards({ limit: 500 })) {
      if (exclude.includes(c.id)) continue;
      // 默认只带「同一个站」记的卡：跨站带旧事最容易答错，要跨站得你显式开
      if (!crossSite && c.site !== site) continue;
      const title = (c.title || '').toLowerCase();
      const summary = (c.summary || '').toLowerCase();
      const tags = (c.tags || []).join(' ').toLowerCase();
      const kw = keys.length ? Math.min(1, (hits(title, keys) * 3 + hits(tags, keys) * 2 + hits(summary, keys)) / Math.max(3, keys.length)) : 0;
      const sameSite = site && c.site === site ? 1 : 0;
      const rel = kw * 0.8 + sameSite * 0.2;
      if (kw < 0.2) continue;                          // 没一个字对得上就不塞，哪怕同站
      const days = Math.max(0, (now - Date.parse(c.createdAt || 0)) / 86400000);
      const fresh = Math.pow(0.5, days / 30);          // 30 天半衰
      const used = 0;                                  // 使用次数还没接；先留权重位
      scored.push({ card: c, rel, score: rel * 0.6 + fresh * 0.3 + used * 0.1 });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, limit).map((s) => s.card);
  }

  function markUsed(ids) {
    const now = new Date().toISOString();
    for (const id of ids) {
      const card = readCard(id);
      if (!card) continue;
      card.uses = (card.uses || 0) + 1;
      card.lastUsedAt = now;
      try { writeAtomic(cardPath(id), JSON.stringify(card, null, 2)); } catch {}
    }
  }

  /** 把挑出的卡拼成一段前情提要，硬预算 INJECT_BUDGET 字 */
  function buildInjection(cards) {
    if (!cards.length) return '';
    const head = '【以前记的（可能过时；跟当前页面冲突时以当前页面为准）】';
    let out = head + '\n';
    for (const c of cards) {
      const day = String(c.createdAt || '').slice(0, 10);
      const line = '· ' + day + '《' + c.title + '》——' + c.summary + (c.tags?.length ? '（标签：' + c.tags.join('、') + '）' : '') + '\n';
      if (out.length + line.length > INJECT_BUDGET) break;
      out += line;
    }
    return out === head + '\n' ? '' : out;
  }

  return {
    dir: MEM_DIR,
    saveCard,
    getCard,
    listCards,
    deleteCard,
    clearSite,
    stats,
    keywords,
    pickFor,
    markUsed,
    buildInjection,
  };
}
