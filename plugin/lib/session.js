/**
 * 网页问答会话池：把「网页里那个小框」接到 DSH 自己的 agent 上。
 *
 * 为什么不走 `dsh headless` 子进程：子进程和宿主是两个世界，记忆要靠拼字符串
 * 冒充，每次问答还要冷启动。这里直接在 DSH 进程里 create 一个 agent，
 * 同一个 key（一个内容脚本实例）复用同一个会话，所以第二问天然带上下文。
 *
 * 三条纪律写在实现里：
 *   1) 网页内容不可信 ⇒ 这个会话的工具被限制成空集（tools.restrict({allow: []})），
 *      永远只能说话，不能读文件 / 跑命令 / 查记忆。
 *   2) 只订阅事件、不碰别人的会话：所有 session/event 都要按 id 过滤。
 *   3) 每个调用都自己结算，绝不让异常冒到宿主（同进程连坐）。
 *
 * 注意：本文件不许 import 任何 `@deepseek-ai/*` 包 —— 插件挂在 profile 外部目录，
 * 运行期解析不到。sessionId / 内容块只是 JSON 形状，按 DSH 的公开形状手写即可。
 */

import { randomUUID } from 'node:crypto';

/** 一段问答最多等多久（毫秒）；超时按失败结算，避免小框永远转圈。 */
const TURN_TIMEOUT_MS = 180000;

/** 一条消息最多带几张图（20MB 请求体上限之外再加一道，防一次塞几百张）。 */
const MAX_IMAGES = 8;

/** 每个 key 最多留多少条对话原文给「记住这段」用（只读，不参与问答）。 */
const MAX_THREAD_MESSAGES = 40;

/** 每个 key 的对话原文总字数上限：防止长会话把内存撑爆。 */
const MAX_THREAD_CHARS = 20000;

/** 浏览器传来的图只认这几种（附件服务也只收这几种）。 */
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);

/** 网页侧会话的人设：短、先结论、明确自己看不到文件 / 没有工具。 */
const PERSONA = [
  '你是浏览器小框里的对话助手，用户正在看网页，把选中的文字或截图发给你。',
  '你看不到用户电脑上的文件，也不能执行任何命令，也没有任何可用的工具；',
  '需要动手（读文件、跑命令、改代码）时，请直接说明你做不了，让用户回到 DSH 主会话去做。',
  '中文回答，先给结论再给理由，控制在一屏内；不确定就说不确定，不要编。',
].join('\n');

/** 统一的错误文案：永远拿得到一条字符串。 */
function messageOf(error) {
  if (!error) return '未知错误';
  return error && error.message ? String(error.message) : String(error);
}

/** 插件日志只有拿得到才打，打日志本身绝不许抛。 */
function warn(ctx, text) {
  try {
    const logger = ctx && ctx.logger;
    if (logger && typeof logger.warn === 'function') logger.warn('page-chat: %s', text);
  } catch {
    /* 日志失败不算失败 */
  }
}

/**
 * 把浏览器传来的一张图（data URL 或 {mimeType,data}）拆成附件服务要的入参。
 * @param image - 浏览器传来的单个图片项。
 * @returns {{data: Buffer, mediaType: string}} 或 null（这货根本不像图）。
 */
function decodeImage(image) {
  if (typeof image === 'string') {
    const match = /^data:([^;,]+)?(?:;[^,]*)?;base64,([\s\S]*)$/.exec(image);
    if (!match) return null;
    return { data: Buffer.from(match[2] || '', 'base64'), mediaType: normalizeType(match[1]) };
  }
  if (!image || typeof image !== 'object') return null;
  const raw = typeof image.data === 'string' ? image.data : '';
  if (!raw) return null;
  const match = /^data:([^;,]+)?(?:;[^,]*)?;base64,([\s\S]*)$/.exec(raw);
  if (match) {
    return { data: Buffer.from(match[2] || '', 'base64'), mediaType: normalizeType(match[1] || image.mimeType) };
  }
  return { data: Buffer.from(raw, 'base64'), mediaType: normalizeType(image.mimeType) };
}

