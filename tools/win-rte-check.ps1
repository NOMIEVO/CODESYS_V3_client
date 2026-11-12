# win-rte-check.ps1 — CODESYS Control RTE 实时性配置体检（Windows 工控机）
# ════════════════════════════════════════════════════════════════════════════
# 依据：CODESYS 官方文档
#   《Configuring Real-Time Behavior on Special Platforms》
#   《Hardware Configuration – Recommendations》
#   https://content.helpme-codesys.com/en/CODESYS%20Control/_rtsl_windows_rte_v3_examples_hints.html
#
# 为什么需要它：RTE 必须独占一个物理 CPU 核才能提供微秒级实时性。以下任一项不满足，
# RTE 的调度就会退化成「时间片分享」，表现为**每个操作固定等一个节拍**（本项目实测
# 约 8.9ms、96% 落在 8.5~9.0ms），于是 500 次协议往返就变成 4.5 秒。
#
# 最常见的杀手（官方明确列出）：
#   · BIOS 里 VT/AMD-V 开着 → Win10+ 会让 Windows 自己跑在虚拟化环境里，
#     RTE 无法启动专用核。**装了 VMware/Hyper-V 的机器默认就中这一条。**
#   · BIOS 里 HT/SMT 开着、C-States 未关、EIST/SpeedStep 未关 → 频率与睡眠状态变化
#   · Windows 快速启动 / 休眠开着 → 会改变 CPU 频率
#   · 第一次启动时 RTE 测得的时钟校准值（注册表 SetClocksPerUS / SetCountsPerMS）
#     在改过 BIOS 频率设置后失效，必须删除让 RTE 重测
#
# 用法（在工控机上，建议管理员）：
#     powershell -ExecutionPolicy Bypass -File win-rte-check.ps1
#     powershell -ExecutionPolicy Bypass -File win-rte-check.ps1 -Apply        # 只改 Windows 侧安全项
#     powershell -ExecutionPolicy Bypass -File win-rte-check.ps1 -Apply -DryRun
#     powershell -ExecutionPolicy Bypass -File win-rte-check.ps1 -ResetClockCalibration
#     powershell -ExecutionPolicy Bypass -File win-rte-check.ps1 -Json
#
# 只读模式不需要管理员。-Apply 需要。
# 不会改 BIOS（做不到），但会把「该去 BIOS 改什么」列清楚。
# ════════════════════════════════════════════════════════════════════════════
[CmdletBinding()]
param(
  [switch]$Apply,
  [switch]$DryRun,
  [switch]$ResetClockCalibration,   # 删除 RTE 时钟校准值，让它启动时重测（官方文档做法）
  [switch]$Json
)

$ErrorActionPreference = 'Continue'
$rows = New-Object System.Collections.ArrayList
function Add-Row {
  param([string]$Group, [string]$Item, [string]$Current, [string]$Want, [string]$Verdict, [string]$Note = '')
  [void]$rows.Add([pscustomobject]@{ Group = $Group; Item = $Item; Current = $Current; Want = $Want; Verdict = $Verdict; Note = $Note })
}
function Say([string]$s) { if (-not $Json) { Write-Host $s } }
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)

Say '════════════════════════════════════════════════════════════'
Say '  CODESYS Control RTE 实时性体检'
Say ("  管理员权限  " + $(if ($isAdmin) { '是' } else { '否（只读可跑，-Apply 需要）' }))
Say '════════════════════════════════════════════════════════════'

# ── 1. 虚拟化：RTE 的头号敌人 ────────────────────────────────────────
$cs = Get-CimInstance Win32_ComputerSystem -ErrorAction SilentlyContinue
$hvPresent = $cs.HypervisorPresent
$dg = Get-CimInstance -Namespace root\Microsoft\Windows\DeviceGuard -ClassName Win32_DeviceGuard -ErrorAction SilentlyContinue
$vbsOn = ($dg -and $dg.VirtualizationBasedSecurityStatus -ge 1)
$hvci = ($dg -and ($dg.SecurityServicesRunning -contains 2))

$bcd = ''
try { $bcd = (bcdedit /enum "{current}" 2>$null | Out-String) } catch { }
$hvLaunch = if ($bcd -match 'hypervisorlaunchtype\s+(\w+)') { $Matches[1] } else { '未设置(Auto)' }

