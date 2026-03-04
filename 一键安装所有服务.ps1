# Memory Qdrant - 一键安装所有服务
# 使用方法：右键 - 以管理员身份运行

$ErrorActionPreference = "Continue"

Write-Host "========================================"
Write-Host "  Memory Qdrant - 一键安装所有服务"
Write-Host "========================================"
Write-Host ""

# 获取脚本所在目录
$SCRIPT_DIR = Split-Path -Parent $MyInvocation.MyCommand.Path
$NSSM = "$SCRIPT_DIR\nssm\nssm.exe"
$LOG_DIR = "$SCRIPT_DIR\logs"

# 创建日志目录
if (!(Test-Path $LOG_DIR)) {
    New-Item -ItemType Directory -Path $LOG_DIR | Out-Null
}

Write-Host "日志目录：$LOG_DIR"
Write-Host ""

# ============================
#  1. 安装 Qdrant 向量数据库服务
# ============================
Write-Host "========================================"
Write-Host "  步骤 1/3: 安装 Qdrant 向量数据库"
Write-Host "========================================"
Write-Host ""

$QDRANT_SERVICE = "QdrantDB"
$QDRANT_EXE = "$SCRIPT_DIR\qdrant\qdrant.exe"
$QDRANT_DIR = "$SCRIPT_DIR\qdrant"

if (!(Test-Path $QDRANT_EXE)) {
    Write-Host "[跳过] 未找到 Qdrant 可执行文件" -ForegroundColor Yellow
    Write-Host "        路径：$QDRANT_EXE"
} else {
    # 清理旧服务
    Start-Process -FilePath $NSSM -ArgumentList "stop $QDRANT_SERVICE" -NoNewWindow -Wait 2>&1 | Out-Null
    Start-Process -FilePath $NSSM -ArgumentList "remove $QDRANT_SERVICE confirm" -NoNewWindow -Wait 2>&1 | Out-Null

    # 安装服务
    Write-Host "正在安装 Qdrant 服务..."
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.CreateNoWindow = $true
    $psi.UseShellExecute = $false
    $psi.FileName = $NSSM
    $psi.Arguments = "add $QDRANT_SERVICE `"$QDRANT_EXE`""
    $psi.WorkingDirectory = $SCRIPT_DIR
    [System.Diagnostics.Process]::Start($psi) | Out-Null
    Start-Sleep -Milliseconds 500

    # 配置服务
    Start-Process -FilePath $NSSM -ArgumentList "set $QDRANT_SERVICE DisplayName `"Qdrant 向量数据库`"" -NoNewWindow -Wait
    Start-Process -FilePath $NSSM -ArgumentList "set $QDRANT_SERVICE Description `"Qdrant 向量数据库服务 - 存储和检索 AI 记忆`"" -NoNewWindow -Wait
    Start-Process -FilePath $NSSM -ArgumentList "set $QDRANT_SERVICE Start SERVICE_AUTO_START" -NoNewWindow -Wait
    Start-Process -FilePath $NSSM -ArgumentList "set $QDRANT_SERVICE AppDirectory `"$QDRANT_DIR`"" -NoNewWindow -Wait
    Start-Process -FilePath $NSSM -ArgumentList "set $QDRANT_SERVICE AppStdout `"$LOG_DIR\qdrant-stdout.log`"" -NoNewWindow -Wait
    Start-Process -FilePath $NSSM -ArgumentList "set $QDRANT_SERVICE AppStderr `"$LOG_DIR\qdrant-stderr.log`"" -NoNewWindow -Wait
    Start-Process -FilePath $NSSM -ArgumentList "set $QDRANT_SERVICE ObjectName LocalSystem" -NoNewWindow -Wait

    # 启动服务
    Start-Process -FilePath $NSSM -ArgumentList "start $QDRANT_SERVICE" -NoNewWindow -Wait
    Start-Sleep -Seconds 2

    $status = (Get-Service $QDRANT_SERVICE -ErrorAction SilentlyContinue).Status
    if ($status -eq "Running") {
        Write-Host "[成功] Qdrant 服务已启动" -ForegroundColor Green
    } else {
        Write-Host "[警告] Qdrant 服务未启动，请检查日志" -ForegroundColor Yellow
    }
}
Write-Host ""