/** 声明类型归一：不认识的按 png 交给附件服务去校验（它会自己解码校验）。 */
function normalizeType(mediaType) {
  const value = typeof mediaType === 'string' ? mediaType.trim().toLowerCase() : '';
  return IMAGE_TYPES.has(value) ? value : 'image/png';
}

/**
 * 把浏览器传来的图片块落成会话可用的附件引用。
 * @param ctx - 宿主上下文，用来取 attachments 服务。
 * @param images - 浏览器传来的图片数组。
 * @returns 可以直接放进消息 content 的 image 块。
 */
async function admitImages(ctx, images) {
  const list = Array.isArray(images) ? images.filter(Boolean).slice(0, MAX_IMAGES) : [];
  if (list.length === 0) return [];
  const store = ctx.get('attachments');
  if (!store || typeof store.saveImages !== 'function') {
    throw new Error('这个 profile 没有附件存储，暂时收不了截图');
  }
  const inputs = [];
  for (const image of list) {
    const decoded = decodeImage(image);
    if (!decoded) continue;
    if (decoded.data.length === 0) continue;
    inputs.push({ data: decoded.data, mediaType: decoded.mediaType });
  }
  if (inputs.length === 0) throw new Error('图片数据看不懂（需要 data URL 或 base64）');
  const refs = await store.saveImages(inputs);
  return refs.map((ref) => ({ type: 'image', attachment: ref }));
}

/** 一条用户消息：形状对齐 dsh-llm 的 UserMessage，id 只是身份，不参与业务。 */
function userMessage(content) {
  return { id: randomUUID(), role: 'user', content, source: { kind: 'user' } };
}

/**
 * 会话池。一个插件实例一个池，key 由扩展侧生成（每个标签页一个）。
 */
export class PageChatSessions {
  /**
   * @param ctx - 宿主上下文（已解析 agents 服务的 scope）。
   * @param options - { cwd, maxTurns }。
   */
  constructor(ctx, options = {}) {
    this.ctx = ctx;
    this.cwd = options.cwd || process.cwd();
    this.maxTurns = Number(options.maxTurns) > 0 ? Number(options.maxTurns) : 20;
    /** key -> { sessionId, handle, turns } */
    this.slots = new Map();
    /** key -> 建会话中的 Promise（同一 key 并发首问只建一个会话） */
    this.creating = new Map();
    /** sessionId -> 在途 turn */
    this.pending = new Map();
    /** key -> 最近几轮问答的原文（给 /memorize 压卡片用；只读，不参与问答） */
    this.threads = new Map();
    /** 网页侧 agent 的 scope 集合：记忆注入段靠它把网页会话排除掉 */
    this.webScopes = new WeakSet();
    this.disposed = false;
    this.off = typeof ctx.on === 'function'
      ? ctx.on('session/event', (session, event) => this.onSessionEvent(session, event))
      : null;
    // 实时正文增量：session/event 只在一条消息定型后才发一次，想边生成边显示
    // 就得听 agent 的流帧。拿不到这个事件也不影响正确性 —— 只是变成「一次性」。
    this.streamOff = typeof ctx.on === 'function'
      ? ctx.on('agent/assistant-stream', (payload) => this.onAssistantStream(payload))
      : null;
  }

  /**
   * 逐块转发模型正在生成的正文（只取 text-delta，思考过程不往外发）。
   * @param payload - { agent, frame }。
   */
  onAssistantStream(payload) {
    if (this.disposed || !payload || !payload.frame) return;
    try {
      const agent = payload.agent;
      const sessionId = agent && agent.session ? String(agent.session.id) : '';
      if (!sessionId) return;
      const turn = this.pending.get(sessionId);
      if (!turn) return;
      const frame = payload.frame;
      if (frame.type === 'start') {
        // 新一次模型尝试：清掉上一条消息的流式占位，避免和定型消息重复计字。
        turn.chunkText = '';
        return;
      }
      if (frame.type !== 'chunk') return;
      const chunk = frame.chunk;
      if (!chunk || chunk.type !== 'text-delta' || typeof chunk.text !== 'string' || !chunk.text) return;
      turn.chunkText += chunk.text;
      this.emit(turn, { type: 'delta', text: chunk.text });
    } catch {
      /* 流帧只是锦上添花，坏了不影响结算 */
    }
  }

