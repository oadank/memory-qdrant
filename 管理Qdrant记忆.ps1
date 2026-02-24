# ================================
# 强制 PowerShell 使用 UTF-8
# ================================
[Console]::InputEncoding  = [System.Text.Encoding]::UTF8
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding           = [System.Text.Encoding]::UTF8
chcp 65001 | Out-Null

$PSDefaultParameterValues['Out-File:Encoding'] = 'utf8'
$PSDefaultParameterValues['*:Encoding'] = 'utf8'

# ================================
# 基础配置
# ================================
$QdrantUrl = "http://localhost:6333"
$Collection = "agent_memory"
$Limit = 1000

function Write-Utf8 {
    param(
        [string]$Message,
        [ConsoleColor]$Color = [ConsoleColor]::White
    )
    [Console]::ForegroundColor = $Color
    Write-Host $Message
    [Console]::ResetColor()
}

function Invoke-QdrantRequest {
    param(
        [string]$Endpoint,
        [object]$BodyObject
    )

    $jsonBody = $BodyObject | ConvertTo-Json -Depth 10 -Compress
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($jsonBody)

    Invoke-WebRequest `
        -Uri "$QdrantUrl/collections/$Collection/$Endpoint" `
        -Method Post `
        -Body $bytes `
        -ContentType "application/json; charset=utf-8" `
        -UseBasicParsing
}

function Get-AllPoints {

    $bodyObject = @{
        limit        = $Limit
        with_payload = $true
        with_vector  = $false
    }

    $response = Invoke-QdrantRequest -Endpoint "points/scroll" -BodyObject $bodyObject
    $json = [System.Text.Encoding]::UTF8.GetString($response.RawContentStream.ToArray()) | ConvertFrom-Json

    $allPoints = @()
    if ($json.result.points) {
        $allPoints += $json.result.points
    }

    return $allPoints | Sort-Object { $_.payload.timestamp }
}

function Show-Memories {

    $global:SortedPoints = Get-AllPoints

    if (!$SortedPoints -or $SortedPoints.Count -eq 0) {
        Write-Utf8 ""
        Write-Utf8 "Qdrant 中没有找到任何记忆。" Yellow
        return
    }

    Write-Utf8 ""
    Write-Utf8 "当前记忆列表：" Green
    Write-Utf8 "------------------------------------------"

    $index = 1
    foreach ($point in $SortedPoints) {

        $timestamp = $point.payload.timestamp
        $text      = [string]$point.payload.text

        $dateTime = [datetimeoffset]::FromUnixTimeMilliseconds($timestamp).LocalDateTime
        $timeStr  = $dateTime.ToString("yyyy-MM-dd HH:mm:ss")

        Write-Utf8 "$index. $timeStr : $text"
        $index++
    }

    Write-Utf8 "------------------------------------------"
}

function Delete-All {

    $body = @{
        filter = @{
            must = @()
        }
    }

    Invoke-QdrantRequest -Endpoint "points/delete" -BodyObject $body | Out-Null
    Write-Utf8 "全部记忆已删除。" Red
}

function Delete-One($number) {

    if ($number -lt 1 -or $number -gt $SortedPoints.Count) {
        Write-Utf8 "序号无效。" Yellow
        return
    }

    $pointId = $SortedPoints[$number - 1].id

    $body = @{
        points = @($pointId)
    }

    Invoke-QdrantRequest -Endpoint "points/delete" -BodyObject $body | Out-Null
    Write-Utf8 "序号 $number 已删除。" Cyan
}

# ================================
# 主循环
# ================================

Write-Utf8 "正在连接 Qdrant..." Cyan

while ($true) {

    Show-Memories

    Write-Utf8 ""
    Write-Utf8 "操作说明：" Yellow
    Write-Utf8 "A      - 删除全部"
    Write-Utf8 "数字   - 删除对应序号"
    Write-Utf8 "回车   - 刷新"
    Write-Utf8 "空格   - 退出"

    $choice = Read-Host "输入"

    # 只输入空格 = 退出
    if ($choice -eq " ") {
        exit
    }

    # 直接回车 = 刷新（什么都不做，进入下一轮）
    if ([string]::IsNullOrWhiteSpace($choice)) {
        continue
    }

    $inputTrim = $choice.Trim().ToUpper()

    # 删除全部
    if ($inputTrim -eq "A") {
        Delete-All
    }
    # 删除指定序号
    elseif ($inputTrim -match "^\d+$") {
        Delete-One([int]$inputTrim)
    }
    else {
        Write-Utf8 "无效输入。" Yellow
    }

    Write-Utf8 ""
}