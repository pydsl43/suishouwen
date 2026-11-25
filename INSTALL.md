# 安装单：三步装好「随手问」

这份文件写给帮你装东西的人：AI 助手照着一层层核，人自己读也能做。

三步：装 DSH → 装插件 → 装扩展。

**全程约 5 分钟，其中 2 分钟是等下载。**

---

## 你要装什么

两件东西，缺一不可：

1. **后端插件**（包名 `@pydsl/dsh-page-chat`，仓库里的 `plugin/`）。它跑在 DSH 里面，负责真正跟模型说话。要写进 DSH `web` profile 的三处：`package.json` 的依赖、`node_modules/@pydsl/` 下的目录联接、`cordis.patch.yml` 里的一小段配置。Windows 上一条命令做完；macOS / Linux 手工改，见文末附录 A。
2. **浏览器扩展**（仓库里的 `extension/`）。它只负责「选中文字 → 弹小框 → 把话发给本机」。装的是 Mozilla 签好名的包（Firefox / Zen），或者解压出来的文件夹（Chrome / Edge）。

只装后端，网页上什么都不出现；只装扩展，小框会一直说连不上。

---

## 开工前先确认

- Node.js **24.9+**（`node --version`）
- DSH **0.2.2+**，而且至少跑过一次（`~/.dsh/profiles/web/` 里有 `package.json`）
- Windows 用 PowerShell **5.1+**（系统自带就是，够用）
- 只有「从网址装」才需要 `git`；已经 clone 到本地就不需要
- **Windows 已实测**；macOS / Linux 走同一份 `scripts/install.mjs`，脚本逻辑有 7 项自动测试，但**没在真 mac / 真 Linux 上跑过**（附录 A 是纯手工版）

`~/.dsh/profiles/web/` 不存在 = DSH 还没跑起来。先 `dsh web`，看到 `http://127.0.0.1:3080` 能打开，再往下走。

---

## 第一步：装 DSH 并跑起来

```powershell
npm i -g @deepseek-ai/dsh
dsh web
```

浏览器打开 `http://127.0.0.1:3080` 能出页面就对了。**这个窗口别关**，插件和扩展都要连它。

---

## 第二步：装插件

### 最快：双击

仓库拿到本地后（`git clone` 或直接下 ZIP）：

| 系统 | 双击 / 执行 | 说明 |
| --- | --- | --- |
| Windows | `一键安装.bat` | 双击就跑；参数可以拖进去，如 `一键安装.bat --port 3081` |
| macOS | `install.command` | 双击；若提示「没有执行权限」，先在终端跑一次 `chmod +x install.command` |
| Linux / 终端 | `bash install.sh` | 三平台同一份 `scripts/install.mjs` |

跑完它会打印一个地址，形如 `http://127.0.0.1:3080/page-chat/setup` —— 那是一页自检向导，扩展装没装上它会自己变绿。**默认端口 3080；DSH 不是这个端口就用 `--port` 或环境变量 `DSH_WEB_PORT` 指定。**

同一份逻辑还有 PowerShell 版（行为等价，`-DryRun` / `-NoRestart` 等参数更细），下面这节就是它。

### Windows：一条命令

先把仓库拿到本地（已经 clone 过就跳过）：

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

### macOS / Linux：没有安装脚本

Windows 双击 `一键安装.bat`、macOS 双击 `install.command`、Linux 跑 `bash install.sh`，三平台是同一份 `scripts/install.mjs`。想完全手工改 profile 的三处，照文末「附录 A」做。

---

## 第三步：装浏览器扩展

扩展不用自己编译。两个包都在 Release 里，下载地址永远是 `latest/download` 这一份：

- Firefox / Zen：`suishouwen-0.4.6-firefox-signed.xpi`（Mozilla 签名）
- Chrome / Edge / Brave：`suishouwen-0.4.6-chrome.zip`（解压后加载）

### Firefox / Zen（首选：签名包）