# ============================
#  2. 安装自动总结服务
# ============================
Write-Host "========================================"
Write-Host "  步骤 2/3: 安装自动总结服务"
Write-Host "========================================"
Write-Host ""

$SUMMARY_SERVICE = "MemoryAutoSummary"
$PYTHON_EXE = (Get-Command python -ErrorAction SilentlyContinue).Source
$SUMMARY_SCRIPT = "$SCRIPT_DIR\auto_summary\auto_summary.py"
$SUMMARY_DIR = "$SCRIPT_DIR\auto_summary"

if (-not $PYTHON_EXE) {
    Write-Host "[跳过] 未找到 Python，请先安装 Python" -ForegroundColor Yellow
} elseif (!(Test-Path $SUMMARY_SCRIPT)) {
    Write-Host "[跳过] 未找到自动总结脚本" -ForegroundColor Yellow
    Write-Host "        路径：$SUMMARY_SCRIPT"
} else {
    # 清理旧服务
    Start-Process -FilePath $NSSM -ArgumentList "stop $SUMMARY_SERVICE" -NoNewWindow -Wait 2>&1 | Out-Null
    Start-Process -FilePath $NSSM -ArgumentList "remove $SUMMARY_SERVICE confirm" -NoNewWindow -Wait 2>&1 | Out-Null

    # 安装服务
    Write-Host "正在安装自动总结服务..."
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.CreateNoWindow = $true
    $psi.UseShellExecute = $false
    $psi.FileName = $NSSM
    $psi.Arguments = "add $SUMMARY_SERVICE `"$PYTHON_EXE`" `"$SUMMARY_SCRIPT`""
    $psi.WorkingDirectory = $SCRIPT_DIR
    [System.Diagnostics.Process]::Start($psi) | Out-Null
    Start-Sleep -Milliseconds 500

    # 配置服务
    Start-Process -FilePath $NSSM -ArgumentList "set $SUMMARY_SERVICE DisplayName `"记忆自动总结服务`"" -NoNewWindow -Wait
    Start-Process -FilePath $NSSM -ArgumentList "set $SUMMARY_SERVICE Description `"AI 记忆自动总结服务 - 定期将原始对话提炼为精华记忆`"" -NoNewWindow -Wait
    Start-Process -FilePath $NSSM -ArgumentList "set $SUMMARY_SERVICE Start SERVICE_AUTO_START" -NoNewWindow -Wait
    Start-Process -FilePath $NSSM -ArgumentList "set $SUMMARY_SERVICE AppDirectory `"$SUMMARY_DIR`"" -NoNewWindow -Wait
    Start-Process -FilePath $NSSM -ArgumentList "set $SUMMARY_SERVICE AppStdout `"$LOG_DIR\auto_summary-stdout.log`"" -NoNewWindow -Wait
    Start-Process -FilePath $NSSM -ArgumentList "set $SUMMARY_SERVICE AppStderr `"$LOG_DIR\auto_summary-stderr.log`"" -NoNewWindow -Wait
    Start-Process -FilePath $NSSM -ArgumentList "set $SUMMARY_SERVICE ObjectName LocalSystem" -NoNewWindow -Wait

    # 启动服务
    Start-Process -FilePath $NSSM -ArgumentList "start $SUMMARY_SERVICE" -NoNewWindow -Wait
    Start-Sleep -Seconds 2

    $status = (Get-Service $SUMMARY_SERVICE -ErrorAction SilentlyContinue).Status
    if ($status -eq "Running") {
        Write-Host "[成功] 自动总结服务已启动" -ForegroundColor Green
    } else {
        Write-Host "[警告] 自动总结服务未启动，请检查日志" -ForegroundColor Yellow
    }
}
Write-Host ""

# ============================
#  3. 安装记忆管理前端服务
# ============================
Write-Host "========================================"
Write-Host "  步骤 3/3: 安装记忆管理前端服务"
Write-Host "========================================"
Write-Host ""

$FRONTEND_SERVICE = "QdrantMemoryManager"
$NODE_EXE = (Get-Command node -ErrorAction SilentlyContinue).Source
$SERVER_SCRIPT = "$SCRIPT_DIR\server.js"

if (-not $NODE_EXE) {
    Write-Host "[错误] 未找到 Node.js，请先安装 Node.js" -ForegroundColor Red
    Write-Host "按任意键退出..."
    $null = $Host.UI.RawUI.ReadKey("NoEcho,IncludeKeyDown")
    exit 1
} elseif (!(Test-Path $SERVER_SCRIPT)) {
    Write-Host "[错误] 未找到 server.js" -ForegroundColor Red
    Write-Host "按任意键退出..."
    $null = $Host.UI.RawUI.ReadKey("NoEcho,IncludeKeyDown")
    exit 1
}

# 清理旧服务
Start-Process -FilePath $NSSM -ArgumentList "stop $FRONTEND_SERVICE" -NoNewWindow -Wait 2>&1 | Out-Null
Start-Process -FilePath $NSSM -ArgumentList "remove $FRONTEND_SERVICE confirm" -NoNewWindow -Wait 2>&1 | Out-Null

# 安装服务
Write-Host "正在安装记忆管理服务..."
$psi = New-Object System.Diagnostics.ProcessStartInfo
$psi.CreateNoWindow = $true
$psi.UseShellExecute = $false
$psi.FileName = $NSSM
$psi.Arguments = "add $FRONTEND_SERVICE `"$NODE_EXE`" `"$SERVER_SCRIPT`""
$psi.WorkingDirectory = $SCRIPT_DIR
[System.Diagnostics.Process]::Start($psi) | Out-Null
Start-Sleep -Milliseconds 500

# 配置服务
Start-Process -FilePath $NSSM -ArgumentList "set $FRONTEND_SERVICE DisplayName `"Qdrant 记忆管理器`"" -NoNewWindow -Wait
Start-Process -FilePath $NSSM -ArgumentList "set $FRONTEND_SERVICE Description `"Qdrant 向量记忆管理服务 - 提供 Web 界面管理和检索 AI 记忆`"" -NoNewWindow -Wait
Start-Process -FilePath $NSSM -ArgumentList "set $FRONTEND_SERVICE Start SERVICE_AUTO_START" -NoNewWindow -Wait
Start-Process -FilePath $NSSM -ArgumentList "set $FRONTEND_SERVICE AppDirectory `"$SCRIPT_DIR`"" -NoNewWindow -Wait
Start-Process -FilePath $NSSM -ArgumentList "set $FRONTEND_SERVICE AppStdout `"$LOG_DIR\frontend-stdout.log`"" -NoNewWindow -Wait
Start-Process -FilePath $NSSM -ArgumentList "set $FRONTEND_SERVICE AppStderr `"$LOG_DIR\frontend-stderr.log`"" -NoNewWindow -Wait
Start-Process -FilePath $NSSM -ArgumentList "set $FRONTEND_SERVICE ObjectName LocalSystem" -NoNewWindow -Wait
Start-Process -FilePath $NSSM -ArgumentList "set $FRONTEND_SERVICE AppExit Default Restart" -NoNewWindow -Wait
Start-Process -FilePath $NSSM -ArgumentList "set $FRONTEND_SERVICE AppRestartDelay 5000" -NoNewWindow -Wait

# 启动服务
Write-Host ""
Write-Host "正在启动记忆管理服务..."
Start-Process -FilePath $NSSM -ArgumentList "start $FRONTEND_SERVICE" -NoNewWindow -Wait
Start-Sleep -Seconds 2

$status = (Get-Service $FRONTEND_SERVICE -ErrorAction SilentlyContinue).Status

Write-Host ""
Write-Host "========================================"
Write-Host "  安装完成!"
Write-Host "========================================"
Write-Host ""
Write-Host "已安装的服务:"
Write-Host "  1. $QDRANT_SERVICE - Qdrant 向量数据库"
Write-Host "  2. $SUMMARY_SERVICE - 自动总结服务"
Write-Host "  3. $FRONTEND_SERVICE - 记忆管理前端"
Write-Host ""
Write-Host "访问地址：http://localhost:3001"
Write-Host ""
Write-Host "服务管理命令:"
Write-Host "  nssm start <服务名>"
Write-Host "  nssm stop <服务名>"
Write-Host "  nssm remove <服务名> confirm"
Write-Host ""
Write-Host "按任意键退出..."
$null = $Host.UI.RawUI.ReadKey("NoEcho,IncludeKeyDown")
