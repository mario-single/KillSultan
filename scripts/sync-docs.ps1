$ErrorActionPreference = "Stop"

param(
  [switch]$Check
)

$root = (Get-Location).Path

$mappings = @(
  @{
    Source = "docs/玩家规则手册.md"
    Targets = @(
      "apps/client/public/docs/玩家规则手册.md",
      "docs/rulebook-zh.md"
    )
  },
  @{
    Source = "docs/玩家规则手册.docx"
    Targets = @(
      "apps/client/public/docs/玩家规则手册.docx",
      "docs/rulebook-zh.docx"
    )
  },
  @{
    Source = "docs/图片命名规范.txt"
    Targets = @(
      "apps/client/public/docs/图片命名规范.txt",
      "apps/client/public/assets/roles/命名规范.txt"
    )
  },
  @{
    Source = "docs/开发TODO.md"
    Targets = @(
      "apps/client/public/docs/开发TODO.md"
    )
  },
  @{
    Source = "docs/AI交接记忆库.md"
    Targets = @(
      "apps/client/public/docs/AI交接记忆库.md"
    )
  }
)

function Resolve-FilePath([string]$relativePath) {
  return Join-Path $root $relativePath
}

function Get-HashSafe([string]$path) {
  if (!(Test-Path $path)) {
    return $null
  }
  return (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash
}

if ($Check) {
  $mismatch = @()
  foreach ($mapping in $mappings) {
    $sourcePath = Resolve-FilePath $mapping.Source
    if (!(Test-Path $sourcePath)) {
      throw "缺少源文件：$($mapping.Source)"
    }
    $sourceHash = Get-HashSafe $sourcePath
    foreach ($target in $mapping.Targets) {
      $targetPath = Resolve-FilePath $target
      $targetHash = Get-HashSafe $targetPath
      if ($sourceHash -ne $targetHash) {
        $mismatch += "$($mapping.Source) != $target"
      }
    }
  }

  if ($mismatch.Count -gt 0) {
    Write-Host "以下文档未同步：" -ForegroundColor Yellow
    $mismatch | ForEach-Object { Write-Host " - $_" -ForegroundColor Yellow }
    exit 1
  }

  Write-Host "文档已同步（检查通过）"
  exit 0
}

foreach ($mapping in $mappings) {
  $sourcePath = Resolve-FilePath $mapping.Source
  if (!(Test-Path $sourcePath)) {
    throw "缺少源文件：$($mapping.Source)"
  }
  foreach ($target in $mapping.Targets) {
    $targetPath = Resolve-FilePath $target
    $targetDir = Split-Path -Parent $targetPath
    if (!(Test-Path $targetDir)) {
      New-Item -ItemType Directory -Path $targetDir | Out-Null
    }
    Copy-Item -LiteralPath $sourcePath -Destination $targetPath -Force
    Write-Host "已同步：$($mapping.Source) -> $target"
  }
}

Write-Host "文档同步完成"
