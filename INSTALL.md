# 安装单（写给「用户的 AI 助手」）

这份文件是给**帮你装东西的 AI 助手**读的：照着做，一条一条核。人自己读也能照做，只是会多几步。

---

## 你要装什么

两个东西，装在两处：

1. **后端插件**（包名 `@pydsl/dsh-page-chat`，仓库里的 `plugin/`）。它跑在 DSH 里面，负责真正跟模型说话。装它要动 DSH 的 `web` profile 三处：`package.json` 的依赖、`node_modules/@pydsl/` 下的目录联接、`cordis.patch.yml` 里的一小段配置。**这三处由一条命令一次做完**，不要手工改。
2. **浏览器扩展**（仓库里的 `extension/`）。它只负责「选中文字 → 弹小框 → 把话发给本机」。扩展必须手工在浏览器里加载，命令替不了。

两者缺一不可：只装后端，网页上什么都不出现；只装扩展，小框会一直说连不上。

---

## 开工前先确认

- Node.js **24.9+**（`node --version`）
- DSH **0.2.2+** 而且至少跑过一次（`~/.dsh/profiles/web/` 里有 `package.json`）
- PowerShell **5.1+**（Windows 自带的就是 5.1，够用）
- 只有「从网址装」才需要 `git`；已经 clone 到本地就不需要

`~/.dsh/profiles/web/` 不存在 = DSH 还没跑起来。先 `dsh web`，看到 `http://127.0.0.1:3080` 能打开，再回来装。

---

## 一条命令装后端

先把仓库拿到本地（已经 clone 过就跳过第一行）：

```powershell
git clone https://github.com/pydsl43/suishouwen
cd suishouwen
```

**先看它打算做什么（不写任何文件）：**

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\install.ps1 -DryRun
```

输出的每一行都是「将要做什么」。看着对，再去掉 `-DryRun` 真跑：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\install.ps1
```

想装到别的地方、或 DSH 不在默认位置，加参数：

| 参数 | 默认 | 什么时候用 |
| --- | --- | --- |
| `-Repo <路径或网址>` | 脚本所在仓库 | 仓库不在这台机器的这个位置；给网址会先 clone 到临时目录 |
| `-DshHome <路径>` | `%USERPROFILE%\.dsh` | DSH 家目录不在默认位置 |
| `-Profile <名字>` | `web` | 要装进别的 profile |
| `-MemoryDir <绝对路径>` | 不写（用插件自带默认） | 想把记忆卡放到指定目录 |
| `-NoRestart` | 关 | 装完不要碰正在跑的 dsh web |
| `-DryRun` | 关 | 只打印计划，不落盘 |

这条命令做的事（都可重复跑，不会重复插入）：

1. 校验 `plugin/package.json` 存在、包名是 `@pydsl/dsh-page-chat`；不对就停，不会装错东西。
2. 把改动前的 `package.json` 和 `cordis.patch.yml` 备份到 `%USERPROFILE%\.dsh\.backup-page-chat-<时间戳>\`（结尾会打印路径）。
3. 在 profile 的 `dependencies` 里写 `"@pydsl/dsh-page-chat": "file:<仓库>/plugin"`（保留原文件的缩进风格）。
4. 建 `node_modules\@pydsl\dsh-page-chat` 目录联接指向 `<仓库>/plugin`；已存在且指向同一处就跳过，指向别处就报错让你先删（不会静默覆盖）。
5. 往 `cordis.patch.yml` **追加**一段 page-chat 配置（不动已有的段和注释）。
6. 检查 `http://127.0.0.1:3080/page-chat/health`：插件已经在跑就不重启；没在跑就试着重启（本机没有可靠重启办法时，会告诉你手动重启，绝不乱杀 node 进程）。
7. 最后把扩展的安装步骤和卸载命令打印出来。

---

## 装完怎么验

三条，从下往上验：

**① 后端活着**：浏览器或命令行打开

```
http://127.0.0.1:3080/page-chat/health
```

应当返回类似 `{"ok":true,"dshReady":true,"version":"0.2.0",...}`。`sessions` 和 `now` 每次都变，只看 `ok`、`dshReady`、`version` 三项。连接被拒 = dsh web 没跑；`ok:false` / `dshReady:false` = 插件装了但没被加载（多半是没重启）。

