#requires -Version 5.1
<#
  install-extension.ps1 — 把「随手问」浏览器扩展装进 Chrome / Edge / Firefox / Zen，
  并等它自己报到，好让「装上了没有」不再靠人描述界面。

  做四件事（都可重复跑，幂等）：
    1. 找 <Repo>\extension；火狐包 _dist-firefox\manifest.json 缺了就 node build-firefox.mjs 重打
    2. 打开浏览器的扩展页（Chrome/Edge 是 chrome://extensions，Firefox/Zen 是 about:addons）
    3. 把「要选的那个路径」放进剪贴板，并用资源管理器打开它
    4. 轮询 http://127.0.0.1:3080/page-chat/installed，看到 installed:true 才算真装好

  用法：
    powershell -ExecutionPolicy Bypass -File .\scripts\install-extension.ps1
    powershell -ExecutionPolicy Bypass -File .\scripts\install-extension.ps1 -Browser firefox -Wait 60
    powershell -ExecutionPolicy Bypass -File .\scripts\install-extension.ps1 -Browser none -Wait 1 -NoOpen

  退出码：0 = 看到扩展连上来；2 = 等超时 / 探测不到浏览器；1 = 仓库里找不到扩展目录。

  注意：本文件是 UTF-8 带 BOM 保存的，这样 Windows PowerShell 5.1 也能正确读中文。
#>

[CmdletBinding()]
param(
  [ValidateSet('auto', 'chrome', 'edge', 'firefox', 'zen', 'none')]
  [string]$Browser = 'auto',
  [string]$Repo = '',
  [int]$Wait = 180,
  # 跳过着浏览器 / 剪贴板 / 资源管理器，只做打包与轮询（自测与无人值守用）。
  [switch]$NoOpen,
  # 自测用：轮询哪个地址。正常用默认值，别改。
  [string]$InstalledUrl = 'http://127.0.0.1:3080/page-chat/installed'
)

$ErrorActionPreference = 'Stop'

function Say([string]$Text) { Write-Host $Text }

function Stop-With([string]$Text) {
  Write-Host $Text -ForegroundColor Yellow
  exit 2
}

# 在常见安装位置里找一个浏览器可执行文件；找不到返回空串。
function Find-BrowserExe([string]$Name) {
  $roots = @($env:ProgramFiles, ${env:ProgramFiles(x86)}, $env:LOCALAPPDATA)
  $rel = @()
  switch ($Name) {
    'chrome' { $rel = @('Google\Chrome\Application\chrome.exe', 'Google\Chrome Beta\Application\chrome.exe') }
    'edge' { $rel = @('Microsoft\Edge\Application\msedge.exe') }
    'firefox' { $rel = @('Mozilla Firefox\firefox.exe') }
    'zen' { $rel = @('Zen Browser\zen.exe', 'Programs\Zen Browser\zen.exe') }
  }
  foreach ($root in $roots) {
    if (-not $root) { continue }
    foreach ($item in $rel) {
      $full = Join-Path $root $item
      if (Test-Path -LiteralPath $full) { return $full }
    }
  }
  return ''
}

if (-not $Repo) {
  $Repo = Split-Path -Parent $PSScriptRoot
}
$Repo = (Resolve-Path -LiteralPath $Repo).Path

$extensionDir = Join-Path $Repo 'extension'
if (-not (Test-Path -LiteralPath $extensionDir)) {
  Write-Host ('找不到扩展目录：' + $extensionDir) -ForegroundColor Red
  exit 1
}

# ── 1. 火狐包缺了就重打（幂等；产物在 _dist-firefox\）──────────────────────
$distManifest = Join-Path $Repo '_dist-firefox\manifest.json'
if (-not (Test-Path -LiteralPath $distManifest)) {
  $builder = Join-Path $Repo 'build-firefox.mjs'
  if (-not (Test-Path -LiteralPath $builder)) {
    Write-Host ('缺少打包脚本：' + $builder) -ForegroundColor Red
    exit 1
  }
  Say '火狐包不存在，先打一份：node build-firefox.mjs'
  Push-Location -LiteralPath $Repo
  try {
    & node build-firefox.mjs
    if ($LASTEXITCODE -ne 0) { Stop-With '打包失败（node build-firefox.mjs 非 0 退出），先修好再装。' }
  } finally {
    Pop-Location
  }
}

