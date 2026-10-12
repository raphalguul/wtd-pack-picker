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

$outPath = Join-Path $outDir "WindowEmbed.exe"
$srcPath = Join-Path $PSScriptRoot "Program.cs"

& $csc /nologo /target:exe /out:$outPath /platform:x64 /reference:System.dll $srcPath

if ($LASTEXITCODE -eq 0) {
    Write-Host "Build successful: $outPath"
} else {
    Write-Error "Build failed with exit code $LASTEXITCODE"
    exit $LASTEXITCODE
}
