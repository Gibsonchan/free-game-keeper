$ErrorActionPreference = 'Stop'
Unregister-ScheduledTask -TaskName 'FreeGameKeeper' -Confirm:$false
