param([string]$InitialDirectory, [string]$Title = '选择照片文件夹')

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)

if ($PSVersionTable.PSVersion -ge [version]'7.4') {
    Add-Type -AssemblyName PresentationFramework
    $dialog = [Microsoft.Win32.OpenFolderDialog]::new()
    $dialog.Title = $title
    $dialog.Multiselect = $true
    $dialog.AddToRecent = $false
    if ($InitialDirectory -and (Test-Path -LiteralPath $InitialDirectory -PathType Container)) {
        $dialog.InitialDirectory = $InitialDirectory
    }
    $paths = @()
    if ($dialog.ShowDialog() -eq $true) {
        $paths = @($dialog.FolderNames)
    }
} else {
    Add-Type -Path (Join-Path $PSScriptRoot 'FolderPicker.cs')
    $paths = @([PhotoMap.FolderPicker]::Choose($title, $InitialDirectory))
}
ConvertTo-Json -InputObject $paths -Compress
