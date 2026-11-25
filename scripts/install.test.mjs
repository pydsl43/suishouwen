import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { run } from './install.mjs';

const PLUGIN = '@pydsl/dsh-page-chat';
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..');
const installerPath = path.join(scriptDir, 'install.mjs');
const pluginDir = path.join(repoRoot, 'plugin');
const expectedDep = `file:${pluginDir.replace(/\\/g, '/')}`;

function safeReaddir(dir) {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

function removeLink(linkPath) {
  try {
    fs.unlinkSync(linkPath);
  } catch {
    try {
      fs.rmdirSync(linkPath);
    } catch {
      /* 没有就算了 */
    }
  }
}

function cleanupHome(home) {
  const profiles = path.join(home, 'profiles');
  for (const name of safeReaddir(profiles)) {
    removeLink(path.join(profiles, name, 'node_modules', '@pydsl', 'dsh-page-chat'));
  }
  fs.rmSync(home, { recursive: true, force: true });
}

function makeHome(t, { profile = 'web', indent = 2, extraProfiles = [] } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'suishouwen-xplat-'));
  t.after(() => cleanupHome(home));
  for (const name of [profile, ...extraProfiles]) {
    const dir = path.join(home, 'profiles', name);
    fs.mkdirSync(dir, { recursive: true });
    const pkg = { name: `dsh-profile-${name}`, private: true, dependencies: {} };
    fs.writeFileSync(path.join(dir, 'package.json'), `${JSON.stringify(pkg, null, indent)}\n`, 'utf8');
    fs.writeFileSync(path.join(dir, 'cordis.patch.yml'), '', 'utf8');
  }
  return home;
}

function profilePaths(home, name = 'web') {
  const dir = path.join(home, 'profiles', name);
  return {
    dir,
    pkg: path.join(dir, 'package.json'),
    patch: path.join(dir, 'cordis.patch.yml'),
    link: path.join(dir, 'node_modules', '@pydsl', 'dsh-page-chat'),
  };
}

function argsFor(home, { profile = 'web', extra = [] } = {}) {
  return ['--repo', repoRoot, '--dsh-home', home, '--profile', profile, '--no-restart', ...extra];
}

async function invoke(argv) {
  const stdout = [];
  const stderr = [];
  const code = await run(argv, {
    out: (s) => stdout.push(s),
    err: (s) => stderr.push(s),
    isTTY: false,
  });
  return { code, stdout: stdout.join(''), stderr: stderr.join(''), all: stdout.join('') + stderr.join('') };
}

function listBackups(home) {
  return safeReaddir(home).filter((name) => name.startsWith('.backup-page-chat-')).sort();
}

function snapshotTree(root) {
  const lines = [];
  const walk = (dir, rel) => {
    for (const name of fs.readdirSync(dir).sort()) {
      const abs = path.join(dir, name);
      const relPath = rel === '' ? name : `${rel}/${name}`;
      const st = fs.lstatSync(abs);
      if (st.isSymbolicLink()) {
        lines.push(`L ${relPath} -> ${fs.readlinkSync(abs)}`);
      } else if (st.isDirectory()) {
        walk(abs, relPath);
      } else {
        const hash = createHash('sha256').update(fs.readFileSync(abs)).digest('hex');
        lines.push(`F ${relPath} ${hash}`);
      }
    }
  };
  walk(root, '');
  return lines.join('\n');
}

function assertLinkPointsToPlugin(linkPath) {
  const st = fs.lstatSync(linkPath);
  assert.equal(st.isSymbolicLink(), true, `${linkPath} 应当是一个链接`);
  assert.equal(
    fs.realpathSync(linkPath).toLowerCase(),
    fs.realpathSync(pluginDir).toLowerCase(),
    '链接应当指向仓库的 plugin 目录',
  );
}

test('首次安装：写依赖、建链接、追加 patch、留备份', async (t) => {
  const home = makeHome(t);
  const { pkg, patch, link } = profilePaths(home);

  const result = await invoke(argsFor(home));
  assert.equal(result.code, 0, result.all);

  const manifest = JSON.parse(fs.readFileSync(pkg, 'utf8'));
  assert.equal(manifest.dependencies[PLUGIN], expectedDep);

  assertLinkPointsToPlugin(link);

  const patchText = fs.readFileSync(patch, 'utf8');
  assert.match(patchText, /^- insert:$/m);
  assert.match(patchText, /^\s+- id: page-chat$/m);
  assert.match(patchText, /maxTurns: 20/);

  const backups = listBackups(home);
  assert.equal(backups.length, 1, '第一次安装应当留一个备份目录');
  assert.ok(fs.existsSync(path.join(home, backups[0], 'package.json')));
  assert.ok(fs.existsSync(path.join(home, backups[0], 'cordis.patch.yml')));
});

