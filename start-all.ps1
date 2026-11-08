# SurfCore 一键启动：QQ(手动) → SnowLuma → 注入小号 → 桥接
# 前提：QQ 客户端已登录小号并保持运行（最小化即可）。
# 用法：右键「使用 PowerShell 运行」，或双击同目录的 启动小鲸鱼.bat

$ErrorActionPreference = 'Continue'
$SnowDir   = 'E:\SnowLuma-v2.3.2-win-x64'
$SurfDir   = 'E:\DSH-Data\surfcore'
$DshExe    = 'E:\DeepSeek Harness\DeepSeek Harness.exe'
$BotUin    = '3257048211'          # 小号：鲸鲸
$SluWeb    = 'http://127.0.0.1:5099'
$SluUser   = 'admin'
$SluPass   = 'SnowLuma-ced22047'
$TokenFile = 'C:\Users\Administrator\snowluma-token.txt'

function Say($msg) { Write-Host "[启动] $msg" -ForegroundColor Cyan }
function PortUp($port) { (Test-NetConnection -ComputerName 127.0.0.1 -Port $port -WarningAction SilentlyContinue).TcpTestSucceeded }

# ── 1. QQ 是否在跑 ────────────────────────────────────────────
$qq = Get-Process QQ -ErrorAction SilentlyContinue
if (-not $qq) { Write-Host "[!] 没检测到 QQ 进程，请先登录小号 QQ 再运行" -ForegroundColor Yellow; Start-Sleep 5; exit 1 }
Say "QQ 在运行（$($qq.Count) 个进程）"

# ── 1.5 DSH（桥接调模型必须靠它）───────────────────────────────
$dsh = Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue
if ($dsh) {
  Say 'DSH 已在运行'
} else {
  Say '启动 DSH…'
  if (Test-Path $DshExe) {
    Start-Process -FilePath $DshExe
    for ($i = 0; $i -lt 45; $i++) { Start-Sleep 2; if (Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue) { break } }
    Start-Sleep 8
    Say 'DSH 已拉起'
  } else {
    Write-Host "[!] 找不到 DSH：$DshExe，请手动打开 DeepSeek Harness" -ForegroundColor Yellow
  }
}

# ── 2. SnowLuma ──────────────────────────────────────────────
if (PortUp 5099) {
  Say 'SnowLuma 已在运行'
} else {
  Say '启动 SnowLuma…'
  Start-Process -FilePath "$SnowDir\start-snowluma.bat" -WorkingDirectory $SnowDir -WindowStyle Hidden
  for ($i = 0; $i -lt 30; $i++) { Start-Sleep 2; if (PortUp 5099) { break } }
  if (-not (PortUp 5099)) { Write-Host '[!] SnowLuma 没能起来（5099 未监听）' -ForegroundColor Red; Start-Sleep 5; exit 1 }
  Say 'SnowLuma WebUI 已就绪'
}

# ── 3. 登录拿 token（保存的 token 失效时用密码重登）─────────────
$tok = ''
if (Test-Path $TokenFile) { $tok = (Get-Content $TokenFile -Raw).Trim() }
function Try-Token($t) {
  if (-not $t) { return $false }
  try { Invoke-RestMethod -Uri "$SluWeb/api/processes" -Headers @{ Authorization = "Bearer $t" } -TimeoutSec 8 | Out-Null; return $true } catch { return $false }
}
if (-not (Try-Token $tok)) {
  Say 'token 失效，用密码重新登录…'
  $body = @{ username = $SluUser; password = $SluPass } | ConvertTo-Json
  try {
    $r = Invoke-RestMethod -Uri "$SluWeb/api/login" -Method Post -ContentType 'application/json' -Body $body -TimeoutSec 15
    $tok = $r.token
    Set-Content -Path $TokenFile -Value $tok -NoNewline -Encoding ASCII
    Say '登录成功'
  } catch { Write-Host "[!] SnowLuma 登录失败：$($_.Exception.Message)" -ForegroundColor Red; Start-Sleep 5; exit 1 }
}
$H = @{ Authorization = "Bearer $tok"; 'Content-Type' = 'application/json' }

