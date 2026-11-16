# dsh-healthylife

给自己用的作息守护插件（DeepSeek Harness 插件）：到点弹窗提醒、倒计时自动关机、可取消配额、按星期设置不同时间窗。

不是「提高效率」的工具，是「到点就把机器关掉」的工具。

## 功能

- **按周设置宵禁窗口**：每天可单独启用、单独设起止时间；跨零点的窗口严格按原区间执行（周一 23:00–06:00 会一直挡到周二 06:00，周二白天的设置不影响它）
- **提前提醒弹窗**：独立 WPF 桌面窗口（不是 DSH 内部浮层），显示「距离宵禁还有 N 分钟」，每分钟自动刷新
- **倒计时与关机**：倒计时结束自动执行 `shutdown /s /t 0 /f`；不点按钮就是关机
- **取消配额**：每晚最多取消几次、每周累计上限；一周按宵禁夜算（周一宵禁结束后归零），所以凌晨那次宵禁不会因为跨零点就白拿一次
- **自动豁免**：电量低于 20% / 会议软件运行中 / 备份任务进行中，命中即跳过并占用一次配额
- **宵禁时段禁止登录**：用 `net user /times:` 限制账户登录时段，宵禁期间开机停在登录界面
- **最后 60 分钟冻结配置**：宵禁启动前一小时，窗口时间、宵禁开关、取消配额都不允许修改（避免「再改五分钟」）
- **退出守护**：DSH 被关掉后由计划任务把它拉回来，隐藏窗口停在托盘
- **开机自启**：登录时静默启动，窗口隐藏
- **周报与历史记录**

## 系统要求

- Windows 10 / 11
- DeepSeek Harness 桌面版 `0.2.2-rc.1`（插件 API 随版本漂移，升级后请重跑设置页的「兼容性自检」）
- 修改登录时段、注册计划任务需要**管理员权限**（DSH 以管理员身份运行即可）
- 桌面弹窗是 .NET 框架依赖应用，需要 **.NET 10 Desktop Runtime**

## 安装

```bash
dsh plugin add github:jiboda394-glitch/dsh-healthylife
```

或在 DSH 的插件管理里指向本地目录。装好后进「设置 → 健康生活」。

## 数据与文件

- 状态：`%LOCALAPPDATA%\healthylife\state.json`（原子写：tmp + rename）
- 可用环境变量 `DSH_HEALTHYLIFE_HOME` 改到别的目录
- 守护日志 `guard.log`（超过 200KB 自动截断保留 32KB）
- 弹窗日志 `native/dist/popup.log`

## 已知限制

- **只拦新登录，不拦解锁**：`net user /times:` 控制的是登录时段，Windows 不会把已经登录的会话踢掉
- **强制执行依赖 DSH 在跑**：调度器跑在 DSH 宿主里，DSH 完全退出后只剩计划任务守护负责把它拉起来
- **弹窗需要 .NET 10 Desktop Runtime**：装不上时设置页自检会显示 ✗
- 未保存文件检测是启发式的，只覆盖常见编辑器/Office 的窗口标题

## 从源码构建弹窗

```powershell
$env:DOTNET_CLI_HOME = "$PWD\.dotnet-home"
$env:NUGET_PACKAGES  = "$PWD\.nuget"
dotnet build native/Popup/Popup.csproj -c Release -o native/dist
```

产物是 `HealthyLife.Popup.exe` + `HealthyLife.Popup.dll` + `deps.json` + `runtimeconfig.json`，四个文件缺一不可（exe 只是 apphost，代码在 dll 里）。

## 结构

| 文件 | 作用 |
|---|---|
| `index.js` | 宿主半侧：调度、配额、登录时段、计划任务、弹窗启动、HTTP 路由 |
| `client.js` | 设置页（`settings.section` 槽位） |
| `native/Popup/` | WPF 桌面弹窗源码 |
| `native/dist/` | 预编译弹窗（开箱即用） |
| `cordis.patch.yml` | 插件插桩 |
