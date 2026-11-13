# win-nic-check.ps1 — 面向 CODESYS/PLC 通讯的网卡与系统参数体检（Windows 工控机）
# ════════════════════════════════════════════════════════════════════════════
# 用途：工控机上跑一遍，逐项列出「影响 PLC 往返延迟」的参数，并标注是否符合建议值。
#      默认只读；加 -Apply 才改（逐项打印 原值 → 新值，改不动的会写明原因）。
#
# 为什么查这些：本项目实测（同一客户端、同一交换机）
#     KSC-SA40       每次协议操作 ≈ 0.4ms
#     Win10 + RTE    每次协议操作 ≈ 9ms（96% 落在 8.9±0.5ms，高度量化）
#     TCP 握手仅 1.1ms（内核栈）→ 网口速率与带宽不是瓶颈，但下列参数会影响
#     「每次往返」的几个毫秒；真正的 8ms 大头在 Runtime 调度与任务周期。
#   所以顺序是：先按本脚本把「不该有的延迟」清掉（能拿回 0.5~1.5ms/操作），
#   再去查 Runtime 任务周期（那才是主要矛盾）。
#
# 用法（在工控机上，建议以管理员身份运行 PowerShell）：
#     powershell -ExecutionPolicy Bypass -File win-nic-check.ps1
#     powershell -ExecutionPolicy Bypass -File win-nic-check.ps1 -PlcIp 192.168.1.92
#     powershell -ExecutionPolicy Bypass -File win-nic-check.ps1 -Apply
#     powershell -ExecutionPolicy Bypass -File win-nic-check.ps1 -Json > nic.json
#
# 只读模式不需要管理员；-Apply 需要管理员。
# ════════════════════════════════════════════════════════════════════════════
[CmdletBinding()]
param(
  [string]$PlcIp   = '192.168.1.92',   # 用它反查「面向 PLC 的那块网卡」
  [string]$Adapter = '',               # 手动指定网卡名（留空自动）
  [switch]$Apply,                      # 应用建议值（需管理员）
  [switch]$DryRun,                     # 与 -Apply 同用：只列出将要改什么，不实际写入
  [switch]$Json                        # 仅输出 JSON
)

$ErrorActionPreference = 'Continue'
$script:rows = New-Object System.Collections.ArrayList

function Add-Row {
  param([string]$Group, [string]$Item, [string]$Current, [string]$Want, [string]$Verdict, [string]$Note = '')
  [void]$script:rows.Add([pscustomobject]@{
    Group = $Group; Item = $Item; Current = $Current; Want = $Want; Verdict = $Verdict; Note = $Note
  })
}

function Say([string]$s) { if (-not $Json) { Write-Host $s } }

# ── 1. 选定网卡：优先找能到达 PLC 的那块 ─────────────────────────────
if (-not $Adapter) {
  try {
    $route = Find-NetRoute -RemoteIPAddress $PlcIp -ErrorAction Stop | Select-Object -First 1
    $Adapter = $route.InterfaceAlias
  } catch {
    $up = Get-NetAdapter | Where-Object { $_.Status -eq 'Up' -and $_.Virtual -eq $false } | Select-Object -First 1
    if ($up) { $Adapter = $up.Name }
  }
}
if (-not $Adapter) { Say '✗ 找不到活动网卡，请用 -Adapter 指定'; exit 2 }

$nic = Get-NetAdapter -Name $Adapter -ErrorAction SilentlyContinue
if (-not $nic) {
  $alt = Get-NetAdapter | Where-Object { $_.InterfaceDescription -like "*$Adapter*" } | Select-Object -First 1
  if ($alt) { $nic = $alt; $Adapter = $alt.Name } else { Say "✗ 找不到网卡：$Adapter"; exit 2 }
}

Say '════════════════════════════════════════════════════════════'
Say '  面向 PLC 通讯的网卡体检'
Say "  网卡  $($nic.Name)  ($($nic.InterfaceDescription))"
Say "  速率  $($nic.LinkSpeed)   状态 $($nic.Status)"
Say "  PLC   $PlcIp"
Say '════════════════════════════════════════════════════════════'

# ── 2. 高级属性：关键字匹配（兼容 Intel 英文/Realtek 中文命名） ─────────
$props = Get-NetAdapterAdvancedProperty -Name $nic.Name -ErrorAction SilentlyContinue
function Get-Prop([string[]]$kw) {
  foreach ($k in $kw) {
    $hit = $props | Where-Object { $_.RegistryKeyword -eq $k } | Select-Object -First 1
    if ($hit) { return $hit }
  }
  foreach ($k in $kw) {
    $hit = $props | Where-Object { $_.DisplayName -match $k } | Select-Object -First 1
    if ($hit) { return $hit }
  }
  return $null
}

