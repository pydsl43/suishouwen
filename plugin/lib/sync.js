// 记忆云同步：把 <dir>/cards 里那几张卡搬到云端，换台机器也能翻。
//
// 支持两种底层，用户在面板里选一种：
//   1) 私有 GitHub 仓库（走 REST，不需要装 git、不需要 clone）
//   2) WebDAV（坚果云 / 自架 Nextcloud 都行）
//
// 为什么这么做合并不会打架：
//   - 一张卡一个文件、写完不再改（文件名带卡号，两台机器不可能撞名）；
//   - 删除不删文件，写一个 deleted/<id>.json 的小标记；
//   - 远端根目录放一个 index（path → sha256），谁跟谁不一样就传谁，
//     内容一样就一句话不说 —— 不需要 rebase，不需要挑时间，随时同步。
//
// 这里只搬「卡片 + 原文 +（可选）截图」，不碰 DSH 画像，也不碰项目里别的东西。
//
// 移植差异（只改接线方式）：不再是模块级单例——目录由 createSync({ dir }) 从插件 config 传进来，
// 不再读 ANNOTATOR_MEMORY_DIR，也不再按文件位置猜；配置仍落 <dir>/.sync.json。
// 令牌明文存储这个缺陷先照旧（后面单独修，别在这段顺手改设计）。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const INDEX_NAME = 'dsh-memory-index.json';
const INDEX_VERSION = 1;

const VOLATILE = ['uses', 'lastUsedAt', 'syncedAt']; // 只属于这台机器的字段，不同步

// ---------- 配置 ----------

const DEFAULT_CFG = {
  kind: '',            // '' | 'github' | 'webdav'
  enabled: false,
  syncShots: false,    // 截图默认不跟（体积大）
  device: '',          // 这台机器的名字，写进卡里好认
  branch: 'main',
  github: { owner: '', repo: '', token: '', apiBase: 'https://api.github.com' },
  webdav: { url: '', user: '', pass: '' },
  lastSyncAt: null,
  lastResult: null,
};

function osName() {
  return 'dev-' + String(process.env.COMPUTERNAME || 'local').toLowerCase().slice(0, 12);
}

// ---------- 小工具 ----------

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

function readJsonSafe(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function writeAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}

// ---------- 适配器：GitHub ----------

function ghHeaders(cfg) {
  return {
    authorization: 'Bearer ' + cfg.github.token,
    accept: 'application/vnd.github+json',
    'x-github-api-version': '2022-11-28',
    'content-type': 'application/json',
    'user-agent': 'dsh-browser-annotator',
  };
}

const ghBase = (cfg) => (cfg.github.apiBase || DEFAULT_CFG.github.apiBase).replace(/\/+$/, '');
const ghRepoUrl = (cfg) => ghBase(cfg) + '/repos/' + cfg.github.owner + '/' + cfg.github.repo;

