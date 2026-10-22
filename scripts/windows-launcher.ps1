[CmdletBinding()]
param(
  [switch]$InstallOnly,
  [switch]$NoBrowser,
  # Release/CI verification hook: exercise the same portable-runtime path used
  # on a Windows computer with no compatible Node.js or Python installed.
  [switch]$ForcePortableRuntime
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
Set-StrictMode -Version 2.0
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$ProjectRoot = [IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot)).TrimEnd('\')
$RuntimeRoot = Join-Path $ProjectRoot '.runtime'

function Write-Step([string]$Message) {
  Write-Host "`n==> $Message" -ForegroundColor Cyan
}

function Get-Sha256([string]$FilePath) {
  $fullPath = [IO.Path]::GetFullPath($FilePath)
  $stream = [IO.File]::OpenRead($fullPath)
  try {
    $sha256 = [Security.Cryptography.SHA256]::Create()
    try {
      return ([BitConverter]::ToString($sha256.ComputeHash($stream))).Replace('-', '').ToLowerInvariant()
    } finally {
      $sha256.Dispose()
    }
  } finally {
    $stream.Dispose()
  }
}

function Assert-ProjectChild([string]$Target) {
  $full = [IO.Path]::GetFullPath($Target)
  if (-not $full.StartsWith($ProjectRoot + '\', [StringComparison]::OrdinalIgnoreCase)) {
    throw "拒绝操作项目目录外的路径：$full"
  }
  return $full
}

function Get-EnvValue([string]$Key) {
  $envFile = Join-Path $ProjectRoot '.env'
  if (-not (Test-Path -LiteralPath $envFile)) { return '' }
  foreach ($line in Get-Content -LiteralPath $envFile) {
    if ($line -match "^\s*$([regex]::Escape($Key))\s*=\s*(.*)$") {
      $current = $Matches[1].Trim()
      if (($current.StartsWith('"') -and $current.EndsWith('"')) -or ($current.StartsWith("'") -and $current.EndsWith("'"))) {
        return $current.Substring(1, $current.Length - 2)
      }
      return ($current -replace '\s+#.*$', '').Trim()
    }
  }
  return ''
}

function Test-Node20([string]$Executable) {
  if (-not $Executable -or -not (Test-Path -LiteralPath $Executable)) { return $false }
  try {
    $version = (& $Executable --version 2>$null | Select-Object -First 1)
    return $version -match '^v(\d+)\.' -and [int]$Matches[1] -ge 20
  } catch { return $false }
}

function Get-WindowsArch {
  $raw = if ($env:PROCESSOR_ARCHITEW6432) { $env:PROCESSOR_ARCHITEW6432 } else { $env:PROCESSOR_ARCHITECTURE }
  switch ($raw.ToUpperInvariant()) {
    'ARM64' { return 'arm64' }
    'AMD64' { return 'x64' }
    'X86'   { throw '当前 Node.js 官方 LTS 不再提供 32 位 Windows 便携包。请在 Windows 10/11 64 位系统上运行本程序。' }
    default { throw "不支持的 Windows CPU 架构：$raw" }
  }
}

function Install-PortableNode {
  Write-Step '未找到 Node.js 20+，正在下载 Node.js 官方 LTS 便携版（无需管理员权限）'
  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
  New-Item -ItemType Directory -Path $RuntimeRoot -Force | Out-Null
  $downloads = Assert-ProjectChild (Join-Path $RuntimeRoot 'downloads')
  New-Item -ItemType Directory -Path $downloads -Force | Out-Null
  $arch = Get-WindowsArch
  $index = Invoke-RestMethod -Uri 'https://nodejs.org/dist/index.json' -TimeoutSec 60
  $release = @($index | Where-Object { $_.lts -and [int]($_.version.TrimStart('v').Split('.')[0]) -ge 20 })[0]
  if (-not $release) { throw '无法从 nodejs.org 获取可用的 LTS 版本。' }
  $fileName = "node-$($release.version)-win-$arch.zip"
  $baseUrl = "https://nodejs.org/dist/$($release.version)"
  $zipFile = Assert-ProjectChild (Join-Path $downloads $fileName)
  $sumFile = Assert-ProjectChild (Join-Path $downloads 'SHASUMS256.txt')
  Invoke-WebRequest -UseBasicParsing -Uri "$baseUrl/$fileName" -OutFile $zipFile -TimeoutSec 300
  Invoke-WebRequest -UseBasicParsing -Uri "$baseUrl/SHASUMS256.txt" -OutFile $sumFile -TimeoutSec 60
  $sumLine = Get-Content -LiteralPath $sumFile | Where-Object { $_ -match "\s+$([regex]::Escape($fileName))$" } | Select-Object -First 1
  if (-not $sumLine) { throw 'Node.js 官方校验文件中没有找到下载包。' }
  $expected = ($sumLine -split '\s+')[0].ToLowerInvariant()
  $actual = Get-Sha256 $zipFile
  if ($actual -ne $expected) { throw 'Node.js 下载包 SHA-256 校验失败，已拒绝安装。' }

  $extractRoot = Assert-ProjectChild (Join-Path $RuntimeRoot ("node-extract-" + $PID))
  $nodeHome = Assert-ProjectChild (Join-Path $RuntimeRoot 'node')
  if (Test-Path -LiteralPath $extractRoot) { Remove-Item -LiteralPath $extractRoot -Recurse -Force }
  New-Item -ItemType Directory -Path $extractRoot -Force | Out-Null
  Expand-Archive -LiteralPath $zipFile -DestinationPath $extractRoot -Force
  $expanded = Join-Path $extractRoot "node-$($release.version)-win-$arch"
  if (-not (Test-Path -LiteralPath (Join-Path $expanded 'node.exe'))) { throw 'Node.js 解压结果不完整。' }
  if (Test-Path -LiteralPath $nodeHome) { Remove-Item -LiteralPath $nodeHome -Recurse -Force }
  Move-Item -LiteralPath $expanded -Destination $nodeHome
  Remove-Item -LiteralPath $extractRoot -Recurse -Force
  Remove-Item -LiteralPath $zipFile,$sumFile -Force
  return (Join-Path $nodeHome 'node.exe')
}

function Find-Node {
  if (-not $ForcePortableRuntime) {
    $systemNode = Get-Command node.exe -ErrorAction SilentlyContinue
    if ($systemNode -and (Test-Node20 $systemNode.Source)) { return $systemNode.Source }
  }
  $localNode = Join-Path $RuntimeRoot 'node\node.exe'
  if (Test-Node20 $localNode) { return $localNode }
  return Install-PortableNode
}

function Install-Dependencies([string]$NodeExe) {
  $lockFile = Join-Path $ProjectRoot 'package-lock.json'
  $stampFile = Assert-ProjectChild (Join-Path $RuntimeRoot 'package-lock.sha256')
  $lockHash = Get-Sha256 $lockFile
  $markers = @(
    (Join-Path $ProjectRoot 'node_modules\undici\package.json'),
    (Join-Path $ProjectRoot 'node_modules\@decibeltrade\sdk\package.json'),
    (Join-Path $ProjectRoot 'node_modules\risex-client\package.json')
  )
  $currentStamp = if (Test-Path -LiteralPath $stampFile) { (Get-Content -LiteralPath $stampFile -Raw).Trim() } else { '' }
  $missing = @($markers | Where-Object { -not (Test-Path -LiteralPath $_) })
  if ($missing.Count -eq 0 -and $currentStamp -eq $lockHash) {
    Write-Host '依赖已经是最新版本，跳过安装。' -ForegroundColor DarkGray
    return
  }
  Write-Step '正在按 package-lock.json 安装 Node.js 依赖'
  New-Item -ItemType Directory -Path $RuntimeRoot -Force | Out-Null
  $npmCmd = Join-Path (Split-Path -Parent $NodeExe) 'npm.cmd'
  if (Test-Path -LiteralPath $npmCmd) {
    & $npmCmd ci --no-audit --no-fund
  } else {
    $npm = Get-Command npm.cmd -ErrorAction SilentlyContinue
    if (-not $npm) { throw '找到 Node.js，但找不到 npm。请删除 .runtime 后重试。' }
    & $npm.Source ci --no-audit --no-fund
  }
  if ($LASTEXITCODE -ne 0) { throw "npm ci 失败，退出码 $LASTEXITCODE。请检查网络、代理或 npm 源。" }
  $stillMissing = @($markers | Where-Object { -not (Test-Path -LiteralPath $_) })
  if ($stillMissing.Count) { throw '依赖安装不完整（包括 RISEx 可选客户端）。请删除 node_modules 后重试。' }
  Set-Content -LiteralPath $stampFile -Value $lockHash -Encoding Ascii
}

function Test-Python312X64([string]$Executable) {
  if (-not $Executable -or -not (Test-Path -LiteralPath $Executable)) { return $false }
  try {
    # Keep this Python expression free of quote characters.  Windows
    # PowerShell 5.1 removes embedded double quotes while it builds a native
    # process command line, even if the surrounding PowerShell literal is
    # single-quoted.  The old probe consequently reached Python as invalid
    # source and every fresh portable-Python install was rejected.
    $probeCode = 'import struct,sys;print(str(sys.version_info.major)+chr(46)+str(sys.version_info.minor)+chr(58)+str(struct.calcsize(chr(80))*8))'
    $probe = (& $Executable -c $probeCode 2>$null | Select-Object -First 1)
    # Some PowerShell hosts do not populate LASTEXITCODE when a native process
    # is on the left side of a pipeline. A failed probe cannot emit this exact
    # sentinel, so checking the output is both sufficient and more portable.
    return $null -ne $probe -and ([string]$probe).Trim() -eq '3.12:64'
  } catch { return $false }
}

function Test-LighterSdk([string]$Executable, [string]$ExpectedVersion) {
  if (-not $Executable -or -not (Test-Path -LiteralPath $Executable)) { return $false }
  try {
    # See Test-Python312X64: this also has to work in Windows PowerShell 5.1.
    # The package name is expressed as byte values so the Python -c argument
    # contains no quotes for PowerShell to strip.
    $probeCode = 'import importlib.metadata as m;import lighter;print(m.version(bytes((108,105,103,104,116,101,114,45,115,100,107)).decode()))'
    $probe = (& $Executable -c $probeCode 2>$null | Select-Object -First 1)
    return $null -ne $probe -and ([string]$probe).Trim() -eq $ExpectedVersion
  } catch { return $false }
}

function Find-Python312 {
  if ($ForcePortableRuntime) {
    $forcedPortable = Join-Path $RuntimeRoot 'python\python.exe'
    if (Test-Python312X64 $forcedPortable) { return [IO.Path]::GetFullPath($forcedPortable) }
    return ''
  }

  $configured = Get-EnvValue 'LIGHTER_PYTHON'
  if ($configured) {
    $configured = [Environment]::ExpandEnvironmentVariables($configured)
    if (-not [IO.Path]::IsPathRooted($configured)) { $configured = Join-Path $ProjectRoot $configured }
    if (Test-Python312X64 $configured) { return [IO.Path]::GetFullPath($configured) }
    throw "LIGHTER_PYTHON 不是可用的 64 位 Python 3.12：$configured"
  }

  $portable = Join-Path $RuntimeRoot 'python\python.exe'
  if (Test-Python312X64 $portable) { return [IO.Path]::GetFullPath($portable) }

  $candidates = @(
    'C:\Python312\python.exe',
    (Join-Path $env:LOCALAPPDATA 'Programs\Python\Python312\python.exe'),
    (Join-Path $env:LOCALAPPDATA 'Programs\Python\Python312-64\python.exe'),
    (Join-Path $env:ProgramFiles 'Python312\python.exe')
  )
  if (${env:ProgramFiles(x86)}) {
    $candidates += Join-Path ${env:ProgramFiles(x86)} 'Python312\python.exe'
  }

  foreach ($commandName in @('python3.12.exe', 'python.exe', 'python3.exe')) {
    $commands = @(Get-Command $commandName -CommandType Application -ErrorAction SilentlyContinue)
    foreach ($command in $commands) { $candidates += $command.Source }
  }

  $launcher = Get-Command py.exe -ErrorAction SilentlyContinue
  if ($launcher) {
    try {
      $resolved = (& $launcher.Source -3.12 -c 'import sys; print(sys.executable)' 2>$null | Select-Object -First 1)
      if ($resolved -and (Test-Python312X64 $resolved.Trim())) { return $resolved.Trim() }
    } catch {}
  }

  # PEP 514 registry discovery covers per-user, all-user and non-default
  # installation directories even when Python was not added to PATH.
  $registryRoots = @(
    'Registry::HKEY_CURRENT_USER\Software\Python\PythonCore',
    'Registry::HKEY_LOCAL_MACHINE\Software\Python\PythonCore',
    'Registry::HKEY_LOCAL_MACHINE\Software\WOW6432Node\Python\PythonCore'
  )
  foreach ($registryRoot in $registryRoots) {
    if (-not (Test-Path -LiteralPath $registryRoot)) { continue }
    foreach ($versionKey in @(Get-ChildItem -LiteralPath $registryRoot -ErrorAction SilentlyContinue)) {
      if ($versionKey.PSChildName -notmatch '^3\.12(?:$|[-.])') { continue }
      $installKeyPath = Join-Path $versionKey.PSPath 'InstallPath'
      $installKey = Get-Item -LiteralPath $installKeyPath -ErrorAction SilentlyContinue
      if (-not $installKey) { continue }
      $executable = $installKey.GetValue('ExecutablePath')
      $installDir = $installKey.GetValue('')
      if ($executable) { $candidates += [string]$executable }
      if ($installDir) { $candidates += Join-Path ([string]$installDir) 'python.exe' }
    }
  }

  $seen = @{}
  foreach ($candidate in $candidates) {
    if (-not $candidate) { continue }
    $expanded = [Environment]::ExpandEnvironmentVariables([string]$candidate)
    $key = $expanded.ToLowerInvariant()
    if ($seen.ContainsKey($key)) { continue }
    $seen[$key] = $true
    if (Test-Python312X64 $expanded) { return [IO.Path]::GetFullPath($expanded) }
  }
  return ''
}

function Install-PortablePython312 {
  Write-Step 'RHC LIVE 需要 Python 3.12，正在准备项目内 64 位便携运行环境'
  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
  New-Item -ItemType Directory -Path $RuntimeRoot -Force | Out-Null
  $downloads = Assert-ProjectChild (Join-Path $RuntimeRoot 'downloads')
  New-Item -ItemType Directory -Path $downloads -Force | Out-Null
  $arch = Get-WindowsArch
  if ($arch -eq 'x86') { throw 'RHC Lighter 官方签名器需要可运行 x64 程序的 64 位 Windows。' }
  # The pinned official Lighter signer is Windows x64. Windows on ARM can run
  # the amd64 Python build through its x64 compatibility layer.
  $version = '3.12.10'
  $fileName = "python-$version-embed-amd64.zip"
  $zipFile = Assert-ProjectChild (Join-Path $downloads $fileName)
  $expectedHash = '4acbed6dd1c744b0376e3b1cf57ce906f9dc9e95e68824584c8099a63025a3c3'
  Invoke-WebRequest -UseBasicParsing -Uri "https://www.python.org/ftp/python/$version/$fileName" -OutFile $zipFile -TimeoutSec 300
  if ((Get-Sha256 $zipFile) -ne $expectedHash) {
    Remove-Item -LiteralPath $zipFile -Force -ErrorAction SilentlyContinue
    throw 'Python 官方便携包 SHA-256 校验失败，已拒绝使用。'
  }

  $pythonHome = Assert-ProjectChild (Join-Path $RuntimeRoot 'python')
  $extractRoot = Assert-ProjectChild (Join-Path $RuntimeRoot ("python-extract-" + $PID))
  if (Test-Path -LiteralPath $extractRoot) { Remove-Item -LiteralPath $extractRoot -Recurse -Force }
  New-Item -ItemType Directory -Path $extractRoot -Force | Out-Null
  try {
    Expand-Archive -LiteralPath $zipFile -DestinationPath $extractRoot -Force
    $pthFile = Join-Path $extractRoot 'python312._pth'
    if (-not (Test-Path -LiteralPath $pthFile)) { throw 'Python 便携包缺少 python312._pth。' }
    [IO.File]::WriteAllText(
      $pthFile,
      "python312.zip`r`n.`r`nLib\site-packages`r`nimport site`r`n",
      [Text.Encoding]::ASCII
    )
    New-Item -ItemType Directory -Path (Join-Path $extractRoot 'Lib\site-packages') -Force | Out-Null
    $stagedPython = Join-Path $extractRoot 'python.exe'
    if (-not (Test-Python312X64 $stagedPython)) { throw '解压后的 Python 不是可用的 64 位 3.12。' }
    if (Test-Path -LiteralPath $pythonHome) { Remove-Item -LiteralPath $pythonHome -Recurse -Force }
    Move-Item -LiteralPath $extractRoot -Destination $pythonHome
  } finally {
    Remove-Item -LiteralPath $zipFile -Force -ErrorAction SilentlyContinue
    if (Test-Path -LiteralPath $extractRoot) { Remove-Item -LiteralPath $extractRoot -Recurse -Force -ErrorAction SilentlyContinue }
  }
  $pythonExe = Join-Path $pythonHome 'python.exe'
  if (-not (Test-Python312X64 $pythonExe)) { throw '项目内 Python 便携环境安装失败。' }
  return $pythonExe
}

function Install-PortableLighterSdk(
  [string]$PythonExe,
  [string]$Requirements,
  [string]$ExpectedVersion,
  [string]$RequirementsHash
) {
  $pythonHome = Split-Path -Parent $PythonExe
  $sitePackages = Assert-ProjectChild (Join-Path $pythonHome 'Lib\site-packages')
  New-Item -ItemType Directory -Path $sitePackages -Force | Out-Null
  $stamp = Assert-ProjectChild (Join-Path $pythonHome '.requirements.sha256')
  $current = if (Test-Path -LiteralPath $stamp) { (Get-Content -LiteralPath $stamp -Raw).Trim() } else { '' }
  if ($current -eq $RequirementsHash -and (Test-LighterSdk $PythonExe $ExpectedVersion)) { return }

  Write-Step '正在向项目内便携环境安装 RHC Lighter 官方 Python SDK'
  $downloads = Assert-ProjectChild (Join-Path $RuntimeRoot 'downloads')
  New-Item -ItemType Directory -Path $downloads -Force | Out-Null
  $pipWheel = Assert-ProjectChild (Join-Path $downloads 'pip-26.1.2-py3-none-any.whl')
  $pipUrl = 'https://files.pythonhosted.org/packages/5d/95/6b5cb3461ea5673ba0995989746db58eb18b91b54dbf331e72f569540946/pip-26.1.2-py3-none-any.whl'
  $pipHash = '382ff9f685ee3bc25864f820aa50505825f10f5458ffff07e30a6d96e5715cab'
  Invoke-WebRequest -UseBasicParsing -Uri $pipUrl -OutFile $pipWheel -TimeoutSec 120
  try {
    if ((Get-Sha256 $pipWheel) -ne $pipHash) { throw 'pip 官方 wheel 的 SHA-256 校验失败，已拒绝执行。' }
    $bootstrap = 'import sys; sys.path.insert(0, sys.argv.pop(1)); from pip._internal.cli.main import main; raise SystemExit(main())'
    & $PythonExe -c $bootstrap $pipWheel install --disable-pip-version-check --no-cache-dir --only-binary=:all: --upgrade --target $sitePackages -r $Requirements
    if (-not (Test-LighterSdk $PythonExe $ExpectedVersion)) {
      throw "lighter-sdk $ExpectedVersion 无法在便携 Python 中加载。请检查网络是否允许访问 pypi.org 和 files.pythonhosted.org。"
    }
    Set-Content -LiteralPath $stamp -Value $RequirementsHash -Encoding Ascii
  } finally {
    Remove-Item -LiteralPath $pipWheel -Force -ErrorAction SilentlyContinue
  }
}

function Ensure-LighterRuntime {
  if ((Get-EnvValue 'LR_MODE').ToLowerInvariant() -ne 'live') {
    Write-Host 'RHC 当前不是 LIVE，跳过 Python 签名环境。' -ForegroundColor DarkGray
    return
  }
  $python = Find-Python312
  if (-not $python) { $python = Install-PortablePython312 }
  $requirements = Join-Path $ProjectRoot 'requirements-lighter.txt'
  $hash = Get-Sha256 $requirements
  $requirementLine = Get-Content -LiteralPath $requirements | Where-Object { $_ -match '^\s*lighter-sdk\s*==\s*' } | Select-Object -First 1
  if (-not $requirementLine) { throw 'requirements-lighter.txt 缺少锁定的 lighter-sdk 版本。' }
  $expectedSdkVersion = ($requirementLine -split '==', 2)[1].Trim()

  $portablePython = Join-Path $RuntimeRoot 'python\python.exe'
  if ([IO.Path]::GetFullPath($python).Equals([IO.Path]::GetFullPath($portablePython), [StringComparison]::OrdinalIgnoreCase)) {
    Install-PortableLighterSdk $python $requirements $expectedSdkVersion $hash
    $env:LIGHTER_PYTHON = $python
    return
  }

  $venv = Assert-ProjectChild (Join-Path $ProjectRoot '.lighter-venv')
  $venvPython = Join-Path $venv 'Scripts\python.exe'
  if ((Test-Path -LiteralPath $venvPython) -and -not (Test-Python312X64 $venvPython)) {
    Remove-Item -LiteralPath $venv -Recurse -Force
  }
  if (-not (Test-Path -LiteralPath $venvPython)) {
    Write-Step '正在创建 RHC Lighter 隔离签名环境'
    & $python -m venv $venv
    if (-not (Test-Path -LiteralPath $venvPython)) { throw '创建 .lighter-venv 失败。' }
  }

  $stamp = Join-Path $venv '.requirements.sha256'
  $current = if (Test-Path -LiteralPath $stamp) { (Get-Content -LiteralPath $stamp -Raw).Trim() } else { '' }
  if ($current -ne $hash -or -not (Test-LighterSdk $venvPython $expectedSdkVersion)) {
    Write-Step '正在安装 RHC Lighter 官方 Python SDK'
    & $venvPython -m pip install --disable-pip-version-check --no-cache-dir -r $requirements
    if (-not (Test-LighterSdk $venvPython $expectedSdkVersion)) {
      throw "lighter-sdk $expectedSdkVersion 安装或加载失败。请检查网络、安全软件和 Python 架构。"
    }
    Set-Content -LiteralPath $stamp -Value $hash -Encoding Ascii
  }
  $env:LIGHTER_PYTHON = $venvPython
}

function Test-TcpPort([string]$HostName, [int]$Port) {
  $client = [Net.Sockets.TcpClient]::new()
  try {
    $async = $client.BeginConnect($HostName, $Port, $null, $null)
    if (-not $async.AsyncWaitHandle.WaitOne(600)) { return $false }
    $client.EndConnect($async)
    return $true
  } catch { return $false } finally { $client.Dispose() }
}

function Test-ExistingGridBot([string]$Url) {
  try {
    $result = Invoke-RestMethod -Uri "$Url/api/overview" -TimeoutSec 2
    return $null -ne $result.de -and $null -ne $result.ex -and $null -ne $result.rs -and $null -ne $result.ar -and $null -ne $result.lr
  } catch { return $false }
}

function Main {
  Set-Location -LiteralPath $ProjectRoot
  Write-Host '五交易所网格机器人 · Windows 一键启动' -ForegroundColor Green
  Write-Host "项目目录：$ProjectRoot" -ForegroundColor DarkGray

  $envFile = Join-Path $ProjectRoot '.env'
  if (-not (Test-Path -LiteralPath $envFile)) {
    $envTemplate = Join-Path $ProjectRoot '.env.example'
    if (-not (Test-Path -LiteralPath $envTemplate)) {
      $legacyTemplate = Join-Path $ProjectRoot 'env.example'
      if (Test-Path -LiteralPath $legacyTemplate) {
        $envTemplate = $legacyTemplate
        Write-Host '提示：发现 env.example；建议将它改名为 .env.example。' -ForegroundColor Yellow
      } else {
        throw '缺少配置模板 .env.example。请重新完整下载并解压项目，不要只复制一键启动文件。'
      }
    }
    Copy-Item -LiteralPath $envTemplate -Destination $envFile
    Write-Host '已创建全 PAPER 安全配置 .env；首次启动不会发送真实订单。' -ForegroundColor Yellow
  }

  $node = Find-Node
  Write-Host "Node.js：$(& $node --version)  ($node)" -ForegroundColor DarkGray
  Install-Dependencies $node
  Ensure-LighterRuntime

  Write-Step '启动前配置预检'
  & $node (Join-Path $ProjectRoot 'scripts\preflight.js')
  if ($LASTEXITCODE -ne 0) { throw '配置预检未通过。' }
  if ($InstallOnly) {
    Write-Host "`n安装和配置检查已完成（InstallOnly），未启动服务器。" -ForegroundColor Green
    return
  }

  $hostValue = Get-EnvValue 'HOST'
  if (-not $hostValue) { $hostValue = '127.0.0.1' }
  $portValue = Get-EnvValue 'PORT'
  $port = if ($portValue) { [int]$portValue } else { 8283 }
  $browserHost = if ($hostValue -in @('0.0.0.0', '::')) { '127.0.0.1' } else { $hostValue }
  $url = "http://${browserHost}:$port"

  if (Test-TcpPort $browserHost $port) {
    if (Test-ExistingGridBot $url) {
      Write-Host "程序已在运行，直接打开：$url" -ForegroundColor Yellow
      if (-not $NoBrowser) { Start-Process $url }
      return
    }
    throw "端口 $port 已被其他程序占用。不会关闭该程序；请在 .env 中修改 PORT 后重试。"
  }

  Write-Step "正在启动服务器：$url"
  Write-Host '保持此窗口开启；关闭窗口或按 Ctrl+C 会停止本次实例。' -ForegroundColor Yellow
  $browserJob = $null
  if (-not $NoBrowser) {
    $browserJob = Start-Job -ScriptBlock {
      param($TargetUrl)
      for ($attempt = 0; $attempt -lt 90; $attempt++) {
        try {
          Invoke-WebRequest -UseBasicParsing -Uri "$TargetUrl/api/overview" -TimeoutSec 1 | Out-Null
          Start-Process $TargetUrl
          return
        } catch { Start-Sleep -Milliseconds 500 }
      }
    } -ArgumentList $url
  }
  try {
    & $node (Join-Path $ProjectRoot 'src\server.js')
    if ($LASTEXITCODE -ne 0) { throw "服务器退出，退出码 $LASTEXITCODE。" }
  } finally {
    if ($browserJob) {
      Stop-Job -Job $browserJob -ErrorAction SilentlyContinue
      Remove-Job -Job $browserJob -Force -ErrorAction SilentlyContinue
    }
  }
}

try {
  Main
  exit 0
} catch {
  Write-Host "`n[启动失败] $($_.Exception.Message)" -ForegroundColor Red
  Write-Host '请检查网络、.env 配置，并查阅 docs\常见问题.md。' -ForegroundColor Yellow
  exit 1
}
