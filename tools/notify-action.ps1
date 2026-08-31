# Deliver one Steam notification as a Windows toast, and register what a
# click needs. EXPERIMENTAL: nothing in this file has run on a real Windows
# machine yet; docs/platforms.md lists the validation pass.
#
# Windows PowerShell 5.1 only: pwsh (6+) removed WinRT projection support
# entirely, so [Windows.UI.Notifications...] type activation throws there.
#
# Spawned by backend/main.lua (CreateProcessW, CREATE_NO_WINDOW), one process
# per notification, exiting right after Show(): clicks are not waited for.
# The toast carries activationType="protocol", and Windows itself launches
# the registered snn: handler (tools/click-handler.js) on a click -- no
# resident process, no COM activator, no vendored binary.
#
# Usage: notify-action.ps1 -Setup            register AUMID branding + snn: scheme (idempotent)
#        notify-action.ps1 -Teardown         remove both registrations and the icon
#        notify-action.ps1 -Id <id>          deliver <id>.notify from the runtime directory
#
# The .notify file carries the same five slots the POSIX helper takes as
# positional arguments: title, body, image, route, ingame. A file, not a
# command line, so quoting stays out of the contract.

param(
    [string]$Id,
    [switch]$Setup,
    [switch]$Teardown
)

$ErrorActionPreference = 'Stop'

# Materialized into the runtime directory next to plugin.log and .click, so
# the script's own location is the runtime directory.
$RuntimeDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$Aumid = 'me.tysmith.steam-native-notify'
$AumidKey = "HKCU:\Software\Classes\AppUserModelId\$Aumid"
$SchemeKey = 'HKCU:\Software\Classes\snn'
$IconPath = Join-Path $RuntimeDir 'steam.ico'
$LogFile = Join-Path $RuntimeDir 'plugin.log'

function Write-PluginLog([string]$Line) {
    # Same shape as backend/main.lua's mirror, so tools/capture-style triage
    # reads one vocabulary. Best-effort: logging must never break delivery.
    try {
        $stamp = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
        Add-Content -LiteralPath $LogFile -Value "[$stamp] [steam-native-notify] $Line" -Encoding UTF8
    } catch {}
}

function Get-SteamDir {
    # The backend publishes millennium.steam_path() here at every load.
    $file = Join-Path $RuntimeDir 'steam-dir'
    if (Test-Path -LiteralPath $file) {
        $dir = (Get-Content -LiteralPath $file -First 1).Trim()
        if ($dir) { return $dir }
    }
    return $null
}

if ($Setup) {
    # Branding: a registry-only AppUserModelId (DisplayName + IconUri) is how
    # Microsoft's own ToastNotificationManagerCompat registers unpackaged
    # apps; no Start-menu shortcut is involved. HKCU merges over HKLM in the
    # classes view, so no elevation is needed.
    New-Item -Path $AumidKey -Force | Out-Null
    New-ItemProperty -Path $AumidKey -Name DisplayName -Value 'Steam' -PropertyType String -Force | Out-Null
    # The icon is extracted from the user's own steam.exe rather than shipped:
    # branding should show Steam's identity without this plugin distributing
    # Valve's artwork. IconUri is cosmetic; failure leaves DisplayName-only.
    try {
        $steam = Get-SteamDir
        $exe = if ($steam) { Join-Path $steam 'steam.exe' } else { $null }
        if ($exe -and (Test-Path -LiteralPath $exe)) {
            Add-Type -AssemblyName System.Drawing
            $icon = [System.Drawing.Icon]::ExtractAssociatedIcon($exe)
            $stream = [System.IO.File]::Open($IconPath, 'Create')
            $icon.Save($stream)
            $stream.Close()
            New-ItemProperty -Path $AumidKey -Name IconUri -Value $IconPath -PropertyType String -Force | Out-Null
        }
    } catch {
        Write-PluginLog "setup: icon extraction failed, DisplayName-only branding: $($_.Exception.Message)"
    }
    # The click path: snn: is a per-user URI scheme whose handler writes the
    # click file. wscript //B runs the JScript with no window and no dialogs.
    $handler = Join-Path $RuntimeDir 'click-handler.js'
    $command = "`"$env:SystemRoot\System32\wscript.exe`" //B //Nologo `"$handler`" `"%1`""
    New-Item -Path "$SchemeKey\shell\open\command" -Force | Out-Null
    Set-ItemProperty -Path $SchemeKey -Name '(Default)' -Value 'URL:Steam Native Notify'
    Set-ItemProperty -Path $SchemeKey -Name 'URL Protocol' -Value ''
    Set-ItemProperty -Path "$SchemeKey\shell\open\command" -Name '(Default)' -Value $command
    Write-PluginLog 'setup: AUMID branding and snn: scheme registered'
    exit 0
}

