# healthylife — 让 DSH 以管理员身份随登录启动
#
# 为什么需要：Windows 的「账户登录时段」（net user /times）只能由管理员修改。
# 插件在 01:00 应用登录限制时需要管理员权限，否则会返回「拒绝访问」。
# 这个脚本注册一个「登录时以最高权限启动 DSH」的计划任务，只需授权一次，
# 之后每次登录都会静默以管理员身份运行 DSH，不再弹 UAC。
#
# 用法：右键本文件 →「使用 PowerShell 运行」，或在管理员 PowerShell 中执行：
#   powershell -NoProfile -ExecutionPolicy Bypass -File .\setup-elevated.ps1

$ErrorActionPreference = 'Stop'

$exe = 'F:\DSH\Program\DeepSeek Harness.exe'
$taskName = 'HealthyLife\DSH Elevated'
$runKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
$runValue = 'HealthyLife'

if (-not (Test-Path -LiteralPath $exe)) {
    throw "找不到 DSH 可执行文件：$exe"
}

$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object Security.Principal.WindowsPrincipal($identity)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Write-Host '需要管理员权限，正在请求提权…'
    $arguments = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ('"{0}"' -f $PSCommandPath))
    Start-Process -FilePath 'powershell.exe' -Verb RunAs -ArgumentList $arguments
    return
}

$action = New-ScheduledTaskAction -Execute $exe
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$taskPrincipal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Highest
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable

Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Principal $taskPrincipal -Settings $settings -Force | Out-Null

# 移除插件写入的 HKCU Run 自启动项，避免登录时启动两份 DSH
if (Test-Path -LiteralPath $runKey) {
    Remove-ItemProperty -Path $runKey -Name $runValue -ErrorAction SilentlyContinue
}

Write-Host ''
Write-Host "已注册计划任务：$taskName" -ForegroundColor Green
Write-Host "  - 登录时以管理员身份启动：$exe"
Write-Host "  - 已移除 HKCU Run 里的重复自启动项"
Write-Host ''
Write-Host '下一步：重启 DSH（任务栏退出后重新打开），插件会检测到管理员权限。' -ForegroundColor Yellow
Write-Host '撤销：schtasks /delete /tn "HealthyLife\DSH Elevated" /f'
