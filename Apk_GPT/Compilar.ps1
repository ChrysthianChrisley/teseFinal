param([switch]$RefreshDependencies)
$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw 'Node.js é necessário.' }
$apkJavaCandidates = @($env:JAVA_HOME, 'C:\Program Files\Java\jdk-22', 'C:\Program Files\Android\Android Studio\jbr')
$apkJava = $apkJavaCandidates | Where-Object { $_ -and (Test-Path -LiteralPath (Join-Path $_ 'bin\java.exe')) } | Select-Object -First 1
if (-not $apkJava) { throw 'Configure JAVA_HOME para um JDK 21 ou superior.' }
$env:JAVA_HOME = $apkJava
$env:PATH = (Join-Path $apkJava 'bin') + ';' + $env:PATH
$apkSdkCandidates = @((Join-Path $PSScriptRoot 'tools\android-sdk'), $env:ANDROID_HOME, $env:ANDROID_SDK_ROOT)
$apkSdk = $apkSdkCandidates | Where-Object { $_ -and (Test-Path -LiteralPath (Join-Path $_ 'platforms\android-36\android.jar')) } | Select-Object -First 1
if (-not $apkSdk) { throw 'Configure ANDROID_HOME para um SDK com Android 36 e Build Tools 35.0.0.' }
$env:ANDROID_HOME = $apkSdk
$apkUtf8 = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText((Join-Path $PSScriptRoot 'android\local.properties'), ('sdk.dir=' + $apkSdk.Replace('\','/') + "`n"), $apkUtf8)
& node (Join-Path $PSScriptRoot 'build-web.cjs')
if ($LASTEXITCODE -ne 0) { throw 'Falha ao incorporar os arquivos web.' }
Push-Location -LiteralPath (Join-Path $PSScriptRoot 'android')
try {
    $apkGradleArgs = @('assembleDebug', '--console=plain')
    if ($RefreshDependencies) { $apkGradleArgs += '--refresh-dependencies' }
    & .\gradlew.bat @apkGradleArgs
    if ($LASTEXITCODE -ne 0) { throw 'Compilação Android falhou.' }
} finally { Pop-Location }
$apkDestination = Join-Path $PSScriptRoot 'MonitorPlantar-GPT.apk'
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'android\app\build\outputs\apk\debug\app-debug.apk') -Destination $apkDestination -Force
$apkHash = (Get-FileHash -LiteralPath $apkDestination -Algorithm SHA256).Hash.ToLowerInvariant()
[System.IO.File]::WriteAllText((Join-Path $PSScriptRoot 'MonitorPlantar-GPT.sha256'), "$apkHash  MonitorPlantar-GPT.apk`n", $apkUtf8)
Write-Output "APK gerado: $apkDestination"