# 关闭类：这些开着会让每个包/每次交互多等一段时间
$offList = @(
  @{ Key = @('*InterruptModeration');                       Name = '中断调整 Interrupt Moderation'; Why = '合并中断成批上报。实测对「空闲后 0.93ms」无影响（关掉仍 0.93ms），但对持续高速小包有轻微帮助' },
  @{ Key = @('*EEE','AdvancedEEE','EnableGreenEthernet','GigabitLite','PowerSavingMode','AutoDisableGigabit');
     Name = '节能以太网 / 绿色以太网 / 低功耗';                Why = '【实测最关键】空闲后进低功耗态，每包要先唤醒 PHY，RTT 0.93ms→关掉 0.13ms（7 倍）' },
  @{ Key = @('*FlowControl');                               Name = '流控制 Flow Control';            Why = 'pause 帧会让发送方整段停顿，突发读取时更明显' },
  @{ Key = @('*LsoV2IPv4','*LsoV2IPv6');                    Name = '大量传送减负 LSO v2';            Why = '大包分片交给网卡，小包协议无收益且增加不可预期延迟' },
  @{ Key = @('*JumboPacket');                               Name = '巨型帧 Jumbo Frame';            Why = '本协议帧 ≤516B，开巨型帧没有任何好处，还易与交换机不一致' },
  @{ Key = @('*WakeOnMagicPacket','*WakeOnPattern','S5WakeOnLan'); Name = '网络唤醒 WoL';           Why = '保持网卡待机逻辑活跃，生产中无用' },
  @{ Key = @('*PMARPOffload','*PMNSOffload');               Name = 'ARP/NS 减负';                    Why = '交给网卡代答，个别驱动会引入额外处理' },
  @{ Key = @('*PriorityVLANTag');                           Name = '优先级和 VLAN 标记';             Why = '不用 VLAN 时关掉，减少每包处理' }
)
foreach ($it in $offList) {
  $p = Get-Prop $it.Key
  if (-not $p) { Add-Row '网卡高级属性' $it.Name '（此项不存在）' '关闭' 'n/a' $it.Why; continue }
  $v = [string]$p.DisplayValue
  $isOff = $v -match '关闭|Disabled|Disable|^0$|Off'
  Add-Row '网卡高级属性' $it.Name $v '关闭' $(if ($isOff) { 'OK' } else { '建议改' }) $it.Why
  if ($Apply -and -not $isOff -and $DryRun) {
    Add-Row '　└ 待改' $it.Name "$v → 关闭" '' 'dry' '（-DryRun，未写入）'
  } elseif ($Apply -and -not $isOff) {
    try {
      Set-NetAdapterAdvancedProperty -Name $nic.Name -RegistryKeyword $p.RegistryKeyword -RegistryValue 0 -NoRestart -ErrorAction Stop
      Add-Row '　└ 已应用' $it.Name "$v → 关闭" '' 'done' ''
    } catch {
      Add-Row '　└ 未应用' $it.Name $v '' 'fail' $_.Exception.Message.Split("`n")[0]
    }
  }
}

# 缓冲区：偏大有利于突发，偏小会丢帧重传
foreach ($buf in @(
  @{ Key = @('*ReceiveBuffers');  Name = '接收缓冲区 Receive Buffers'; Min = 1024 },
  @{ Key = @('*TransmitBuffers'); Name = '传送缓冲区 Transmit Buffers'; Min = 1024 }
)) {
  $p = Get-Prop $buf.Key
  if (-not $p) { Add-Row '网卡高级属性' $buf.Name '（此项不存在）' "≥$($buf.Min)" 'n/a' ''; continue }
  $v = [int]($p.DisplayValue -replace '[^\d]', '')
  Add-Row '网卡高级属性' $buf.Name ([string]$v) "≥$($buf.Min)" $(if ($v -ge $buf.Min) { 'OK' } else { '建议改' }) '偏大能吸收突发，偏小会触发重传'
  if ($Apply -and $v -lt $buf.Min) {
    try {
      Set-NetAdapterAdvancedProperty -Name $nic.Name -RegistryKeyword $p.RegistryKeyword -RegistryValue $buf.Min -NoRestart -ErrorAction Stop
      Add-Row '　└ 已应用' $buf.Name "$v → $($buf.Min)" '' 'done' ''
    } catch {
      Add-Row '　└ 未应用' $buf.Name ([string]$v) '' 'fail' $_.Exception.Message.Split("`n")[0]
    }
  }
}

