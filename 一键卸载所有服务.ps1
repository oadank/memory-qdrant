# Memory Qdrant - 一键卸载所有服务
# 使用方法：右键 - 以管理员身份运行

$ErrorActionPreference = "Continue"

Write-Host "========================================"
Write-Host "  Memory Qdrant - 一键卸载所有服务"
Write-Host "========================================"
Write-Host ""

$SCRIPT_DIR = Split-Path -Parent $MyInvocation.MyCommand.Path
$NSSM = "$SCRIPT_DIR\nssm\nssm.exe"

if (!(Test-Path $NSSM)) {
    Write-Host "[错误] 未找到 nssm.exe: $NSSM" -ForegroundColor Red
    Write-Host "按任意键退出..."
    $null = $Host.UI.RawUI.ReadKey("NoEcho,IncludeKeyDown")
    exit 1
}

$services = @(
    "QdrantMemoryManager",
    "MemoryAutoSummary",
    "QdrantDB"
)

Write-Host "将卸载以下服务："
foreach ($svc in $services) {
    Write-Host "  - $svc"
}
Write-Host ""
Write-Host "按 Y 确认卸载，其他键取消..."
$confirm = $Host.UI.RawUI.ReadKey("NoEcho,IncludeKeyDown")

if ($confirm.Character -ne 'Y' -and $confirm.Character -ne 'y') {
    Write-Host ""
    Write-Host "已取消。"
    Write-Host "按任意键退出..."
    $null = $Host.UI.RawUI.ReadKey("NoEcho,IncludeKeyDown")
    exit 0
}

Write-Host ""
foreach ($svc in $services) {
    $serviceObj = Get-Service $svc -ErrorAction SilentlyContinue
    if (-not $serviceObj) {
        Write-Host "[跳过] 服务不存在：$svc" -ForegroundColor Yellow
        continue
    }

    Write-Host "[处理中] 停止服务：$svc"
    Start-Process -FilePath $NSSM -ArgumentList "stop $svc" -NoNewWindow -Wait 2>&1 | Out-Null

    Write-Host "[处理中] 删除服务：$svc"
    Start-Process -FilePath $NSSM -ArgumentList "remove $svc confirm" -NoNewWindow -Wait 2>&1 | Out-Null

    Start-Sleep -Milliseconds 300
    $stillThere = Get-Service $svc -ErrorAction SilentlyContinue
    if ($stillThere) {
        Write-Host "[警告] 删除失败：$svc" -ForegroundColor Yellow
    } else {
        Write-Host "[成功] 已删除：$svc" -ForegroundColor Green
    }
}

Write-Host ""
Write-Host "========================================"
Write-Host "  卸载流程结束"
Write-Host "========================================"
Write-Host ""
Write-Host "提示：日志与数据文件不会自动删除。"
Write-Host "按任意键退出..."
$null = $Host.UI.RawUI.ReadKey("NoEcho,IncludeKeyDown")