  /**
   * agents 服务到底在不在、还能不能建会话。
   * @returns 布尔。
   */
  canRun() {
    if (this.disposed) return false;
    const agents = this.ctx.get('agents');
    return !!agents && typeof agents.create === 'function';
  }

  get size() {
    return this.slots.size;
  }

  /**
   * 把会话事件分发给正在等的那个 turn。
   * @param session - 事件所属会话。
   * @param event - { type, data, seq }。
   */
  onSessionEvent(session, event) {
    if (this.disposed || !session || !event) return;
    const sessionId = String(session.id);
    const turn = this.pending.get(sessionId);
    if (!turn) return;
    try {
      if (event.type === 'assistant/message') {
        const content = event.data && event.data.message && event.data.message.content;
        const full = Array.isArray(content)
          ? content.filter((block) => block && block.type === 'text' && typeof block.text === 'string')
            .map((block) => block.text).join('')
          : '';
        // 流帧已经把正文吐过了：只补「定型消息比流多出来的那截」，绝不重复计字。
        const streamed = turn.chunkText || '';
        if (streamed && full.startsWith(streamed)) {
          const rest = full.slice(streamed.length);
          if (rest) this.emit(turn, { type: 'delta', text: rest });
          turn.text += full;
        } else if (streamed) {
          // 流和定型对不上（少见：中途改稿 / 重试）：以定型消息为准，不再追加增量。
          turn.text += full;
        } else if (full) {
          turn.text += full;
          this.emit(turn, { type: 'delta', text: full });
        }
        turn.chunkText = '';
        return;
      }
      if (event.type === 'turn/end') {
        // 先把这一轮的回答落进对话本，再结算：/memorize 读的就是它。
        this.recordTurn(turn.key, { role: 'dsh', text: turn.text });
        const reason = (event.data && event.data.reason) || {};
        if (reason.kind === 'completed') {
          this.settle(sessionId, { ok: true, text: turn.text });
        } else {
          const detail = reason.error && reason.error.message
            ? String(reason.error.message)
            : String(reason.kind || '未完成');
          this.settle(sessionId, { ok: false, error: detail, text: turn.text });
        }
      }
    } catch (error) {
      this.settle(sessionId, { ok: false, error: messageOf(error), text: turn.text });
    }
  }

  /** 给前端的增量回调：它自己抛了也不许影响会话。 */
  emit(turn, event) {
    try {
      turn.onEvent(event);
    } catch {
      /* 前端断了就断了，会话继续结算 */
    }
  }

  /** 结算一个 turn，并清掉超时计时器。 */
  settle(sessionId, result) {
    const turn = this.pending.get(sessionId);
    if (!turn) return;
    this.pending.delete(sessionId);
    clearTimeout(turn.timer);
    if (result.ok) turn.resolve({ ok: true, text: result.text || '' });
    else turn.reject(new Error(result.error || '回答失败'));
  }

  /**
   * 取（或建）这个 key 对应的 DSH 会话。
   * @param key - 扩展侧给的会话键。
   * @returns {{ sessionId, handle, turns }}。
   */
  async slotFor(key) {
    const existing = this.slots.get(key);
    if (existing) return existing;
    if (this.disposed) throw new Error('插件已卸载');
    let inflight = this.creating.get(key);
    if (!inflight) {
      inflight = this.createSlot(key);
      this.creating.set(key, inflight);
      // 失败也要把占位删掉，否则这个 key 永远建不出会话
      inflight.catch(() => {}).then(() => {
        if (this.creating.get(key) === inflight) this.creating.delete(key);
      });
    }
    return inflight;
  }

