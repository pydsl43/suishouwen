#requires -Version 5.1
<#
  uninstall.ps1 — 把「随手问」的后端插件从 DSH 里清干净。

  反向做三件事（都可重复跑）：
    1. 删 <Profile>\node_modules\@pydsl\dsh-page-chat 目录联接
       （只删指向 <仓库>\plugin 的那一个；指向别处的不动，会提示你自己确认）
    2. 从 <Profile>\package.json 的 dependencies 里去掉 "@pydsl/dsh-page-chat"
    3. 从 <Profile>\cordis.patch.yml 里删掉 page-chat 那一段
       （只删这一段，别的插件段和注释都不动）

  记忆目录**不删**，只在结尾告诉你路径。

  用法：
    powershell -ExecutionPolicy Bypass -File .\scripts\uninstall.ps1
    powershell -ExecutionPolicy Bypass -File .\scripts\uninstall.ps1 -DryRun
    powershell -ExecutionPolicy Bypass -File .\scripts\uninstall.ps1 -DshHome D:\tmp\dsh -Profile web

  本文件是 UTF-8 带 BOM 保存的，这样 Windows PowerShell 5.1 也能正确读中文。
#>

[CmdletBinding()]
param(
  [string]$DshHome = '',
  [string]$Profile = 'web',
  [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
$PluginName = '@pydsl/dsh-page-chat'
$backupDir = $null

# ── 小工具（与 install.ps1 同一套约定） ──────────────────────────────────

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

function Normalize-PathSlash([string]$Path) {
  return ($Path -replace '\\', '/')
}

function Backup-Into([string]$Dir, [string]$Path) {
  if (-not (Test-Path -LiteralPath $Path)) { return }
  if (-not (Test-Path -LiteralPath $Dir)) { New-Item -ItemType Directory -Force -Path $Dir | Out-Null }
  $name = [System.IO.Path]::GetFileName($Path)
  Copy-Item -LiteralPath $Path -Destination (Join-Path $Dir $name) -Force
}

function Get-JunctionTarget([string]$LinkPath) {
  if (-not (Test-Path -LiteralPath $LinkPath)) { return '' }
  $item = Get-Item -LiteralPath $LinkPath -Force
  if ($item.LinkType -ne 'Junction' -and $item.LinkType -ne 'SymbolicLink') { return '<not-a-link>' }
  $target = @($item.Target)[0]
  if ([string]::IsNullOrEmpty($target)) { return '<no-target>' }
  return [System.IO.Path]::GetFullPath($target).TrimEnd('\', '/')
}

# ── package.json：去掉依赖 ───────────────────────────────────────────────

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
# ── cordis.patch.yml：只删 page-chat 那一段 ─────────────────────────────

function Test-PageChatInPatch([string]$Text) {
  if ([regex]::IsMatch($Text, '(?m)^\s*-\s*id:\s*page-chat\s*$')) { return $true }
  if ([regex]::IsMatch($Text, "(?m)^\s*name:\s*'@pydsl/dsh-page-chat'\s*$")) { return $true }
  return $false
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

  $idx = -1
  for ($i = 0; $i -lt $lines.Count; $i++) {
    if ($lines[$i] -match '^\s*-\s*id:\s*page-chat\s*$' -or $lines[$i] -match "^\s*-\s*name:\s*'@pydsl/dsh-page-chat'\s*$") { $idx = $i; break }
  }
  if ($idx -lt 0) {
    Write-Host '  找到了 page-chat 的影子但没定位到条目，跳过（没动文件）。'
    return 'skip'
  }

  $itemIndent = ([regex]::Match($lines[$idx], '^[ \t]*')).Value.Length
  $end = $idx
  for ($j = $idx + 1; $j -lt $lines.Count; $j++) {
    if ($lines[$j].Trim() -eq '') { break }
    $ind = ([regex]::Match($lines[$j], '^[ \t]*')).Value.Length
    if ($ind -le $itemIndent) { break }
    $end = $j
  }
  $lines.RemoveRange($idx, ($end - $idx + 1))

  # insert 头下面空了就把头一起删，别留个空 insert
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
  Write-Host '  cordis.patch.yml 里的 page-chat 段已移除（别的段没动）。'
  return 'remove'
}

function Get-MemoryDirHint([string]$PatchPath) {
  if (-not (Test-Path -LiteralPath $PatchPath)) { return '' }
  $text = Read-Utf8 $PatchPath
  $m = [regex]::Match($text, "memoryDir:\s*!!js\s+dshHomePath\('([^']*)'\)")
  if ($m.Success) { return $m.Groups[1].Value }
  $m2 = [regex]::Match($text, "memoryDir:\s*'([^']*)'")
  if ($m2.Success) { return $m2.Groups[1].Value }
  return ''
}

# ── 主流程 ────────────────────────────────────────────────────────────────

try {
  Write-Host ''
  Write-Host '随手问 · 后端插件卸载'
  Write-Host '────────────────────'

  if ([string]::IsNullOrWhiteSpace($DshHome)) {
    $DshHome = Join-Path $env:USERPROFILE '.dsh'
  }
  $DshHome = [System.IO.Path]::GetFullPath($DshHome).TrimEnd('\', '/')
  if (-not (Test-Path -LiteralPath $DshHome)) {
    throw "找不到 DSH 家目录：$DshHome 。用 -DshHome 指向正确的位置再试。"
  }

  $profileDir = Join-Path (Join-Path $DshHome 'profiles') $Profile
  if (-not (Test-Path -LiteralPath $profileDir)) {
    throw "profile「$Profile」不存在：$profileDir 。用 -Profile 指定正确的 profile 再试。"
  }
  $pkgPath = Join-Path $profileDir 'package.json'
  $patchPath = Join-Path $profileDir 'cordis.patch.yml'
  $linkPath = Join-Path $profileDir 'node_modules\@pydsl\dsh-page-chat'
  $linkDir = Join-Path $profileDir 'node_modules\@pydsl'
  Write-Host "  profile：$profileDir"

  # 期望的联接目标：优先看依赖里写的，其次看脚本所在的仓库
  $expected = ''
  if (Test-Path -LiteralPath $pkgPath) {
    $m = [regex]::Match((Read-Utf8 $pkgPath), '"@pydsl/dsh-page-chat"\s*:\s*"file:([^"]*)"')
    if ($m.Success) {
      $expected = [System.IO.Path]::GetFullPath(($m.Groups[1].Value -replace '/', '\')).TrimEnd('\', '/')
    }
  }
  if ([string]::IsNullOrWhiteSpace($expected)) {
    $repoGuess = Split-Path -Parent $PSScriptRoot
    $expected = [System.IO.Path]::GetFullPath((Join-Path $repoGuess 'plugin')).TrimEnd('\', '/')
  }
  $linkTarget = Get-JunctionTarget $linkPath

  $memoryHint = Get-MemoryDirHint $patchPath

  if ($DryRun) {
    Write-Host ''
    Write-Host '[DryRun] 不会写任何文件。将要做的事：'
    if ($linkTarget -eq '') { Write-Host '  - 目录联接：不存在，跳过' }
    elseif ($linkTarget -eq $expected) { Write-Host "  - 目录联接：删除 $linkPath（指向 $linkTarget）" }
    elseif ($linkTarget -eq '<not-a-link>' -or $linkTarget -eq '<no-target>') { Write-Host "  - 目录联接：$linkPath 不是联接 / 没目标，会跳过（需要你自己确认）" }
    else { Write-Host "  - 目录联接：指向 $linkTarget，与预期的 $expected 不一致，会跳过（不动别人的联接）" }

    if ((Test-Path -LiteralPath $pkgPath) -and [regex]::IsMatch((Read-Utf8 $pkgPath), '"@pydsl/dsh-page-chat"')) {
      Write-Host '  - package.json：移除依赖'
    } else { Write-Host '  - package.json：依赖不在，跳过' }

    if ((Test-Path -LiteralPath $patchPath) -and (Test-PageChatInPatch (Read-Utf8 $patchPath))) {
      Write-Host '  - cordis.patch.yml：删除 page-chat 段'
    } else { Write-Host '  - cordis.patch.yml：没有 page-chat 段，跳过' }
    Write-Host '  - 记忆目录：不删'
    Write-Host ''
    Write-Host '[DryRun] 结束，什么都没改。'
    exit 0
  }

  Write-Host '[1/4] 备份现有文件'
  $stamp = Get-Date -Format 'yyyyMMddHHmmss'
  $backupDir = Join-Path $DshHome ('.backup-page-chat-uninstall-' + $stamp)
  Backup-Into $backupDir $pkgPath
  Backup-Into $backupDir $patchPath
  Write-Host "  备份：$backupDir"

  Write-Host '[2/4] 删目录联接'
  if ($linkTarget -eq '') {
    Write-Host '  目录联接不在，跳过。'
  } elseif ($linkTarget -eq '<not-a-link>' -or $linkTarget -eq '<no-target>') {
    Write-Host "  $linkPath 不是目录联接（或没目标），不动它。如果确定要删，手工删这个目录。" -ForegroundColor Yellow
  } elseif ($linkTarget -eq $expected) {
    # junction 只删联接本身，不动目标目录里的内容
    $item = Get-Item -LiteralPath $linkPath -Force
    [System.IO.Directory]::Delete($linkPath, $false)
    Write-Host "  目录联接已删除（插件源目录 $linkTarget 没动）。"
  } else {
    Write-Host "  目录联接指向 $linkTarget ，和预期的 $expected 不一样，跳过（不删别人的）。" -ForegroundColor Yellow
    Write-Host '  如果你确认这就是要删的那个，手工删它再重跑。'
  }

  Write-Host '[3/4] 摘依赖 / 摘 patch 段'
  if (Test-Path -LiteralPath $pkgPath) { $null = Remove-Dependency $pkgPath } else { Write-Host '  profile 没有 package.json，跳过依赖。' }
  if (Test-Path -LiteralPath $patchPath) { $null = Remove-PatchBlock $patchPath } else { Write-Host '  profile 没有 cordis.patch.yml，跳过 patch。' }

  Write-Host '[4/4] 收尾'
  if (Test-Path -LiteralPath $linkDir) {
    $left = @(Get-ChildItem -LiteralPath $linkDir -Force -ErrorAction SilentlyContinue)
    if ($left.Count -eq 0) {
      Remove-Item -LiteralPath $linkDir -Force
      Write-Host '  空的 @pydsl 目录已顺手删掉。'
    }
  }
  $nmDir = Join-Path $profileDir 'node_modules'
  if (Test-Path -LiteralPath $nmDir) {
    $rest = @(Get-ChildItem -LiteralPath $nmDir -Force -ErrorAction SilentlyContinue)
    if ($rest.Count -eq 0) { Remove-Item -LiteralPath $nmDir -Force; Write-Host '  空的 node_modules 目录已顺手删掉。' }
  }

  Write-Host ''
  Write-Host '卸载完成。插件文件本身留在仓库里没动，想彻底删就删仓库目录。'

  if ($memoryHint -ne '') {
    if ($memoryHint -like '*/*' -or $memoryHint -like '*\*') {
      Write-Host ('记忆目录没删，还在这儿：' + $memoryHint)
    } else {
      Write-Host ('记忆目录没删，还在这儿：' + (Join-Path $DshHome $memoryHint))
    }
  } else {
    Write-Host ('记忆目录没删：通常在 ' + (Join-Path $DshHome 'page-chat-memory'))
  }
  Write-Host ''
  Write-Host '要让它立刻从 DSH 里消失：关掉当前 dsh web 的窗口，重新运行  dsh web 。'
  if ($backupDir) { Write-Host ('备份目录（想恢复从这里拷回）：' + $backupDir) }
  Write-Host ''
  exit 0
}
catch {
  Write-Host ''
  Write-Host ('卸载失败：' + $_.Exception.Message) -ForegroundColor Red
  if ($backupDir) { Write-Host ('已做的改动可以从这里拷回：' + $backupDir) -ForegroundColor Yellow }
  exit 1
}
