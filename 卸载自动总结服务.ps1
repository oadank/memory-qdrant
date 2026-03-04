# 记忆自动总结服务 - 服务卸载脚本
# 使用方法：右键 - 以管理员身份运行

$ErrorActionPreference = "Continue"

Write-Host "========================================"
Write-Host "  记忆自动总结服务 - 卸载程序"
Write-Host "========================================"
Write-Host ""

$SERVICE_NAME = "MemoryAutoSummary"

# 检查服务是否存在
$service = Get-Service $SERVICE_NAME -ErrorAction SilentlyContinue
if (-not $service) {
    Write-Host "服务不存在：$SERVICE_NAME" -ForegroundColor Yellow
    Write-Host "按任意键退出..."
    $null = $Host.UI.RawUI.ReadKey("NoEcho,IncludeKeyDown")
    exit 0
}

Write-Host "找到服务：$SERVICE_NAME"
Write-Host "服务状态：$($service.Status)"
Write-Host ""

# 确认删除
Write-Host "是否删除此服务？"
Write-Host "按 Y 确认，其他键取消..."
$confirm = $Host.UI.RawUI.ReadKey("NoEcho,IncludeKeyDown")

if ($confirm.Character -ne 'Y' -and $confirm.Character -ne 'y') {
    Write-Host ""
    Write-Host "已取消"
    Write-Host "按任意键退出..."
    $null = $Host.UI.RawUI.ReadKey("NoEcho,IncludeKeyDown")
    exit 0
}

# 获取脚本所在目录
$SCRIPT_DIR = Split-Path -Parent $MyInvocation.MyCommand.Path
$NSSM = "$SCRIPT_DIR\nssm\nssm.exe"

# 停止并删除服务
Write-Host ""
Write-Host "正在停止服务..."
Start-Process -FilePath $NSSM -ArgumentList "stop $SERVICE_NAME" -NoNewWindow -Wait | Out-Null

Write-Host "正在删除服务..."
Start-Process -FilePath $NSSM -ArgumentList "remove $SERVICE_NAME confirm" -NoNewWindow -Wait | Out-Null

Start-Sleep -Seconds 1

# 验证
$service = Get-Service $SERVICE_NAME -ErrorAction SilentlyContinue
Write-Host ""
Write-Host "========================================"
if (-not $service) {
    Write-Host "  服务已成功删除!" -ForegroundColor Green
} else {
    Write-Host "  删除失败，请手动检查" -ForegroundColor Red
}
Write-Host "========================================"
Write-Host ""
Write-Host "按任意键退出..."
$null = $Host.UI.RawUI.ReadKey("NoEcho,IncludeKeyDown")
