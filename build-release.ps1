$ErrorActionPreference = "Stop"

$version = "1.0.0"
$nodeVersion = "v24.16.0"
$nodeUrl = "https://nodejs.org/dist/$nodeVersion/win-x64/node.exe"

$distDir = Join-Path $PSScriptRoot "dist\wtd-pack-picker"
$zipFile = Join-Path $PSScriptRoot "release\WTD-Pack-Picker-$version.zip"

Write-Host "=== WTD Pack Picker Release Builder ==="
Write-Host "Version: $version"

# Clean
if (Test-Path $distDir) { Remove-Item -Recurse -Force $distDir }
New-Item -ItemType Directory -Path $distDir -Force | Out-Null
New-Item -ItemType Directory -Path (Join-Path $distDir "renderer") -Force | Out-Null
New-Item -ItemType Directory -Path (Join-Path $distDir "lib") -Force | Out-Null
$saveDir = Join-Path $distDir "save-handler\bin"
New-Item -ItemType Directory -Path $saveDir -Force | Out-Null
$releaseDir = Join-Path $PSScriptRoot "release"
if (-not (Test-Path $releaseDir)) { New-Item -ItemType Directory -Path $releaseDir -Force | Out-Null }

# Download portable Node.js
$nodeExe = Join-Path $distDir "node.exe"
if (-not (Test-Path $nodeExe)) {
    Write-Host "Downloading Node.js $nodeVersion..."
    Invoke-WebRequest -Uri $nodeUrl -OutFile $nodeExe
}

# Copy app files
Write-Host "Copying app files..."
Copy-Item (Join-Path $PSScriptRoot "server.js") $distDir
Copy-Item (Join-Path $PSScriptRoot "workshop-names.json") $distDir
Copy-Item (Join-Path $PSScriptRoot "package.json") $distDir
Copy-Item (Join-Path $PSScriptRoot "renderer\*") (Join-Path $distDir "renderer")
Copy-Item (Join-Path $PSScriptRoot "lib\*") (Join-Path $distDir "lib")
Copy-Item (Join-Path $PSScriptRoot "save-handler\bin\SaveHandler.exe") $saveDir -ErrorAction SilentlyContinue

# Build C# handler if binary doesn't exist
if (-not (Test-Path (Join-Path $saveDir "SaveHandler.exe"))) {
    Write-Host "Building C# save handler..."
    & (Join-Path $PSScriptRoot "save-handler\build.ps1")
    Copy-Item (Join-Path $PSScriptRoot "save-handler\bin\SaveHandler.exe") $saveDir
}

# Create start script
$startBat = @'
@echo off
title WTD Pack Picker
echo.
echo   WTD Pack Picker vVERSION
echo   =========================
echo.
echo   Starting server on http://localhost:4500
echo   Close this window to stop the server.
echo.
start http://localhost:4500
node.exe server.js
pause
'@ -replace "VERSION", $version
Set-Content -Path (Join-Path $distDir "start.bat") -Value $startBat

# Install production dependencies
Write-Host "Installing dependencies..."
Push-Location $distDir
npm install --production --no-audit --no-fund 2>&1 | Out-Null
Pop-Location

# Create zip
Write-Host "Creating release zip..."
Compress-Archive -Path "$distDir\*" -DestinationPath $zipFile -Force

$sizeMB = [math]::Round((Get-Item $zipFile).Length / 1MB, 1)
Write-Host "Done: $zipFile ($sizeMB MB)"
