#requires -Version 5.1
<#
  install.ps1 — 一条命令把「随手问」的后端插件装进 DSH。

  做三件事（都可重复跑，不会重复插入）：
    1. 在 <DshHome>\profiles\<Profile>\package.json 的 dependencies 里写
       "@pydsl/dsh-page-chat": "file:<仓库>\plugin"
    2. 建 <Profile>\node_modules\@pydsl\dsh-page-chat 目录联接（junction）→ <仓库>\plugin
    3. 往 <Profile>\cordis.patch.yml 追加 page-chat 的 insert 段

  用法：
    powershell -ExecutionPolicy Bypass -File .\scripts\install.ps1
    powershell -ExecutionPolicy Bypass -File .\scripts\install.ps1 -DryRun
    powershell -ExecutionPolicy Bypass -File .\scripts\install.ps1 -DshHome D:\tmp\dsh -Profile web

  注意：本文件是 UTF-8 带 BOM 保存的，这样 Windows PowerShell 5.1 也能正确读中文。
#>

[CmdletBinding()]
param(
  [string]$Repo = '',
  [string]$DshHome = '',
  [string]$Profile = 'web',
  [string]$MemoryDir = '',
  [switch]$NoRestart,
  [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
$PluginName = '@pydsl/dsh-page-chat'
$backupDir = $null

# ── 小工具 ────────────────────────────────────────────────────────────────

function Read-Utf8([string]$Path) {
  return [System.IO.File]::ReadAllText($Path, [System.Text.Encoding]::UTF8)
}

function Write-Utf8Preserve([string]$Path, [string]$Text) {
  $hasBom = $false
  if (Test-Path -LiteralPath $Path) {
    $bytes = [System.IO.File]::ReadAllBytes($Path)
    if ($bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF) { $hasBom = $true }
  }
  $enc = New-Object System.Text.UTF8Encoding($hasBom)
  [System.IO.File]::WriteAllText($Path, $Text, $enc)
}

function Get-Newline([string]$Text) {
  if ($Text.Contains("`r`n")) { return "`r`n" }
  return "`n"
}

function Get-IndentUnit([string]$Text) {
  $unit = ''
  foreach ($line in ($Text -split "`r?`n")) {
    $m = [regex]::Match($line, '^([ \t]+)"')
    if ($m.Success) {
      $ws = $m.Groups[1].Value
      if ($unit -eq '' -or $ws.Length -lt $unit.Length) { $unit = $ws }
    }
  }
  if ($unit -eq '') { $unit = '  ' }
  return $unit
}

function Normalize-PathSlash([string]$Path) {
  return ($Path -replace '\\', '/')
}

function Get-FileHashSafe([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path)) { return '<missing>' }
  return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash
}

function Backup-Into([string]$Dir, [string]$Path) {
  if (-not (Test-Path -LiteralPath $Path)) { return }
  if (-not (Test-Path -LiteralPath $Dir)) { New-Item -ItemType Directory -Force -Path $Dir | Out-Null }
  $name = [System.IO.Path]::GetFileName($Path)
  Copy-Item -LiteralPath $Path -Destination (Join-Path $Dir $name) -Force
}

# ── 找仓库根 ──────────────────────────────────────────────────────────────

function Resolve-RepoRoot([string]$Spec) {
  if ([string]::IsNullOrWhiteSpace($Spec)) {
    # 默认：脚本所在目录的上一级
    return (Split-Path -Parent $PSScriptRoot)
  }
  if ($Spec -match '^(https?://|git@|ssh://)') {
    if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
      throw "要从网址安装需要先装 git（命令行里找不到 git）。也可以先把仓库下载到本地，再用 -Repo <本地目录>。"
    }
    $cloneDir = Join-Path ([System.IO.Path]::GetTempPath()) 'suishouwen'
    if (Test-Path -LiteralPath (Join-Path $cloneDir '.git')) {
      Write-Host "  仓库已存在，执行 git pull：$cloneDir"
      & git -C $cloneDir pull --ff-only 2>&1 | Out-Null
      if ($LASTEXITCODE -ne 0) {
        throw "git pull 失败（$cloneDir）。可以删掉这个目录重试，或改用 -Repo <本地目录>。"
      }
    } else {
      Write-Host "  克隆仓库到：$cloneDir"
      & git clone --depth 1 $Spec $cloneDir 2>&1 | Out-Null
      if ($LASTEXITCODE -ne 0) {
        throw "git clone 失败。检查网址和网络，或先把仓库下载到本地再用 -Repo <本地目录>。"
      }
    }
    return $cloneDir
  }
  $p = $Spec
  if (-not [System.IO.Path]::IsPathRooted($p)) { $p = Join-Path (Get-Location).Path $p }
  return [System.IO.Path]::GetFullPath($p).TrimEnd('\', '/')
}

function Assert-PluginManifest([string]$Root) {
  $manifest = Join-Path $Root 'plugin\package.json'
  if (-not (Test-Path -LiteralPath $manifest)) {
    throw "这个目录不像「随手问」仓库：找不到 plugin\package.json（看的路径是 $Root）。请用 -Repo 指向仓库根目录，里面应当有 plugin\ 和 extension\。"
  }
  $pkg = (Read-Utf8 $manifest) | ConvertFrom-Json
  if ([string]$pkg.name -ne $PluginName) {
    throw "plugin\package.json 里的包名是「$($pkg.name)」，不是 $PluginName。这个仓库的 plugin 目录可能被换过，先别装。"
  }
  return $manifest
}

# ── package.json：加依赖（文本编辑，保留原缩进） ──────────────────────────

function Set-Dependency([string]$Path, [string]$Value) {
  $text = Read-Utf8 $Path
  $nl = Get-Newline $text
  $unit = Get-IndentUnit $text

  $m = [regex]::Match($text, '"dependencies"\s*:\s*\{')
  if (-not $m.Success) {
    throw "profile 的 package.json 里没有 ""dependencies"" 这一段，没法加依赖。请先让 DSH 生成/修好这个文件。"
  }
  $openIdx = $m.Index + $m.Length - 1
  $closeIdx = Find-MatchingBrace $text $openIdx
  if ($closeIdx -lt 0) { throw 'profile 的 package.json 括号不配对，先别改它，检查一下文件。' }

  $before = $text.Substring(0, $openIdx + 1)
  $inside = $text.Substring($openIdx + 1, $closeIdx - $openIdx - 1)
  $after = $text.Substring($closeIdx)

  # 已有这个 key 吗？
  $keyRx = '"@pydsl/dsh-page-chat"\s*:\s*"([^"]*)"'
  if ([regex]::IsMatch($inside, $keyRx)) {
    $old = [regex]::Match($inside, $keyRx).Groups[1].Value
    if ($old -eq $Value) {
      Write-Host '  依赖已存在且指向同一个目录，跳过。'
      return 'skip'
    }
    $insideNew = [regex]::Replace($inside, $keyRx, {
      param($mm)
      return '"@pydsl/dsh-page-chat": "' + $Value + '"'
    })
    Write-Utf8Preserve $Path ($before + $insideNew + $after)
    Write-Host "  依赖已更新：$old -> $Value"
    return 'update'
  }

  # 行首缩进：dependencies 这一行自己的缩进
  $lineStart = $text.LastIndexOf("`n", [Math]::Max(0, $m.Index - 1))
  $depsLine = $text.Substring($lineStart + 1, $m.Index - $lineStart - 1)
  $depsIndent = ([regex]::Match($depsLine, '^[ \t]*')).Value
  $entryIndent = $depsIndent + $unit
  $entry = $entryIndent + '"@pydsl/dsh-page-chat": "' + $Value + '"'

  if ($inside.Trim() -eq '') {
    # 空对象 {} -> 展开成多行
    $newInside = $nl + $entry + $nl + $depsIndent
    Write-Utf8Preserve $Path ($before + $newInside + $after)
  } else {
    # 非空：插在 { 后面，自带逗号，原有条目不用动
    $newInside = $nl + $entry + ','
    Write-Utf8Preserve $Path ($before + $newInside + $inside + $after)
  }
  Write-Host "  依赖已写入：$Value"
  return 'add'
}

function Find-MatchingBrace([string]$Text, [int]$OpenIdx) {
  $depth = 0
  $inString = $false
  $escaped = $false
  for ($i = $OpenIdx; $i -lt $Text.Length; $i++) {
    $c = $Text[$i]
    if ($inString) {
      if ($escaped) { $escaped = $false }
      elseif ($c -eq '\') { $escaped = $true }
      elseif ($c -eq '"') { $inString = $false }
      continue
    }
    if ($c -eq '"') { $inString = $true; continue }
    if ($c -eq '{') { $depth++ }
    elseif ($c -eq '}') {
      $depth--
      if ($depth -eq 0) { return $i }
    }
  }
  return -1
}

function Remove-Dependency([string]$Path) {
  $text = Read-Utf8 $Path
  if (-not [regex]::IsMatch($text, '"@pydsl/dsh-page-chat"')) {
    Write-Host '  依赖本来就不在，跳过。'
    return 'skip'
  }
  $nl = Get-Newline $text
  $lines = New-Object System.Collections.Generic.List[string]
  foreach ($l in ($text -split "`r?`n")) { $lines.Add($l) }
  $idx = -1
  for ($i = 0; $i -lt $lines.Count; $i++) {
    if ($lines[$i] -match '^\s*"@pydsl/dsh-page-chat"\s*:\s*"[^"]*"\s*,?\s*$') { $idx = $i; break }
  }
  if ($idx -lt 0) {
    throw 'package.json 里提到了这个依赖，但不是单独一行的写法，脚本不敢猜。请手工删掉那一行。'
  }
  if ($lines[$idx].TrimEnd().EndsWith(',')) {
    $lines.RemoveAt($idx)
  } else {
    # 最后一条没有逗号：删掉它，再把上一条的尾逗号去掉
    $lines.RemoveAt($idx)
    for ($k = $idx - 1; $k -ge 0; $k--) {
      if ($lines[$k].Trim() -ne '') { $lines[$k] = ($lines[$k] -replace ',\s*$', ''); break }
    }
  }
  $new = $lines -join $nl
  $new = [regex]::Replace($new, '"dependencies"\s*:\s*\{\s*\}', '"dependencies": {}')
  try {
    $null = $new | ConvertFrom-Json
  } catch {
    throw '删除依赖后 package.json 不再是合法 JSON，已停下（没写盘）。请把文件发我看看。'
  }
  Write-Utf8Preserve $Path $new
  Write-Host '  依赖已移除。'
  return 'remove'
}
# ── 目录联接（junction） ─────────────────────────────────────────────────

function Get-JunctionState([string]$LinkPath, [string]$TargetPath) {
  if (-not (Test-Path -LiteralPath $LinkPath)) { return 'missing' }
  $item = Get-Item -LiteralPath $LinkPath -Force
  if ($item.LinkType -ne 'Junction' -and $item.LinkType -ne 'SymbolicLink') { return 'other' }
  $target = @($item.Target)[0]
  if ([string]::IsNullOrEmpty($target)) { return 'other' }
  $a = [System.IO.Path]::GetFullPath($target).TrimEnd('\', '/')
  $b = [System.IO.Path]::GetFullPath($TargetPath).TrimEnd('\', '/')
  if ($a -ieq $b) { return 'same' }
  return 'diff:' + $target
}

# ── cordis.patch.yml ─────────────────────────────────────────────────────

function Test-PageChatInPatch([string]$Text) {
  if ([regex]::IsMatch($Text, '(?m)^\s*-\s*id:\s*page-chat\s*$')) { return $true }
  if ([regex]::IsMatch($Text, "(?m)^\s*name:\s*'@pydsl/dsh-page-chat'\s*$")) { return $true }
  return $false
}

function New-PatchBlock([string]$Nl, [string]$MemoryValue) {
  $lines = @(
    '- insert:',
    '    - id: page-chat',
    "      name: '@pydsl/dsh-page-chat'",
    '      config:',
    ('        memoryDir: ' + $MemoryValue),
    '        maxTurns: 20'
  )
  return ($lines -join $Nl)
}

function Add-PatchBlock([string]$Path, [string]$MemoryValue) {
  $text = Read-Utf8 $Path
  $nl = Get-Newline $text
  if (Test-PageChatInPatch $text) {
    Write-Host '  cordis.patch.yml 里已经有 page-chat，跳过。'
    return 'skip'
  }
  $block = New-PatchBlock $nl $MemoryValue
  $trimmed = $text.Trim()
  if ($trimmed -eq '' -or $trimmed -eq '[]') {
    $new = $block + $nl
  } else {
    $new = $text
    if (-not $new.EndsWith("`n")) { $new += $nl }
    if (-not $new.EndsWith($nl + $nl)) { $new += $nl }   # 段前留一个空行
    $new += $block + $nl
  }
  Write-Utf8Preserve $Path $new
  Write-Host '  cordis.patch.yml 已追加 page-chat 段。'
  return 'add'
}

function Remove-PatchBlock([string]$Path) {
  $text = Read-Utf8 $Path
  if (-not (Test-PageChatInPatch $text)) {
    Write-Host '  cordis.patch.yml 里本来就没有 page-chat，跳过。'
    return 'skip'
  }
  $nl = Get-Newline $text
  $lines = New-Object System.Collections.Generic.List[string]
  foreach ($l in ($text -split "`r?`n")) { $lines.Add($l) }

  # 找到 page-chat 的那一项
  $idx = -1
  for ($i = 0; $i -lt $lines.Count; $i++) {
    if ($lines[$i] -match '^\s*-\s*id:\s*page-chat\s*$' -or $lines[$i] -match "^\s*-\s*name:\s*'@pydsl/dsh-page-chat'\s*$") { $idx = $i; break }
  }
  if ($idx -lt 0) { return 'skip' }

  $itemIndent = ([regex]::Match($lines[$idx], '^[ \t]*')).Value.Length
  $end = $idx
  for ($j = $idx + 1; $j -lt $lines.Count; $j++) {
    if ($lines[$j].Trim() -eq '') { break }
    $ind = ([regex]::Match($lines[$j], '^[ \t]*')).Value.Length
    if ($ind -le $itemIndent) { break }
    $end = $j
  }
  $lines.RemoveRange($idx, ($end - $idx + 1))

  # 如果 insert 头下面已经没有任何条目了，连头一起删掉
  for ($i = 0; $i -lt $lines.Count; $i++) {
    if ($lines[$i] -notmatch '^\s*-\s*insert:\s*$') { continue }
    $headerIndent = ([regex]::Match($lines[$i], '^[ \t]*')).Value.Length
    $next = -1
    for ($j = $i + 1; $j -lt $lines.Count; $j++) {
      if ($lines[$j].Trim() -eq '') { continue }
      $next = $j
      break
    }
    $hasItem = $false
    if ($next -ge 0) {
      $nextIndent = ([regex]::Match($lines[$next], '^[ \t]*')).Value.Length
      if ($nextIndent -gt $headerIndent -and $lines[$next] -match '^\s*-\s') { $hasItem = $true }
    }
    if (-not $hasItem) {
      $lines.RemoveAt($i)
      $i--
    }
  }

  Write-Utf8Preserve $Path ($lines -join $nl)
  Write-Host '  cordis.patch.yml 里的 page-chat 段已移除。'
  return 'remove'
}

# ── 验收 / 重启 ──────────────────────────────────────────────────────────

function Get-PageChatHealth([int]$TimeoutSec = 3) {
  $url = 'http://127.0.0.1:3080/page-chat/health'
  try {
    $req = @{ Uri = $url; UseBasicParsing = $true; TimeoutSec = $TimeoutSec }
    if ($PSVersionTable.PSVersion.Major -lt 6) {
      [System.Net.ServicePointManager]::ServerCertificateValidationCallback = { $true }
    } else {
      $req['SkipCertificateCheck'] = $true
    }
    $resp = Invoke-WebRequest @req
    $body = [string]$resp.Content
    $json = $null
    try { $json = $body | ConvertFrom-Json } catch { }
    return @{ Status = [int]$resp.StatusCode; Body = $body; Json = $json; Error = '' }
  } catch {
    return @{ Status = 0; Body = ''; Json = $null; Error = $_.Exception.Message }
  }
}

function Test-DshRootAlive {
  try {
    $req = @{ Uri = 'http://127.0.0.1:3080/'; UseBasicParsing = $true; TimeoutSec = 2; MaximumRedirection = 0 }
    if ($PSVersionTable.PSVersion.Major -lt 6) {
      [System.Net.ServicePointManager]::ServerCertificateValidationCallback = { $true }
    } else {
      $req['SkipCertificateCheck'] = $true
    }
    $null = Invoke-WebRequest @req
    return $true
  } catch {
    # 401/302 之类也算「服务在」
    if ($_.Exception.Response -ne $null) { return $true }
    return $false
  }
}

function Show-Health([string]$Prefix) {
  $h = Get-PageChatHealth
  if ($h.Status -eq 200 -and $h.Json -ne $null) {
    Write-Host ("  {0} /page-chat/health -> ok={1} dshReady={2} version={3}" -f $Prefix, $h.Json.ok, $h.Json.dshReady, $h.Json.version)
    return $true
  }
  if ($h.Status -eq 0) {
    Write-Host ("  {0} /page-chat/health 连不上：{1}" -f $Prefix, $h.Error)
  } else {
    Write-Host ("  {0} /page-chat/health -> HTTP {1}" -f $Prefix, $h.Status)
  }
  return $false
}

function Restart-DshWeb {
  # 先看插件是不是已经在跑了；在跑就不折腾。
  $h = Get-PageChatHealth
  if ($h.Status -eq 200) {
    Write-Host '  插件已经在运行，不用重启。'
    return 'already'
  }
  if (-not (Test-DshRootAlive)) {
    Write-Host '  DSH 本体没在跑（3080 端口连不上）。'
    Write-Host '  下一步：先运行  dsh web  然后重开这个脚本（或者直接手工验证 health）。'
    return 'not-running'
  }

  # 本机如果有可靠的重启脚本，就交给它：延迟 + 脱离进程树，避免把当前会话一起杀掉。
  $restartScript = Join-Path $env:USERPROFILE '.dsh\skills\restart-dsh\scripts\restart-dsh-web.ps1'
  if (Test-Path -LiteralPath $restartScript) {
    $psExe = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    if (-not (Test-Path -LiteralPath $psExe)) { $psExe = 'powershell.exe' }
    Start-Process -FilePath $psExe -WindowStyle Hidden -ArgumentList @(
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ('"' + $restartScript + '"'),
      '-Detached', '-DelaySeconds', '120', '-NoOpen'
    )
    Write-Host '  已安排 120 秒后重启 dsh web（脱离当前进程，不会打断这次回答）。'
    Write-Host '  两分钟后重新访问 health 确认；这次先不自动等。'
    return 'scheduled'
  }

  # 公共仓库里不带本机专用的重启脚本：不替用户乱杀进程，给一句人话 + 命令。
  Write-Host '  DSH 在跑，但新插件要重启才生效。这里不替你杀进程（怕误伤别的 node）。'
  Write-Host '  下一步：关掉当前 dsh web 的窗口，重新运行  dsh web  即可。'
  return 'manual'
}

# ── 主流程 ────────────────────────────────────────────────────────────────

try {
  Write-Host ''
  Write-Host '随手问 · 后端插件安装'
  Write-Host '────────────────────'

  if ([string]::IsNullOrWhiteSpace($DshHome)) {
    $DshHome = Join-Path $env:USERPROFILE '.dsh'
  }
  $DshHome = [System.IO.Path]::GetFullPath($DshHome).TrimEnd('\', '/')
  if (-not (Test-Path -LiteralPath $DshHome)) {
    throw "找不到 DSH 家目录：$DshHome 。DSH 还没装过？先装 DSH 并运行一次 dsh web，或用 -DshHome 指向正确的位置。"
  }

  Write-Host "[1/5] 定位仓库"
  $repoRoot = Resolve-RepoRoot $Repo
  $null = Assert-PluginManifest $repoRoot
  $pluginPath = [System.IO.Path]::GetFullPath((Join-Path $repoRoot 'plugin')).TrimEnd('\', '/')
  Write-Host "  仓库：$repoRoot"
  Write-Host "  插件：$pluginPath"

  $profileDir = Join-Path (Join-Path $DshHome 'profiles') $Profile
  Write-Host "[2/5] 检查 profile"
  if (-not (Test-Path -LiteralPath $profileDir)) {
    throw "profile「$Profile」不存在：$profileDir 。这个目录应当由 DSH 自己创建；先运行  dsh web  一次，或用 -Profile 指定已有的 profile。"
  }
  $pkgPath = Join-Path $profileDir 'package.json'
  $patchPath = Join-Path $profileDir 'cordis.patch.yml'
  if (-not (Test-Path -LiteralPath $pkgPath)) {
    throw "profile 里没有 package.json：$pkgPath 。先让 DSH 正常启动一次再来装。"
  }
  Write-Host "  profile：$profileDir"

  $depValue = 'file:' + (Normalize-PathSlash $pluginPath)
  $memoryValue = "!!js dshHomePath('page-chat-memory')"
  if (-not [string]::IsNullOrWhiteSpace($MemoryDir)) {
    $md = [System.IO.Path]::GetFullPath($MemoryDir).TrimEnd('\', '/')
    $memoryValue = "'" + (Normalize-PathSlash $md) + "'"
  }

  $linkDir = Join-Path $profileDir 'node_modules\@pydsl'
  $linkPath = Join-Path $linkDir 'dsh-page-chat'

  $depBefore = Get-FileHashSafe $pkgPath
  $patchBefore = Get-FileHashSafe $patchPath

  if ($DryRun) {
    Write-Host ''
    Write-Host '[DryRun] 不会写任何文件。将要做的事：'
    $cur = [regex]::Match((Read-Utf8 $pkgPath), '"@pydsl/dsh-page-chat"\s*:\s*"([^"]*)"')
    if ($cur.Success) {
      if ($cur.Groups[1].Value -eq $depValue) { Write-Host '  - package.json：依赖已存在，会跳过' }
      else { Write-Host ("  - package.json：把依赖从 " + $cur.Groups[1].Value + " 改成 " + $depValue) }
    } else {
      Write-Host "  - package.json：新增依赖 $depValue"
    }
    $state = Get-JunctionState $linkPath $pluginPath
    switch -Regex ($state) {
      '^missing$'  { Write-Host "  - 目录联接：新建 $linkPath -> $pluginPath" }
      '^same$'     { Write-Host '  - 目录联接：已存在且指向正确，会跳过' }
      '^diff:'     { Write-Host ("  - 目录联接：已存在但指向 " + $state.Substring(5) + "，会报错让你先删") }
      default      { Write-Host "  - 目录联接：$linkPath 已存在但不是联接，会报错" }
    }
    if (Test-PageChatInPatch (Read-Utf8 $patchPath)) { Write-Host '  - cordis.patch.yml：已有 page-chat，会跳过' }
    else { Write-Host '  - cordis.patch.yml：追加 page-chat 段' }
    if ($NoRestart) { Write-Host '  - 重启：-NoRestart，不重启' } else { Write-Host '  - 重启：检查 health，必要时重启（或提示你手动重启）' }
    Write-Host ''
    Write-Host '[DryRun] 结束，什么都没改。'
    exit 0
  }

  Write-Host "[3/5] 备份现有文件"
  $stamp = Get-Date -Format 'yyyyMMddHHmmss'
  $backupDir = Join-Path $DshHome ('.backup-page-chat-' + $stamp)
  Backup-Into $backupDir $pkgPath
  Backup-Into $backupDir $patchPath
  Write-Host "  备份：$backupDir"

  Write-Host "[4/5] 写依赖 / 建联接 / 加 patch"
  $depResult = Set-Dependency $pkgPath $depValue

  $state = Get-JunctionState $linkPath $pluginPath
  if ($state -eq 'missing') {
    if (-not (Test-Path -LiteralPath $linkDir)) { New-Item -ItemType Directory -Force -Path $linkDir | Out-Null }
    New-Item -ItemType Junction -Path $linkPath -Target $pluginPath | Out-Null
    Write-Host "  目录联接已建立 -> $pluginPath"
  } elseif ($state -eq 'same') {
    Write-Host '  目录联接已存在且指向正确，跳过。'
  } elseif ($state -eq 'diff:') {
    throw "目录联接已存在但指向别处：" + $state.Substring(5) + "。请先删掉 $linkPath 再重跑（它可能是别的版本的插件）。"
  } else {
    throw "$linkPath 已存在，但不是目录联接（可能是普通目录）。请先删掉它再重跑，免得覆盖你已有的插件。"
  }

  if (Test-Path -LiteralPath $patchPath) {
    $null = Add-PatchBlock $patchPath $memoryValue
  } else {
    $nl = "`n"
    [System.IO.File]::WriteAllText($patchPath, (New-PatchBlock $nl $memoryValue) + $nl, (New-Object System.Text.UTF8Encoding($false)))
    Write-Host '  cordis.patch.yml 原来不存在，已新建并写入 page-chat 段。'
  }

  Write-Host "[5/5] 重启与验收"
  $restart = 'skipped'
  if ($NoRestart) {
    Write-Host '  -NoRestart：不重启。'
  } else {
    $restart = Restart-DshWeb
  }

  $healthOk = Show-Health '当前'

  Write-Host ''
  if ($healthOk) {
    Write-Host '装好了：插件已经在跑，health 正常。'
  } else {
    Write-Host '文件都装好了，但插件还没在跑（多半是没重启）。'
  }

  Write-Host ''
  Write-Host '下一步：装浏览器扩展'
  Write-Host "  Chrome / Edge / Brave：打开 chrome://extensions -> 开发者模式 -> 加载已解压的扩展程序 -> 选 $repoRoot\extension"
  Write-Host '  Firefox / Zen：先在仓库根目录运行  node build-firefox.mjs ，再打开 about:debugging#/runtime/this-firefox -> 临时载入附加组件 -> 选 _dist-firefox\manifest.json'
  Write-Host ''
  Write-Host '怎么确认整条链路：普通网页里选中两个字以上，选区右下角出现「随手问」小浮标，点开能收到回答。'
  Write-Host ''
  Write-Host ('卸载：powershell -ExecutionPolicy Bypass -File ' + (Join-Path $PSScriptRoot 'uninstall.ps1'))
  if ($backupDir) { Write-Host ('备份目录（出问题从这里拷回）：' + $backupDir) }
  Write-Host ''
  exit 0
}
catch {
  Write-Host ''
  Write-Host ('安装失败：' + $_.Exception.Message) -ForegroundColor Red
  if ($backupDir) { Write-Host ('已做的改动可以从这里拷回：' + $backupDir) -ForegroundColor Yellow }
  exit 1
}
