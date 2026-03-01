@echo off
REM 启动 Qdrant 记忆管理器服务
echo Starting Qdrant Memory Manager...
echo Please make sure you have Node.js installed.
echo.

REM 检查是否安装了node
node --version >nul 2>&1
if %errorlevel% neq 0 (
    echo Error: Node.js is not installed or not in PATH.
    echo Please install Node.js and try again.
    pause
    exit /b 1
)

REM 检查是否安装了npm包
if not exist node_modules (
    echo Installing dependencies...
    npm install
    if %errorlevel% neq 0 (
        echo Failed to install dependencies.
        pause
        exit /b 1
    )
)

REM 启动服务
echo Starting server at http://localhost:3001
node server.js

pause