if ($Teardown) {
    foreach ($key in @($AumidKey, $SchemeKey)) {
        if (Test-Path -Path $key) { Remove-Item -Path $key -Recurse -Force }
    }
    if (Test-Path -LiteralPath $IconPath) { Remove-Item -LiteralPath $IconPath -Force }
    Write-PluginLog 'teardown: registrations removed'
    exit 0
}

if (-not $Id) { exit 2 }

# ---------------------------------------------------------------- delivery

$NotifyFile = Join-Path $RuntimeDir "$Id.notify"
if (-not (Test-Path -LiteralPath $NotifyFile)) { exit 1 }
try {
    $Payload = Get-Content -LiteralPath $NotifyFile -Raw | ConvertFrom-Json
} catch {
    Write-PluginLog "payload $Id unreadable, notification dropped: $($_.Exception.Message)"
    Remove-Item -LiteralPath $NotifyFile -Force -ErrorAction SilentlyContinue
    exit 1
}
Remove-Item -LiteralPath $NotifyFile -Force

# The notification platform can wedge under bursts ("The notification
# platform is unavailable", recovery is service restart or reboot). After
# one such failure every send inside the back-off window is dropped with a
# log line instead of hammering the service.
$Backoff = Join-Path $RuntimeDir '.wpn-backoff'
if ((Test-Path -LiteralPath $Backoff) -and
    ((Get-Date) - (Get-Item -LiteralPath $Backoff).LastWriteTime).TotalSeconds -lt 60) {
    Write-PluginLog "delivery suppressed during platform back-off: $($Payload.title)"
    exit 1
}

# Icon resolution, mirroring the POSIX helper: library-cache art needs no
# fetch, CDN avatars are downloaded once into the same sha1-named cache with
# the same 30-day prune. Toast images are dropped silently by Windows when
# oversized, so anything past ~190KB is re-encoded down to a 256px PNG.
function Resolve-Icon([string]$Raw) {
    if (-not $Raw) { return $null }
    $steam = Get-SteamDir
    if ($Raw -match 'steamloopback\.host/assets/(.+)$') {
        if (-not $steam) { return $null }
        $tail = ($Matches[1] -split '\?')[0] -replace '/', '\'
        $path = Join-Path (Join-Path (Join-Path $steam 'appcache') 'librarycache') $tail
        if (Test-Path -LiteralPath $path) { return $path }
        return $null
    }
    if ($Raw -match '^https?://') {
        $cache = Join-Path $RuntimeDir 'icons'
        New-Item -ItemType Directory -Path $cache -Force | Out-Null
        try {
            Get-ChildItem -LiteralPath $cache -File |
                Where-Object { $_.LastWriteTime -lt (Get-Date).AddDays(-30) } |
                Remove-Item -Force -ErrorAction SilentlyContinue
        } catch {}
        $stem = ($Raw -split '\?')[0]
        $ext = [System.IO.Path]::GetExtension($stem)
        if ($ext -notmatch '^\.(jpg|jpeg|png|gif|webp)$') { $ext = '.img' }
        $sha = [System.BitConverter]::ToString(
            [System.Security.Cryptography.SHA1]::Create().ComputeHash(
                [System.Text.Encoding]::UTF8.GetBytes($stem))).Replace('-', '').ToLower()
        $cached = Join-Path $cache "$sha$ext"
        if (-not (Test-Path -LiteralPath $cached)) {
            try {
                Invoke-WebRequest -Uri $Raw -OutFile "$cached.part" -UseBasicParsing -TimeoutSec 5
                Move-Item -LiteralPath "$cached.part" -Destination $cached -Force
            } catch {
                Remove-Item -LiteralPath "$cached.part" -Force -ErrorAction SilentlyContinue
                return $null
            }
        }
        return $cached
    }
    if ((Test-Path -LiteralPath $Raw) -and [System.IO.Path]::IsPathRooted($Raw)) { return $Raw }
    return $null
}