# ── 4. 找到小号进程并注入 ─────────────────────────────────────
$list = (Invoke-RestMethod -Uri "$SluWeb/api/processes" -Headers $H -TimeoutSec 10).list
$target = $list | Where-Object { $_.account -and [string]$_.account.uin -eq $BotUin } | Select-Object -First 1
if (-not $target) {
  # 刚登录的 QQ 可能还没被识别：先刷新一遍
  foreach ($p in $list) { try { Invoke-RestMethod -Uri "$SluWeb/api/processes/$($p.pid)/refresh" -Method Post -Headers $H -Body '{}' -TimeoutSec 20 | Out-Null } catch {} }
  $list = (Invoke-RestMethod -Uri "$SluWeb/api/processes" -Headers $H -TimeoutSec 10).list
  $target = $list | Where-Object { $_.account -and [string]$_.account.uin -eq $BotUin } | Select-Object -First 1
}
if (-not $target) { Write-Host "[!] 没找到小号 $BotUin 的 QQ 进程，确认小号已登录" -ForegroundColor Yellow; Start-Sleep 5; exit 1 }

if ($target.injected) {
  Say "小号 $BotUin 已注入（pid $($target.pid)）"
} else {
  Say "注入小号 $BotUin（pid $($target.pid)）…"
  try { Invoke-RestMethod -Uri "$SluWeb/api/processes/$($target.pid)/load" -Method Post -Headers $H -Body '{}' -TimeoutSec 90 | Out-Null } catch { Write-Host "[!] 注入失败：$($_.Exception.Message)" -ForegroundColor Red }
  Start-Sleep 6
}

# 大号千万别动：只做提醒
$big = $list | Where-Object { $_.account -and [string]$_.account.uin -eq '82071738' -and $_.injected }
if ($big) { Write-Host "[!] 大号 82071738 也被注入了（pid $($big.pid)），建议卸载" -ForegroundColor Yellow }

for ($i = 0; $i -lt 15; $i++) { if ((PortUp 3000) -and (PortUp 3001)) { break }; Start-Sleep 2 }
if (PortUp 3000) { Say 'OneBot 3000/3001 已监听' } else { Write-Host '[!] OneBot 端口没起来' -ForegroundColor Red }

# ── 5. 桥接 ──────────────────────────────────────────────────
if (PortUp 3100) {
  Say '桥接已在运行'
} else {
  Say '启动桥接…'
  Start-Process -FilePath 'cmd.exe' -ArgumentList '/c','start.bat' -WorkingDirectory $SurfDir -WindowStyle Hidden
  for ($i = 0; $i -lt 20; $i++) { Start-Sleep 2; if (PortUp 3100) { break } }
}

# ── 6. 状态汇总 ──────────────────────────────────────────────
Start-Sleep 3
$ct = ''
$m = Select-String -Path "$SurfDir\config.json" -Pattern '"consoleToken"\s*:\s*"([^"]+)"' -Encoding UTF8 | Select-Object -First 1
if ($m) { $ct = $m.Matches[0].Groups[1].Value }
if (-not $ct) { $ct = 'fca18c1c227d40feab2505ddf14571ad' }
try {
  $st = Invoke-RestMethod -Uri "http://127.0.0.1:3100/api/status?token=$ct" -TimeoutSec 15
  Write-Host ''
  Write-Host "角色：$($st.role)    DSH：$($st.dshReady)    QQ 连接：$($st.snowluma.connected)    账号在线：$($st.snowluma.accountOnline)" -ForegroundColor Green
  Write-Host "白名单群：$($st.allowGroups -join ', ')    私聊：$($st.allowPrivate -join ', ')" -ForegroundColor Green
  Write-Host "控制台：http://127.0.0.1:3100/?token=$ct" -ForegroundColor Green
} catch {
  Write-Host "[!] 桥接状态读取失败：$($_.Exception.Message)" -ForegroundColor Yellow
}
Write-Host ''
Write-Host '完成。QQ 客户端请保持登录（最小化/托盘都行），关掉 QQ 她就下线。' -ForegroundColor Gray
Start-Sleep 3
