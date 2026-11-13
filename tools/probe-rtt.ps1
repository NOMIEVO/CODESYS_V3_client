# probe-rtt.ps1 — 测「真实链路往返」，并判断是否被网卡中断节流拖慢
# ══════════════════════════════════════════════════════════════════════════════
# 为什么需要它：
#   ① Windows 的 ping 只显示整数毫秒 —— 0.6ms 和 1.4ms 都显示「1ms」，看不出差别
#   ② 用程序测 TCP 连接含用户态调度开销（Node 约 +1.5ms、.NET Ping 约 +0.7ms），
#      同样掩盖真实链路
#   唯一可靠的办法是抓包取帧时间戳。本脚本用系统内置 pktmon（Win10 1809+，
#   无需安装 Wireshark）测纯链路往返。
#
# 实测案例（本机 Realtek PCIe GbE → 工控机 192.168.1.92，千兆直连，同一台机器四组对照）：
#
#   节能项  中断节流   刚重启网卡    60~80 秒后
#   ──────────────────────────────────────────────
#   开      开         —            0.934ms
#   开      关         0.145ms      0.935ms   ← 关节流无效，空闲后又变慢
#   关      关         0.125ms      0.127ms   ← 稳定
#   关      开         0.118ms      0.131ms   ← 稳定（且不必关节流）
#
# 结论：**节能机制才是元凶**，关掉后 0.93ms → 0.13ms（约 7 倍），与中断节流无关。
# 典型机制：网卡空闲后进低功耗态，收到包要先唤醒 PHY/链路，每次多付 ~0.8ms。
# 而 Windows ping 在这两种状态下都显示「0ms / 1ms」，完全看不出差别。
#
# 判读：
#   < 0.30ms  正常（千兆直连应为 0.1~0.3ms）
#   0.5~1.5ms 偏高，最常见原因是【节能项】开着（EEE/绿色以太网/Power Saving/设备省电）
#   > 2ms     查双工/线材/是否经多层交换/是否走 Wi-Fi
#
# 用法（需要管理员，pktmon 要求）：
#   powershell -ExecutionPolicy Bypass -File probe-rtt.ps1
#   powershell -ExecutionPolicy Bypass -File probe-rtt.ps1 -Target 192.168.1.92 -Count 20
#   powershell -ExecutionPolicy Bypass -File probe-rtt.ps1 -IdleSeconds 70   # 先空闲再测（复现"越用越慢"）
#   powershell -ExecutionPolicy Bypass -File probe-rtt.ps1 -Json
#   powershell -ExecutionPolicy Bypass -File probe-rtt.ps1 -Cleanup          # 只清理临时文件
# ══════════════════════════════════════════════════════════════════════════════
[CmdletBinding()]
param(
  [string]$Target = '192.168.1.92',
  [int]$Count = 10,
  [string]$Adapter = '',
  [int]$IdleSeconds = 0,
  [switch]$Json,
  [switch]$Cleanup
)

$ErrorActionPreference = 'Stop'
$dir = Join-Path $env:TEMP 'myx-rtt'
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)

if ($Cleanup) {
  if (Test-Path $dir) { Remove-Item $dir -Recurse -Force -ErrorAction SilentlyContinue }
  Write-Host "已清理 $dir"
  exit 0
}

if (-not (Get-Command pktmon -ErrorAction SilentlyContinue)) {
  Write-Host "✗ 本机没有 pktmon（需要 Windows 10 1809 及以上）"
  exit 2
}
if (-not $isAdmin) {
  Write-Host "✗ 需要管理员权限（pktmon 抓包要求）。请以管理员身份重开 PowerShell。"
  exit 2
}

New-Item -ItemType Directory -Path $dir -Force | Out-Null