1. 下载 [`suishouwen-0.4.6-firefox-signed.xpi`](https://github.com/pydsl43/suishouwen/releases/latest/download/suishouwen-0.4.6-firefox-signed.xpi)。
2. 打开 `about:addons` → 右上角齿轮 → **从文件安装附加组件** → 选刚下好的 `.xpi`。
3. 扩展列表里出现「随手问」就成了。不用开发者模式；重启浏览器也不会掉。

Zen 就是 Firefox，同样走这三步。

### Chrome / Edge / Brave（解压加载，唯一办法）

1. 下载 [`suishouwen-0.4.6-chrome.zip`](https://github.com/pydsl43/suishouwen/releases/latest/download/suishouwen-0.4.6-chrome.zip) 并**解压**。
2. 打开 `chrome://extensions`（Edge 是 `edge://extensions`），右上角打开「开发者模式」。
3. 点「加载已解压的扩展程序」，选**解压出来的文件夹**（不是 zip，也不是仓库根目录）。

Chrome 稳定版不接受自签名 `.crx`，双击装不上。解压加载是唯一的本地装法。

校验和在同页的 `SHA256SUMS.txt` 里。

### 确认扩展真的报到了

扩展一加载成功，就会自己向 DSH 报一次到。终端里跑：

```powershell
curl.exe http://127.0.0.1:3080/page-chat/installed
```

看到 `"installed":true` 和 `"version":"0.4.6"` 才算真装上 —— 这条记录是扩展自己写进来的，不是「浏览器界面上看起来有」。`version` 是扩展版本，`at` 是最后一次报到时间；DSH 重启后记录仍在（落在磁盘上）。看到 `"installed":false` = 扩展没加载成功，或者加载的还是不会报到的旧版。

`scripts\install-extension.ps1` 能替你等：打开扩展页、把要选的路径放进剪贴板、轮询 `/page-chat/installed`，连上就打印「装好了，扩展版本 X 已连上」。**Firefox / Zen 别用它**，照上面的签名包三步走（原因见附录 B）；Chrome / Edge 可以用。

---

## 装完怎么验

三条，从下往上验：

**① 后端活着**：浏览器或命令行打开

```
http://127.0.0.1:3080/page-chat/health
```

应当返回类似 `{"ok":true,"dshReady":true,"version":"0.2.1",...}`。`sessions` 和 `now` 每次都变，只看 `ok`、`dshReady`、`version` 三项。连接被拒 = dsh web 没跑；`ok:false` / `dshReady:false` = 插件装了但没被加载（多半是没重启）。

**② 扩展报到了**：上面 `/page-chat/installed` 里 `installed` 为 `true`，且 `version` 与 `extension/manifest.json` 一致。

**③ 整条链路通**：随便打开一个普通网页（`https://example.com` 就行），选中两个字以上，选区右下角出现「随手问」小浮标；点开，问一句「这什么意思」，能收到回答。

> ①②在命令输出里就能看到，③必须人手动点一下。**没做③之前，不要说「装好了」，说「装好了，等你确认最后一下」。**

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

## 附录 A：macOS / Linux 手工装插件（未验）

Windows 之外没有安装脚本。下面是脚本在 Windows 上做的等价操作，**未在 macOS / Linux 上验过**。改的是 DSH 的 `web` profile（默认 `~/.dsh/profiles/web/`），改前把整个目录备份一份。

1. **依赖**：profile 的 `package.json` 里，`dependencies` 加一行
   `"@pydsl/dsh-page-chat": "file:/绝对路径/suishouwen/plugin"`。
2. **链接**：让 `node_modules/@pydsl/dsh-page-chat` 指向同一个 `plugin/` 目录：

   ```bash
   mkdir -p node_modules/@pydsl
   ln -s /绝对路径/suishouwen/plugin node_modules/@pydsl/dsh-page-chat
   ```

3. **配置**：`cordis.patch.yml` 追加仓库里 `plugin/cordis.patch.yml` 的那一段（`id: page-chat`、`name: '@pydsl/dsh-page-chat'`，config 照抄，注意缩进）。
4. **重启 `dsh web`**，再按上面「装完怎么验」核。

回滚：删掉那个链接、删依赖那一行、删 patch 里那一段，重启 `dsh web`。

---

## 附录 B：想改代码，自己打包

只有改扩展源码时才需要。不改就直接下 Release 里的包。

```powershell
node build-firefox.mjs
```

它把 `extension/` 组装成 `_dist-firefox/`（MV2 火狐包）。开发时看效果：打开 `about:debugging#/runtime/this-firefox` → **临时载入附加组件** → 选 `_dist-firefox/manifest.json`。**临时载入重启浏览器就掉**，只适合开发；正式安装仍用上面第三步的签名包。

打包 / 签名脚本：`scripts\package-extension.ps1`（出 Chrome zip 和火狐包）、`scripts\sign-firefox.ps1`（交 Mozilla 自动签名，需要 AMO 凭据）。

注意：`scripts\install-extension.ps1` 对 Firefox / Zen 打开的仍是 `about:debugging` 的临时载入页（脚本还没改成签名包流程）。Firefox 用户别用它，按第三步手动装。

---

## AGENT CHECKLIST

装完逐条核，每条都能一条命令验完。全过再回报「装好了」；有一条没过，回报那条的实际输出。

- [ ] 仓库里有插件清单：`Test-Path .\plugin\package.json` 为 `True`
- [ ] 包名对得上：`(Get-Content .\plugin\package.json -Raw | ConvertFrom-Json).name` 输出 `@pydsl/dsh-page-chat`
- [ ] 依赖已写入且 JSON 合法：`(Get-Content "$env:USERPROFILE\.dsh\profiles\web\package.json" -Raw | ConvertFrom-Json).dependencies.'@pydsl/dsh-page-chat'` 输出 `file:.../plugin`
- [ ] 目录联接指向正确：`(Get-Item "$env:USERPROFILE\.dsh\profiles\web\node_modules\@pydsl\dsh-page-chat" -Force).Target` 指向本仓库的 `plugin` 目录
- [ ] patch 里只有一段：`Select-String -Path "$env:USERPROFILE\.dsh\profiles\web\cordis.patch.yml" -Pattern 'id: page-chat'` 命中 **1** 行
- [ ] 后端活着：`(Invoke-WebRequest http://127.0.0.1:3080/page-chat/health -UseBasicParsing).Content` 里 `ok` 和 `dshReady` 都是 `true`
- [ ] 签名包能下：`curl.exe -I https://github.com/pydsl43/suishouwen/releases/latest/download/suishouwen-0.4.6-firefox-signed.xpi` 返回 200 或 302（或用户已把 `.xpi` 下到本地）
- [ ] 扩展目录有清单：`Test-Path .\extension\manifest.json` 为 `True`（版本与 Release 的 0.4.6 一致）
- [ ] 已按浏览器告知装法：Firefox / Zen 下签名包 → `about:addons` → 齿轮 → 从文件安装；Chrome / Edge 解压 zip → 开发者模式 → 加载已解压
- [ ] 扩展真的连上了：`curl.exe http://127.0.0.1:3080/page-chat/installed` 里 `installed` 为 `true`，且 `version` 与 `extension\manifest.json` 一致（别只看浏览器扩展页有没有卡片）

装的过程中如果改过什么、修过什么，回报时一并说；没验到的（比如用户还没去浏览器点过）要明说「未验」。