# 速率与双工：固定 1G 全双工（不要自动，也不要 100M）
$sd = Get-Prop @('*SpeedDuplex')
if ($sd) {
  $v = [string]$sd.DisplayValue
  $auto = $v -match '自动|Auto'
  $is100 = $v -match '100'
  $verdict = if ($is100) { '必须改' } elseif ($auto) { '建议改' } else { 'OK' }
  Add-Row '网卡高级属性' '连接速度和双工模式' $v '1.0 Gbps 全双工（固定）' $verdict `
    '自动协商在部分交换机上会协商成 100M，且链路状态变化时会短暂中断；固定 1G 全双工最稳'
}

# RSS：多核建议开；若 RTE 绑核，队列数应与承载核数匹配
$rss = Get-Prop @('*RSS')
if ($rss) {
  $on = ([string]$rss.DisplayValue) -match '开启|Enabled|Enable'
  Add-Row '网卡高级属性' 'RSS 接收端调整' ([string]$rss.DisplayValue) '开启' $(if ($on) { 'OK' } else { '建议改' }) '多核分担中断；单核绑定时可关'
}

# ── 3. 电源管理：别让系统关掉这块网卡 ──────────────────────────────
$pm = $null
try {
  $guid = (Get-NetAdapter -Name $nic.Name).InterfaceGuid
  $pm = Get-CimInstance -Namespace root/wmi -ClassName MSPower_DeviceEnable -ErrorAction SilentlyContinue |
        Where-Object { $_.InstanceName -like "*$($nic.PnPDeviceID)*" } | Select-Object -First 1
} catch { }
if ($pm) {
  Add-Row '电源管理' '允许计算机关闭此设备以省电' $(if ($pm.Enable) { '已勾选' } else { '未勾选' }) '未勾选' `
    $(if ($pm.Enable) { '建议改' } else { 'OK' }) '勾选后空闲会进低功耗态，下一次读取要先唤醒'
  if ($Apply -and $pm.Enable) {
    try {
      Set-CimInstance -InputObject $pm -Property @{ Enable = $false } -ErrorAction Stop
      Add-Row '　└ 已应用' '允许计算机关闭此设备以省电' '已勾选 → 未勾选' '' 'done' ''
    } catch {
      Add-Row '　└ 未应用' '允许计算机关闭此设备以省电' '' '' 'fail' '需管理员权限或驱动不支持'
    }
  }
} else {
  Add-Row '电源管理' '允许计算机关闭此设备以省电' '（无法读取）' '未勾选' 'n/a' '可在设备管理器→网卡→电源管理里手查'
}

