$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$launcherPath = Join-Path $projectRoot 'start-hidden.vbs'
if (-not (Test-Path -LiteralPath $launcherPath)) { throw 'Launcher not found' }
$wscriptPath = Join-Path $env:WINDIR 'System32\wscript.exe'
$existing = Get-ScheduledTask -TaskName 'FreeGameKeeper' -ErrorAction SilentlyContinue
if ($existing) {
  $expectedArgument = '"{0}"' -f $launcherPath
  if ($existing.Actions.Count -ne 1 -or $existing.Actions[0].Execute -ne $wscriptPath -or $existing.Actions[0].Arguments -ne $expectedArgument) {
    throw 'An unrelated task already uses the name FreeGameKeeper; no changes were made.'
  }
}
$action = New-ScheduledTaskAction -Execute $wscriptPath -Argument ('"{0}"' -f $launcherPath) -WorkingDirectory $projectRoot
$trigger = New-ScheduledTaskTrigger -AtLogOn -User ([Security.Principal.WindowsIdentity]::GetCurrent().Name)
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 2)
Register-ScheduledTask -TaskName 'FreeGameKeeper' -Action $action -Trigger $trigger -Settings $settings -Description 'Local Epic and Steam free game claimer, WeCom notifications' -Force | Select-Object TaskName, State
