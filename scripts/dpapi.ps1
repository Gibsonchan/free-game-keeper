param([ValidateSet('Protect','Unprotect')][string]$Mode)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Security
$inputBytes = [Convert]::FromBase64String([Console]::In.ReadToEnd().Trim())
$scope = [Security.Cryptography.DataProtectionScope]::CurrentUser
if ($Mode -eq 'Protect') {
  $outputBytes = [Security.Cryptography.ProtectedData]::Protect($inputBytes, $null, $scope)
} else {
  $outputBytes = [Security.Cryptography.ProtectedData]::Unprotect($inputBytes, $null, $scope)
}
[Console]::Out.Write([Convert]::ToBase64String($outputBytes))
