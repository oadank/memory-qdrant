# install.ps1
# 必须以管理员身份运行

# 检查管理员权限
if (-NOT ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole] "Administrator")) {
    Write-Host "请以管理员身份运行此脚本！" -ForegroundColor Red
    exit 1
}

# 切换到脚本所在目录（仓库根目录）
Set-Location $PSScriptRoot

# 定义关键路径
$qdrantDir = "$PSScriptRoot\Qdrant"
$qdrantExe = "$qdrantDir\qdrant.exe"
$nssmExe   = "$PSScriptRoot\nssm\nssm.exe"
$logsDir   = "$qdrantDir\logs"
$scriptPath = "$PSScriptRoot\管理Qdrant记忆.ps1"   # 正确路径
$serviceName = "qdrant"
$serviceDisplayName = "Qdrant Service"
$serviceDescription = "Qdrant向量数据库服务，用于OpenClaw记忆插件"

# 检查服务是否已存在
if (Get-Service $serviceName -ErrorAction SilentlyContinue) {
    Write-Host "服务 $serviceName 已存在，正在停止并删除..." -ForegroundColor Yellow
    & $nssmExe stop $serviceName
    & $nssmExe remove $serviceName confirm
}

# 安装服务
Write-Host "正在安装服务 $serviceName ..." -ForegroundColor Cyan
& $nssmExe install $serviceName "`"$qdrantExe`""

# 设置启动目录（关键！确保 Qdrant 在正确目录运行）
& $nssmExe set $serviceName AppDirectory "`"$qdrantDir`""

# 设置服务显示名称和描述
& $nssmExe set $serviceName DisplayName "$serviceDisplayName"
& $nssmExe set $serviceName Description "$serviceDescription"

# 设置登录账户：本地系统账户，并允许与桌面交互
& $nssmExe set $serviceName ObjectName LocalSystem
& $nssmExe set $serviceName AppNoConsole 0   # 允许服务与桌面交互

# 设置 I/O 重定向（日志文件）
& $nssmExe set $serviceName AppStdout  "`"$logsDir\output.log`""
& $nssmExe set $serviceName AppStderr  "`"$logsDir\error.log`""
& $nssmExe set $serviceName AppStdin   "`"$logsDir\input.log`""   # 可选

# 设置服务启动类型为自动
& $nssmExe set $serviceName Start SERVICE_AUTO_START

# 启动服务
& $nssmExe start $serviceName

# 等待几秒并验证服务状态
Start-Sleep -Seconds 5
try {
    $response = Invoke-RestMethod -Uri "http://localhost:6333/collections" -ErrorAction Stop
    Write-Host "Qdrant 服务已成功启动，返回：$($response | ConvertTo-Json)" -ForegroundColor Green
} catch {
    Write-Host "Qdrant 服务启动失败，请检查日志目录：$logsDir" -ForegroundColor Red
}

# 创建桌面快捷方式（管理脚本）
$shortcutPath = "$env:USERPROFILE\Desktop\Qdrant记忆管理.lnk"
$ws = New-Object -ComObject WScript.Shell
$shortcut = $ws.CreateShortcut($shortcutPath)
$shortcut.TargetPath = "powershell.exe"
$shortcut.Arguments = "-NoExit -File `"$scriptPath`""
$shortcut.Description = "管理 Qdrant 记忆"
$shortcut.WorkingDirectory = "$PSScriptRoot"
$shortcut.Save()

Write-Host "桌面快捷方式已创建。" -ForegroundColor Green

# ==================== 安装自动总结服务 ====================
Write-Host "正在配置自动总结服务..." -ForegroundColor Cyan

$pythonExe = "C:\Users\oadan\AppData\Local\Programs\Python\Python312\python.exe"
$autoSummaryDir = "$PSScriptRoot\auto_summary"
$summaryScript = "auto_summary.py"
$summaryLogDir = $autoSummaryDir   # 日志直接放在 auto_summary 目录下
$summaryServiceName = "qdmemauto"
$summaryDisplayName = "Memory Auto Summary Service"
$summaryDescription = "自动总结服务，每6小时执行一次记忆总结"

# 检查 Python 解释器是否存在
if (-not (Test-Path $pythonExe)) {
    Write-Host "错误：找不到 Python 解释器，路径 $pythonExe 无效。" -ForegroundColor Red
    exit 1
}

# 检查脚本是否存在
if (-not (Test-Path "$autoSummaryDir\$summaryScript")) {
    Write-Host "错误：找不到自动总结脚本 $autoSummaryDir\$summaryScript" -ForegroundColor Red
    exit 1
}

# 检查并停止/删除已存在的自动总结服务
if (Get-Service $summaryServiceName -ErrorAction SilentlyContinue) {
    Write-Host "服务 $summaryServiceName 已存在，正在停止并删除..." -ForegroundColor Yellow
    & $nssmExe stop $summaryServiceName
    & $nssmExe remove $summaryServiceName confirm
}

