$ErrorActionPreference = "Stop"

$scriptDir = $PSScriptRoot
$binDir = Join-Path $scriptDir "bin"
$specDir = Join-Path $scriptDir "build"
$venvDir = Join-Path $scriptDir "build_venv"

Write-Host "=== Building audio_handler.exe ==="

# Clean previous builds
if (Test-Path $binDir) { Remove-Item -Recurse -Force $binDir }
if (Test-Path $specDir) { Remove-Item -Recurse -Force $specDir }
if (Test-Path $venvDir) { Remove-Item -Recurse -Force $venvDir }
New-Item -ItemType Directory -Force -Path $binDir | Out-Null

# Create isolated virtual environment (no system site-packages)
Write-Host "Creating isolated virtual environment..."
python -m venv --clear $venvDir
$python = Join-Path $venvDir "Scripts\python.exe"

# Install only what we need
# PyInstaller: install with deps (needs altgraph, pefile, packaging, etc.)
# UnityPy: --no-deps to avoid Pillow, etcpak, texture2ddecoder, fmod_toolkit
# pydub/fsb5: small, deps don't matter
Write-Host "Installing minimal dependencies..."
& $python -m pip install pyinstaller==6.17.0 --quiet
& $python -m pip install --no-deps UnityPy==1.25.2 pydub==0.25.1 fsb5==1.0 --quiet

# Then manually add the transitive deps we DO need (UnityPy runtime deps)
& $python -m pip install lz4 brotli fsspec attrs pywin32-ctypes --quiet

$sp = Join-Path $venvDir "Lib\site-packages"
# Strip everything we don't need (removed from venv so PyInstaller can't find it)
$removeDirs = @("PIL", "Pillow*", "etcpak", "texture2ddecoder", "fmod_toolkit", "pyfmodex", "astc_encoder_py", "astc_encoder*")
foreach ($pat in $removeDirs) {
    Get-ChildItem $sp -Directory -Filter $pat -ErrorAction SilentlyContinue | Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
}

# Build with PyInstaller in the clean venv
Write-Host "Compiling with PyInstaller (isolated venv)..."
$venvSp = Join-Path $venvDir "Lib\site-packages"
$resourcesGlob = Join-Path $venvSp "UnityPy\resources\lzma.tpk"
& $python -m PyInstaller --onefile `
    --name audio_handler `
    --distpath $binDir `
    --workpath $specDir `
    --add-data "$resourcesGlob;UnityPy/resources" `
    --runtime-hook (Join-Path $scriptDir "runtime_hook.py") `
    --hidden-import UnityPy `
    --hidden-import UnityPy.resources `
    --hidden-import UnityPy.streams.EndianBinaryReader `
    --hidden-import pydub `
    --hidden-import fsb5 `
    (Join-Path $scriptDir "audio_handler.py")

# Clean up
Write-Host "Cleaning up..."
if (Test-Path $specDir) { Remove-Item -Recurse -Force $specDir }
if (Test-Path $venvDir) { Remove-Item -Recurse -Force $venvDir }
Remove-Item -Force (Join-Path $scriptDir "audio_handler.spec") -ErrorAction SilentlyContinue

# Verify
$exe = Join-Path $binDir "audio_handler.exe"
if (Test-Path $exe) {
    $size = [math]::Round((Get-Item $exe).Length / 1MB, 1)
    Write-Host "Done: $exe ($size MB)"
} else {
    throw "Build failed: audio_handler.exe not found"
}
