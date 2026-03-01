# ================================
# verify-memory-time.ps1 - 验证记忆时间戳脚本
# ================================

# ================================
# 强制控制台 UTF-8
# ================================
[Console]::InputEncoding  = [System.Text.Encoding]::UTF8
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding           = [System.Text.Encoding]::UTF8
$null = chcp 65001 2>$null

$PSDefaultParameterValues['Out-File:Encoding'] = 'utf8'
$PSDefaultParameterValues['*:Encoding'] = 'utf8'

# ================================
# 基础配置
# ================================
$QdrantUrl = "http://localhost:6333"
$Collection = "agent_memory"

function Write-Utf8 {
    param(
        [string]$Message,
        [ConsoleColor]$Color = [ConsoleColor]::White
    )
    [Console]::ForegroundColor = $Color
    Write-Host $Message
    [Console]::ResetColor()
}

# ================================
# 核心请求函数 - 手动 UTF-8 解码
# ================================
function Invoke-QdrantRequest {
    param(
        [string]$Endpoint,
        [object]$BodyObject,
        [string]$Method = 'Post'
    )

    $url = "$QdrantUrl/collections/$Collection/$Endpoint"

    try {
        $params = @{
            Uri = $url
            Method = $Method
            ContentType = "application/json; charset=utf-8"
            UseBasicParsing = $true
            ErrorAction = 'Stop'
        }
        if ($BodyObject) {
            $params.Body = $BodyObject | ConvertTo-Json -Depth 10 -Compress
        }

        $response = Invoke-WebRequest @params

        # 手动按 UTF-8 解码（解决 PS5 乱码）
        $response.RawContentStream.Position = 0
        $reader = New-Object System.IO.StreamReader($response.RawContentStream, [System.Text.Encoding]::UTF8)
        $text = $reader.ReadToEnd()
        $reader.Close()

        return $text | ConvertFrom-Json
    }
    catch {
        Write-Utf8 "❌ Qdrant 请求失败: $_" Red
        if ($_.Exception.Response) {
            try {
                $errorStream = $_.Exception.Response.GetResponseStream()
                $errorReader = New-Object System.IO.StreamReader($errorStream, [System.Text.Encoding]::UTF8)
                $errorBody = $errorReader.ReadToEnd()
                Write-Utf8 "错误详情: $errorBody" Yellow
                $errorReader.Close()
                $errorStream.Close()
            } catch {}
        }
        return $null
    }
}

# ================================
# 将 timestamp 统一转换为本地时间字符串
# ================================
function ConvertTo-LocalTimeString {
    param([object]$Timestamp)
    try {
        if ($null -eq $Timestamp) { return "[未知]" }
        $s = $Timestamp.ToString().Trim()
        # 处理数字毫秒（13位）
        if ($s -match '^\d{13}$') {
            $ms = [int64]$s
            $dt = [DateTimeOffset]::FromUnixTimeMilliseconds($ms).LocalDateTime
            return $dt.ToString("yyyy-MM-dd HH:mm:ss")
        }
        # 处理数字秒（10位）
        if ($s -match '^\d{10}$') {
            $sec = [int64]$s
            $dt = [DateTimeOffset]::FromUnixTimeSeconds($sec).LocalDateTime
            return $dt.ToString("yyyy-MM-dd HH:mm:ss")
        }
        # 处理 ISO 8601 字符串（假设为 UTC）
        $formats = @(
            'yyyy-MM-ddTHH:mm:ss.fffZ',
            'yyyy-MM-ddTHH:mm:ssZ',
            'yyyy-MM-ddTHH:mm:ss.fffzzz',
            'yyyy-MM-ddTHH:mm:sszzz'
        )
        $dt = [DateTime]::ParseExact($s, $formats, [System.Globalization.CultureInfo]::InvariantCulture, [System.Globalization.DateTimeStyles]::AssumeUniversal)
        $dt = $dt.ToLocalTime()
        return $dt.ToString("yyyy-MM-dd HH:mm:ss")
    }
    catch {
        return $Timestamp.ToString()
    }
}