# ── 2. 选哪个浏览器 ──────────────────────────────────────────────────────
$want = $Browser
if ($want -eq 'auto') {
  foreach ($candidate in @('chrome', 'edge', 'firefox', 'zen')) {
    if (Find-BrowserExe $candidate) { $want = $candidate; break }
  }
  if ($want -eq 'auto') {
    Stop-With '本机没探测到 Chrome / Edge / Firefox / Zen。装一个，或用 -Browser 指定（也可以 -Browser none 只看自检）。'
  }
}

$isFirefox = ($want -eq 'firefox' -or $want -eq 'zen')
$open = (-not $NoOpen) -and ($want -ne 'none')

if ($isFirefox) {
  # Firefox / Zen 走「从文件安装」正式流程：需要 Mozilla 签过名的 .xpi，
  # 本地有就复制路径，没有就复制下载地址（发版页里的 latest 永远指向最新签名包）。
  $signed = Get-ChildItem -Path (Join-Path $Repo 'dist') -Filter '*firefox-signed.xpi' -File -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTime -Descending | Select-Object -First 1
  if ($signed) {
    $selectPath = $signed.FullName
  } else {
    $selectPath = 'https://github.com/pydsl43/suishouwen/releases/latest/download/suishouwen-0.4.6-firefox-signed.xpi'
  }
  $folderToOpen = Split-Path -Parent $distManifest
  $page = 'about:addons'
} else {
  $selectPath = $extensionDir
  $folderToOpen = $extensionDir
  $page = 'chrome://extensions'
  if ($want -eq 'edge') { $page = 'edge://extensions' }
}

# ── 3. 开页面、复制路径、开目录 ──────────────────────────────────────────
if ($open) {
  $exe = Find-BrowserExe $want
  if ($exe) {
    try {
      Start-Process -FilePath $exe -ArgumentList $page
    } catch {
      Say ('没能自动打开浏览器，手动打开这个地址：' + $page)
    }
  } else {
    Say ('没找到 ' + $want + ' 的可执行文件，手动打开这个地址：' + $page)
  }
  try {
    Set-Clipboard -Value $selectPath
  } catch {
    try { $selectPath | clip.exe } catch { }
  }
  try {
    Start-Process -FilePath 'explorer.exe' -ArgumentList ('"' + $folderToOpen + '"')
  } catch { }
}

# ── 4. 三步人话 ──────────────────────────────────────────────────────────
Say ''
Say '接下来三步：'
if ($isFirefox) {
  Say '  1) 在打开的 Firefox / Zen 里进入 about:addons'
  Say '  2) 右上角齿轮 → 「从文件安装附加组件…」（Install Add-on From File）'
  Say '  3) 选这个签名包（路径或地址已复制到剪贴板）：' + $selectPath
  if ($selectPath -like 'http*') {
    Say '     （剪贴板是下载地址：先在浏览器里打开它把 .xpi 存到本地，再回到第 2 步选文件）'
  }
} else {
  $label = 'Chrome'
  if ($want -eq 'edge') { $label = 'Edge' }
  Say ('  1) 在打开的 ' + $label + ' 扩展页，右上角打开「开发者模式」')
  Say '  2) 点「加载已解压的扩展程序」（Load unpacked）'
  Say ('  3) 选这个目录（路径已复制到剪贴板）：' + $selectPath)
}

# ── 5. 等扩展自己报到 ────────────────────────────────────────────────────
if ($Wait -lt 1) { $Wait = 1 }
Say ''
Say ('等扩展连上来（最多 ' + $Wait + ' 秒）…')
$deadline = (Get-Date).AddSeconds($Wait)
$version = ''
$installed = $false
while ((Get-Date) -lt $deadline) {
  try {
    $data = Invoke-RestMethod -Uri $InstalledUrl -Method Get -TimeoutSec 2
    if ($data -and $data.installed -eq $true) {
      $version = [string]$data.version
      $installed = $true
      break
    }
  } catch {
    # DSH 没起 / 端口不通：继续等（用户可能正在启 DSH）
  }
  Start-Sleep -Milliseconds 1000
}

if ($installed) {
  Say ('装好了，扩展版本 ' + $version + ' 已连上。')
  exit 0
}

Say '还没看到扩展连上来，检查是不是选错目录。'
Say ('自检地址：' + $InstalledUrl)
exit 2
