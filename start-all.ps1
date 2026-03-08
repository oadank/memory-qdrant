# OpenClaw 三层记忆系统 - 一键启动脚本
# 用法：.\start-all.ps1

$ErrorActionPreference = "Stop"
$PROJECT_ROOT = Split-Path -Parent $MyInvocation.MyCommand.Path
$COMPOSE_FILE = Join-Path $PROJECT_ROOT "docker-compose.yml"

Write-Host "========================================" -ForegroundColor Cyan
Write-Host "  OpenClaw 三层记忆系统 - 启动脚本" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan

# 步骤 1: 检查 Docker
Write-Host "`n[1/4] 检查 Docker 状态..." -ForegroundColor Yellow
try {
    $dockerCheck = docker ps 2>&1
    Write-Host "  Docker 状态：正常" -ForegroundColor Green
} catch {
    Write-Host "  Docker 无法连接！" -ForegroundColor Red
    Write-Host "  请先重启 Docker Desktop，然后重新运行此脚本" -ForegroundColor Red
    Write-Host "`n  重启 Docker Desktop 方法：" -ForegroundColor Yellow
    Write-Host "  1. 右键点击系统托盘的 Docker 图标" -ForegroundColor White
    Write-Host "  2. 选择 'Quit Docker Desktop'" -ForegroundColor White
    Write-Host "  3. 等待 10 秒后重新打开 Docker Desktop" -ForegroundColor White
    Write-Host "  4. 确保看到 'Docker Desktop is running' 状态" -ForegroundColor White
    exit 1
}

# 步骤 2: 停止现有容器（如果有）
Write-Host "`n[2/4] 停止现有容器..." -ForegroundColor Yellow
Set-Location $PROJECT_ROOT
docker compose down 2>&1 | ForEach-Object { Write-Host "  $_" }

# 步骤 3: 启动所有服务
Write-Host "`n[3/4] 启动 Docker 容器..." -ForegroundColor Yellow
docker compose up -d 2>&1 | ForEach-Object { Write-Host "  $_" }

# 步骤 4: 等待服务启动
Write-Host "`n[4/4] 等待服务启动（约 30 秒）..." -ForegroundColor Yellow
$retryCount = 0
$maxRetries = 30
$memoryServerReady = $false

while ($retryCount -lt $maxRetries -and -not $memoryServerReady) {
    Start-Sleep -Seconds 2
    $retryCount++
    try {
        $response = Invoke-WebRequest -Uri "http://localhost:7777/api/health" -TimeoutSec 5 -UseBasicParsing -ErrorAction Stop
        if ($response.StatusCode -eq 200) {
            $memoryServerReady = $true
        }
    } catch {
        Write-Host "  等待 memory-server 启动... ($retryCount/$maxRetries)" -ForegroundColor Gray
    }
}

if (-not $memoryServerReady) {
    Write-Host "  memory-server 启动超时！" -ForegroundColor Red
    docker compose logs memory-server 2>&1 | Select-Object -Last 20 | ForEach-Object { Write-Host "  $_" }
    exit 1
}

# 显示服务状态
Write-Host "`n========================================" -ForegroundColor Cyan
Write-Host "  服务启动完成！" -ForegroundColor Green
Write-Host "========================================" -ForegroundColor Cyan

docker compose ps 2>&1 | ForEach-Object { Write-Host "  $_" }

Write-Host "`n 访问地址：" -ForegroundColor Green
Write-Host "  记忆管理界面：http://localhost:3001" -ForegroundColor White
Write-Host "  Memory Server: http://localhost:7777" -ForegroundColor White
Write-Host "  Qdrant:        http://localhost:6333" -ForegroundColor White
Write-Host "  PostgreSQL:    localhost:5432" -ForegroundColor White

Write-Host "`n 提示：运行 '.\stop-all.ps1' 停止所有服务" -ForegroundColor Yellow
