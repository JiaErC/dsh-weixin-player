# 把 dsh-weixin-player 装进 DSH 的 web profile。
#
# 做三件事：装插件自己的依赖并编译 → 登记进 profile → 提示你重启。
# 可重复执行：已安装时只重编译。
$ErrorActionPreference = 'Stop'

$pluginDir = Split-Path -Parent $PSScriptRoot
$profile = if ($env:DSH_WEIXIN_PROFILE) { $env:DSH_WEIXIN_PROFILE } else { 'web' }

Write-Host "插件目录: $pluginDir"
Write-Host "目标 profile: $profile"

# 1) link 安装不会带上插件自己的依赖，必须在插件目录里装一次。
if (-not (Test-Path (Join-Path $pluginDir 'node_modules'))) {
  Write-Host '安装依赖…'
  Push-Location $pluginDir
  try { npm install --no-audit --no-fund } finally { Pop-Location }
}

# 2) 编译到 lib/
Write-Host '编译…'
Push-Location $pluginDir
try {
  npm run build
  if ($LASTEXITCODE -ne 0) { throw "npm run build 失败（退出码 $LASTEXITCODE）" }
} finally { Pop-Location }

# 3) 登记进 profile（会自动加进 dsh.profile.bundles）
$spec = "link:$($pluginDir.Replace('\', '/'))"
Write-Host "登记: dsh plugin --profile $profile add $spec"
dsh plugin --profile $profile add $spec
if ($LASTEXITCODE -ne 0) { throw "dsh plugin add 失败（退出码 $LASTEXITCODE）" }

Write-Host ''
Write-Host '完成。接下来：'
Write-Host '  1. 重启正在运行的 dsh（例如重新执行 dsh web）'
Write-Host '  2. 刷新浏览器页面 —— 右侧栏「新建 tab」里会出现「微信」'
Write-Host '  3. 在 tab 里扫码登录；同一个 tab 顶部可给当前会话启用 weixin_* 工具'
Write-Host '  （完整状态页：http://127.0.0.1:3080/dsh-weixin ）'