  /** 真正建一个会话（只在 slotFor 里调用）。 */
  async createSlot(key) {
    const agents = this.ctx.get('agents');
    if (!agents || typeof agents.create !== 'function') throw new Error('DSH 没就绪（agents 服务不可用）');
    const sessionId = randomUUID();
    const handle = await agents.create({
      sessionId,
      meta: { cwd: this.cwd },
      agentOptions: this.agentOptions(),
      setup: (agentCtx) => {
        // 只读红线：这个会话一个工具都不给。allow 空集即全部拒绝，且不依赖工具名。
        agentCtx.inject(['tools'], (scope) => {
          try {
            scope.tools.restrict({ allow: [] });
          } catch (error) {
            warn(this.ctx, `限制工具失败：${messageOf(error)}`);
          }
        });
        // 人设：短、先结论、明确没有工具。顺手记下这个 scope，
        // 好让记忆注入段把网页会话排除掉（网页会话永远看不到记忆工具）。
        agentCtx.inject(['systemPrompt'], (scope) => {
          try {
            scope.systemPrompt.section({
              name: 'page-chat',
              order: 60,
              text: (context) => {
                this.noteWebScope(context && context.scope);
                return PERSONA;
              },
            });
          } catch (error) {
            warn(this.ctx, `注入人设失败：${messageOf(error)}`);
          }
        });
      },
    });
    const slot = { sessionId, handle, turns: 0 };
    this.slots.set(key, slot);
    return slot;
  }

  /**
   * 模型选择跟随 DSH 的默认路由（跟 Web 端新建会话同一套取法）。
   * 拿不到 agentDefaultModel 就不传，让 agent 用自身默认。
   */
  agentOptions() {
    const defaults = this.ctx.get('agentDefaultModel');
    if (!defaults || typeof defaults.currentSelection !== 'function') return undefined;
    return {
      get provider() { return defaults.currentSelection().provider; },
      get model() { return defaults.currentSelection().model; },
      get reasoningEffort() { return defaults.currentSelection().reasoningEffort; },
    };
  }

  /**
   * 问一句，等这一轮结束。
   * @param key - 会话键。
   * @param input - { text, images }。
   * @param onEvent - 增量回调（{type:'delta',text}）。
   * @returns { ok, text }。
   */
  async ask(key, input, onEvent = () => {}) {
    let slot = await this.slotFor(key);
    // 轮数上限：到顶就换一个全新会话（上下文清空，防无限长）。
    if (slot.turns >= this.maxTurns) {
      await this.drop(key);
      slot = await this.slotFor(key);
    }
    if (this.pending.has(slot.sessionId)) throw new Error('上一句还在回答，等它说完再问');

    // 先同步占位，避免两次并发请求都通过上面的检查（中间有 await）。
    const turn = { key, text: '', chunkText: '', onEvent, resolve: null, reject: null, timer: null };
    const promise = new Promise((resolve, reject) => {
      turn.resolve = resolve;
      turn.reject = reject;
    });
    turn.timer = setTimeout(() => {
      this.settle(slot.sessionId, { ok: false, error: '等太久了（180 秒没有回答完）', text: turn.text });
    }, TURN_TIMEOUT_MS);
    this.pending.set(slot.sessionId, turn);

    try {
      const content = [];
      const images = await admitImages(this.ctx, input && input.images);
      content.push(...images);
      const text = input && typeof input.text === 'string' ? input.text : '';
      if (text.trim()) content.push({ type: 'text', text });
      if (content.length === 0) throw new Error('空消息');
      slot.handle.agent.followup(userMessage(content));
      slot.turns += 1;
      // 记进这个 key 的对话本（只读用途）：/memorize 靠它把这段压成卡片。
      this.recordTurn(key, { role: 'me', text, hasImage: images.length > 0 });
    } catch (error) {
      this.settle(slot.sessionId, { ok: false, error: messageOf(error), text: '' });
    }
    return promise;
  }

