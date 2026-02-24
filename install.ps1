# install.ps1
# 以管理员身份运行此脚本

# 1. 检查管理员权限
if (-NOT ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole] "Administrator")) {
    Write-Host "请以管理员身份运行此脚本！" -ForegroundColor Red
    exit 1
}

# 2. 切换到脚本所在目录
Set-Location $PSScriptRoot

# 3. 创建必要的文件夹
$dataDir = "$PSScriptRoot\qdrant\data"
$logDir  = "$PSScriptRoot\qdrant\logs"
if (-not (Test-Path $dataDir)) { New-Item -ItemType Directory -Path $dataDir -Force }
if (-not (Test-Path $logDir))  { New-Item -ItemType Directory -Path $logDir  -Force }

# 4. 使用 NSSM 安装 Qdrant 服务
$nssm = "$PSScriptRoot\nssm\nssm.exe"
$qdrantExe = "$PSScriptRoot\qdrant\qdrant.exe"
$serviceName = "QdrantMemory"

# 检查服务是否已存在
if (Get-Service $serviceName -ErrorAction SilentlyContinue) {
    Write-Host "服务 $serviceName 已存在，正在停止并删除..." -ForegroundColor Yellow
    & $nssm stop $serviceName
    & $nssm remove $serviceName confirm
}

# 安装服务
& $nssm install $serviceName $qdrantExe
& $nssm set $serviceName AppParameters "--config-dir `"$PSScriptRoot\qdrant\config`" --data-dir `"$dataDir`""
& $nssm set $serviceName AppStdout "$logDir\stdout.log"
& $nssm set $serviceName AppStderr "$logDir\stderr.log"
& $nssm set $serviceName Start SERVICE_AUTO_START
& $nssm start $serviceName

# 5. 验证 Qdrant 是否正常运行（等待几秒）
Start-Sleep -Seconds 5
try {
    $response = Invoke-RestMethod -Uri "http://localhost:6333/collections" -ErrorAction Stop
    Write-Host "Qdrant 服务已启动，返回：$($response | ConvertTo-Json)" -ForegroundColor Green
} catch {
    Write-Host "Qdrant 服务启动失败，请检查日志目录 $logDir" -ForegroundColor Red
}

# 6. 安装 Python 自动总结技能的依赖
Write-Host "正在安装自动总结技能依赖..." -ForegroundColor Cyan
Set-Location "$PSScriptRoot\auto_summary"
# 假设用户系统已安装 Python，这里可以创建虚拟环境
python -m venv venv
& .\venv\Scripts\pip install -r requirements.txt

# 7. 将管理脚本加入 PATH 或创建快捷方式
$scriptPath = "$PSScriptRoot\scripts\Qdrant记忆.ps1"
# 可选：在用户桌面创建快捷方式
$shortcutPath = "$env:USERPROFILE\Desktop\Qdrant记忆管理.lnk"
$ws = New-Object -ComObject WScript.Shell
$shortcut = $ws.CreateShortcut($shortcutPath)
$shortcut.TargetPath = "powershell.exe"
$shortcut.Arguments = "-NoExit -File `"$scriptPath`""
$shortcut.Description = "管理 Qdrant 记忆"
$shortcut.Save()

Write-Host "安装完成！" -ForegroundColor Green
Write-Host "你可以双击桌面上的快捷方式运行管理脚本，或直接运行：$scriptPath"