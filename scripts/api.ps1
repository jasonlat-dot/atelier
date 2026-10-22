param(
    [ValidateSet('run','infrastructure','test-infrastructure','test-browser')]
    [string]$Action = 'run'
)
$ErrorActionPreference = 'Stop'
$apiRoot = Join-Path $PSScriptRoot '../services/api'
$configName = if ($Action -in 'test-infrastructure','test-browser') { '.env.test.local' } else { '.env' }
$configFile = Join-Path $apiRoot $configName
if (-not (Test-Path -LiteralPath $configFile)) { throw "Missing local configuration: $configFile" }
# Parse plain KEY=VALUE only. Configuration is data, never executable PowerShell.
$saved = @{}
try {
    foreach ($line in Get-Content -LiteralPath $configFile) {
        if ($line -match '^\s*(#|$)') { continue }
        if ($line -notmatch '^([A-Z][A-Z0-9_]*)=(.*)$') { throw 'Invalid environment configuration line' }
        $name = $Matches[1]
        $value = $Matches[2]
        $saved[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
        [Environment]::SetEnvironmentVariable($name, $value, 'Process')
    }
    Push-Location $apiRoot
    try {
        switch ($Action) {
            'run' { & cargo run --locked -p atelier-app }
            'infrastructure' { & cargo run --locked -p atelier-app --example check_infrastructure -- --migrate }
            'test-infrastructure' {
                & cargo test --locked -p atelier-auth -p atelier-wallet -p atelier-assets -p atelier-upstream --tests -- --ignored
                if ($LASTEXITCODE -ne 0) { throw 'Database regression failed' }
                & cargo test --locked -p atelier-app --test wallet_http --test assets_schema --test assets_http --test upstream_http -- --ignored
            }
            'test-browser' {
                Push-Location (Join-Path $apiRoot '../../apps/web')
                try { & npm run test:e2e:auth } finally { Pop-Location }
            }
        }
        if ($LASTEXITCODE -ne 0) { throw "API action failed with exit code $LASTEXITCODE" }
    } finally { Pop-Location }
} finally {
    foreach ($name in $saved.Keys) { [Environment]::SetEnvironmentVariable($name, $saved[$name], 'Process') }
}
