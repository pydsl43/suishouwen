/**
 * 一次性「记忆整理器」：给 compress.js 的 `ask({ text })` 提供一个真模型调用。
 *
 * 为什么不复用 lib/session.js 的网页会话：那边的人设是「浏览器小框助手」，
 * 说话带寒暄，压卡片的 prompt 会被它当聊天回。这里临时建一个干净 agent：
 *   - 工具限制成空集（它读的是网页原文，绝不能反过来调工具）；
 *   - 人设只有「按格式输出 JSON」；
 *   - 问完就 dispose，不留在会话池里。
 *
 * 和 session.js 一样：不 import 任何 `@deepseek-ai/*`，一切能力从 ctx 上拿。
 */

import { randomUUID } from 'node:crypto';

/** 压一张卡最多等多久（毫秒）。 */
const SUMMARIZE_TIMEOUT_MS = 120000;

/** 整理器的人设：只做格式转换，不聊天。 */
const PERSONA = [
  '你是记忆整理器，只做一件事：把用户给的一段对话压成一行 JSON 记忆卡片。',
  '不要寒暄、不要解释、不要代码块围栏，只输出 JSON。',
  '字段：{"title":"不超过18字","summary":"不超过120字","points":["要点1","要点2","要点3"],"tags":["最多4个短标签"],"category":"工作|生活|学习|其他"}',
  'title 要具体，带上主题名词；不要抄原句里的路径、链接和命令。',
].join('\n');

/** 统一错误文案：永远拿得到一条字符串。 */
function messageOf(error) {
  if (!error) return '未知错误';
  return error && error.message ? String(error.message) : String(error);
}

/**
 * 从 assistant/message 事件里抽正文（只取 text 块）。
 * @param data - event.data。
 * @returns 字符串（没有就是空串）。
 */
function assistantTextOf(data) {
  const content = data && data.message && data.message.content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('');
}

/**
 * 造一个整理器。
 * @param ctx - 宿主上下文（插件根 ctx 即可）。
 * @param options - { cwd }。
 * @returns {{ ask: (input: { text: string }) => Promise<string> }}
 */
export function createSummarizer(ctx, options = {}) {
  if (!ctx || typeof ctx.get !== 'function') throw new Error('createSummarizer 需要宿主 ctx');
  const cwd = typeof options.cwd === 'string' && options.cwd ? options.cwd : process.cwd();

  /** 模型选择跟随 DSH 的默认路由（和 lib/session.js 同一套取法）。 */
  function agentOptions() {
    const defaults = ctx.get('agentDefaultModel');
    if (!defaults || typeof defaults.currentSelection !== 'function') return undefined;
    try {
      return {
        get provider() { return defaults.currentSelection().provider; },
        get model() { return defaults.currentSelection().model; },
        get reasoningEffort() { return defaults.currentSelection().reasoningEffort; },
      };
    } catch {
      return undefined;
    }
  }

  /**
   * 问一次，等这一轮结束，只回正文。
   * @param input - { text }。
   * @returns 模型输出（可能不是 JSON，格式由 compress.js 的 parseCard 判）。
   */
  async function ask(input) {
    const text = input && typeof input.text === 'string' ? input.text : '';
    if (!text.trim()) throw new Error('整理器收到空文本');
    const agents = ctx.get('agents');
    if (!agents || typeof agents.create !== 'function') throw new Error('DSH 没就绪（agents 服务不可用）');

    const sessionId = randomUUID();
    let buffer = '';
    let settlement = null;
    const done = new Promise((resolve, reject) => {
      settlement = { resolve, reject };
    });
    const finish = (fn, value) => {
      const target = settlement;
      if (!target) return;
      settlement = null;
      if (timer) clearTimeout(timer);
      fn(target, value);
    };
    const resolveWith = (value) => finish((target, v) => target.resolve(v), value);
    const rejectWith = (error) => finish((target, v) => target.reject(v), error);

    let timer = null;
    const off = typeof ctx.on === 'function'
      ? ctx.on('session/event', (session, event) => {
        try {
          if (!session || String(session.id) !== sessionId || !event) return;
          if (event.type === 'assistant/message') {
            buffer += assistantTextOf(event.data);
            return;
          }
          if (event.type !== 'turn/end') return;
          const reason = (event.data && event.data.reason) || {};
          if (reason.kind === 'completed') {
            resolveWith(buffer);
          } else {
            const detail = reason.error && reason.error.message ? String(reason.error.message) : String(reason.kind || '未完成');
            rejectWith(new Error(detail));
          }
        } catch (error) {
          rejectWith(error);
        }
      })
      : null;

    let handle = null;
    try {
      handle = await agents.create({
        sessionId,
        meta: { cwd },
        agentOptions: agentOptions(),
        setup: (agentCtx) => {
          // 红线：整理器也不给任何工具（它读的是网页原文，不能被原文指挥）。
          agentCtx.inject(['tools'], (scope) => {
            try {
              scope.tools.restrict({ allow: [] });
            } catch {
              /* tools 服务缺席就不限制 */
            }
          });
          agentCtx.inject(['systemPrompt'], (scope) => {
            try {
              scope.systemPrompt.section({ name: 'page-chat-summarizer', order: 60, text: () => PERSONA });
            } catch {
              /* 人设注不进去就靠 prompt 自己兜 */
            }
          });
        },
      });
      timer = setTimeout(() => {
        rejectWith(new Error('压卡片等太久了（120 秒没有回答完）'));
      }, SUMMARIZE_TIMEOUT_MS);
      handle.agent.followup({
        id: randomUUID(),
        role: 'user',
        content: [{ type: 'text', text }],
        source: { kind: 'user' },
      });
      return await done;
    } finally {
      if (off) {
        try {
          off();
        } catch {
          /* 已经断了 */
        }
      }
      if (timer) clearTimeout(timer);
      if (handle && typeof handle.dispose === 'function') {
        try {
          Promise.resolve(handle.dispose()).catch(() => {});
        } catch (error) {
          void messageOf(error);
        }
      }
    }
  }

  return { ask };
}
