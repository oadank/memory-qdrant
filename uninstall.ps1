# uninstall.ps1
# 必须以管理员身份运行

# 检查管理员权限
if (-NOT ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole] "Administrator")) {
    Write-Host "请以管理员身份运行此脚本！" -ForegroundColor Red
    exit 1
}

# 切换到脚本所在目录（仓库根目录）
Set-Location $PSScriptRoot

# 定义路径
$nssmExe = "$PSScriptRoot\nssm\nssm.exe"
$qdrantDir = "$PSScriptRoot\Qdrant"
$autoSummaryDir = "$PSScriptRoot\auto_summary"
$scriptPath = "$PSScriptRoot\管理Qdrant记忆.ps1"
$shortcutPath = "$env:USERPROFILE\Desktop\Qdrant记忆管理.lnk"

Write-Host "========== 开始卸载 Memory Qdrant 插件 ==========" -ForegroundColor Yellow

# ==================== 卸载 Qdrant 服务 ====================
$qdrantServiceName = "qdrant"
if (Get-Service $qdrantServiceName -ErrorAction SilentlyContinue) {
    Write-Host "正在停止并删除 Qdrant 服务 ($qdrantServiceName) ..." -ForegroundColor Cyan
    # 尝试用 nssm 删除
    if (Test-Path $nssmExe) {
        & $nssmExe stop $qdrantServiceName
        & $nssmExe remove $qdrantServiceName confirm
    } else {
        # 回退到 sc 命令
        Stop-Service $qdrantServiceName -Force
        sc.exe delete $qdrantServiceName
    }
    Write-Host "Qdrant 服务已删除。" -ForegroundColor Green
} else {
    Write-Host "Qdrant 服务不存在，跳过。" -ForegroundColor Yellow
}

# ==================== 卸载自动总结服务 ====================
$summaryServiceName = "qdmemauto"
if (Get-Service $summaryServiceName -ErrorAction SilentlyContinue) {
    Write-Host "正在停止并删除自动总结服务 ($summaryServiceName) ..." -ForegroundColor Cyan
    if (Test-Path $nssmExe) {
        & $nssmExe stop $summaryServiceName
        & $nssmExe remove $summaryServiceName confirm
    } else {
        Stop-Service $summaryServiceName -Force
        sc.exe delete $summaryServiceName
    }
    Write-Host "自动总结服务已删除。" -ForegroundColor Green
} else {
    Write-Host "自动总结服务不存在，跳过。" -ForegroundColor Yellow
}

# ==================== 删除桌面快捷方式 ====================
if (Test-Path $shortcutPath) {
    Remove-Item $shortcutPath -Force
    Write-Host "桌面快捷方式已删除。" -ForegroundColor Green
} else {
    Write-Host "桌面快捷方式不存在，跳过。" -ForegroundColor Yellow
}

# ==================== 询问是否删除数据和日志 ====================
Write-Host ""
Write-Host "是否要删除 Qdrant 数据和日志文件？" -ForegroundColor Yellow
Write-Host "注意：这将删除所有存储的记忆数据，且不可恢复！" -ForegroundColor Red
$delData = Read-Host "删除 Qdrant 数据？(Y/N)"
if ($delData -eq 'Y' -or $delData -eq 'y') {
    # 删除 storage、snapshots 和 logs 目录
    $pathsToDelete = @(
        "$qdrantDir\storage",
        "$qdrantDir\snapshots",
        "$qdrantDir\logs"
    )
    foreach ($p in $pathsToDelete) {
        if (Test-Path $p) {
            Remove-Item -Recurse -Force $p
            Write-Host "已删除: $p" -ForegroundColor Green
        }
    }
    Write-Host "Qdrant 数据已清除。" -ForegroundColor Green
} else {
    Write-Host "保留 Qdrant 数据。" -ForegroundColor Cyan
}

Write-Host ""
$delLogs = Read-Host "是否删除自动总结日志文件（summary_*.log）？(Y/N)"
if ($delLogs -eq 'Y' -or $delLogs -eq 'y') {
    $summaryLogs = @(
        "$autoSummaryDir\summary_stdout.log",
        "$autoSummaryDir\summary_stderr.log"
    )
    foreach ($log in $summaryLogs) {
        if (Test-Path $log) {
            Remove-Item $log -Force
            Write-Host "已删除: $log" -ForegroundColor Green
        }
    }
} else {
    Write-Host "保留自动总结日志。" -ForegroundColor Cyan
}

# ==================== 可选：清理 OpenClaw 配置 ====================
Write-Host ""
Write-Host "如果你希望从 OpenClaw 配置中移除插件路径，请手动编辑：" -ForegroundColor Yellow
$openClawConfig = "$env:USERPROFILE\.openclaw\openclaw.json"
if (Test-Path $openClawConfig) {
    Write-Host "配置文件路径: $openClawConfig" -ForegroundColor Cyan
    Write-Host "删除 plugins.load.paths 中与以下路径匹配的条目：" -ForegroundColor Cyan
    Write-Host "  `"$PSScriptRoot`"" -ForegroundColor White
} else {
    Write-Host "未找到 OpenClaw 配置文件，无需清理。" -ForegroundColor Cyan
}

# ==================== 完成提示 ====================
Write-Host ""
Write-Host "🎉 卸载完成！" -ForegroundColor Green
Write-Host "插件目录 $PSScriptRoot 仍保留，如需彻底删除请手动删除该文件夹。" -ForegroundColor Yellow