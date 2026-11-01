# Builds ClaudePulse.exe with the C# compiler that ships with Windows, then installs shortcuts.
# Usage:  powershell -ExecutionPolicy Bypass -File build.ps1   [-NoStartup]
# Needs Node.js 18+. The C# compiler ships with Windows (.NET Framework 4).
param([switch]$NoStartup)
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$csc = "$env:WINDIR\Microsoft.NET\Framework64\v4.0.30319\csc.exe"
$exe = Join-Path $here 'ClaudePulse.exe'
$ico = Join-Path $here 'pulse.ico'
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) { throw 'Node.js 18 or newer is required: https://nodejs.org' }
if ([int]((& node -v) -replace '^v(\d+).*', '$1') -lt 18) { throw 'Node.js 18 or newer is required.' }
$refs = '/r:System.Windows.Forms.dll', '/r:System.Drawing.dll', '/r:System.Web.Extensions.dll'

Get-Process ClaudePulse -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep -Milliseconds 300

# pass 1: build without icon, use it to render the icon file; pass 2: embed the icon
& $csc /nologo /target:winexe /optimize+ /out:$exe @refs (Join-Path $here 'Pulse.cs')
if ($LASTEXITCODE) { throw 'compile failed' }
& $exe --make-icon $ico
& $exe --make-png (Join-Path $here 'icon.png') 192
& $csc /nologo /target:winexe /optimize+ /win32icon:$ico /out:$exe @refs (Join-Path $here 'Pulse.cs')
if ($LASTEXITCODE) { throw 'compile failed' }

function New-Shortcut($path, $arguments) {
  $sh = New-Object -ComObject WScript.Shell
  $l = $sh.CreateShortcut($path)
  $l.TargetPath = $exe; $l.Arguments = $arguments; $l.WorkingDirectory = $here
  $l.IconLocation = "$exe,0"; $l.Description = 'Claude usage insights and launcher'
  $l.Save()
}
New-Shortcut (Join-Path ([Environment]::GetFolderPath('Programs')) 'Claude Pulse.lnk') ''
if (-not $NoStartup) { New-Shortcut (Join-Path ([Environment]::GetFolderPath('Startup')) 'Claude Pulse.lnk') '--silent' }

Write-Host "Built $exe"
Write-Host 'Start Menu shortcut added. Pin it: Start > Claude Pulse > right-click > Pin to taskbar.'
Start-Process $exe
