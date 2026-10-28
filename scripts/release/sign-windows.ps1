$ErrorActionPreference = 'Stop'
$complete = $env:WINDOWS_CERTIFICATE -and $env:WINDOWS_CERTIFICATE_PASSWORD
if ($env:RELEASE_CHANNEL -eq 'stable' -and -not $complete) {
  throw 'Stable Windows releases require WINDOWS_CERTIFICATE and WINDOWS_CERTIFICATE_PASSWORD'
}
if (-not $complete) {
  if ($env:WINDOWS_CERTIFICATE -or $env:WINDOWS_CERTIFICATE_PASSWORD) {
    throw 'Configure both Windows signing secrets together'
  }
  exit 0
}
$certificatePath = Join-Path $env:RUNNER_TEMP 'span-signing.pfx'
try {
  [IO.File]::WriteAllBytes($certificatePath, [Convert]::FromBase64String($env:WINDOWS_CERTIFICATE))
  $password = ConvertTo-SecureString -String $env:WINDOWS_CERTIFICATE_PASSWORD -AsPlainText -Force
  $certificate = Import-PfxCertificate -FilePath $certificatePath -CertStoreLocation Cert:\CurrentUser\My -Password $password
  if (-not $certificate.HasPrivateKey) { throw 'Signing certificate has no private key' }
  $configPath = Join-Path $env:RUNNER_TEMP 'span-release.json'
  $config = Get-Content $configPath -Raw | ConvertFrom-Json -AsHashtable
  $config.bundle = @{
    windows = @{
      certificateThumbprint = $certificate.Thumbprint
      digestAlgorithm = 'sha256'
      timestampUrl = 'http://timestamp.digicert.com'
    }
  }
  $config | ConvertTo-Json -Depth 10 | Set-Content $configPath -Encoding utf8
} finally {
  Remove-Item $certificatePath -Force -ErrorAction SilentlyContinue
}
