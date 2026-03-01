# ================================
# 管理Qdrant记忆.ps1 - 优化版
# 显示关键词 + 代码精简
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
$Limit = 1000
$OllamaUrl = "http://localhost:11434"
$EmbeddingModel = "bge-m3:latest"

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
# 退出前暂停函数
# ================================
function Pause-Exit {
    Write-Utf8 "`n按 Enter 键退出..." Gray
    $null = Read-Host
    exit
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
    # 调试输出可取消注释下一行
    # Write-Utf8 "正在请求: $url" Gray

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
        limit        = $Limit
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
        # 排序：使用 UTC 毫秒作为排序键
        return $allPoints | Sort-Object {
            $ts = $_.payload.timestamp
            try {
                if ($null -eq $ts) { return 0 }
                $s = $ts.ToString().Trim()
                # 处理数字毫秒（13位）
                if ($s -match '^\d{13}$') { return [int64]$s }
                # 处理数字秒（10位）
                if ($s -match '^\d{10}$') { return [int64]$s * 1000 }
                # 处理 ISO 格式（2026-02-27T16:15:22.219Z）
                if ($s -match '^\d{4}-\d{2}-\d{2}T') {
                    $dt = [DateTime]::ParseExact($s, "yyyy-MM-ddTHH:mm:ss.fffZ", [System.Globalization.CultureInfo]::InvariantCulture, [System.Globalization.DateTimeStyles]::AssumeUniversal)
                    return [int64]($dt - [DateTime]::UnixEpoch).TotalMilliseconds
                }
                # 处理中文格式（2026/3/1 03:21:43）
                if ($s -match '^\d{4}/\d{1,2}/\d{1,2}') {
                    $dt = [DateTime]::ParseExact($s, "yyyy/M/d HH:mm:ss", [System.Globalization.CultureInfo]::InvariantCulture)
                    return [int64]($dt - [DateTime]::UnixEpoch).TotalMilliseconds
                }
                # 处理其他可能的格式
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
# 显示记忆列表（含关键词）
# ================================
function Show-Memories {
    $global:SortedPoints = Get-AllPoints

    if (!$global:SortedPoints -or $global:SortedPoints.Count -eq 0) {
        Write-Utf8 ""
        Write-Utf8 "Qdrant 中没有找到任何记忆。" Yellow
        return
    }

    Write-Utf8 ""
    Write-Utf8 "当前记忆列表：" Green
    Write-Utf8 "------------------------------------------"

    $index = 1
    foreach ($point in $global:SortedPoints) {
        $timestamp = $point.payload.timestamp
        $text      = [string]$point.payload.text
        $role      = $point.payload.role
        $type      = $point.payload.type
        $tags      = $point.payload.tags

        $typeIndicator = ""
        $color = [ConsoleColor]::White
        if ($type -eq 'insight') {
            $typeIndicator = " [精华]"
            $color = [ConsoleColor]::Magenta
        } elseif ($role -eq 'user') {
            $typeIndicator = " [用户]"
            $color = [ConsoleColor]::Green
        } elseif ($role -eq 'assistant') {
            $typeIndicator = " [助手]"
            $color = [ConsoleColor]::Yellow
        } else {
            $typeIndicator = " [未知]"
            $color = [ConsoleColor]::Gray
        }

        $timeStr = ConvertTo-LocalTimeString -Timestamp $timestamp

        Write-Utf8 "【$index】 $timeStr$typeIndicator :" $color

        # 显示文本（缩进4空格）
        $indentedText = ($text -split "`n" | ForEach-Object { "    $_" }) -join "`n"
        Write-Utf8 $indentedText $color

        # 显示关键词（如果有）
        if ($tags -and $tags.Count -gt 0) {
            # 修改为「」包围的关键词
            $tagStr = ($tags | ForEach-Object { "「$_」" }) -join " "
            Write-Utf8 "    关键词：$tagStr" Cyan
        }

        Write-Utf8 ""
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

    $response = Invoke-QdrantRequest -Endpoint "points/delete" -BodyObject $body
    if ($response) {
        Write-Utf8 "✅ 全部记忆已删除。" Red
        $global:SortedPoints = Get-AllPoints
    } else {
        Write-Utf8 "❌ 删除全部失败，请检查 Qdrant 服务。" Red
    }
}

# ======= 提取标签函数（优先使用jieba，失败则回退到正则）=======
function Extract-Tags {
    param(
        [string]$Text,
        [int]$TopK = 15
    )

    if ([string]::IsNullOrWhiteSpace($Text)) { return @() }

    # 尝试使用 jieba 分词（通过临时文件调用 python）
    $jiebaResult = $null
    $python = Get-Command python -ErrorAction SilentlyContinue
    if ($python) {
        $tempPy = [System.IO.Path]::GetTempFileName() + ".py"
        $tempOut = [System.IO.Path]::GetTempFileName()
        try {
            # 写入 Python 脚本
            @"
import sys, json
try:
    import jieba
    text = sys.stdin.read().strip()
    words = jieba.lcut(text)
    # 过滤长度小于2的词，并去重
    result = list(dict.fromkeys([w for w in words if len(w.strip()) >= 2]))
    print(json.dumps(result, ensure_ascii=False))
except Exception as e:
    print('[]')
"@ | Out-File -FilePath $tempPy -Encoding utf8

            # 将文本保存到临时文件，避免命令行编码问题
            $tempInput = [System.IO.Path]::GetTempFileName()
            [System.IO.File]::WriteAllText($tempInput, $Text, [System.Text.Encoding]::UTF8)

            # 执行 python
            $process = Start-Process -FilePath python -ArgumentList "$tempPy" -RedirectStandardInput $tempInput -RedirectStandardOutput $tempOut -NoNewWindow -Wait -PassThru
            if ($process.ExitCode -eq 0) {
                $output = [System.IO.File]::ReadAllText($tempOut, [System.Text.Encoding]::UTF8)
                $jiebaResult = $output | ConvertFrom-Json
            }
        } catch {
            # 忽略错误，继续使用正则
        } finally {
            Remove-Item $tempPy -ErrorAction SilentlyContinue
            Remove-Item $tempInput -ErrorAction SilentlyContinue
            Remove-Item $tempOut -ErrorAction SilentlyContinue
        }
    }

    if ($jiebaResult -and $jiebaResult.Count -gt 0) {
        return $jiebaResult | Select-Object -First $TopK
    }

    # 回退到正则提取（兼容 PS5）
    Write-Utf8 "⚠️ 使用备用正则表达式提取标签" Yellow
    $pattern = '[\p{IsCJKUnifiedIdeographs}]+|[A-Za-z]+|\d+'
    try {
        $tokens = [regex]::Matches($Text, $pattern) | ForEach-Object { $_.Value }
    } catch {
        $pattern = '[\u4e00-\u9fff]+|[A-Za-z]+|\d+'
        $tokens = [regex]::Matches($Text, $pattern) | ForEach-Object { $_.Value }
    }

    $stop = @(
        "你","我","他","她","它","他们","她们","它们","我们","你们",
        "的","了","呢","啊","吗","嘛","吧","是","有","和","就","都","还","在",
        "这个","那个","什么","怎么","为啥","为什么","啥","时候","现在"
    )

    $clean = @()
    foreach ($t in $tokens) {
        $w = $t.Trim()
        if ($w.Length -lt 2) { continue }
        if ($stop -contains $w) { continue }
        $clean += $w
    }

    return ($clean | Select-Object -Unique | Select-Object -First $TopK)
}

function Parse-UserInputToIndices {
    param([string]$InputString)

    $indices = @()
    $parts = $InputString -split '[,，]'
    foreach ($part in $parts) {
        $part = $part.Trim()
        if ($part -match '^(\d+)-(\d+)$') {
            $start = [int]$matches[1]
            $end = [int]$matches[2]
            if ($start -le $end) {
                $indices += $start..$end
            } else {
                Write-Utf8 "⚠️ 范围无效: $part" Yellow
            }
        } elseif ($part -match '^\d+$') {
            $indices += [int]$part
        } elseif ($part -ne '') {
            Write-Utf8 "⚠️ 无法识别的输入: $part" Yellow
        }
    }
    $indices = $indices | Sort-Object -Unique
    return $indices
}

# ========== 批量插入记忆 ==========
function Add-Memory {
    Write-Utf8 "输入记忆内容，回车换行，空行结束本条，然后自动开始下一条。直接回车结束录入。" Cyan
    $allMemories = @()
    $index = 1
    while ($true) {
        Write-Utf8 "--- 第 $index 条记忆（输入内容，空行结束本条）---" Yellow
        $lines = @()
        while ($true) {
            $line = Read-Host
            if ([string]::IsNullOrWhiteSpace($line)) {
                break
            }
            $lines += $line
        }
        if ($lines.Count -eq 0) {
            if ($allMemories.Count -eq 0) {
                Write-Utf8 "未输入任何内容，取消插入。" Yellow
            } else {
                Write-Utf8 "录入结束，共输入 $($allMemories.Count) 条记忆。" Green
            }
            break
        }
        $text = $lines -join "`n"
        $allMemories += $text
        $index++
    }

    if ($allMemories.Count -eq 0) {
        return
    }

    Write-Utf8 "将插入 $($allMemories.Count) 条共享精华记忆 (userId=shared, type=insight)" Cyan

    $successCount = 0
    foreach ($text in $allMemories) {
        Write-Utf8 "正在为第 $($successCount+1) 条记忆生成向量..." Cyan
        $embedBody = @{
            model = $EmbeddingModel
            prompt = $text
        } | ConvertTo-Json

        try {
            $embedResponse = Invoke-RestMethod -Uri "$OllamaUrl/api/embeddings" -Method Post -Body $embedBody -ContentType "application/json" -ErrorAction Stop
            $vector = $embedResponse.embedding
        }
        catch {
            Write-Utf8 "❌ 生成向量失败: $_" Red
            Write-Utf8 "请检查 Ollama 服务是否正在运行，以及模型 '$EmbeddingModel' 是否已拉取。" Yellow
            continue
        }

        $pointId = [guid]::NewGuid().ToString()
        $tags = Extract-Tags -Text $text -TopK 15
        $payload = @{
            text = $text
            tags = $tags
            timestamp = [int64]([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds())
            userId = "shared"
            conversationId = "manual"
            role = "assistant"
            type = "insight"
            mem_type = "精华"
            source_ids = @()
            processed = $true
        }
        $body = @{
            points = @(
                @{
                    id = $pointId
                    vector = $vector
                    payload = $payload
                }
            )
        }

        $response = Invoke-QdrantRequest -Endpoint "points?wait=true" -Method Put -BodyObject $body
        if ($response) {
            Write-Utf8 "✅ 记忆插入成功，ID: $pointId" Green
            $successCount++
        } else {
            Write-Utf8 "❌ 插入失败，请检查 Qdrant 服务。" Red
        }
    }

    Write-Utf8 "批量插入完成，成功 $successCount 条，失败 $($allMemories.Count - $successCount) 条。" Green
    $global:SortedPoints = Get-AllPoints
}

# ================================
# 主程序开始
# ================================

Write-Utf8 "正在连接 Qdrant..." Cyan

# 预检 Qdrant 服务
try {
    $test = Invoke-WebRequest -Uri "$QdrantUrl/collections" -UseBasicParsing -ErrorAction Stop
    Write-Utf8 "✅ Qdrant 服务连接成功。" Green
}
catch {
    Write-Utf8 "❌ 无法连接到 Qdrant ($QdrantUrl)" Red
    Write-Utf8 "请确保 Qdrant 服务已启动（例如运行 'Start-Service qdrant'）。" Yellow
    Pause-Exit
}

# 主交互循环
while ($true) {
    Show-Memories

    Write-Utf8 ""
    Write-Utf8 "操作说明：" Yellow
    Write-Utf8 "A      - 删除全部"
    Write-Utf8 "数字   - 删除对应序号（支持多个，如：1,2,3 或 1-3 或 1,3-5,7）"
    Write-Utf8 "I      - 插入新记忆（批量，默认共享精华记忆 insight）"
    Write-Utf8 "S      - 手动总结"
    Write-Utf8 "回车   - 刷新"
    Write-Utf8 "空格   - 退出"

    $choice = Read-Host "输入"

    if ($choice -eq " ") {
        Write-Utf8 "退出程序。" Green
        Pause-Exit
    }

    if ([string]::IsNullOrWhiteSpace($choice)) {
        continue
    }

    $inputTrim = $choice.Trim()

    # 处理命令
    switch ($inputTrim.ToUpper()) {
        'A' {
            Delete-All
            continue
        }
        'I' {
            Add-Memory
            continue
        }
        'S' {
            Write-Utf8 "开始手动触发自动总结..." Cyan

            $scriptPath = Join-Path $PSScriptRoot "auto_summary\auto_summary.py"
            if (-not (Test-Path $scriptPath)) {
                Write-Utf8 "❌ 找不到 auto_summary.py，路径: $scriptPath" Red
                continue
            }

            Write-Utf8 "正在执行: python $scriptPath --once" Cyan
            try {
                $output = & python $scriptPath --once 2>&1
                $exitCode = $LASTEXITCODE
                if ($exitCode -eq 0) {
                    Write-Utf8 "✅ 总结完成，刷新记忆列表。" Green
                    $global:SortedPoints = Get-AllPoints
                    Show-Memories
                } else {
                    Write-Utf8 "❌ 总结执行失败，退出代码: $exitCode" Red
                    Write-Utf8 "输出信息: $output" Yellow
                }
            }
            catch {
                Write-Utf8 "❌ 执行总结时出错: $_" Red
            }
            continue
        }
        default {
            # 尝试解析为数字索引
            $indices = Parse-UserInputToIndices -InputString $inputTrim
            if ($indices.Count -eq 0) {
                Write-Utf8 "无效输入。" Yellow
                continue
            }

            if (-not $global:SortedPoints -or $global:SortedPoints.Count -eq 0) {
                Write-Utf8 "当前没有记忆可删除。" Yellow
                continue
            }

            $maxIndex = $global:SortedPoints.Count
            $validIndices = @()
            $invalidIndices = @()
            foreach ($idx in $indices) {
                if ($idx -ge 1 -and $idx -le $maxIndex) {
                    $validIndices += $idx
                } else {
                    $invalidIndices += $idx
                }
            }

            if ($invalidIndices.Count -gt 0) {
                Write-Utf8 "以下序号无效（超出范围）: $($invalidIndices -join ', ')" Yellow
            }

            if ($validIndices.Count -gt 0) {
                $pointIds = @($validIndices | ForEach-Object { $global:SortedPoints[$_ - 1].id } | Select-Object -Unique)
                $body = @{ points = $pointIds }
                $response = Invoke-QdrantRequest -Endpoint "points/delete" -BodyObject $body
                if ($response) {
                    Write-Utf8 "✅ 已删除序号: $($validIndices -join ', ')" Cyan
                    $global:SortedPoints = Get-AllPoints
                } else {
                    Write-Utf8 "❌ 删除失败，请检查 Qdrant 服务。" Red
                }
            }
        }
    }
}