Add-Row '虚拟化（最关键）' 'Windows 是否运行在虚拟化层上' `
  $(if ($hvPresent -eq $true) { '是（HypervisorPresent=True）' } else { '否' }) '否' `
  $(if ($hvPresent -eq $true) { '必须改' } else { 'OK' }) `
  '官方文档：Win10+ 若 VT 开启，Windows 自身会跑在虚拟化环境里，RTE 无法独占 CPU 核，实时性退化为时间片 → 每次操作固定等一个节拍'

Add-Row '虚拟化（最关键）' 'hypervisorlaunchtype' $hvLaunch 'off' `
  $(if ($hvLaunch -match '^off$') { 'OK' } else { '待确认' }) `
  'bcdedit /set hypervisorlaunchtype off 后重启可关闭 Hyper-V 引导（若暂时不能关 BIOS 的 VT）'

Add-Row '虚拟化（最关键）' '基于虚拟化的安全 VBS' `
  $(if ($dg) { "状态=$($dg.VirtualizationBasedSecurityStatus)" } else { '无法读取' }) '0（关闭）' `
  $(if ($vbsOn) { '必须改' } else { 'OK' }) '设置 → 隐私和安全性 → Windows 安全中心 → 设备安全性 → 内核隔离 → 内存完整性，关掉'

Add-Row '虚拟化（最关键）' '内存完整性 HVCI' $(if ($hvci) { '已开启' } else { '关闭' }) '关闭' `
  $(if ($hvci) { '必须改' } else { 'OK' }) 'HVCI 会占用虚拟化能力并拦截驱动，RTE 调度驱动可能加载异常'

foreach ($f in @(
  @{ N = 'Microsoft-Hyper-V-All'; D = 'Hyper-V 平台' },
  @{ N = 'VirtualMachinePlatform'; D = '虚拟机平台' },
  @{ N = 'HypervisorPlatform';     D = '虚拟机监控程序平台' }
)) {
  $st = $null
  try { $st = (Get-CimInstance Win32_OptionalFeature -Filter "Name='$($f.N)'" -ErrorAction Stop).InstallState } catch { }
  # InstallState: 1=Enabled 2=Disabled 3=Absent
  $txt = switch ($st) { 1 { '已启用' } 2 { '已禁用' } 3 { '未安装' } default { '未知' } }
  Add-Row '虚拟化（最关键）' $f.D $txt '已禁用/未安装' `
    $(if ($st -eq 1) { '必须改' } else { 'OK' }) `
    'PowerShell(管理员): Disable-WindowsOptionalFeature -Online -FeatureName ' + $f.N + ' -NoRestart'
}

$cpu = Get-CimInstance Win32_Processor -ErrorAction SilentlyContinue | Select-Object -First 1
if ($cpu) {
  $htOn = ($cpu.NumberOfLogicalProcessors -gt $cpu.NumberOfCores)
  Add-Row 'BIOS（需手动进设置）' '超线程 HT / SMT' `
    ("$($cpu.NumberOfCores) 核 / $($cpu.NumberOfLogicalProcessors) 逻辑处理器") '关闭（逻辑=物理）' `
    $(if ($htOn) { '必须改' } else { 'OK' }) '官方要求禁用；超线程会让 RTE 的独占核被兄弟线程干扰'
  Add-Row 'BIOS（需手动进设置）' 'VT / AMD-V' `
    $(if ($hvPresent -eq $true) { '开着（推断）' } else { '无法从系统判断' }) '关闭' `
    $(if ($hvPresent -eq $true) { '必须改' } else { '待确认' }) `
    'BIOS 里叫 Intel VT-x / VT-d（Intel）或 SVM Mode（AMD）。若这台机器还要跑 VMware，二者只能选一个'
  Add-Row 'BIOS（需手动进设置）' 'C-States（睡眠状态）' '需进 BIOS 查看' '关闭（C0 only / Disabled）' '待确认' `
    'C 状态会关缓存、降电压与频率；RTE 要求处理器不进睡眠态'
  Add-Row 'BIOS（需手动进设置）' 'EIST / SpeedStep / Cool''n''Quiet' '需进 BIOS 查看' '关闭' '待确认' `
    '频率动态变化会让 RTE 的微秒级计时失准'
  Add-Row 'BIOS（需手动进设置）' 'Legacy USB / 周期性 SMI' '需进 BIOS 查看' '关闭' '待确认' `
    'SMI 会让整机停几十到几百微秒，是实时性抖动的常见来源'
  Add-Row 'BIOS（需手动进设置）' 'E-Core（Intel 12 代及以后）' '需进 BIOS 查看' '关闭' '待确认' `
    '能效核会参与调度，官方要求关闭'

  if ($cpu.CurrentClockSpeed -and $cpu.MaxClockSpeed -and $cpu.CurrentClockSpeed -lt $cpu.MaxClockSpeed) {
    Add-Row 'CPU 频率' '当前/最高主频' ("$($cpu.CurrentClockSpeed) / $($cpu.MaxClockSpeed) MHz") '当前 = 最高' '建议改' `
      '当前低于最高 → 存在降频（电源计划或 C-State）。RTE 的计时校准会失准'
  } else {
    Add-Row 'CPU 频率' '当前/最高主频' ("$($cpu.CurrentClockSpeed) / $($cpu.MaxClockSpeed) MHz") '当前 = 最高' 'OK' ''
  }
}

