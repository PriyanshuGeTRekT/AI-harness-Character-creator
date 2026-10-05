# Adds AgentDeck shortcuts to the Desktop and Start menu. Run once:
#   powershell -ExecutionPolicy Bypass -File install-shortcuts.ps1
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$shell = New-Object -ComObject WScript.Shell
foreach ($dir in @([Environment]::GetFolderPath('Desktop'), [Environment]::GetFolderPath('Programs'))) {
  $link = $shell.CreateShortcut((Join-Path $dir 'AgentDeck.lnk'))
  $link.TargetPath = Join-Path $env:WINDIR 'System32\wscript.exe'
  $link.Arguments = '"' + (Join-Path $here 'AgentDeck.vbs') + '"'
  $link.WorkingDirectory = $here
  $link.Description = 'AgentDeck: control panel for AI coding agents'
  $link.Save()
  Write-Host "Created $($link.FullName)"
}