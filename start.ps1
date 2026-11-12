param(
    [int]$Port = 0,
    [switch]$NoBrowser,
    [switch]$Repair
)

$ErrorActionPreference = 'Stop'
$venv = Join-Path $PSScriptRoot '.venv'
$python = Join-Path $venv 'Scripts\python.exe'
$app = Join-Path $PSScriptRoot 'app.py'
$requirements = Join-Path $PSScriptRoot 'requirements.txt'

function Find-Python([switch]$Base) {
    $executable = if ($Base) { 'sys._base_executable' } else { 'sys.executable' }
    $probe = "import json, sys; print(json.dumps(dict(path=$executable))) if sys.version_info >= (3, 9) else sys.exit(1)"
    $names = if ($Base) { @('python.exe', 'py.exe') } else { @('py.exe', 'python.exe') }
    foreach ($command in @(Get-Command $names -CommandType Application -ErrorAction SilentlyContinue)) {
        $prefix = @()
        if ($Base -and $command.Name -eq 'py.exe') { $prefix = @('-3') }
        try {
            $result = & $command.Source @prefix -E -c $probe 2>$null
            if ($LASTEXITCODE -eq 0 -and $result -is [string]) {
                $path = (ConvertFrom-Json -InputObject $result).path
                if ($path -and (Test-Path -LiteralPath $path -PathType Leaf)) { return $path }
            }
        } catch {
            continue
        }
    }
    throw 'Python 3.9 or newer is required. Open a terminal with Python available and run .\start.ps1 -Repair.'
}

function Test-PythonDependencies([string]$Interpreter) {
    try {
        $result = & $Interpreter -E -c 'from PIL import Image, ImageOps; print(1)' 2>$null
        return $LASTEXITCODE -eq 0 -and $result -eq '1'
    } catch {
        return $false
    }
}

if ($Repair) {
    $basePython = Find-Python -Base
    if (Test-Path -LiteralPath $venv) {
        $backup = '.venv-backup-' + [guid]::NewGuid().ToString('N').Substring(0, 8)
        Rename-Item -LiteralPath $venv -NewName $backup
        Write-Host "Previous environment saved as $backup"
    }
    & $basePython -E -m venv $venv
    if ($LASTEXITCODE -ne 0) { throw 'Could not create the local Python environment.' }
    & $python -E -m pip install --only-binary=:all: -r $requirements
    if ($LASTEXITCODE -ne 0) { throw 'Dependency installation failed. Check the pip error above, then retry .\start.ps1 -Repair.' }
} elseif (-not (Test-Path -LiteralPath $venv)) {
    $python = Find-Python
}

if (-not (Test-PythonDependencies $python)) {
    throw 'Pillow could not load for this Python installation. Run .\start.ps1 -Repair to rebuild the environment on this computer.'
}

$shellName = if ($PSVersionTable.PSEdition -eq 'Desktop') { 'powershell.exe' } else { 'pwsh.exe' }
$options = @('--powershell', (Join-Path $PSHOME $shellName), '--port', $Port)
if ($NoBrowser) { $options += '--no-browser' }
& $python -E $app @options
exit $LASTEXITCODE
