<#
.SYNOPSIS
  把「随手问」打成交给用户的安装包：Firefox 家族用 .xpi，Chromium 家族用 .zip。

.DESCRIPTION
  产出两个文件（版本号取自 extension\manifest.json）：
    dist\suishouwen-<版本>-firefox.xpi   —— 里面的 manifest 是 MV2（Zen / Firefox / LibreWolf / Waterfox）
    dist\suishouwen-<版本>-chrome.zip    —— 解压后用「加载已解压的扩展程序」装（Chrome / Edge / Brave / Vivaldi）

  注意：稳定版 Chrome 会拒绝自签名的 .crx（CRX_REQUIRED_PROOF_MISSING），
  Firefox 正式版/Zen 会拒绝未签名的 .xpi。想「点一下就装」必须先过 Mozilla 的 AMO 未上架签名。
  这个脚本只管打包，不签名。

.EXAMPLE
  pwsh -NoProfile -File scripts\package-extension.ps1
#>
[CmdletBinding()]
param(
  [string]$Repo = (Split-Path -Parent $PSScriptRoot),
  [string]$OutDir = ''
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem | Out-Null

$Repo = (Resolve-Path -LiteralPath $Repo).Path
if (-not $OutDir) { $OutDir = Join-Path $Repo 'dist' }

$extDir = Join-Path $Repo 'extension'
if (-not (Test-Path -LiteralPath $extDir)) { throw "找不到扩展目录：$extDir" }

$manifestPath = Join-Path $extDir 'manifest.json'
if (-not (Test-Path -LiteralPath $manifestPath)) { throw "找不到 $manifestPath" }
$manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
$version = $manifest.version
if (-not $version) { throw 'manifest.json 里没有 version' }

Write-Host "打包 随手问 $version" -ForegroundColor Cyan

# 1) 先重组火狐包（MV2）
$build = Join-Path $Repo 'build-firefox.mjs'
if (Test-Path -LiteralPath $build) {
  Write-Host '→ 组装 _dist-firefox'
  Push-Location $Repo
  try { & node $build | Out-Null } finally { Pop-Location }
  if ($LASTEXITCODE -ne 0) { throw "build-firefox.mjs 失败（exit $LASTEXITCODE）" }
}

$ffDir = Join-Path $Repo '_dist-firefox'
if (-not (Test-Path -LiteralPath $ffDir)) { throw "找不到 $ffDir" }
$ffManifest = Join-Path $ffDir 'manifest.json'
if (-not (Test-Path -LiteralPath $ffManifest)) { throw "火狐包里没有 manifest.json：$ffManifest" }
$ff = Get-Content -LiteralPath $ffManifest -Raw | ConvertFrom-Json
if ($ff.manifest_version -ne 2) { throw "_dist-firefox\manifest.json 不是 MV2（读到 $($ff.manifest_version)）" }

New-Item -ItemType Directory -Force -Path $OutDir | Out-Null

function New-ZipFromDir {
  param([string]$Source, [string]$Destination)
  if (Test-Path -LiteralPath $Destination) { Remove-Item -LiteralPath $Destination -Force }
  [System.IO.Compression.ZipFile]::CreateFromDirectory(
    $Source,
    $Destination,
    [System.IO.Compression.CompressionLevel]::Optimal,
    $false   # 不要在压缩包里多套一层目录
  ) | Out-Null
}

$xpi = Join-Path $OutDir "suishouwen-$version-firefox.xpi"
$zip = Join-Path $OutDir "suishouwen-$version-chrome.zip"

Write-Host '→ 打 Firefox / Zen 包（.xpi，MV2）'
New-ZipFromDir -Source $ffDir -Destination $xpi

Write-Host '→ 打 Chromium 包（.zip，MV3）'
New-ZipFromDir -Source $extDir -Destination $zip

# 2) 自检：包内根目录必须有 manifest.json，且版本一致
Add-Type -AssemblyName System.IO.Compression
foreach ($pkg in @(
    @{ Path = $xpi; ExpectMv = 2; Label = 'xpi' },
    @{ Path = $zip; ExpectMv = 3; Label = 'zip' }
  )) {
  $archive = [System.IO.Compression.ZipFile]::OpenRead($pkg.Path)
  try {
    $rootManifest = $archive.Entries | Where-Object { $_.FullName -eq 'manifest.json' }
    if (-not $rootManifest) { throw "$($pkg.Label) 的根目录没有 manifest.json（可能多套了一层目录）" }
    $reader = New-Object System.IO.StreamReader($rootManifest.Open())
    try { $inner = $reader.ReadToEnd() | ConvertFrom-Json } finally { $reader.Dispose() }
    if ($inner.version -ne $version) { throw "$($pkg.Label) 里版本是 $($inner.version)，期望 $version" }
    if ($inner.manifest_version -ne $pkg.ExpectMv) { throw "$($pkg.Label) 的 manifest_version 是 $($inner.manifest_version)，期望 $($pkg.ExpectMv)" }
    $entryCount = $archive.Entries.Count
  } finally {
    $archive.Dispose()
  }
  $sizeKb = [math]::Round((Get-Item -LiteralPath $pkg.Path).Length / 1KB, 1)
  Write-Host ("  ✓ {0}  {1} KB, {2} 个文件" -f (Split-Path -Leaf $pkg.Path), $sizeKb, $entryCount) -ForegroundColor Green
}

# 3) 校验和
$sums = Join-Path $OutDir 'SHA256SUMS.txt'
$lines = @()
foreach ($f in @($xpi, $zip)) {
  $h = (Get-FileHash -LiteralPath $f -Algorithm SHA256).Hash.ToLower()
  $lines += "$h  $(Split-Path -Leaf $f)"
}
Set-Content -LiteralPath $sums -Value ($lines -join "`n") -Encoding utf8NoBOM
Write-Host "校验和写入 $(Split-Path -Leaf $sums)"

Write-Host ''
Write-Host '完成。两个包：' -ForegroundColor Cyan
Write-Host "  $xpi"
Write-Host "  $zip"
Write-Host ''
Write-Host '怎么装：' -ForegroundColor Cyan
Write-Host '  Firefox / Zen：未签名包只能在 临时载入 / 开发者版；正式版请先用 AMO 未上架签名，拿到签名后的 .xpi 再「从文件安装」。'
Write-Host '  Chrome / Edge：解压 zip → 打开 chrome://extensions → 开开发者模式 → 加载已解压的扩展程序 → 选中解压出的文件夹。'
Write-Host '  自签名 .crx 被稳定版 Chrome 拒绝（CRX_REQUIRED_PROOF_MISSING），所以不给 crx。'
