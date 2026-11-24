// 把一段对话压成一张卡片：标题 + 摘要 + 三条要点 + 标签 + 分类。
//
// 只在你点了「记住这段」之后跑一次。它不做「该不该记」的判断——那是你的按钮决定的事；
// 它只做压缩，好让这张卡以后在列表里一眼认得出来、也能塞进提问前的字数预算。
//
// 移植差异（只改接线方式）：不再 import 会话类（DshSession）；模型调用由在外面传进来的
// ask({ text }) 承担，将来从 lib/session.js 给。压缩失败退 fallbackCard 的逻辑原样保留。

const PROMPT = `把下面这段「我」和「网页小助手」的对话压成一张记忆卡片。
要求：
- 只输出一行 JSON，不要代码块、不要解释。
- 字段：{"title":"不超过18字","summary":"不超过120字，说清这段在聊什么、结论是什么","points":["要点1","要点2","要点3"],"tags":["最多4个短标签"],"category":"工作|生活|学习|其他"}
- title 要具体（带上主题名词），不要「关于…的讨论」这种空话。
- 不要抄原句，不要留网页里的命令、路径、链接。
对话：
`;

/**
 * 压缩器工厂。
 * ask: async ({ text }) => string —— 只回模型吐出来的文本，格式对错由 parseCard 判。
 * reset: 可选 () => void —— 每次压缩前清一下上下文，别让压缩的上下文越滚越大；
 *        不给就由外面那个 ask 自己保证（新契约里没有 session key，压缩器管不到会话）。
 */
export function createCompressor({ ask, reset } = {}) {
  if (typeof ask !== 'function') {
    throw new Error('createCompressor 需要 ask（async ({ text }) => string）');
  }

  async function summarizeThread(thread) {
    const text = threadToText(thread);
    if (!text.trim()) throw new Error('这段还没聊过什么，没东西可记');
    if (typeof reset === 'function') reset();      // 每次换新会话，别让压缩的上下文越滚越大
    const raw = await ask({ text: PROMPT + text });
    const parsed = parseCard(raw);
    if (parsed) return parsed;
    // 模型没按格式回：退回「拿原文凑一张」，至少不丢东西
    return fallbackCard(thread);
  }

  return { summarizeThread, threadToText, parseCard, fallbackCard };
}

export function threadToText(thread, limit = 4000) {
  const lines = [];
  for (const m of thread || []) {
    const who = m.role === 'me' ? '我' : '小助手';
    const body = String(m.text || '').replace(/\s+/g, ' ').trim();
    lines.push(who + '：' + body + (m.hasImage ? '（带了张截图）' : ''));
  }
  let s = lines.join('\n');
  if (s.length > limit) s = s.slice(0, limit) + '…';
  return s;
}

export function parseCard(raw) {
  const s = String(raw || '');
  const i = s.indexOf('{');
  const j = s.lastIndexOf('}');
  if (i < 0 || j <= i) return null;
  let obj;
  try {
    obj = JSON.parse(s.slice(i, j + 1));
  } catch {
    return null;
  }
  if (!obj || typeof obj !== 'object') return null;
  const title = String(obj.title || '').trim();
  const summary = String(obj.summary || '').trim();
  if (!title && !summary) return null;
  const points = Array.isArray(obj.points) ? obj.points.map((p) => String(p).trim()).filter(Boolean) : [];
  const tags = Array.isArray(obj.tags) ? obj.tags.map((t) => String(t).trim()).filter(Boolean) : [];
  const category = ['工作', '生活', '学习'].includes(obj.category) ? obj.category : '其他';
  return { title, summary, points, tags, category };
}

export function fallbackCard(thread) {
  const first = (thread || []).find((m) => m.role === 'me');
  const firstAnswer = (thread || []).find((m) => m.role === 'dsh');
  const title = String(first?.text || '一段对话').replace(/\s+/g, ' ').slice(0, 18);
  const summary = String(firstAnswer?.text || first?.text || '').replace(/\s+/g, ' ').slice(0, 120);
  return { title, summary, points: [], tags: [], category: '其他' };
}