function Limit-IconSize([string]$Path) {
    if (-not $Path) { return $null }
    if ((Get-Item -LiteralPath $Path).Length -le 190KB) { return $Path }
    try {
        Add-Type -AssemblyName System.Drawing
        $img = [System.Drawing.Image]::FromFile($Path)
        $side = [Math]::Min(256, [Math]::Max($img.Width, $img.Height))
        $scale = $side / [Math]::Max($img.Width, $img.Height)
        $small = New-Object System.Drawing.Bitmap $img, ([int]($img.Width * $scale)), ([int]($img.Height * $scale))
        # Into the plugin's own cache, never beside the source: the source
        # can be Steam's library cache, which is not this plugin's to write
        # into, and only RuntimeDir\icons is swept by the 30-day prune.
        $cache = Join-Path $RuntimeDir 'icons'
        New-Item -ItemType Directory -Path $cache -Force | Out-Null
        $out = Join-Path $cache "$([System.IO.Path]::GetFileName($Path)).256.png"
        $small.Save($out, [System.Drawing.Imaging.ImageFormat]::Png)
        $small.Dispose(); $img.Dispose()
        return $out
    } catch {
        return $null
    }
}

$Title = [string]$Payload.title
$Body = [string]$Payload.body
$Route = [string]$Payload.route
$Icon = Limit-IconSize (Resolve-Icon ([string]$Payload.image))

function Esc([string]$Text) { [System.Security.SecurityElement]::Escape($Text) }

# activationType="protocol": Windows ShellExecutes the launch URI on a click,
# banner or (with persistence) Action Center, with no process of ours alive.
# No route means the toast is deliberately inert, mirroring Steam's own.
$ToastAttrs = ''
if ($Route -match '^replay:([A-Za-z0-9_.\-]+)$') {
    $ToastAttrs = " activationType=`"protocol`" launch=`"snn:replay/$($Matches[1])`""
}
$ImageXml = ''
if ($Icon) {
    # Avatars render circle-cropped the way Steam draws them; game art stays square.
    $crop = if (([string]$Payload.image) -match 'avatars\.') { " hint-crop=`"circle`"" } else { '' }
    $uri = ([System.Uri]$Icon).AbsoluteUri
    $ImageXml = "<image placement=`"appLogoOverride`"$crop src=`"$(Esc $uri)`"/>"
}
$Xml = "<toast$ToastAttrs><visual><binding template=`"ToastGeneric`">" +
    "<text>$(Esc $Title)</text><text>$(Esc $Body)</text>$ImageXml" +
    '</binding></visual></toast>'

try {
    $null = [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime]
    $null = [Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom, ContentType = WindowsRuntime]
    $doc = New-Object Windows.Data.Xml.Dom.XmlDocument
    $doc.LoadXml($Xml)
    $toast = New-Object Windows.UI.Notifications.ToastNotification $doc
    [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($Aumid).Show($toast)
} catch {
    if ($_.Exception.Message -match 'notification platform') {
        New-Item -ItemType File -Path $Backoff -Force | Out-Null
        Write-PluginLog "notification platform unavailable, backing off 60s: $($_.Exception.Message)"
    } else {
        Write-PluginLog "toast delivery failed: $($_.Exception.Message)"
    }
    exit 1
}
exit 0
