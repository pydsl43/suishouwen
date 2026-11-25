#!/usr/bin/env node
/**
 * install.mjs — 随手问的后端插件安装器（跨平台核心逻辑）。
 *
 * 三个入口都调它：
 *   Windows 双击      一键安装.bat      -> node scripts\install.mjs
 *   macOS 双击        install.command   -> node scripts/install.mjs
 *   macOS/Linux 终端  install.sh        -> node scripts/install.mjs
 *
 * 做四件事（都可重复跑，不会重复插入）：
 *   1. 在 <DshHome>/profiles/<Profile>/package.json 的 dependencies 里写
 *      "@pydsl/dsh-page-chat": "file:<仓库>/plugin"
 *   2. 建 <Profile>/node_modules/@pydsl/dsh-page-chat 链接 -> <仓库>/plugin
 *   3. 往 <Profile>/cordis.patch.yml 追加 page-chat 的 insert 段
 *   4. 检查 http://127.0.0.1:<port>/page-chat/health，告诉你还要不要重启
 *
 * 参数见 --help。写文件前会备份；链接指向别处时只报错，绝不覆盖。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

export const PLUGIN_NAME = '@pydsl/dsh-page-chat';
export const DEFAULT_PORT = 3080;
export const EXT_VERSION = '0.4.5';

const SELF_PATH = fileURLToPath(import.meta.url);
const DEFAULT_REPO = path.dirname(path.dirname(SELF_PATH));

// ── 小工具 ────────────────────────────────────────────────────────────────

export function trimTrailingSep(p) {
  const s = String(p).replace(/[\\/]+$/, '');
  return s === '' ? path.parse(String(p)).root : s;
}

function toPosix(p) {
  return String(p).replace(/\\/g, '/');
}

function sameFsPath(a, b) {
  const na = trimTrailingSep(path.resolve(a));
  const nb = trimTrailingSep(path.resolve(b));
  return process.platform === 'win32' ? na.toLowerCase() === nb.toLowerCase() : na === nb;
}

export function detectNewline(text) {
  return text.includes('\r\n') ? '\r\n' : '\n';
}

/**
 * 探测一个缩进层级是多少：取「行首空白 + 引号」的行里最短的空白。
 * 2 空格 -> "  "，4 空格 -> "    "，tab -> "\t"；探测不到就 2 空格。
 */
export function detectIndentUnit(text) {
  let unit = '';
  for (const line of text.split(/\r?\n/)) {
    const m = /^([ \t]+)"/.exec(line);
    if (!m) continue;
    const ws = m[1];
    if (unit === '' || ws.length < unit.length) unit = ws;
  }
  if (unit === '') return /^[\t]+"/m.test(text) ? '\t' : '  ';
  return unit;
}

function readTextFile(file) {
  const buf = fs.readFileSync(file);
  let bom = false;
  let start = 0;
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    bom = true;
    start = 3;
  }
  return { text: buf.subarray(start).toString('utf8'), bom };
}

function writeTextFile(file, text, bom) {
  fs.writeFileSync(file, (bom ? '\uFEFF' : '') + text, 'utf8');
}

function findMatchingBrace(text, openIdx) {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = openIdx; i < text.length; i += 1) {
    const c = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') {
      inString = true;
      continue;
    }
    if (c === '{') depth += 1;
    else if (c === '}') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function assertJson(text) {
  try {
    JSON.parse(text);
  } catch (e) {
    throw new Error(`改完的 package.json 不是合法 JSON（${e.message}），已停下，没有写盘。请把文件发我看看。`);
  }
}

