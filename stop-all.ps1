# OpenClaw 三层记忆系统 - 停止脚本
# 用法：.\stop-all.ps1

$ErrorActionPreference = "SilentlyContinue"
$PROJECT_ROOT = Split-Path -Parent $MyInvocation.MyCommand.Path

Write-Host "========================================" -ForegroundColor Cyan
Write-Host "  OpenClaw 三层记忆系统 - 停止服务" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan

Set-Location $PROJECT_ROOT

Write-Host "`n 停止 Docker 容器..." -ForegroundColor Yellow
docker compose down 2>&1 | ForEach-Object { Write-Host "  $_" }

Write-Host "`n 服务已停止" -ForegroundColor Green