# ── 2. Windows 省电能力（官方明确要求关） ────────────────────────────
$scheme = ''
try { $scheme = (powercfg /getactivescheme 2>$null) -join ' ' } catch { }
$high = $scheme -match '高性能|High performance|卓越性能|Ultimate|始终开启|Always on'
Add-Row 'Windows 电源' '电源计划' ($scheme -replace '.*\((.*)\).*', '$1') '高性能 / 卓越性能（Always on）' `
  $(if ($high) { 'OK' } else { '必须改' }) '官方原文：power scheme should always be set to "Always on"'

$throttleMin = $null
try {
  $out = powercfg /query SCHEME_CURRENT SUB_PROCESSOR PROCTHROTTLEMIN 2>$null | Out-String
  if ($out -match '当前交流电源设置索引:\s*0x([0-9a-fA-F]+)') { $throttleMin = [Convert]::ToInt32($Matches[1], 16) }
  elseif ($out -match 'Current AC Power Setting Index:\s*0x([0-9a-fA-F]+)') { $throttleMin = [Convert]::ToInt32($Matches[1], 16) }
} catch { }
Add-Row 'Windows 电源' '最小处理器状态（交流）' $(if ($null -ne $throttleMin) { "$throttleMin%" } else { '无法读取' }) '100%' `
  $(if ($throttleMin -eq 100) { 'OK' } else { '建议改' }) '低于 100% 允许降频，RTE 计时会漂'

$fs = (Get-ItemProperty 'HKLM:\SYSTEM\CurrentControlSet\Control\Session Manager\Power' -Name HiberbootEnabled -ErrorAction SilentlyContinue).HiberbootEnabled
Add-Row 'Windows 电源' '快速启动 Fast Startup' $(if ($fs -eq 1) { '已开启' } else { '关闭' }) '关闭' `
  $(if ($fs -eq 1) { '必须改' } else { 'OK' }) '官方明确：快速启动会改变 CPU 频率'

$hib = (Get-ItemProperty 'HKLM:\SYSTEM\CurrentControlSet\Control\Power' -Name HibernateEnabled -ErrorAction SilentlyContinue).HibernateEnabled
Add-Row 'Windows 电源' '休眠 Hibernate' $(if ($hib -eq 1) { '已开启' } else { '关闭' }) '关闭' `
  $(if ($hib -eq 1) { '必须改' } else { 'OK' }) '同上；powercfg /h off 可一并关掉快速启动与休眠'