# 安装自动总结服务
& $nssmExe install $summaryServiceName "`"$pythonExe`""
& $nssmExe set $summaryServiceName AppDirectory "`"$autoSummaryDir`""
& $nssmExe set $summaryServiceName AppParameters "$summaryScript"
& $nssmExe set $summaryServiceName DisplayName "$summaryDisplayName"
& $nssmExe set $summaryServiceName Description "$summaryDescription"
& $nssmExe set $summaryServiceName ObjectName LocalSystem
& $nssmExe set $summaryServiceName AppNoConsole 0   # 允许与桌面交互
& $nssmExe set $summaryServiceName AppStdout "`"$summaryLogDir\summary_stdout.log`""
& $nssmExe set $summaryServiceName AppStderr "`"$summaryLogDir\summary_stderr.log`""
& $nssmExe set $summaryServiceName Start SERVICE_AUTO_START
& $nssmExe start $summaryServiceName

Write-Host "自动总结服务已启动。" -ForegroundColor Green

# ==================== 配置 OpenClaw 并重启 ====================
Write-Host ""
Write-Host "========== 配置 OpenClaw 插件 ==========" -ForegroundColor Yellow

$openClawConfigPath = "$env:USERPROFILE\.openclaw\openclaw.json"
$pluginPath = $PSScriptRoot

if (Test-Path $openClawConfigPath) {
    Write-Host "找到 OpenClaw 配置文件：$openClawConfigPath" -ForegroundColor Cyan
    
    try {
        # 读取配置文件（保留原始编码）
        $configJson = Get-Content $openClawConfigPath -Raw
        $config = $configJson | ConvertFrom-Json
        
        # 确保 plugins.load.paths 存在
        if (-not $config.plugins) {
            $config | Add-Member -NotePropertyName plugins -NotePropertyValue @{ load = @{ paths = @() } }
        } elseif (-not $config.plugins.load) {
            $config.plugins | Add-Member -NotePropertyName load -NotePropertyValue @{ paths = @() }
        } elseif (-not $config.plugins.load.paths) {
            $config.plugins.load | Add-Member -NotePropertyName paths -NotePropertyValue @()
        }
        
        # 如果插件路径未添加，则添加
        if ($config.plugins.load.paths -notcontains $pluginPath) {
            $config.plugins.load.paths += $pluginPath
            # 保存回文件（保持 JSON 格式）
            $config | ConvertTo-Json -Depth 10 | Set-Content $openClawConfigPath -Encoding UTF8
            Write-Host "✅ 已将插件路径添加到 openclaw.json" -ForegroundColor Green
        } else {
            Write-Host "插件路径已存在，无需重复添加。" -ForegroundColor Yellow
        }
    } catch {
        Write-Host "⚠️ 处理 openclaw.json 时出错：$_" -ForegroundColor Red
        Write-Host "请手动添加插件路径到 openclaw.json。" -ForegroundColor Yellow
    }
} else {
    Write-Host "未找到 OpenClaw 配置文件 ($openClawConfigPath)" -ForegroundColor Yellow
    Write-Host "请确保 OpenClaw 已安装，并手动将以下路径添加到其配置文件中：" -ForegroundColor Cyan
    Write-Host "  `"$pluginPath`"" -ForegroundColor White
}

# ==================== 重启 OpenClaw ====================
Write-Host ""
Write-Host "========== 准备重启 OpenClaw ==========" -ForegroundColor Yellow
Write-Host "此操作将停止现有 OpenClaw 进程并重新启动。" -ForegroundColor Cyan
$confirm = Read-Host "是否立即重启 OpenClaw？(Y/N)"
if ($confirm -eq 'Y' -or $confirm -eq 'y') {
    Write-Host "[1/4] 正在停止 OpenClaw 计划任务..." -ForegroundColor Cyan
    schtasks /End /TN "OpenClaw Gateway" 2>$null
    
    Write-Host "[2/4] 正在强制杀死残留 Node 进程..." -ForegroundColor Cyan
    taskkill /f /t /im node.exe 2>$null
    
    Write-Host "[3/4] 等待端口 18789 释放..." -ForegroundColor Cyan
    Start-Sleep -Seconds 3
    
    Write-Host "[4/4] 启动网关新窗口..." -ForegroundColor Cyan
    $openClawDir = "$env:USERPROFILE\.openclaw"
    if (Test-Path "$openClawDir\gateway.cmd") {
        Start-Process -FilePath "cmd.exe" -ArgumentList "/k gateway.cmd start" -WorkingDirectory $openClawDir -WindowStyle Normal
        Write-Host ""
        Write-Host "==============================================" -ForegroundColor Green
        Write-Host "重启完成！如果新窗口提示 'Started'，就没问题了。" -ForegroundColor Green
        Write-Host "如果新窗口还报错，请检查是否有其他程序占用了 18789。" -ForegroundColor Green
        Write-Host "==============================================" -ForegroundColor Green
    } else {
        Write-Host "错误：找不到 $openClawDir\gateway.cmd" -ForegroundColor Red
    }
} else {
    Write-Host "跳过重启 OpenClaw。请稍后手动重启以应用插件配置。" -ForegroundColor Yellow
}

# ==================== 测试提示 ====================
Write-Host ""
Write-Host "🎉 安装完成！" -ForegroundColor Green
Write-Host "你可以双击桌面上的快捷方式运行管理脚本，或直接运行：$scriptPath"
$testConfirm = Read-Host "是否立即运行管理脚本测试服务是否安装成功？(Y/N)"
if ($testConfirm -eq 'Y' -or $testConfirm -eq 'y') {
    & $scriptPath
} else {
    Write-Host "你可以稍后手动运行管理脚本进行测试。" -ForegroundColor Yellow
}