test('重复安装：文件内容幂等，每次只多一个备份目录', async (t) => {
  const home = makeHome(t);
  const { pkg, patch } = profilePaths(home);

  const first = await invoke(argsFor(home));
  assert.equal(first.code, 0, first.all);
  const pkgAfterFirst = fs.readFileSync(pkg, 'utf8');
  const patchAfterFirst = fs.readFileSync(patch, 'utf8');

  const second = await invoke(argsFor(home));
  const third = await invoke(argsFor(home));
  assert.equal(second.code, 0, second.all);
  assert.equal(third.code, 0, third.all);

  assert.equal(fs.readFileSync(pkg, 'utf8'), pkgAfterFirst, '第二次/第三次不应再改 package.json');
  assert.equal(fs.readFileSync(patch, 'utf8'), patchAfterFirst, '第二次/第三次不应再改 cordis.patch.yml');
  assert.equal(listBackups(home).length, 3, '跑了三次就该有三个备份目录');

  const patchText = fs.readFileSync(patch, 'utf8');
  assert.equal((patchText.match(/id: page-chat/g) || []).length, 1, 'page-chat 只能出现一次');
});

test('链接指向别处：非 0 退出，且一个文件都不改', async (t) => {
  const home = makeHome(t);
  const { dir, pkg, patch, link } = profilePaths(home);
  const otherDir = fs.mkdtempSync(path.join(os.tmpdir(), 'suishouwen-other-'));
  t.after(() => fs.rmSync(otherDir, { recursive: true, force: true }));

  fs.mkdirSync(path.dirname(link), { recursive: true });
  fs.symlinkSync(otherDir, link, process.platform === 'win32' ? 'junction' : 'dir');

  const before = snapshotTree(home);
  const beforePkg = fs.readFileSync(pkg, 'utf8');
  const beforePatch = fs.readFileSync(patch, 'utf8');

  const spawned = spawnSync(process.execPath, [installerPath, ...argsFor(home)], {
    encoding: 'utf8',
  });
  assert.equal(spawned.status, 1, `${spawned.stdout}\n${spawned.stderr}`);
  assert.match(spawned.stderr, /先删掉|指向别处/);

  assert.equal(fs.readFileSync(pkg, 'utf8'), beforePkg);
  assert.equal(fs.readFileSync(patch, 'utf8'), beforePatch);
  assert.equal(listBackups(home).length, 0, '报错时不该留备份目录');
  assert.equal(snapshotTree(home), before, '除了预先造的那个错链接，目录不该有任何变化');
  assert.ok(fs.existsSync(dir));
});

test('--dry-run：目录内容哈希前后完全一致，且打印 3999 端口', async (t) => {
  const home = makeHome(t);
  const before = snapshotTree(home);

  const result = await invoke([
    '--repo', repoRoot,
    '--dsh-home', home,
    '--profile', 'web',
    '--dry-run',
    '--no-restart',
    '--port', '3999',
  ]);
  assert.equal(result.code, 0, result.all);
  assert.match(result.stdout, /\[DryRun\]/);
  assert.match(result.stdout, /:3999\/page-chat\/setup/);
  assert.equal(snapshotTree(home), before, 'dry-run 不该写任何文件');
  assert.equal(listBackups(home).length, 0);
});

test('--dsh-home 与 --profile 生效：只动指定 profile', async (t) => {
  const home = makeHome(t, { profile: 'web', extraProfiles: ['other'] });
  const web = profilePaths(home, 'web');
  const other = profilePaths(home, 'other');
  const webPkgBefore = fs.readFileSync(web.pkg, 'utf8');
  const webPatchBefore = fs.readFileSync(web.patch, 'utf8');

  const result = await invoke(argsFor(home, { profile: 'other' }));
  assert.equal(result.code, 0, result.all);

  const otherManifest = JSON.parse(fs.readFileSync(other.pkg, 'utf8'));
  assert.equal(otherManifest.dependencies[PLUGIN], expectedDep);
  assertLinkPointsToPlugin(other.link);
  assert.match(fs.readFileSync(other.patch, 'utf8'), /id: page-chat/);

  assert.equal(fs.readFileSync(web.pkg, 'utf8'), webPkgBefore, 'web profile 不该被动');
  assert.equal(fs.readFileSync(web.patch, 'utf8'), webPatchBefore, 'web profile 不该被动');
  assert.equal(fs.existsSync(web.link), false, '不该给 web profile 建链接');
});

test('保留缩进：4 空格的 package.json 写完后仍是 4 空格', async (t) => {
  const home = makeHome(t, { indent: 4 });
  const { pkg } = profilePaths(home);

  const result = await invoke(argsFor(home));
  assert.equal(result.code, 0, result.all);

  const text = fs.readFileSync(pkg, 'utf8');
  assert.match(text, /^ {4}"dependencies": \{$/m, 'dependencies 这一行应当是 4 空格缩进');
  assert.match(text, /^ {8}"@pydsl\/dsh-page-chat": "file:/m, '新加的依赖应当是 8 空格缩进');
  assert.equal(text.includes('\t'), false);
  assert.equal(JSON.parse(text).dependencies[PLUGIN], expectedDep);
});

test('仓库不对：退出码 1，不碰 DSH 家目录', async (t) => {
  const home = makeHome(t);
  const emptyRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'suishouwen-empty-'));
  t.after(() => fs.rmSync(emptyRepo, { recursive: true, force: true }));

  const before = snapshotTree(home);
  const result = await invoke([
    '--repo', emptyRepo,
    '--dsh-home', home,
    '--profile', 'web',
    '--no-restart',
  ]);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /plugin\/package\.json/);
  assert.equal(snapshotTree(home), before);
});