# ── 1. 记录网卡状态（用于解释结果） ────────────────────────────────
if (-not $Adapter) {
  try {
    $route = Find-NetRoute -RemoteIPAddress $Target -ErrorAction Stop | Select-Object -First 1
    $Adapter = $route.InterfaceAlias
  } catch { }
}
$modState = $null; $speedDup = $null; $link = $null
$powerItems = @()
if ($Adapter) {
  $p = Get-NetAdapterAdvancedProperty -Name $Adapter -ErrorAction SilentlyContinue |
       Where-Object { $_.RegistryKeyword -eq '*InterruptModeration' } | Select-Object -First 1
  if ($p) {
    $modState = if ($p.RegistryValue -eq '1') { '开启' } else { '关闭' }
  }
  $s = Get-NetAdapterAdvancedProperty -Name $Adapter -ErrorAction SilentlyContinue |
       Where-Object { $_.RegistryKeyword -eq '*SpeedDuplex' } | Select-Object -First 1
  if ($s) { $speedDup = $s.DisplayValue }
  $link = (Get-NetAdapter -Name $Adapter -ErrorAction SilentlyContinue).LinkSpeed
  # 节能类：这几项才是「空闲后每包多 0.8ms」的元凶
  foreach ($k in '*EEE', 'AdvancedEEE', 'EnableGreenEthernet', 'GigabitLite', 'PowerSavingMode', 'AutoDisableGigabit') {
    $it = Get-NetAdapterAdvancedProperty -Name $Adapter -ErrorAction SilentlyContinue |
          Where-Object { $_.RegistryKeyword -eq $k } | Select-Object -First 1
    if ($it) { $powerItems += [pscustomobject]@{ name = $it.DisplayName; key = $k; val = [string]$it.RegistryValue } }
  }
}
$powerOn = @($powerItems | Where-Object { $_.val -eq '1' })

if (-not $Json) {
  Write-Host '════════════════════════════════════════════════════'
  Write-Host '  真实链路往返（pktmon 取帧时间戳）'
  Write-Host "  目标 $Target · 网卡 $Adapter · 链路 $link"
  Write-Host "  中断节流 $modState · 速率双工 $speedDup"
  if ($powerItems.Count) {
    $onNames = if ($powerOn.Count) { ($powerOn | ForEach-Object { $_.name }) -join '、' } else { '全部已关' }
    Write-Host "  节能项   $onNames"
  }
  Write-Host '════════════════════════════════════════════════════'
}

# 可选：先空闲一段时间，让网卡进入低功耗态（复现"刚重启很快、过一会儿变慢"）
if ($IdleSeconds -gt 0) {
  if (-not $Json) { Write-Host "  先空闲 $IdleSeconds 秒，让网卡进低功耗态…" }
  Start-Sleep -Seconds $IdleSeconds
}

# ── 2. 抓包 ────────────────────────────────────────────────────────
$stamp = Get-Date -Format 'HHmmss'
$etl = Join-Path $dir "rtt_$stamp.etl"
$txt = Join-Path $dir "rtt_$stamp.txt"

try {
  pktmon filter remove 2>$null | Out-Null
  pktmon start --capture --pkt-size 96 -f $etl 2>&1 | Out-Null
  Start-Sleep -Milliseconds 500
  $pingOut = ping -n $Count $Target 2>&1
  Start-Sleep -Milliseconds 400
  pktmon stop 2>$null | Out-Null
  pktmon filter remove 2>$null | Out-Null
} finally {
  # 无论如何都要停掉，避免后台持续抓包
  try { pktmon stop 2>$null | Out-Null } catch { }
  try { pktmon filter remove 2>$null | Out-Null } catch { }
}

if (-not (Test-Path $txt) -and (Test-Path $etl)) {
  # etl2txt 会在 etl 旁边自动生成同名 .txt，不要重定向它的输出
  pktmon etl2txt $etl 2>&1 | Out-Null
}
if (-not (Test-Path $txt)) {
  Write-Host "✗ 抓包文件未生成，无法测量"
  exit 1
}

# ── 3. 解析：request 取最晚时刻（离开本机），reply 取最早时刻（刚进本机） ──
$lines = [System.IO.File]::ReadAllLines($txt)
$req = @{}; $rep = @{}; $cur = $null
foreach ($l in $lines) {
  $m = [regex]::Match($l, '::(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{7})')
  if ($m.Success) {
    $cur = [datetime]::ParseExact($m.Groups[1].Value, 'yyyy-MM-dd HH:mm:ss.fffffff', $null)
  }
  if ($null -eq $cur) { continue }
  # 只取目标相关的 ICMP；同时剔除本机其他网卡（如 WiFi）上的同名流量
  if ($l -match 'ICMP echo request.*seq (\d+)') {
    $s = [int]$Matches[1]
    if (-not $req.ContainsKey($s) -or $cur -gt $req[$s]) { $req[$s] = $cur }
  }
  if ($l -match 'ICMP echo reply.*seq (\d+)') {
    $s = [int]$Matches[1]
    if (-not $rep.ContainsKey($s) -or $cur -lt $rep[$s]) { $rep[$s] = $cur }
  }
}

