param(
  [string]$OpenClawDist = "C:\Users\oadan\AppData\Roaming\npm\node_modules\openclaw\dist\reply-DhtejUNZ.js"
)

$ErrorActionPreference = "Stop"

if (-not (Test-Path $OpenClawDist)) {
  throw "目标文件不存在: $OpenClawDist"
}

$backup = "$OpenClawDist.bak-memory-qdrant-display-mask"
if (-not (Test-Path $backup)) {
  Copy-Item $OpenClawDist $backup -Force
  Write-Host "已创建备份: $backup"
} else {
  Write-Host "已存在备份: $backup"
}

$content = Get-Content -Raw $OpenClawDist

if ($content -match "stripInjectedUserTime") {
  Write-Host "补丁已存在，无需重复应用。"
  exit 0
}

$old = @'
					if (imageResult.images.length > 0) await abortable(activeSession.prompt(effectivePrompt, { images: imageResult.images }));
					else await abortable(activeSession.prompt(effectivePrompt));
'@

$new = @'
					if (imageResult.images.length > 0) await abortable(activeSession.prompt(effectivePrompt, { images: imageResult.images }));
					else await abortable(activeSession.prompt(effectivePrompt));
					try {
						const msgs = activeSession?.messages;
						if (Array.isArray(msgs)) {
							for (let i = msgs.length - 1; i >= 0; i--) {
								const m = msgs[i];
								if (m?.role !== "user") continue;
								const stripInjectedUserTime = (s) => typeof s === "string" ? s.replace(/(#\s*用户输入\s*\n+)(?:\[[^\]]*\d{4}-\d{2}-\d{2}[^\]]*\]\s*)+/g, "$1") : s;
								if (typeof m.content === "string") m.content = stripInjectedUserTime(m.content);
								else if (Array.isArray(m.content)) {
									for (const part of m.content) {
										if (part && typeof part === "object" && part.type === "text" && typeof part.text === "string") {
											part.text = stripInjectedUserTime(part.text);
										}
									}
								}
								break;
							}
						}
					} catch {}
'@

if (-not $content.Contains($old)) {
  throw "未命中预期片段，OpenClaw 版本可能已变化。请先手工检查: $OpenClawDist"
}

$content = $content.Replace($old, $new)
Set-Content -Path $OpenClawDist -Value $content -Encoding UTF8

try {
  node --check $OpenClawDist | Out-Null
  Write-Host "补丁已应用并通过语法检查。"
} catch {
  Write-Warning "补丁已写入但语法检查失败。可回滚：Copy-Item '$backup' '$OpenClawDist' -Force"
  throw
}

Write-Host "完成。请重启 OpenClaw 生效。"
