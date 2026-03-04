# Qdrant 记忆管理器 - Windows 服务安装脚本
# 使用方法：右键 - 以管理员身份运行

$ErrorActionPreference = "Continue"

Write-Host "========================================"
Write-Host "  Qdrant 记忆管理器 - 服务安装程序"
Write-Host "========================================"
Write-Host ""

# 获取脚本所在目录
$SCRIPT_DIR = Split-Path -Parent $MyInvocation.MyCommand.Path
$SERVICE_NAME = "QdrantMemoryManager"
$WORK_DIR = $SCRIPT_DIR
$LOG_DIR = "$WORK_DIR\logs"

# 动态获取 Node.js 路径
$NODE_EXE = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $NODE_EXE) {
    Write-Host "错误：未找到 Node.js，请先安装 Node.js" -ForegroundColor Red
    Write-Host "按任意键退出..."
    $null = $Host.UI.RawUI.ReadKey("NoEcho,IncludeKeyDown")
    exit 1
}
Write-Host "Node.js 路径：$NODE_EXE"

# 检查 server.js
$SERVER_SCRIPT = "$SCRIPT_DIR\server.js"
if (!(Test-Path $SERVER_SCRIPT)) {
    Write-Host "错误：未找到 server.js" -ForegroundColor Red
    Write-Host "按任意键退出..."
    $null = $Host.UI.RawUI.ReadKey("NoEcho,IncludeKeyDown")
    exit 1
}

# 创建日志目录
if (!(Test-Path $LOG_DIR)) {
    New-Item -ItemType Directory -Path $LOG_DIR | Out-Null
    Write-Host "已创建日志目录：$LOG_DIR"
}

# 停止并删除旧服务
Write-Host ""
Write-Host "正在清理旧服务..."
Start-Process -FilePath "$SCRIPT_DIR\nssm\nssm.exe" -ArgumentList "stop $SERVICE_NAME" -NoNewWindow -Wait -RedirectStandardOutput $null 2>&1 | Out-Null
Start-Process -FilePath "$SCRIPT_DIR\nssm\nssm.exe" -ArgumentList "remove $SERVICE_NAME confirm" -NoNewWindow -Wait -RedirectStandardOutput $null 2>&1 | Out-Null
Write-Host "  旧服务已清理"

# 安装新服务
Write-Host ""
Write-Host "正在安装服务..."

# 使用 NSSM 的 add 命令进行完整配置
$psi = New-Object System.Diagnostics.ProcessStartInfo
$psi.CreateNoWindow = $true
$psi.UseShellExecute = $false
$psi.RedirectStandardOutput = $true
$psi.RedirectStandardError = $true
$psi.FileName = "$SCRIPT_DIR\nssm\nssm.exe"
$psi.Arguments = "add $SERVICE_NAME `"$NODE_EXE`" `"$SERVER_SCRIPT`""
$psi.WorkingDirectory = $WORK_DIR

$process = [System.Diagnostics.Process]::Start($psi)
$process.WaitForExit()

if ($process.ExitCode -ne 0) {
    Write-Host "服务安装失败" -ForegroundColor Red
    Write-Host "按任意键退出..."
    $null = $Host.UI.RawUI.ReadKey("NoEcho,IncludeKeyDown")
    exit 1
}

# 配置服务参数
Write-Host "正在配置服务..."

# 设置显示名称
Start-Process -FilePath "$SCRIPT_DIR\nssm\nssm.exe" -ArgumentList "set $SERVICE_NAME DisplayName `"Qdrant 记忆管理器`"" -NoNewWindow -Wait
# 设置服务描述
Start-Process -FilePath "$SCRIPT_DIR\nssm\nssm.exe" -ArgumentList "set $SERVICE_NAME Description `"Qdrant 向量记忆管理服务 - 提供 Web 界面管理和检索 AI 记忆`"" -NoNewWindow -Wait
# 设置自动启动
Start-Process -FilePath "$SCRIPT_DIR\nssm\nssm.exe" -ArgumentList "set $SERVICE_NAME Start SERVICE_AUTO_START" -NoNewWindow -Wait
# 设置工作目录
Start-Process -FilePath "$SCRIPT_DIR\nssm\nssm.exe" -ArgumentList "set $SERVICE_NAME AppDirectory `"$WORK_DIR`"" -NoNewWindow -Wait
# 设置日志
Start-Process -FilePath "$SCRIPT_DIR\nssm\nssm.exe" -ArgumentList "set $SERVICE_NAME AppStdout `"$LOG_DIR\service.log`"" -NoNewWindow -Wait
Start-Process -FilePath "$SCRIPT_DIR\nssm\nssm.exe" -ArgumentList "set $SERVICE_NAME AppStderr `"$LOG_DIR\service-error.log`"" -NoNewWindow -Wait
# 设置崩溃重启
Start-Process -FilePath "$SCRIPT_DIR\nssm\nssm.exe" -ArgumentList "set $SERVICE_NAME AppExit Default Restart" -NoNewWindow -Wait
Start-Process -FilePath "$SCRIPT_DIR\nssm\nssm.exe" -ArgumentList "set $SERVICE_NAME AppRestartDelay 5000" -NoNewWindow -Wait
# 设置 LocalSystem 账户
Start-Process -FilePath "$SCRIPT_DIR\nssm\nssm.exe" -ArgumentList "set $SERVICE_NAME ObjectName LocalSystem" -NoNewWindow -Wait

# 启动服务
Write-Host ""
Write-Host "正在启动服务..."
Start-Process -FilePath "$SCRIPT_DIR\nssm\nssm.exe" -ArgumentList "start $SERVICE_NAME" -NoNewWindow -Wait
Start-Sleep -Seconds 2

# 验证服务状态
$status = (Get-Service $SERVICE_NAME -ErrorAction SilentlyContinue).Status

Write-Host ""
Write-Host "========================================"
if ($status -eq "Running") {
    Write-Host "  服务安装并启动成功!" -ForegroundColor Green
    Write-Host "  服务名称：$SERVICE_NAME"
    Write-Host "  访问地址：http://localhost:3001"
} else {
    Write-Host "  服务安装完成，但未自动启动" -ForegroundColor Yellow
    Write-Host "  请检查日志：$LOG_DIR\service-error.log"
}
Write-Host "========================================"
Write-Host ""
Write-Host "服务管理命令:"
Write-Host "  查看状态：nssm status $SERVICE_NAME"
Write-Host "  启动服务：nssm start $SERVICE_NAME"
Write-Host "  停止服务：nssm stop $SERVICE_NAME"
Write-Host "  删除服务：nssm remove $SERVICE_NAME confirm"
Write-Host ""
Write-Host "按任意键退出..."
$null = $Host.UI.RawUI.ReadKey("NoEcho,IncludeKeyDown")