async function ghJson(cfg, method, url, body) {
  const res = await fetch(url, { method, headers: ghHeaders(cfg), body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
  return { status: res.status, ok: res.ok, data };
}

// ---------- 索引结构 ----------

const emptyIndex = () => ({ version: INDEX_VERSION, updatedAt: null, files: {} });

function normalizeIndex(index) {
  const out = emptyIndex();
  out.updatedAt = index && index.updatedAt ? index.updatedAt : null;
  if (index && index.files && typeof index.files === 'object') {
    for (const [k, v] of Object.entries(index.files)) {
      if (!v) continue;
      out.files[k] = { sha256: String(v.sha256 || ''), size: Number(v.size || 0), at: v.at || null };
    }
  }
  return out;
}

const githubAdapter = {
  name: 'github',

  async test(cfg) {
    const r = await ghJson(cfg, 'GET', ghRepoUrl(cfg));
    if (r.ok) return { ok: true, detail: '仓库可访问：' + cfg.github.owner + '/' + cfg.github.repo };
    if (r.status === 404) return { ok: false, detail: '看不到这个仓库（地址不对，或 token 没给这个仓库权限）' };
    if (r.status === 401) return { ok: false, detail: 'token 无效或过期了' };
    return { ok: false, detail: 'HTTP ' + r.status + '：' + (r.data && r.data.message ? r.data.message : '') };
  },

  async createRepo(cfg, name, isPrivate = true) {
    const r = await ghJson(cfg, 'POST', ghBase(cfg) + '/user/repos', {
      name,
      private: isPrivate,
      auto_init: false,
      description: 'DSH 浏览器插件的记忆库（自动创建）',
    });
    if (r.ok) return { ok: true, owner: cfg.github.owner, repo: r.data.name };
    if (r.status === 422) return { ok: false, detail: '已经有同名仓库了，直接填这个名字就行' };
    if (r.status === 403 || r.status === 404) return { ok: false, detail: '这个 token 没有建仓库的权限（要么换成 classic token 勾 repo，要么你在网页上手动建一个）' };
    return { ok: false, detail: 'HTTP ' + r.status + '：' + (r.data && r.data.message ? r.data.message : '') };
  },

  async readIndex(cfg) {
    const url = ghRepoUrl(cfg) + '/contents/' + INDEX_NAME + '?ref=' + encodeURIComponent(cfg.branch || 'main');
    const r = await ghJson(cfg, 'GET', url);
    if (r.status === 404) return { index: emptyIndex(), sha: null };
    if (!r.ok) throw new Error('读远端索引失败：HTTP ' + r.status);
    const buf = Buffer.from(String(r.data.content || '').replace(/\n/g, ''), 'base64');
    const index = JSON.parse(buf.toString('utf8'));
    return { index: normalizeIndex(index), sha: r.data.sha };
  },

  async putFile(cfg, filePath, buf) {
    // 先问有没有（有的话更新要带 sha）
    const metaUrl = ghRepoUrl(cfg) + '/contents/' + filePath + '?ref=' + encodeURIComponent(cfg.branch || 'main');
    const meta = await ghJson(cfg, 'GET', metaUrl);
    const body = {
      message: 'memory: ' + filePath + ' (' + (cfg.device || 'device') + ')',
      content: buf.toString('base64'),
      branch: cfg.branch || 'main',
    };
    if (meta.ok && meta.data && meta.data.sha) body.sha = meta.data.sha;
    const r = await ghJson(cfg, 'PUT', ghRepoUrl(cfg) + '/contents/' + filePath, body);
    if (!r.ok) throw new Error('写 ' + filePath + ' 失败：HTTP ' + r.status + ' ' + (r.data && r.data.message ? r.data.message : ''));
    return r.data && r.data.content ? r.data.content.sha : '';
  },

  async getFile(cfg, filePath) {
    const url = ghRepoUrl(cfg) + '/contents/' + filePath + '?ref=' + encodeURIComponent(cfg.branch || 'main');
    const r = await ghJson(cfg, 'GET', url);
    if (!r.ok) return null;
    return Buffer.from(String(r.data.content || '').replace(/\n/g, ''), 'base64');
  },
};

// ---------- 适配器：WebDAV ----------

function davUrl(cfg, rel) {
  const base = String(cfg.webdav.url || '').replace(/\/+$/, '');
  return rel ? base + '/' + rel.split('/').map(encodeURIComponent).join('/') : base + '/';
}

function davHeaders(cfg, extra = {}) {
  const token = Buffer.from(cfg.webdav.user + ':' + cfg.webdav.pass, 'utf8').toString('base64');
  return { authorization: 'Basic ' + token, 'user-agent': 'dsh-browser-annotator', ...extra };
}

const webdavAdapter = {
  name: 'webdav',

  async test(cfg) {
    const res = await fetch(davUrl(cfg), { method: 'PROPFIND', headers: davHeaders(cfg, { depth: '0' }) });
    if (res.status === 207 || res.ok) return { ok: true, detail: '连上了：' + cfg.webdav.url };
    if (res.status === 401) return { ok: false, detail: '用户名或应用密码不对' };
    if (res.status === 404) return { ok: false, detail: '这个地址不对（WebDAV 地址一般以斜杠结尾的那种）' };
    return { ok: false, detail: 'HTTP ' + res.status };
  },

  async readIndex(cfg) {
    const res = await fetch(davUrl(cfg, INDEX_NAME), { headers: davHeaders(cfg) });
    if (res.status === 404) return { index: emptyIndex(), sha: null };
    if (!res.ok) throw new Error('读远端索引失败：HTTP ' + res.status);
    const index = JSON.parse(await res.text());
    return { index: normalizeIndex(index), sha: null };
  },

  async putFile(cfg, filePath, buf) {
    const res = await fetch(davUrl(cfg, filePath), { method: 'PUT', headers: davHeaders(cfg, { 'content-type': 'application/octet-stream' }), body: buf });
    if (!res.ok) throw new Error('写 ' + filePath + ' 失败：HTTP ' + res.status);
    return '';
  },

  async getFile(cfg, filePath) {
    const res = await fetch(davUrl(cfg, filePath), { headers: davHeaders(cfg) });
    if (!res.ok) return null;
    return Buffer.from(await res.arrayBuffer());
  },
};

/** 记忆目录必须是调用方给的绝对路径：不给或给相对路径就直接报错，免得悄悄写到某个猜出来的地方 */
function requireAbsDir(dir) {
  const d = String(dir || '');
  if (!d || !path.isAbsolute(d)) {
    throw new Error('createSync 需要绝对路径 dir（拿到的是「' + d + '」）');
  }
  return path.resolve(d);
}

/**
 * 云同步工厂。dir 是绝对路径（将来由调用方从插件 config 传进来）：
 *   <dir>/cards  卡片与原文
 *   <dir>/shots  截图（可选同步）
 *   <dir>/deleted 删除标记
 *   <dir>/.sync.json 同步配置
 */
export function createSync({ dir } = {}) {
  const MEM_DIR = requireAbsDir(dir);
  const CARDS_DIR = path.join(MEM_DIR, 'cards');
  const SHOTS_DIR = path.join(MEM_DIR, 'shots');
  const CONFIG_FILE = path.join(MEM_DIR, '.sync.json');

  function loadConfig() {
    try {
      const raw = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
      return { ...DEFAULT_CFG, ...raw, github: { ...DEFAULT_CFG.github, ...(raw.github || {}) }, webdav: { ...DEFAULT_CFG.webdav, ...(raw.webdav || {}) } };
    } catch {
      return { ...DEFAULT_CFG, github: { ...DEFAULT_CFG.github }, webdav: { ...DEFAULT_CFG.webdav } };
    }
  }

  function saveConfig(patch = {}) {
    fs.mkdirSync(MEM_DIR, { recursive: true });
    const cfg = loadConfig();
    const next = { ...cfg, ...patch };
    next.github = { ...cfg.github, ...(patch.github || {}) };
    next.webdav = { ...cfg.webdav, ...(patch.webdav || {}) };
    if (typeof next.kind === 'string' && next.kind) next.enabled = patch.enabled !== false;
    if (patch.enabled === false) next.enabled = false;
    if (!next.device) next.device = osName();
    const tmp = CONFIG_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf8');
    fs.renameSync(tmp, CONFIG_FILE);
    return publicConfig(next);
  }

  /** 对外展示：token/密码不回显，只说有没有 */
  function publicConfig(cfg = loadConfig()) {
    return {
      kind: cfg.kind || '',
      enabled: !!cfg.enabled,
      syncShots: !!cfg.syncShots,
      device: cfg.device || '',
      branch: cfg.branch || 'main',
      github: {
        owner: cfg.github.owner || '',
        repo: cfg.github.repo || '',
        hasToken: !!cfg.github.token,
        apiBase: cfg.github.apiBase || DEFAULT_CFG.github.apiBase,
      },
      webdav: { url: cfg.webdav.url || '', user: cfg.webdav.user || '', hasPass: !!cfg.webdav.pass },
      ready: isReady(cfg),
      lastSyncAt: cfg.lastSyncAt || null,
      lastResult: cfg.lastResult || null,
    };
  }

  function isReady(cfg = loadConfig()) {
    if (cfg.kind === 'github') return !!(cfg.github.owner && cfg.github.repo && cfg.github.token);
    if (cfg.kind === 'webdav') return !!(cfg.webdav.url && cfg.webdav.user && cfg.webdav.pass);
    return false;
  }

  // 推上去的卡：去掉只属于本机的字段，保证「同一张卡任何时候传上去都一样」
  function cardForRemote(file) {
    const card = readJsonSafe(file);
    if (!card) return null;
    for (const k of VOLATILE) delete card[k];
    return Buffer.from(JSON.stringify(card, null, 2), 'utf8');
  }

  /** 本地要同步的文件：path → { buf, kind } */
  function collectLocal(cfg) {
    const out = new Map();
    fs.mkdirSync(CARDS_DIR, { recursive: true });
    for (const f of fs.readdirSync(CARDS_DIR)) {
      const full = path.join(CARDS_DIR, f);
      if (f.endsWith('.json')) {
        const card = readJsonSafe(full);
        if (!card) continue;
        const buf = cardForRemote(full);
        if (!buf) continue;
        out.set('cards/' + f, buf);
        if (card.status === 'deleted') {
          // 删除也要让别的机器知道：写一个小标记，纯新增，永远不冲突
          out.set('deleted/' + card.id + '.json', Buffer.from(JSON.stringify({ id: card.id, at: card.deletedAt || new Date().toISOString() }), 'utf8'));
        }
      } else if (f.endsWith('.thread.jsonl')) {
        out.set('parts/' + f, fs.readFileSync(full));
      }
    }
    if (cfg.syncShots) {
      fs.mkdirSync(SHOTS_DIR, { recursive: true });
      for (const f of fs.readdirSync(SHOTS_DIR)) {
        if (f.endsWith('.png') || f.endsWith('.jpg')) out.set('shots/' + f, fs.readFileSync(path.join(SHOTS_DIR, f)));
      }
      for (const f of fs.readdirSync(CARDS_DIR)) {
        if (f.endsWith('.png') || f.endsWith('.jpg')) out.set('shots/' + f, fs.readFileSync(path.join(CARDS_DIR, f)));
      }
    }
    // 远端已删的本机卡，本地也要标记（由 pull 处理），这里不生成
    return out;
  }

  function adapterFor(cfg) {
    if (cfg.kind === 'github') return githubAdapter;
    if (cfg.kind === 'webdav') return webdavAdapter;
    return null;
  }

  async function testConnection(cfg = loadConfig()) {
    const ad = adapterFor(cfg);
    if (!ad) return { ok: false, detail: '还没选同步方式' };
    if (!isReady(cfg)) return { ok: false, detail: '配置还没填全' };
    try {
      return await ad.test(cfg);
    } catch (e) {
      return { ok: false, detail: String(e && e.message ? e.message : e) };
    }
  }

  async function createRepo(name, cfg = loadConfig()) {
    if (cfg.kind !== 'github') return { ok: false, detail: '只有 GitHub 能替你建仓库；WebDAV 用你现成的目录就行' };
    const clean = String(name || '').trim().replace(/[^A-Za-z0-9._-]/g, '-');
    if (!clean) return { ok: false, detail: '仓库名不能空' };
    if (!cfg.github.token) return { ok: false, detail: '先填 token' };
    try {
      return await githubAdapter.createRepo(cfg, clean, true);
    } catch (e) {
      return { ok: false, detail: String(e && e.message ? e.message : e) };
    }
  }

  /**
   * 同步一次：先把本机新的推上去，再把远端新的拉下来。
   * 返回 { ok, pushed:[], pulled:[], removed:[], conflicts:[], detail }
   */
  async function syncNow(cfg = loadConfig()) {
    const started = Date.now();
    const ad = adapterFor(cfg);
    if (!ad) return { ok: false, detail: '还没选同步方式' };
    if (!isReady(cfg)) return { ok: false, detail: '配置还没填全' };

    const result = { ok: true, pushed: [], pulled: [], removed: [], conflicts: [], detail: '' };
    try {
      const { index } = await ad.readIndex(cfg);
      const local = collectLocal(cfg);

      // 1) 推：本地有、远端没有或内容不一样
      for (const [p, buf] of local) {
        const h = sha256(buf);
        const remote = index.files[p];
        if (remote && remote.sha256 === h) continue;
        await ad.putFile(cfg, p, buf);
        index.files[p] = { sha256: h, size: buf.length, at: new Date().toISOString() };
        result.pushed.push(p);
      }

      // 2) 拉：远端有、本地没有或内容不一样
      for (const [p, meta] of Object.entries(index.files)) {
        if (!p || p === INDEX_NAME) continue;
        const localPath = localPathFor(p);
        if (!localPath) continue;
        const existsRaw = fs.existsSync(localPath) ? fs.readFileSync(localPath) : null;
        // 卡片的本地文件比远端多几个「只属于这台机器」的字段，比对时先抹平，免得每次同步都以为撞车
        const existing = p.startsWith('cards/') && existsRaw ? cardForRemote(localPath) : existsRaw;
        const existingHash = existing ? sha256(existing) : '';
        if (p.startsWith('deleted/')) {
          // 删除标记：本地照做
          const id = path.basename(p, '.json');
          if (applyTombstone(id)) result.removed.push(id);
          continue;
        }
        if (existingHash === meta.sha256) continue;
        if (existing && !p.startsWith('parts/')) {
          // 同一条路两边都改过：不猜，留一份带设备名的副本，等你看
          const alt = localPath.replace(/(\.[a-z]+)$/, '.' + (cfg.device || 'other') + '$1');
          try { fs.writeFileSync(alt, existing); } catch {}
          result.conflicts.push(p);
          continue;
        }
        const buf = await ad.getFile(cfg, p);
        if (!buf) continue;
        writeAtomic(localPath, buf);
        result.pulled.push(p);
      }

      // 3) 索引也要更新（别人下次才知道我推了什么）
      const indexBuf = Buffer.from(JSON.stringify({ ...index, version: INDEX_VERSION, updatedAt: new Date().toISOString() }, null, 2), 'utf8');
      await ad.putFile(cfg, INDEX_NAME, indexBuf);

      result.detail = '推 ' + result.pushed.length + ' 拉 ' + result.pulled.length + ' 删 ' + result.removed.length + (result.conflicts.length ? ' 冲突 ' + result.conflicts.length : '');
      const next = saveConfig({ lastSyncAt: new Date().toISOString(), lastResult: { ...result, ms: Date.now() - started } });
      return { ...result, ms: Date.now() - started, config: next };
    } catch (e) {
      const detail = String(e && e.message ? e.message : e);
      saveConfig({ lastResult: { ok: false, detail, ms: Date.now() - started } });
      return { ok: false, detail, ms: Date.now() - started };
    }
  }

  function localPathFor(p) {
    if (p.startsWith('cards/')) return path.join(CARDS_DIR, path.basename(p));
    if (p.startsWith('parts/')) return path.join(CARDS_DIR, path.basename(p));
    if (p.startsWith('shots/')) return path.join(SHOTS_DIR, path.basename(p));
    if (p.startsWith('deleted/')) return path.join(MEM_DIR, 'deleted', path.basename(p));
    return null;
  }

  /** 远端说某张卡删了：本地照做（原文和图一起清，卡文件标 deleted） */
  function applyTombstone(id) {
    const file = path.join(CARDS_DIR, id + '.json');
    const card = readJsonSafe(file);
    if (card && card.status === 'deleted') return false;
    if (card) {
      card.status = 'deleted';
      card.deletedAt = card.deletedAt || new Date().toISOString();
      writeAtomic(file, JSON.stringify(card, null, 2));
    }
    for (const f of [id + '.thread.jsonl', id + '.png', id + '.jpg']) {
      try { fs.unlinkSync(path.join(CARDS_DIR, f)); } catch {}
    }
    try { fs.unlinkSync(path.join(SHOTS_DIR, id + '.png')); } catch {}
    return true;
  }

  /** 后台悄悄同步（存完卡顺手推一把），失败不影响提问 */
  function syncInBackground() {
    const cfg = loadConfig();
    if (!cfg.enabled || !isReady(cfg)) return;
    syncNow(cfg).catch(() => {});
  }

  function status() {
    const cfg = loadConfig();
    return publicConfig(cfg);
  }

  return {
    dir: MEM_DIR,
    configPath: CONFIG_FILE,
    loadConfig,
    saveConfig,
    publicConfig,
    isReady,
    syncNow,
    collectLocal,
    testConnection,
    createRepo,
    syncInBackground,
    status,
    adapterFor,
    githubAdapter,
    webdavAdapter,
  };
}