# ── 4. 绑定的协议/过滤驱动：每个都在这条路径上，越少越快 ──────────────
$bind = Get-NetAdapterBinding -Name $nic.Name -ErrorAction SilentlyContinue | Where-Object { $_.Enabled }
$noise = @()
if ($bind) {
  $must = @('ms_tcpip', 'ms_tcpip6', 'ms_pacer', 'ms_lltdio', 'ms_rspndr', 'ms_server', 'ms_msclient')
  $noise = $bind | Where-Object { $must -notcontains $_.ComponentID }
  foreach ($b in $noise) {
    Add-Row '过滤驱动' $b.DisplayName "$($b.ComponentID)" '如非必需则禁用' '待确认' `
      '每一个 NDIS 过滤驱动都在收发路径上，会累加延迟；抓包/VPN/多品牌 GigE 驱动尤其明显'
  }
  Add-Row '过滤驱动' ('合计绑定 ' + $bind.Count + ' 项，其中非标准 ' + $noise.Count + ' 项') '' '' `
    $(if ($noise.Count -eq 0) { 'OK' } else { '待确认' }) '只保留业务必需的，其余禁用后重启网卡再测'
}

# ── 5. 系统层：电源计划 / 处理器状态 / TCP 全局 ─────────────────────
try {
  $scheme = (powercfg /getactivescheme) -join ' '
  $high = $scheme -match '高性能|High performance|卓越性能|Ultimate'
  Add-Row '系统' '电源计划' ($scheme -replace '.*\((.*)\).*', '$1') '高性能 / 卓越性能' $(if ($high) { 'OK' } else { '建议改' }) `
    '平衡计划会降频，RTE 的调度节拍会抖'
} catch {
  Add-Row '系统' '电源计划' '（读取失败）' '高性能' 'n/a' ''
}

$tcp = netsh int tcp show global 2>$null | Out-String
# netsh 输出随语言/版本变化（「接收段合并状态」vs「接收段合并(RSC)」），
# 所以按多个候选关键词定位，取冒号后第一个词
function TcpVal([string[]]$kw, [string]$fallback) {
  foreach ($k in $kw) {
    $m = [regex]::Match($tcp, $k + '[^:：]*[:：]\s*(\S+)')
    if ($m.Success) { return $m.Groups[1].Value }
  }
  return $fallback
}
if ($tcp.Trim()) {
  $rsc = TcpVal @('接收段合并状态', '接收段合并', 'Receive Segment Coalescing') '?'
  Add-Row '系统' 'TCP 接收段合并 RSC' $rsc 'disabled' $(if ($rsc -match 'disabled|已禁用') { 'OK' } else { '建议改' }) `
    'RSC 会合并多段，让上层更晚收到；本协议块仅 448B，合并只有坏处（netsh int tcp set global rsc=disabled）'
  $auto = TcpVal @('接收窗口自动调节级别', 'Receive Window Auto-Tuning Level') '?'
  Add-Row '系统' '接收窗口自动调节级别' $auto 'normal' $(if ($auto -match 'normal|正常') { 'OK' } else { '待确认' }) `
    'restricted 会限制窗口；本协议是小请求+大响应，normal 更合适'
  $ts = TcpVal @('RFC 1323 时间戳', 'Timestamps') '?'
  Add-Row '系统' 'TCP 时间戳' $ts 'enabled' $(if ($ts -match 'enabled|已启用') { 'OK' } else { '待确认' }) `
    '时间戳用于精确 RTT 测量；关掉反而更容易误判超时，建议保持开启'
  $syn = TcpVal @('最大 SYN 重新传输次数', 'Max SYN Retransmissions') '?'
  Add-Row '系统' '最大 SYN 重传次数' $syn '2' $(if ($syn -eq '2') { 'OK' } else { '待确认' }) `
    '默认 4 意味着连接失败要等 4×RTO；降到 2 能让「断开」更快被识别（不影响正常速度）'
}

# 丢包/错包：双工不匹配、线序问题、交换机口故障都会在这里露出
try {
  $st = Get-NetAdapterStatistics -Name $nic.Name -ErrorAction Stop
  $drop = [int]$st.ReceivedDiscardedPackets + [int]$st.OutboundDiscardedPackets
  $err  = [int]$st.ReceivedPacketErrors + [int]$st.OutboundPacketErrors
  Add-Row '链路质量' '丢弃包 Discarded' ([string]$drop) '接近 0' $(if ($drop -eq 0) { 'OK' } else { '建议改' }) `
    '丢弃多常见于双工不匹配（一端自适应成半双工）或网线/水晶头老化；也可能是缓冲区太小'
  Add-Row '链路质量' '错包 Packet Errors' ([string]$err) '0' $(if ($err -eq 0) { 'OK' } else { '必须改' }) `
    '出现错包必须换线/换口，这不是软件能解决的问题'
  if ($nic.LinkSpeed -match '100 Mbps') {
    Add-Row '链路质量' '实际协商速率' ([string]$nic.LinkSpeed) '1 Gbps' '必须改' `
      '只协商到 100M：多为网线只有 4 芯（Cat5 劣质线）或交换机口是百兆。换 Cat5e/Cat6 与千兆口'
  }
} catch { }

