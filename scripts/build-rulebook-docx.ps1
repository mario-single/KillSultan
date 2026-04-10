$ErrorActionPreference = "Stop"

$root = (Get-Location).Path
$sourcePath = Join-Path $root "docs\rulebook-zh.md"
$outputPath = Join-Path $root "docs\rulebook-zh.docx"
$tmpRoot = Join-Path $root "docs\.rulebook_docx_tmp"
$zipPath = Join-Path $root "docs\rulebook-zh.zip"

if (!(Test-Path $sourcePath)) {
  throw "rulebook markdown not found: $sourcePath"
}

if (Test-Path $tmpRoot) {
  Remove-Item -Recurse -Force $tmpRoot
}

New-Item -ItemType Directory -Path $tmpRoot | Out-Null
New-Item -ItemType Directory -Path (Join-Path $tmpRoot "_rels") | Out-Null
New-Item -ItemType Directory -Path (Join-Path $tmpRoot "word") | Out-Null

$contentTypes = @"
<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>
"@

$rels = @"
<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>
"@

function Escape-XmlText {
  param([string]$Text)
  return $Text.Replace("&", "&amp;").Replace("<", "&lt;").Replace(">", "&gt;")
}

$lines = Get-Content -Path $sourcePath -Encoding UTF8
$paragraphXml = New-Object System.Collections.Generic.List[string]

foreach ($line in $lines) {
  $text = $line
  if ($line -eq "") {
    $text = " "
  }
  $escaped = Escape-XmlText -Text $text
  $paragraphXml.Add("<w:p><w:r><w:t xml:space=""preserve"">$escaped</w:t></w:r></w:p>")
}

$documentXml = @"
<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    $($paragraphXml -join "`n    ")
    <w:sectPr>
      <w:pgSz w:w="11906" w:h="16838"/>
      <w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="708" w:footer="708" w:gutter="0"/>
    </w:sectPr>
  </w:body>
</w:document>
"@

[System.IO.File]::WriteAllText((Join-Path $tmpRoot "[Content_Types].xml"), $contentTypes, [System.Text.Encoding]::UTF8)
[System.IO.File]::WriteAllText((Join-Path $tmpRoot "_rels\.rels"), $rels, [System.Text.Encoding]::UTF8)
[System.IO.File]::WriteAllText((Join-Path $tmpRoot "word\document.xml"), $documentXml, [System.Text.Encoding]::UTF8)

if (Test-Path $zipPath) {
  Remove-Item -Force $zipPath
}
if (Test-Path $outputPath) {
  Remove-Item -Force $outputPath
}

Compress-Archive -Path (Join-Path $tmpRoot "*") -DestinationPath $zipPath
Rename-Item -Path $zipPath -NewName (Split-Path -Leaf $outputPath)

Remove-Item -Recurse -Force $tmpRoot
Write-Host "已生成：$outputPath"
