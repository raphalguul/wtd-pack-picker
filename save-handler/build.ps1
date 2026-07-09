$csc = "C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe"
if (-not (Test-Path $csc)) {
    $csc = "C:\Windows\Microsoft.NET\Framework\v4.0.30319\csc.exe"
}
if (-not (Test-Path $csc)) {
    Write-Error "csc.exe not found"
    exit 1
}

$outDir = Join-Path $PSScriptRoot "bin"
if (-not (Test-Path $outDir)) {
    New-Item -ItemType Directory -Path $outDir -Force | Out-Null
}

$outPath = Join-Path $outDir "SaveHandler.exe"
$srcPath = Join-Path $PSScriptRoot "Program.cs"

# Find game's mscorlib for Unity Mono compatibility
$gamePath = "D:\Games\Steam Games\steamapps\common\WhatTheDub"
$mscorlib = Join-Path $gamePath "WhatTheDub_Data\Managed\mscorlib.dll"
if (-not (Test-Path $mscorlib)) {
    Write-Warning "Unity mscorlib not found at $mscorlib, using system mscorlib"
    & $csc /nologo /target:exe /out:$outPath /platform:x64 $srcPath
} else {
    & $csc /nologo /nostdlib /target:exe /out:$outPath /platform:x64 /reference:$mscorlib $srcPath
}

if ($LASTEXITCODE -eq 0) {
    Write-Host "Build successful: $outPath"
} else {
    Write-Error "Build failed with exit code $LASTEXITCODE"
    exit $LASTEXITCODE
}