Add-Row 'Windows 电源' 'PCIe 链接状态电源管理' '需在电源选项里看' '关闭' '待确认' `
  '会让 PCIe 设备（含网卡）进低功耗态'

# ── 3. RTE 自身的安装与校准状态 ──────────────────────────────────────
$svc = Get-Service -ErrorAction SilentlyContinue | Where-Object { $_.Name -match '^CmpDrvScheduler|^CODESYSControl' }
if ($svc) {
  foreach ($s in $svc) {
    $mustRun = $s.Name -match 'CmpDrvScheduler|CODESYSControl.*Service'
    Add-Row 'RTE 组件' $s.Name $s.Status $(if ($mustRun) { 'Running' } else { '按需' }) `
      $(if ($mustRun -and $s.Status -ne 'Running') { '建议改' } else { 'OK' }) ''
  }
} else {
  Add-Row 'RTE 组件' 'CmpDrvScheduler* / CODESYSControl* 服务' '未找到' '存在且运行' '待确认' `
    '本机没装 RTE，或服务名不同（老版本为 CODESYSControlService）。若跑的是 Control Win 而非 RTE，本页大多数 BIOS 项不适用'
}

# 时钟校准值：官方文档明确「改过 BIOS 频率设置后必须删除，让 RTE 重测」
$calFound = @()
foreach ($k in 'CmpDrvSchedulerAMP', 'CmpDrvSchedulerAPIC') {
  $p = "HKLM:\SYSTEM\CurrentControlSet\Services\$k\Params"
  if (Test-Path $p) {
    $v = Get-ItemProperty $p -ErrorAction SilentlyContinue
    if ($null -ne $v.SetClocksPerUS -or $null -ne $v.SetCountsPerMS) {
      $calFound += "$k (SetClocksPerUS=$($v.SetClocksPerUS), SetCountsPerMS=$($v.SetCountsPerMS))"
    }
  }
}
if ($calFound.Count) {
  Add-Row 'RTE 组件' '时钟校准值（注册表）' ($calFound -join ' ; ') '改过 BIOS 后应删除并重测' '待确认' `
    '官方：首次启动测得的值会一直复用；若 BIOS 节能/频率设置变过，这些值失效 → 用 -ResetClockCalibration 删除，重启 RTE 自动重测'
} else {
  Add-Row 'RTE 组件' '时钟校准值（注册表）' '未找到' '（首次启动自动生成）' 'n/a' ''
}

# ── 4. Windows 更新与干扰源 ──────────────────────────────────────────
Add-Row '干扰源' 'Windows 自动更新' '需确认' '手动（生产机禁止自动重启）' '待确认' `
  '官方建议工业控制器手工更新；更新编排器会抢占实时核'

$wu = Get-Service wuauserv -ErrorAction SilentlyContinue
if ($wu) {
  Add-Row '干扰源' 'Windows Update 服务' $wu.Status 'Manual/Disabled（生产期）' '待确认' ''
}

# ── 5. RTE 网卡不能睡（与 win-nic-check 呼应） ────────────────────────
Add-Row 'RTE 网卡' '网卡电源管理' '见 win-nic-check.ps1' '不允许系统关闭' '待确认' `
  '官方：network cards used in the RTE must not be set to sleep mode'

# ── 6. 应用（只动 Windows 侧的、可回退的项） ─────────────────────────
$applied = @()
if ($Apply) {
  if (-not $isAdmin) {
    Add-Row '应用结果' '整体' '缺少管理员权限' '' 'fail' '请以管理员身份重开 Windows PowerShell 再跑 -Apply'
  } else {
    # ① 电源计划 → 卓越性能/高性能
    if (-not $high) {
      if ($DryRun) { Add-Row '应用结果' '电源计划' '将切换到高性能' '' 'dry' '' }
      else {
        $done = $false
        foreach ($g in 'e9a42b02-d5df-448d-aa00-03f14749eb61', '8c5e7fda-e8bf-4a96-9a85-a6e23a8c635c') {
          powercfg /setactive $g 2>$null
          if ($LASTEXITCODE -eq 0) { $done = $true; break }
        }
        Add-Row '应用结果' '电源计划' $(if ($done) { '已切到高性能' } else { '切换失败' }) '' $(if ($done) { 'done' } else { 'fail' }) ''
      }
    }
    # ② 最小处理器状态 100%
    if ($throttleMin -ne 100) {
      if ($DryRun) { Add-Row '应用结果' '最小处理器状态' '将设为 100%' '' 'dry' '' }
      else {
        powercfg /setacvalueindex SCHEME_CURRENT SUB_PROCESSOR PROCTHROTTLEMIN 100 2>$null
        powercfg /setactive SCHEME_CURRENT 2>$null
        Add-Row '应用结果' '最小处理器状态' '已设为 100%' '' 'done' ''
      }
    }
    # ③ 关快速启动 + 休眠
    if ($fs -eq 1 -or $hib -eq 1) {
      if ($DryRun) { Add-Row '应用结果' '快速启动/休眠' '将执行 powercfg /h off' '' 'dry' '' }
      else {
        powercfg /h off 2>$null
        Add-Row '应用结果' '快速启动/休眠' '已关闭（powercfg /h off）' '' 'done' '下次开机生效'
      }
    }
  }
}