  /**
   * 记一条对话原文。只给「记住这段」用，不参与问答，也不会改变 ask 的返回值。
   * @param key - 会话键。
   * @param entry - { role: 'me'|'dsh', text, hasImage }。
   */
  recordTurn(key, entry) {
    if (this.disposed || !key || !entry) return;
    try {
      const text = typeof entry.text === 'string' ? entry.text.slice(0, 4000) : '';
      const hasImage = !!entry.hasImage;
      // 空文本只有在带了图时才有意义（用户可能只甩一张截图）。
      if (!text.trim() && !hasImage) return;
      const list = this.threads.get(key) || [];
      list.push({ role: entry.role === 'me' ? 'me' : 'dsh', text, hasImage });
      let total = 0;
      for (const message of list) total += message.text.length;
      while (list.length > MAX_THREAD_MESSAGES || total > MAX_THREAD_CHARS) {
        const dropped = list.shift();
        total -= dropped ? dropped.text.length : 0;
      }
      this.threads.set(key, list);
    } catch {
      /* 记原文失败不影响问答 */
    }
  }

  /**
   * 只读地取这个 key 的对话原文（副本，改了不会影响内部记录）。
   * @param key - 会话键。
   * @returns {Array<{role:'me'|'dsh', text:string, hasImage:boolean}>}。
   */
  threadOf(key) {
    const list = this.threads.get(key);
    if (!Array.isArray(list)) return [];
    return list.map((message) => ({ ...message }));
  }

  /**
   * 把某个网页 agent 的 scope 记下来（人设 section 每次组装时调用）。
   * @param scope - systemPrompt.section 的 AssembleContext.scope。
   */
  noteWebScope(scope) {
    if (!scope || (typeof scope !== 'object' && typeof scope !== 'function')) return;
    try {
      this.webScopes.add(scope);
    } catch {
      /* scope 不是弱引用可加的对象就算了 */
    }
  }

  /**
   * 这个 scope 是不是网页侧会话？是的话记忆注入段直接返回空。
   * @param scope - AssembleContext.scope。
   * @returns 布尔。
   */
  isWebScope(scope) {
    if (!scope || (typeof scope !== 'object' && typeof scope !== 'function')) return false;
    try {
      return this.webScopes.has(scope);
    } catch {
      return false;
    }
  }

  /**
   * 丢掉某个 key 的会话和它的对话本（扩展点「新对话」时用）。
   * @param key - 会话键。
   * @returns 是否真的丢了一个会话。
   */
  async forget(key) {
    const dropped = await this.drop(key);
    this.threads.delete(key);
    return dropped;
  }

  /**
   * 丢掉某个 key 的会话（扩展点「新对话」时用）。
   * @param key - 会话键。
   * @returns 是否真的丢了一个。
   */
  async drop(key) {
    // 正在建：等它建完再丢，避免留下没人持有的 agent
    const inflight = this.creating.get(key);
    if (inflight) {
      try {
        await inflight;
      } catch {
        /* 建失败就没什么可丢的 */
      }
    }
    const slot = this.slots.get(key);
    if (!slot) return false;
    this.slots.delete(key);
    this.settle(slot.sessionId, { ok: false, error: '会话已重置', text: '' });
    try {
      if (slot.handle && typeof slot.handle.dispose === 'function') await slot.handle.dispose();
    } catch (error) {
      warn(this.ctx, `释放会话失败：${messageOf(error)}`);
    }
    return true;
  }

  /** 插件卸载：解订阅、结算所有在途 turn、放掉所有会话。 */
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    try {
      if (typeof this.off === 'function') this.off();
    } catch {
      /* 已经断了 */
    }
    this.off = null;
    try {
      if (typeof this.streamOff === 'function') this.streamOff();
    } catch {
      /* 已经断了 */
    }
    this.streamOff = null;
    for (const sessionId of [...this.pending.keys()]) {
      this.settle(sessionId, { ok: false, error: '插件正在卸载', text: '' });
    }
    for (const slot of this.slots.values()) {
      try {
        if (slot.handle && typeof slot.handle.dispose === 'function') {
          Promise.resolve(slot.handle.dispose()).catch(() => {});
        }
      } catch {
        /* 忽略 */
      }
    }
    this.slots.clear();
    this.creating.clear();
    this.threads.clear();
  }
}