function formatStamp(date = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}-${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`;
}

// ── package.json：加依赖（文本编辑，保留原缩进） ──────────────────────────

export function upsertDependencyText(text, value) {
  const nl = detectNewline(text);
  const unit = detectIndentUnit(text);

  const m = /"dependencies"\s*:\s*\{/.exec(text);
  if (!m) {
    throw new Error('profile 的 package.json 里没有 "dependencies" 这一段，没法加依赖。请先让 DSH 生成/修好这个文件。');
  }
  const openIdx = m.index + m[0].length - 1;
  const closeIdx = findMatchingBrace(text, openIdx);
  if (closeIdx < 0) {
    throw new Error('profile 的 package.json 括号不配对，先别改它，检查一下文件。');
  }

  const before = text.slice(0, openIdx + 1);
  const inside = text.slice(openIdx + 1, closeIdx);
  const after = text.slice(closeIdx);

  const keyRe = /"@pydsl\/dsh-page-chat"\s*:\s*"([^"]*)"/;
  const found = keyRe.exec(inside);
  if (found) {
    if (found[1] === value) return { text, action: 'skip' };
    const newText = before + inside.replace(keyRe, `"${PLUGIN_NAME}": "${value}"`) + after;
    assertJson(newText);
    return { text: newText, action: 'update', oldValue: found[1] };
  }

  const lineStart = text.lastIndexOf('\n', Math.max(0, m.index - 1));
  const depsLine = text.slice(lineStart + 1, m.index);
  const depsIndent = /^[ \t]*/.exec(depsLine)[0];
  const entry = `${depsIndent}${unit}"${PLUGIN_NAME}": "${value}"`;

  const newText = inside.trim() === ''
    ? before + nl + entry + nl + depsIndent + after
    : before + nl + entry + ',' + inside + after;

  assertJson(newText);
  return { text: newText, action: 'add' };
}

// ── cordis.patch.yml ─────────────────────────────────────────────────────

export function hasPageChatPatch(text) {
  return /^[ \t]*-[ \t]*id:[ \t]*page-chat[ \t]*$/m.test(text)
    || /^[ \t]*(?:-[ \t]*)?name:[ \t]*'@pydsl\/dsh-page-chat'[ \t]*$/m.test(text);
}

export function buildPatchBlock(nl, memoryValue) {
  const lines = [
    '- insert:',
    '    - id: page-chat',
    "      name: '@pydsl/dsh-page-chat'",
    '      config:',
    `        memoryDir: ${memoryValue}`,
    '        maxTurns: 20',
  ];
  return lines.join(nl);
}

export function appendPatchText(text, block, nl) {
  const trimmed = text.trim();
  if (trimmed === '' || trimmed === '[]') return block + nl;
  let out = text;
  if (!out.endsWith('\n')) out += nl;
  if (!out.endsWith(nl + nl)) out += nl;
  return out + block + nl;
}

// ── 链接状态 ─────────────────────────────────────────────────────────────

function normalizeLinkTarget(raw, linkPath) {
  let target = String(raw);
  if (process.platform === 'win32') target = target.replace(/^\\\\\?\\/, '');
  if (!path.isAbsolute(target)) target = path.resolve(path.dirname(linkPath), target);
  return trimTrailingSep(target);
}

/**
 * missing 不存在 / same 指向正确 / diff 指向别处 / other 存在但不是链接。
 */
export function getLinkState(linkPath, targetPath) {
  let st;
  try {
    st = fs.lstatSync(linkPath);
  } catch (e) {
    if (e.code === 'ENOENT') return { state: 'missing' };
    throw e;
  }
  if (!st.isSymbolicLink()) return { state: 'other' };
  let raw;
  try {
    raw = fs.readlinkSync(linkPath);
  } catch {
    return { state: 'other' };
  }
  const target = normalizeLinkTarget(raw, linkPath);
  if (sameFsPath(target, targetPath)) return { state: 'same' };
  return { state: 'diff', target };
}

function createLink(linkPath, targetPath) {
  fs.mkdirSync(path.dirname(linkPath), { recursive: true });
  fs.symlinkSync(targetPath, linkPath, process.platform === 'win32' ? 'junction' : 'dir');
}

function linkConflictError(linkPath, state) {
  if (state.state === 'diff') {
    return `目录链接已存在但指向别处：${state.target}\n`
      + `先删掉它再重跑：${linkPath}\n`
      + '（可能是别的版本的插件；脚本不会替你覆盖。）';
  }
  return `${linkPath} 已存在，但不是链接（可能是普通目录）。\n`
    + '请先删掉它再重跑，免得覆盖你已有的插件。';
}

// ── 备份 ─────────────────────────────────────────────────────────────────

function makeBackupDir(dshHome) {
  const base = path.join(dshHome, `.backup-page-chat-${formatStamp()}`);
  let dir = base;
  let n = 1;
  // 同一秒内重复跑时加 -2、-3，保证每次都是新目录。
  while (fs.existsSync(dir)) {
    n += 1;
    dir = `${base}-${n}`;
  }
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function backupFile(file, backupDir) {
  if (!fs.existsSync(file)) return false;
  fs.copyFileSync(file, path.join(backupDir, path.basename(file)));
  return true;
}

// ── 健康检查 ─────────────────────────────────────────────────────────────

export function checkHealth(port, timeoutMs = 3000) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const req = http.get({
      host: '127.0.0.1',
      port,
      path: '/page-chat/health',
      timeout: timeoutMs,
    }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        if (res.statusCode !== 200) {
          done({ ok: false, status: res.statusCode, error: `HTTP ${res.statusCode}` });
          return;
        }
        let json = null;
        try { json = JSON.parse(body); } catch { /* 非 JSON 也照样算通 */ }
        done({ ok: true, status: 200, body: json ? JSON.stringify(json) : body.trim() });
      });
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error('timeout')));
    req.on('error', (e) => done({ ok: false, error: e.code || e.message }));
  });
}

// ── 参数 ─────────────────────────────────────────────────────────────────

export function parseArgs(argv) {
  const options = {
    repo: '',
    dshHome: '',
    profile: 'web',
    memoryDir: '',
    port: null,
    noRestart: false,
    dryRun: false,
    yes: false,
    help: false,
  };

  const nextValue = (i, name) => {
    const value = argv[i + 1];
    if (value === undefined) throw new Error(`${name} 后面要跟一个值。`);
    return value;
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const eq = arg.startsWith('--') ? arg.indexOf('=') : -1;
    const name = eq > 2 ? arg.slice(0, eq) : arg;
    const inline = eq > 2 ? arg.slice(eq + 1) : undefined;
    const take = (flag) => {
      if (inline !== undefined) return inline;
      const value = nextValue(i, flag);
      i += 1;
      return value;
    };

    switch (name) {
      case '--repo':
        options.repo = take('--repo');
        break;
      case '--dsh-home':
        options.dshHome = take('--dsh-home');
        break;
      case '--profile':
        options.profile = take('--profile');
        break;
      case '--memory-dir':
        options.memoryDir = take('--memory-dir');
        break;
      case '--port':
        options.port = take('--port');
        break;
      case '--no-restart':
        options.noRestart = true;
        break;
      case '--dry-run':
        options.dryRun = true;
        break;
      case '--yes':
        options.yes = true;
        break;
      case '-h':
      case '--help':
        options.help = true;
        break;
      default:
        throw new Error(`不认识的参数：${arg}。用 --help 看用法。`);
    }
  }

  return options;
}

function parsePort(value, from) {
  const s = String(value).trim();
  if (!/^\d+$/.test(s)) throw new Error(`${from}=${value} 不是有效端口（要 1-65535 的整数）。`);
  const n = Number(s);
  if (n < 1 || n > 65535) throw new Error(`${from}=${value} 不是有效端口（要 1-65535 的整数）。`);
  return n;
}

function resolvePort(cliPort) {
  if (cliPort !== null && cliPort !== undefined && cliPort !== '') {
    return parsePort(cliPort, '--port');
  }
  const env = process.env.DSH_WEB_PORT;
  if (env !== undefined && env !== '') return parsePort(env, 'DSH_WEB_PORT');
  return DEFAULT_PORT;
}

function resolveRepo(spec) {
  if (spec === '') return DEFAULT_REPO;
  if (/^(https?:\/\/|git@|ssh:\/\/)/.test(spec)) {
    throw new Error('--repo 只支持本地目录：请先把仓库 git clone 下来，再指向本地仓库根目录。');
  }
  return trimTrailingSep(path.resolve(spec));
}

function assertRepo(repoRoot) {
  const manifestPath = path.join(repoRoot, 'plugin', 'package.json');
  if (!fs.existsSync(manifestPath) || !fs.statSync(manifestPath).isFile()) {
    throw new Error(
      '这个目录不像「随手问」仓库：找不到 plugin/package.json'
      + `（看的路径是 ${repoRoot}）。\n`
      + '请用 --repo 指向仓库根目录，里面应当有 plugin/ 和 extension/。',
    );
  }
  let manifest;
  try {
    manifest = JSON.parse(readTextFile(manifestPath).text);
  } catch (e) {
    throw new Error(`plugin/package.json 不是合法 JSON（${e.message}）：${manifestPath}`);
  }
  if (manifest.name !== PLUGIN_NAME) {
    throw new Error(
      `plugin/package.json 里的包名是「${manifest.name}」，不是 ${PLUGIN_NAME}。`
      + '这个仓库的 plugin 目录可能被换过，先别装。',
    );
  }
}

// ── 交互 ─────────────────────────────────────────────────────────────────

function askPortViaReadline(currentPort) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    let finished = false;
    const finish = (value) => {
      if (finished) return;
      finished = true;
      try { rl.close(); } catch { /* 已经关了 */ }
      resolve(value);
    };
    rl.question(`dsh web 跑在哪个端口？（默认 ${currentPort}，直接回车）`, (answer) => {
      const n = Number.parseInt(String(answer).trim(), 10);
      finish(Number.isInteger(n) && n > 0 && n < 65536 ? n : currentPort);
    });
    rl.on('close', () => finish(currentPort));
  });
}

// ── 打印 ─────────────────────────────────────────────────────────────────

function printHelp(say) {
  say('随手问 · 插件安装器（跨平台）');
  say('');
  say('用法：node scripts/install.mjs [选项]');
  say('');
  say('  --repo <目录>        仓库根目录（默认：本脚本所在的仓库）');
  say('  --dsh-home <目录>    DSH 家目录（默认：$DSH_HOME 或 ~/.dsh）');
  say('  --profile <名字>     DSH profile（默认：web）');
  say('  --memory-dir <目录>  网页记忆存哪里（绝对路径；默认 DSH 家目录下 page-chat-memory）');
  say('  --port <端口>        dsh web 端口（默认：$DSH_WEB_PORT 或 3080）');
  say('  --no-restart         装完不检查、也不提示重启');
  say('  --dry-run            只打印计划，不写任何文件');
  say('  --yes                不提问（端口探测）');
  say('  -h, --help           显示这段说明');
}

function printFinish(say, port, backupDir) {
  say(`自检地址（打开看绿灯）：http://127.0.0.1:${port}/page-chat/setup`);
  say('');
  say('装浏览器扩展：');
  say('  Firefox / Zen（签名包，双击即装）');
  say(`    https://github.com/pydsl43/suishouwen/releases/latest/download/suishouwen-${EXT_VERSION}-firefox-signed.xpi`);
  say('    装不上就走：about:addons → 右上齿轮 → 从文件安装附加组件');
  say('  Chrome / Edge（解压后加载）');
  say(`    https://github.com/pydsl43/suishouwen/releases/latest/download/suishouwen-${EXT_VERSION}-chrome.zip`);
  say('    解压 → chrome://extensions → 打开开发者模式 → 加载已解压的扩展程序');
  say('');
  say(`卸载：删掉 node_modules/${PLUGIN_NAME} 链接、package.json 里那行依赖、cordis.patch.yml 里的 page-chat 段，再重启 dsh web。`);
  if (backupDir) say(`备份：${backupDir}`);
}