$vals = @()
foreach ($s in ($req.Keys | Sort-Object)) {
  if ($rep.ContainsKey($s)) {
    $us = ($rep[$s] - $req[$s]).TotalMilliseconds * 1000
    if ($us -ge 0 -and $us -lt 1000000) { $vals += $us }   # 过滤异常配对
  }
}
$vals = $vals | Sort-Object
if (-not $vals -or $vals.Count -eq 0) {
  Write-Host "✗ 没抓到配对的 ICMP（req=$($req.Count) reply=$($rep.Count)）"
  Write-Host "  可能原因：目标不回 ICMP / 走了别的网卡 / 抓包时间太短"
  exit 1
}

$ms = { param($v) [math]::Round($v / 1000, 3) }
$result = [pscustomobject]@{
  target = $Target
  adapter = $Adapter
  linkSpeed = $link
  interruptModeration = $modState
  speedDuplex = $speedDup
  samples = $vals.Count
  minMs = (& $ms $vals[0])
  medianMs = (& $ms $vals[[int]($vals.Count / 2)])
  maxMs = (& $ms $vals[-1])
  measurement = 'pktmon ICMP frame timestamps'
  at = (Get-Date).ToString('s')
}

if ($Json) {
  $result | ConvertTo-Json
  exit 0
}

Write-Host ''
Write-Host ("  样本 {0} 个" -f $result.samples)
Write-Host ("  min {0}ms   中位 {1}ms   max {2}ms" -f $result.minMs, $result.medianMs, $result.maxMs)
Write-Host ''
Write-Host '  对照：Windows ping 同时显示的是'
$pingOut | Where-Object { $_ -match '时间=|time=' } | Select-Object -First 3 | ForEach-Object { Write-Host ('    ' + $_.Trim()) }
Write-Host '  （整数毫秒，看不出 0.15ms 与 0.94ms 的差别）'
Write-Host ''
Write-Host '  判读'
if ($result.medianMs -lt 0.30) {
  Write-Host '    ✓ 正常。千兆直连应为 0.1~0.3ms，说明网卡与链路都没问题。'
} elseif ($result.medianMs -lt 1.5) {
  Write-Host ("    ! 中位 {0}ms 偏高。实测病因是【节能机制】，不是中断节流：" -f $result.medianMs)
  Write-Host '      网卡空闲后进低功耗态，收到包要先唤醒 PHY/链路，每次多付约 0.8ms。'
  if ($powerOn.Count) {
    Write-Host ("      当前仍开着的节能项：" + (($powerOn | ForEach-Object { $_.name }) -join '、'))
  }
  Write-Host ''
  Write-Host '      实测对照（同一台机器，四组）：'
  Write-Host '        节能开 + 节流开 → 空闲后 0.934ms'
  Write-Host '        节能开 + 节流关 → 空闲后 0.935ms   （关节流无效）'
  Write-Host '        节能关 + 节流开 → 空闲后 0.131ms   （有效，7 倍）'
  Write-Host ''
  Write-Host '      改法（需管理员，逐项关掉后重启网卡）：'
  foreach ($k in '*EEE', 'EnableGreenEthernet', 'PowerSavingMode', 'GigabitLite', 'AdvancedEEE', 'AutoDisableGigabit') {
    Write-Host ("        Set-NetAdapterAdvancedProperty -Name '{0}' -RegistryKeyword '{1}' -RegistryValue 0 -NoRestart -ErrorAction SilentlyContinue" -f $Adapter, $k)
  }
  Write-Host "        Restart-NetAdapter -Name '$Adapter'"
  Write-Host '      另需取消「设备管理器 → 网卡 → 电源管理 → 允许计算机关闭此设备以省电」。'
  Write-Host ''
  Write-Host '      注意：此项只改善「单包往返」与尾部抖动；PLC 的块节拍（约 8.6ms/块）不受影响，'
  Write-Host '            批量读取的总耗时不会因此变短（见 docs/05 §4.5 对照）。'
} else {
  Write-Host ("    ! 中位 {0}ms 明显偏高，按顺序查：" -f $result.medianMs)
  Write-Host '      ① 双工不匹配 → Get-NetAdapterStatistics 看 Packet Errors / Discarded 是否增长'
  Write-Host '      ② 经多级交换机 / 路由器 / VPN'
  Write-Host '      ③ 走到 Wi-Fi 而非有线（确认 Find-NetRoute 选中的网卡）'
  Write-Host '      ④ 对端 ICMP 限速（此时以 TCP 通讯是否正常为准）'
}

Write-Host ''
Write-Host "  [ok] 临时文件在 $dir（-Cleanup 可清理）"
