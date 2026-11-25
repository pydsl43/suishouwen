<#
.SYNOPSIS
  把「随手问」的 Firefox 包交给 Mozilla 签名（未上架渠道），产出可以直接双击安装的 .xpi。

.DESCRIPTION
  只有签过名的 .xpi 才能装进 Firefox / Zen 正式版；未上架（unlisted）渠道免费、不上架商店，
  只是让 Mozilla 自动扫描一遍并签个名。

  凭据不写在脚本里：从参数或环境变量拿。
    AMO_JWT_ISSUER        形如 user:12345678:90
    AMO_JWT_SECRET_FILE   存 secret 的文本文件路径（一行，无空格）

.EXAMPLE
  $env:AMO_JWT_ISSUER = 'user:20356692:633'
  $env:AMO_JWT_SECRET_FILE = 'D:\workspace\dsh-ops\tmp\amo\secret.txt'
  pwsh -NoProfile -File scripts\sign-firefox.ps1
#>
[CmdletBinding()]
param(
  [string]$Repo = (Split-Path -Parent $PSScriptRoot),
  [string]$Issuer = $env:AMO_JWT_ISSUER,
  [string]$SecretFile = $env:AMO_JWT_SECRET_FILE,
  [string]$ArtifactsDir = '',
  [switch]$SkipBuild
)

$ErrorActionPreference = 'Stop'
$Repo = (Resolve-Path -LiteralPath $Repo).Path
if (-not $ArtifactsDir) { $ArtifactsDir = Join-Path $Repo 'dist\signed' }

if (-not $Issuer) { throw '缺 issuer：传 -Issuer 或设 AMO_JWT_ISSUER（形如 user:12345678:90）' }
if (-not $SecretFile) { throw '缺 secret 文件：传 -SecretFile 或设 AMO_JWT_SECRET_FILE' }
if (-not (Test-Path -LiteralPath $SecretFile)) { throw "找不到 secret 文件：$SecretFile" }
if ($Issuer -notmatch '^user:\d+:\d+$') { throw "issuer 形态不对（应形如 user:12345678:90）：$Issuer" }

$secret = (Get-Content -LiteralPath $SecretFile -Raw).Trim()
if ($secret.Length -lt 32) { throw "secret 太短，像是没读对：长度 $($secret.Length)" }

$src = Join-Path $Repo '_dist-firefox'
if (-not $SkipBuild) {
  $build = Join-Path $Repo 'build-firefox.mjs'
  if (-not (Test-Path -LiteralPath $build)) { throw "找不到 $build" }
  Write-Host '→ 重新组装 _dist-firefox'
  Push-Location $Repo
  try { & node $build | Out-Null } finally { Pop-Location }
  if ($LASTEXITCODE -ne 0) { throw "build-firefox.mjs 失败（exit $LASTEXITCODE）" }
}
if (-not (Test-Path -LiteralPath (Join-Path $src 'manifest.json'))) { throw "找不到 $src\manifest.json" }

$manifest = Get-Content -LiteralPath (Join-Path $src 'manifest.json') -Raw | ConvertFrom-Json
$geckoId = $manifest.browser_specific_settings.gecko.id
if (-not $geckoId) { throw '火狐包的 manifest 里没有 browser_specific_settings.gecko.id，签名会失败' }

New-Item -ItemType Directory -Force -Path $ArtifactsDir | Out-Null

Write-Host ("签名：{0} v{1}（gecko id {2}）→ {3}" -f $manifest.name, $manifest.version, $geckoId, $ArtifactsDir) -ForegroundColor Cyan

Push-Location $Repo
try {
  $npxArgs = @(
    '--yes', 'web-ext@8', 'sign',
    '--source-dir', $src,
    '--artifacts-dir', $ArtifactsDir,
    '--channel', 'unlisted',
    '--api-key', $Issuer,
    '--api-secret', $secret,
    '--no-input'
  )
  & npx @npxArgs 2>&1 | Tee-Object -Variable log | Write-Host
  $code = $LASTEXITCODE
} finally {
  Pop-Location
}

if ($code -ne 0) {
  # 把常见失败翻译成人话
  $text = ($log -join "`n")
  if ($text -match 'trademark') { Write-Host 'Mozilla 不让扩展名字里出现 Firefox / Mozilla 商标：把 manifest 的 name 改成纯产品名再签。' -ForegroundColor Red }
  elseif ($text -match 'Invalid JWT|Unauthorized|401') { Write-Host '凭据被拒：issuer/secret 不匹配，或这对 key 已被轮换。' -ForegroundColor Red }
  elseif ($text -match 'already exists|Duplicate') { Write-Host '这个版本号已经在 AMO 上提交过了：改 manifest 版本号再签（同一个版本号不能签两次）。' -ForegroundColor Red }
  elseif ($text -match 'validation') { Write-Host 'Mozilla 的自动校验没通过：看上面 validation 的报错行。' -ForegroundColor Red }
  throw "web-ext sign 失败（exit $code）"
}

$xpi = Get-ChildItem -LiteralPath $ArtifactsDir -Filter '*.xpi' | Sort-Object LastWriteTime -Descending | Select-Object -First 1
if (-not $xpi) { throw "签名命令成功但没找到 .xpi（看 $ArtifactsDir）" }

$hash = (Get-FileHash -LiteralPath $xpi.FullName -Algorithm SHA256).Hash.ToLower()
$sizeKb = [math]::Round($xpi.Length / 1KB, 1)
Write-Host ''
Write-Host '签好了：' -ForegroundColor Green
Write-Host "  $($xpi.FullName)  ($sizeKb KB)"
Write-Host "  sha256 $hash"
Write-Host ''
Write-Host '装法：Firefox / Zen 打开 about:addons → 右上齿轮 → 从文件安装附加组件 → 选这个 .xpi。' -ForegroundColor Cyan

$sums = Join-Path $ArtifactsDir 'SHA256SUMS.txt'
"$hash  $($xpi.Name)" | Set-Content -LiteralPath $sums -Encoding utf8NoBOM
Write-Host "校验和写入 $(Split-Path -Leaf $sums)"