// ── 主流程 ───────────────────────────────────────────────────────────────

export async function run(argv = process.argv.slice(2), io = {}) {
  const out = typeof io.out === 'function' ? io.out : (s) => process.stdout.write(s);
  const err = typeof io.err === 'function' ? io.err : (s) => process.stderr.write(s);
  const say = (line = '') => out(`${line}\n`);
  const isTTY = io.isTTY !== undefined ? Boolean(io.isTTY) : Boolean(process.stdout.isTTY);
  const askPort = typeof io.askPort === 'function' ? io.askPort : askPortViaReadline;

  let backupDir = null;

  try {
    const options = parseArgs(argv);
    if (options.help) {
      printHelp(say);
      return 0;
    }

    say('');
    say('随手问 · 后端插件安装');
    say('────────────────────');

    const repoRoot = resolveRepo(options.repo);
    assertRepo(repoRoot);
    const pluginDir = trimTrailingSep(path.join(repoRoot, 'plugin'));

    say('[1/5] 定位仓库');
    say(`  仓库：${repoRoot}`);
    say(`  插件：${pluginDir}`);

    const dshHome = trimTrailingSep(path.resolve(
      options.dshHome || process.env.DSH_HOME || path.join(os.homedir(), '.dsh'),
    ));
    if (!fs.existsSync(dshHome) || !fs.statSync(dshHome).isDirectory()) {
      throw new Error(
        `找不到 DSH 家目录：${dshHome}。DSH 还没装过？先装 DSH 并运行一次 dsh web，`
        + '或用 --dsh-home 指向正确的位置。',
      );
    }

    const profileName = String(options.profile || 'web').trim();
    if (profileName === '' || /[\\/]/.test(profileName) || profileName === '.' || profileName === '..') {
      throw new Error(`--profile 不是有效的 profile 名字：${options.profile}`);
    }

    say('[2/5] 检查 profile');
    const profileDir = path.join(dshHome, 'profiles', profileName);
    if (!fs.existsSync(profileDir) || !fs.statSync(profileDir).isDirectory()) {
      throw new Error(
        `profile「${profileName}」不存在：${profileDir}。`
        + '这个目录应当由 DSH 自己创建；先运行一次 dsh web，或用 --profile 指定已有的 profile。',
      );
    }
    const pkgPath = path.join(profileDir, 'package.json');
    const patchPath = path.join(profileDir, 'cordis.patch.yml');
    if (!fs.existsSync(pkgPath)) {
      throw new Error(`profile 里没有 package.json：${pkgPath}。先让 DSH 正常启动一次再来装。`);
    }
    say(`  profile：${profileDir}`);

    const port = resolvePort(options.port);
    const depValue = `file:${toPosix(pluginDir)}`;
    let memoryValue = "!!js dshHomePath('page-chat-memory')";
    if (options.memoryDir) {
      const memoryDir = trimTrailingSep(path.resolve(options.memoryDir));
      memoryValue = `'${toPosix(memoryDir).replace(/'/g, "''")}'`;
    }

    const linkPath = path.join(profileDir, 'node_modules', '@pydsl', 'dsh-page-chat');

    const pkgRead = readTextFile(pkgPath);
    const depPlan = upsertDependencyText(pkgRead.text, depValue);
    const linkState = getLinkState(linkPath, pluginDir);
    const patchRead = fs.existsSync(patchPath) ? readTextFile(patchPath) : null;
    const patchHas = patchRead ? hasPageChatPatch(patchRead.text) : false;

    if (!options.dryRun && linkState.state !== 'missing' && linkState.state !== 'same') {
      throw new Error(linkConflictError(linkPath, linkState));
    }

    if (options.dryRun) {
      say('');
      say('[DryRun] 不会写任何文件。将要做的事：');
      say(`  - Node：${process.version}（${process.execPath}）`);
      if (depPlan.action === 'skip') say('  - package.json：依赖已存在且指向同一个目录，会跳过');
      else if (depPlan.action === 'update') say(`  - package.json：把依赖从 ${depPlan.oldValue} 改成 ${depValue}`);
      else say(`  - package.json：新增依赖 ${depValue}`);

      if (linkState.state === 'missing') say(`  - 目录链接：新建 ${linkPath} -> ${pluginDir}`);
      else if (linkState.state === 'same') say('  - 目录链接：已存在且指向正确，会跳过');
      else if (linkState.state === 'diff') say(`  - 目录链接：已存在但指向 ${linkState.target}，正式跑会报错让你先删`);
      else say(`  - 目录链接：${linkPath} 已存在但不是链接，正式跑会报错`);

      say(patchHas ? '  - cordis.patch.yml：已有 page-chat，会跳过' : '  - cordis.patch.yml：追加 page-chat 段');
      say(`  - 备份：${path.join(dshHome, '.backup-page-chat-<时间戳>')}`);
      if (options.noRestart) say('  - 健康检查：--no-restart，跳过');
      else say(`  - 健康检查：http://127.0.0.1:${port}/page-chat/health`);
      say(`  - 自检地址：http://127.0.0.1:${port}/page-chat/setup`);
      say('');
      say('[DryRun] 结束，什么都没改。');
      return 0;
    }

    say('');
    say('[3/5] 备份现有文件');
    backupDir = makeBackupDir(dshHome);
    backupFile(pkgPath, backupDir);
    if (fs.existsSync(patchPath)) backupFile(patchPath, backupDir);
    say(`  备份：${backupDir}`);

    say('[4/5] 写依赖 / 建链接 / 加 patch');
    if (depPlan.action === 'skip') {
      say('  依赖已存在且指向同一个目录，跳过。');
    } else {
      writeTextFile(pkgPath, depPlan.text, pkgRead.bom);
      if (depPlan.action === 'update') say(`  依赖已更新：${depPlan.oldValue} -> ${depValue}`);
      else say(`  依赖已写入：${depValue}`);
    }

    const linkNow = getLinkState(linkPath, pluginDir);
    if (linkNow.state === 'missing') {
      createLink(linkPath, pluginDir);
      say(`  目录链接已建立 -> ${pluginDir}`);
    } else if (linkNow.state === 'same') {
      say('  目录链接已存在且指向正确，跳过。');
    } else {
      throw new Error(linkConflictError(linkPath, linkNow));
    }

    if (patchHas) {
      say('  cordis.patch.yml 里已经有 page-chat，跳过。');
    } else if (patchRead) {
      const nl = detectNewline(patchRead.text);
      const block = buildPatchBlock(nl, memoryValue);
      writeTextFile(patchPath, appendPatchText(patchRead.text, block, nl), patchRead.bom);
      say('  cordis.patch.yml 已追加 page-chat 段。');
    } else {
      const nl = '\n';
      writeTextFile(patchPath, buildPatchBlock(nl, memoryValue) + nl, false);
      say('  cordis.patch.yml 原来不存在，已新建并写入 page-chat 段。');
    }

    say('[5/5] 检查插件是否在跑');
    let healthy = false;
    if (options.noRestart) {
      say('  --no-restart：跳过健康检查和重启提示。');
    } else {
      let result = await checkHealth(port);
      if (result.ok) {
        say(`  插件已在跑：${result.body}`);
        healthy = true;
      } else {
        say(`  /page-chat/health 连不上（${result.error}）。`);
        if (isTTY && !options.yes) {
          const answer = await askPort(port);
          if (Number.isInteger(answer) && answer > 0 && answer < 65536) {
            // eslint-disable-next-line no-param-reassign
            port = answer;
          }
          result = await checkHealth(port);
          if (result.ok) {
            say(`  插件已在跑：${result.body}`);
            healthy = true;
          } else {
            say(`  还是连不上（${result.error}）。`);
          }
        }
        if (!healthy) {
          say('');
          say('插件装好了，但要重启 dsh web 才会加载。');
          say('重启：关掉当前的 dsh web 窗口，重新运行 dsh web（本脚本不会替你杀 node 进程）。');
        }
      }
    }

    say('');
    say('✓ 装好了。');
    printFinish(say, port, backupDir);
    return 0;
  } catch (e) {
    say('');
    err(`✗ 安装失败：${e && e.message ? e.message : e}\n`);
    if (backupDir) err(`已做的改动可以从这里拷回：${backupDir}\n`);
    return 1;
  }
}

function isMainModule() {
  const entry = process.argv[1];
  if (!entry) return false;
  return path.resolve(entry).toLowerCase() === path.resolve(SELF_PATH).toLowerCase();
}

if (isMainModule()) {
  run().then((code) => {
    process.exitCode = code;
  }).catch((e) => {
    process.stderr.write(`✗ 安装失败：${e && e.message ? e.message : e}\n`);
    process.exitCode = 1;
  });
}