# 是否被虚拟交换机/绑卡接管（vEthernet、VMware、Hyper-V 会让每包多一层）
try {
  $virt = Get-NetAdapter -ErrorAction SilentlyContinue |
          Where-Object { $_.Status -eq 'Up' -and ($_.Virtual -or $_.Name -match '^vEthernet|VMnet|Hyper-V') }
  if ($virt -and ($nic.Virtual -or $nic.Name -match 'vEthernet')) {
    Add-Row '虚拟化' '本网卡是虚拟网卡' $nic.Name '应使用物理网卡' '必须改' `
      '经过 vSwitch 会多一跳；PLC 通讯请直连物理网卡，并确保该网卡没被桥接'
  } else {
    Add-Row '虚拟化' '面向 PLC 的网卡类型' $(if ($nic.Virtual) { '虚拟' } else { '物理' }) '物理' `
      $(if ($nic.Virtual) { '必须改' } else { 'OK' }) '物理网卡路径最短'
  }
  if ($virt) {
    Add-Row '虚拟化（仅信息）' '其他虚拟/桥接网卡' (($virt | ForEach-Object { $_.Name }) -join ' , ') '' 'n/a' `
      'VMware/Hyper-V 的桥接协议若绑在物理网卡上，会在收发路径上加一层（见「过滤驱动」）'
  }
} catch { }

# 多网卡同网段（会抢路由，造成偶发超时）
try {
  $same = Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
          Where-Object { $_.IPAddress -ne '127.0.0.1' -and $_.PrefixOrigin -ne 'WellKnown' } |
          Group-Object { ($_.IPAddress -split '\.')[0..2] -join '.' } |
          Where-Object { $_.Count -gt 1 }
  if ($same) {
    foreach ($g in $same) {
      Add-Row '系统' "同网段多地址 $($g.Name).x" (($g.Group | ForEach-Object { "$($_.IPAddress)@$($_.InterfaceAlias)" }) -join ' , ') `
        '只保留一块' '建议改' '两条路径都能到 PLC 时会偶发走错网卡，表现为随机超时'
    }
  } else {
    Add-Row '系统' '同网段多地址' '无' '只保留一块' 'OK' ''
  }
} catch { }

# RTE / Runtime 服务是否在跑（仅作提示）
$svc = Get-Service -ErrorAction SilentlyContinue | Where-Object { $_.Name -match 'CODESYS|3S|RTE' }
if ($svc) {
  foreach ($s in $svc) {
    # 仅信息展示：在客户端电脑上 Runtime 停着是正常的，不能算「需要处理」
    Add-Row 'Runtime（仅信息）' "服务 $($s.Name)" $s.Status '按现场需要' 'n/a' ''
  }
}

# ── 6. 输出 ─────────────────────────────────────────────────────────
if ($Json) {
  [pscustomobject]@{
    nic = [pscustomobject]@{ name = $nic.Name; desc = $nic.InterfaceDescription; speed = [string]$nic.LinkSpeed }
    plcIp = $PlcIp
    checkedAt = (Get-Date).ToString('s')
    rows = $script:rows
  } | ConvertTo-Json -Depth 5
  exit 0
}

Say ''
$grp = ''
foreach ($r in $script:rows) {
  # 「　└ 已应用」这类是上一项的从属行，不单独起小标题
  if ($r.Group -ne $grp) {
    $grp = $r.Group
    if ($grp -notmatch '^　└') { Say ''; Say "── $grp ──" }
  }
  $mark = switch ($r.Verdict) {
    'OK'      { '[ OK ]' }
    'done'    { '[已改]' }
    'dry'     { '[待改]' }
    'fail'    { '[失败]' }
    'n/a'     { '[ -- ]' }
    '建议改'  { '[!!]  ' }
    '必须改'  { '[!!!] ' }
    default   { '[? ]  ' }
  }
  Say ("$mark {0}　当前: {1}　建议: {2}" -f $r.Item, $r.Current, $r.Want)
  if ($r.Note) { Say ("        └ $($r.Note)") }
}

$bad = @($script:rows | Where-Object { $_.Verdict -in @('建议改', '必须改') })
Say ''
Say '════════════════════════════════════════════════════════════'
Say ("  需要处理 {0} 项 / 共检查 {1} 项" -f $bad.Count, $script:rows.Count)
if ($bad.Count -eq 0) {
  Say '  网卡侧没有发现会增加往返延迟的项。'
} else {
  Say '  处理顺序：中断调整 → 节能类 → 过滤驱动 → 速率双工 → 缓冲区'
  if (-not $Apply) { Say '  加 -Apply 可自动改（需管理员），改完重启网卡/重插网线生效。' }
}
Say ''
Say '  改完怎么验证（在客户端电脑上，只读、不写 PLC）：'
Say '    node tools/probe-roundtrip.js <PLC_IP> <APP>     # 看 TCP 握手 与 协议往返 的差'
Say '    node tools/probe-blockgap.js  <PLC_IP> <APP> <符号>  # 看逐块间隔中位是否下降'
Say '  期望：TCP 握手 ≤0.5ms，协议往返相对下降 10~20%。'
Say '  若两项都没变，说明瓶颈不在网卡，请转查 Runtime 任务周期（见 docs/现场诊断-工控机vsSA40.md）。'
Say '════════════════════════════════════════════════════════════'