# ④ 时钟校准值重置（单独开关，默认不动）
if ($ResetClockCalibration) {
  if (-not $isAdmin) {
    Add-Row '应用结果' '时钟校准值' '缺少管理员权限' '' 'fail' ''
  } elseif (-not $calFound.Count) {
    Add-Row '应用结果' '时钟校准值' '本来就没有，无需删除' '' 'n/a' ''
  } elseif ($DryRun) {
    Add-Row '应用结果' '时钟校准值' '将删除 SetClocksPerUS / SetCountsPerMS' '' 'dry' 'RTE 下次启动会重新测量'
  } else {
    foreach ($k in 'CmpDrvSchedulerAMP', 'CmpDrvSchedulerAPIC') {
      $p = "HKLM:\SYSTEM\CurrentControlSet\Services\$k\Params"
      foreach ($n in 'SetClocksPerUS', 'SetCountsPerMS') {
        try { Remove-ItemProperty -Path $p -Name $n -ErrorAction Stop } catch { }
      }
    }
    Add-Row '应用结果' '时钟校准值' '已删除，重启 RTE 后自动重测' '' 'done' '请完整断电重启一次（不是软重启）'
  }
}

# ── 7. 输出 ─────────────────────────────────────────────────────────
if ($Json) {
  [pscustomobject]@{
    host = $env:COMPUTERNAME
    cpu = if ($cpu) { "$($cpu.Name) / $($cpu.NumberOfCores)C$($cpu.NumberOfLogicalProcessors)T" } else { '' }
    hypervisorPresent = $hvPresent
    checkedAt = (Get-Date).ToString('s')
    rows = $rows
  } | ConvertTo-Json -Depth 5
  exit 0
}

$grp = ''
foreach ($r in $rows) {
  if ($r.Group -ne $grp) { $grp = $r.Group; if ($grp -notmatch '^　') { Say ''; Say "── $grp ──" } }
  $mark = switch ($r.Verdict) {
    'OK' { '[ OK ]' } 'done' { '[已改]' } 'dry' { '[待改]' } 'fail' { '[失败]' }
    'n/a' { '[ -- ]' } '建议改' { '[!!]  ' } '待确认' { '[? ]  ' } '必须改' { '[!!!] ' } default { '[? ]  ' }
  }
  Say ("$mark {0}　当前: {1}　要求: {2}" -f $r.Item, $r.Current, $r.Want)
  if ($r.Note) { Say ("        └ $($r.Note)") }
}

$must = @($rows | Where-Object { $_.Verdict -in @('必须改') })
$should = @($rows | Where-Object { $_.Verdict -in @('建议改', '待确认') })
Say ''
Say '════════════════════════════════════════════════════════════'
Say ("  必须改 {0} 项 · 待确认 {1} 项 · 共检查 {2} 项" -f $must.Count, $should.Count, $rows.Count)
if ($hvPresent -eq $true) {
  Say ''
  Say '  ⚠ 头号问题：Windows 正跑在虚拟化层上（VT/Hyper-V/VBS 任一开启都会这样）。'
  Say '    按 CODESYS 官方文档，此时 RTE 无法独占物理核，实时性退化为时间片分享，'
  Say '    表现为「每个操作固定等一个节拍」（本项目现场实测 ≈8.9ms/操作，96% 落在 8.5~9.0ms）。'
  Say '    处理顺序：'
  Say '      ① BIOS 关 VT（若这台机器还要跑 VMware，二者只能选一个）'
  Say '      ② 或退一步：关「虚拟机平台 / 虚拟机监控程序平台」功能 + 关内核隔离内存完整性'
  Say '      ③ bcdedit /set hypervisorlaunchtype off 后重启'
  Say '      ④ 有 RTE 控制面板的话，在 Real-Time 页把专用核指定出来并启用 Core Isolation'
}
Say ''
Say '  BIOS 里还要关（脚本读不到，需手动进设置）：'
Say '    HT/SMT、C-States、EIST/SpeedStep、Legacy USB 与周期性 SMI、自检/内存测试、E-Core'
Say ''
Say '  改完验证（在客户端电脑，只读）：'
Say '    node tools/probe-blockgap.js <PLC_IP> <APP> <符号>'
Say '    合格标准：逐块间隔中位从 ~9ms 降到 <2ms，且分布不再集中在单一窄峰'
Say '════════════════════════════════════════════════════════════'
