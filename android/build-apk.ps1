param(
    [string]$SdkRoot = $env:ANDROID_HOME,
    [string]$JdkRoot = $env:JAVA_HOME
)
$ErrorActionPreference = 'Stop'
if (!$SdkRoot) { $SdkRoot = $env:ANDROID_SDK_ROOT }
if (!$SdkRoot -or !$JdkRoot) { throw 'Set ANDROID_HOME and JAVA_HOME, or pass -SdkRoot and -JdkRoot.' }
$projectRoot = Split-Path -Parent $PSScriptRoot
[xml]$manifest = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'AndroidManifest.xml') -Raw -Encoding UTF8
$version = $manifest.manifest.GetAttribute('versionName', 'http://schemas.android.com/apk/res/android')
if ($version -notmatch '^\d+\.\d+\.\d+$') { throw 'Invalid APK version name.' }
$toolsRoot = Join-Path $SdkRoot 'build-tools\35.0.0'
$androidJar = Join-Path $SdkRoot 'platforms\android-35\android.jar'
$javaExe = Join-Path $JdkRoot 'bin\java.exe'
foreach ($requiredPath in @($androidJar, $javaExe, (Join-Path $toolsRoot 'aapt2.exe'), (Join-Path $toolsRoot 'lib\d8.jar'), (Join-Path $toolsRoot 'lib\apksigner.jar'))) {
    if (!(Test-Path -LiteralPath $requiredPath)) { throw "Missing build tool: $requiredPath" }
}
function Invoke-Checked([string]$Executable, [string[]]$Arguments) {
    & $Executable @Arguments
    if ($LASTEXITCODE -ne 0) { throw "Build command failed: $Executable (exit $LASTEXITCODE)" }
}
Push-Location $PSScriptRoot
try {
    # Each build gets its own output directory; prior APKs and signing keys are preserved.
    $build = '.build\' + [DateTime]::Now.ToString('yyyyMMdd-HHmmss-fff')
    foreach ($dir in @($build, "$build\assets", "$build\generated", "$build\classes", "$build\dex", '.signing', '..\dist')) {
        New-Item -ItemType Directory -Path $dir -Force | Out-Null
    }
    foreach ($asset in @('index.html', 'styles.css', 'store.js', 'persistence.js', 'app.js')) {
        Copy-Item -LiteralPath (Join-Path $projectRoot $asset) -Destination "$build\assets\$asset"
    }
    Invoke-Checked (Join-Path $toolsRoot 'aapt2.exe') @('compile', '--dir', 'res', '-o', "$build\resources.zip")
    Invoke-Checked (Join-Path $toolsRoot 'aapt2.exe') @('link', '-o', "$build\base.apk", '-I', $androidJar, '--manifest', 'AndroidManifest.xml', '-A', "$build\assets", '--java', "$build\generated", "$build\resources.zip")
    $sources = @(Get-ChildItem -LiteralPath 'src', "$build\generated" -Filter '*.java' -Recurse | ForEach-Object { Resolve-Path -LiteralPath $_.FullName -Relative })
    Invoke-Checked (Join-Path $JdkRoot 'bin\javac.exe') (@('-encoding', 'UTF-8', '--release', '8', '-classpath', $androidJar, '-d', "$build\classes") + $sources)
    Invoke-Checked (Join-Path $JdkRoot 'bin\jar.exe') @('cf', "$build\classes.jar", '-C', "$build\classes", '.')
    Invoke-Checked $javaExe @('-cp', (Join-Path $toolsRoot 'lib\d8.jar'), 'com.android.tools.r8.D8', '--release', '--min-api', '26', '--lib', $androidJar, '--output', "$build\dex", "$build\classes.jar")
    Copy-Item -LiteralPath "$build\base.apk" -Destination "$build\unsigned.apk"
    Add-Type -AssemblyName System.IO.Compression
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $zip = [System.IO.Compression.ZipFile]::Open((Join-Path $PSScriptRoot "$build\unsigned.apk"), [System.IO.Compression.ZipArchiveMode]::Update)
    try {
        foreach ($dex in Get-ChildItem -LiteralPath "$build\dex" -Filter '*.dex') {
            [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, $dex.FullName, $dex.Name, [System.IO.Compression.CompressionLevel]::Optimal) | Out-Null
        }
    } finally { $zip.Dispose() }
    Invoke-Checked (Join-Path $toolsRoot 'zipalign.exe') @('-f', '-p', '4', "$build\unsigned.apk", "$build\aligned.apk")
    $keyFile = '.signing\release.jks'
    $passwordFile = '.signing\password.txt'
    if (!(Test-Path -LiteralPath $keyFile)) {
        if (!(Test-Path -LiteralPath $passwordFile)) {
            $randomBytes = New-Object byte[] 32
            $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
            try { $rng.GetBytes($randomBytes) } finally { $rng.Dispose() }
            [System.IO.File]::WriteAllText((Join-Path $PSScriptRoot $passwordFile), [Convert]::ToBase64String($randomBytes), [System.Text.Encoding]::ASCII)
        }
        Invoke-Checked (Join-Path $JdkRoot 'bin\keytool.exe') @('-genkeypair', '-noprompt', '-keystore', $keyFile, '-storetype', 'JKS', '-storepass:file', $passwordFile, '-keypass:file', $passwordFile, '-alias', 'diandian', '-keyalg', 'RSA', '-keysize', '2048', '-validity', '10000', '-dname', 'CN=Diandian Counter, O=Local Apps, C=CN')
    }
    if (!(Test-Path -LiteralPath $passwordFile)) { throw 'Existing signing key password file is missing; do not replace the key.' }
    $apk = "..\dist\diandian-counter-$version.apk"
    Invoke-Checked $javaExe @('-jar', (Join-Path $toolsRoot 'lib\apksigner.jar'), 'sign', '--ks', $keyFile, '--ks-key-alias', 'diandian', '--ks-pass', "file:$passwordFile", '--out', $apk, "$build\aligned.apk")
    Invoke-Checked $javaExe @('-jar', (Join-Path $toolsRoot 'lib\apksigner.jar'), 'verify', '--verbose', '--print-certs', $apk)
    Invoke-Checked (Join-Path $toolsRoot 'zipalign.exe') @('-c', '-p', '4', $apk)
    Invoke-Checked (Join-Path $toolsRoot 'aapt.exe') @('dump', 'badging', $apk)
    (Get-FileHash -LiteralPath $apk -Algorithm SHA256).Hash | Set-Content -LiteralPath "$apk.sha256" -Encoding ASCII
    Write-Output "APK ready: $(Join-Path $projectRoot "dist\diandian-counter-$version.apk")"
} finally { Pop-Location }