**② 扩展加载上了**：浏览器扩展页里能看到「随手问」，并且**没有报错**（Chrome 里图标是彩色的，不是灰色的）。

**③ 整条链路通**：随便打开一个普通网页（`https://example.com` 就行），选中两个字以上，选区右下角出现「随手问」小浮标；点开，问一句「这什么意思」，能收到回答。

> ①②在命令输出里就能看到，③必须人手动点一下。**没做③之前，不要说「装好了」，说「装好了，等你确认最后一下」。**

---

## 装扩展

### Chrome / Edge / Brave

1. 打开 `chrome://extensions`（Edge 是 `edge://extensions`）。
2. 右上角打开「开发者模式」。
3. 点「加载已解压的扩展程序」，选仓库里的 **`extension` 目录**（不是里面的某个文件）。

### Firefox / Zen

1. 在仓库根目录运行 `node build-firefox.mjs`，它会生成 `_dist-firefox/`。
2. 打开 `about:debugging#/runtime/this-firefox`。
3. 点「临时载入附加组件」，选 `_dist-firefox/manifest.json`。

Firefox 的临时扩展在重启浏览器后会消失，要重新载入一次。

---

## 出问题怎么办

先看 [`docs/INSTALL-FAQ.md`](docs/INSTALL-FAQ.md)，里面按症状分类。最常见的三条：

1. **health 返回不了 / 连接被拒** → `dsh web` 没在跑，或者装在别的端口。先把 DSH 跑起来。
2. **health 通了但网页上选中字没浮标** → 扩展没加载、加载到了错的目录、或者当前页面不是普通网页（`chrome://` 开头的页面、扩展商店、PDF 阅读器里都不会出现浮标）。
3. **小框一直转圈 / 说连不上** → 扩展连的不是 `http://127.0.0.1:3080`，或者 DSH 那边插件没生效（回看 health 的 `ok` 和 `dshReady`）。

命令本身报的错都会是完整的中文句子，直接照着那句话做：说「找不到 plugin\package.json」就是 `-Repo` 指错了目录；说「联接指向别处」就是那台机器上已经装过另一个版本，先删掉那个联接再重跑。

---

## 回滚

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\uninstall.ps1
```

它会：删掉那个目录联接（只删自己建的那个）、从 `dependencies` 里摘掉这一条、从 `cordis.patch.yml` 里只删 page-chat 那一段；同样先备份，同样可以重复跑。**记忆目录不删**，只在结尾告诉你它在哪，想清就自己删。

浏览器扩展在扩展页里点「移除」即可。DSH 那边的改动要重启 `dsh web` 才生效。

想回到装之前的状态：上面命令跑完，再把备份目录 `%USERPROFILE%\.dsh\.backup-page-chat-<时间戳>\` 里的两个文件拷回去，重启 dsh web。

---

## AGENT CHECKLIST

装完逐条核，每条都能一条命令验完。全过再回报「装好了」；有一条没过，回报那条的实际输出。

- [ ] 仓库里有插件清单：`Test-Path .\plugin\package.json` 为 `True`
- [ ] 包名对得上：`(Get-Content .\plugin\package.json -Raw | ConvertFrom-Json).name` 输出 `@pydsl/dsh-page-chat`
- [ ] 依赖已写入且 JSON 合法：`(Get-Content "$env:USERPROFILE\.dsh\profiles\web\package.json" -Raw | ConvertFrom-Json).dependencies.'@pydsl/dsh-page-chat'` 输出 `file:.../plugin`
- [ ] 目录联接指向正确：`(Get-Item "$env:USERPROFILE\.dsh\profiles\web\node_modules\@pydsl\dsh-page-chat" -Force).Target` 指向本仓库的 `plugin` 目录
- [ ] patch 里只有一段：`Select-String -Path "$env:USERPROFILE\.dsh\profiles\web\cordis.patch.yml" -Pattern 'id: page-chat'` 命中 **1** 行
- [ ] 后端活着：`(Invoke-WebRequest http://127.0.0.1:3080/page-chat/health -UseBasicParsing).Content` 里 `ok` 和 `dshReady` 都是 `true`
- [ ] 扩展目录有清单：`Test-Path .\extension\manifest.json` 为 `True`（并已告知用户按上一节手工加载）

装的过程中如果改过什么、修过什么，回报时一并说；没验到的（比如用户还没去浏览器点过）要明说「未验」。