# ================================
# 获取所有记忆点并按时间戳排序
# ================================
function Get-AllPoints {
    $bodyObject = @{
        limit        = 100
        offset       = $null
        with_payload = $true
        with_vector  = $false
    }

    $json = Invoke-QdrantRequest -Endpoint "points/scroll" -BodyObject $bodyObject
    if (-not $json) {
        Write-Utf8 "⚠️ 无法获取记忆列表，请检查 Qdrant 服务是否正常运行。" Yellow
        return @()
    }

    try {
        $allPoints = @()
        if ($json.result.points) {
            $allPoints += $json.result.points
        }
        # 排序：使用 UTC 毫秒作为排序键，降序排列（最新的在最下面）
        return $allPoints | Sort-Object -Descending {
            $ts = $_.payload.timestamp
            try {
                if ($null -eq $ts) { return 0 }
                $s = $ts.ToString().Trim()
                if ($s -match '^\d{13}$') { return [int64]$s }        # 毫秒
                if ($s -match '^\d{10}$') { return [int64]$s * 1000 } # 秒
                # 字符串，转换为 UTC 毫秒
                $dt = [DateTime]::Parse($s).ToUniversalTime()
                return [int64]($dt - [DateTime]::UnixEpoch).TotalMilliseconds
            }
            catch {
                return 0
            }
        }
    }
    catch {
        Write-Utf8 "❌ 解析记忆列表失败: $_" Red
        return @()
    }
}

# ================================
# 验证记忆时间戳
# ================================
function Verify-MemoryTime {
    Write-Utf8 "正在连接 Qdrant..." Cyan

    try {
        $test = Invoke-WebRequest -Uri "$QdrantUrl/collections" -UseBasicParsing -ErrorAction Stop
        Write-Utf8 "✅ Qdrant 服务连接成功。" Green
    }
    catch {
        Write-Utf8 "❌ 无法连接到 Qdrant ($QdrantUrl)" Red
        Write-Utf8 "请确保 Qdrant 服务已启动。" Yellow
        return
    }

    Write-Utf8 "正在获取记忆点..." Cyan
    $points = Get-AllPoints

    if ($points.Count -eq 0) {
        Write-Utf8 "⚠️ 未找到任何记忆点。" Yellow
        return
    }

    Write-Utf8 "`n✅ 找到 $($points.Count) 个记忆点，正在验证时间戳..." Green

    $validCount = 0
    $invalidCount = 0

    foreach ($point in $points) {
        $id = $point.id
        $text = $point.payload.text
        $role = $point.payload.role
        $timestamp = $point.payload.timestamp
        $timeStr = ConvertTo-LocalTimeString -Timestamp $timestamp

        # 验证时间戳格式
        $isValid = $true
        $validationError = ""

        try {
            if ($null -eq $timestamp) {
                $isValid = $false
                $validationError = "时间戳为空"
            } else {
                $s = $timestamp.ToString().Trim()
                if (-not ($s -match '^\d{13}$' -or $s -match '^\d{10}$' -or $s -match '^\d{4}-\d{2}-\d{2}T' -or $s -match '^\d{4}/\d{1,2}/\d{1,2}')) {
                    $isValid = $false
                    $validationError = "时间戳格式无效: $s"
                }
            }
        }
        catch {
            $isValid = $false
            $validationError = "时间戳解析错误: $_"
        }

        if ($isValid) {
            $validCount++
            $statusColor = [ConsoleColor]::Green
            $status = "✅"
        } else {
            $invalidCount++
            $statusColor = [ConsoleColor]::Red
            $status = "❌"
        }

        # 显示记忆详情
        Write-Utf8 "`n$status ID: $id" $statusColor
        Write-Utf8 "角色: $role" Cyan
        Write-Utf8 "时间: $timeStr" Yellow
        if ($validationError) {
            Write-Utf8 "错误: $validationError" Red
        }
        Write-Utf8 "内容预览: $(if ($text.Length -gt 50) { $text.Substring(0, 50) + '...' } else { $text })" Gray
    }

    Write-Utf8 "`n====================================="
    Write-Utf8 "验证完成: 有效时间戳 $validCount 个，无效时间戳 $invalidCount 个" Green
    if ($invalidCount -gt 0) {
        Write-Utf8 "⚠️ 发现 $invalidCount 个无效时间戳，请检查记忆写入代码。" Yellow
    }
}

# ================================
# 主程序开始
# ================================
try {
    Verify-MemoryTime
}
catch {
    Write-Utf8 "❌ 程序执行失败: $_" Red
}

Write-Utf8 "`n按 Enter 键退出..." Gray
$null = Read-Host
