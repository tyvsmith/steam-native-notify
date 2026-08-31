-- Backend half of the bridge. The frontend extracts the toast text inside
-- Steam's JS context and hands it here; this end is only responsible for
-- getting it to the notification daemon.

local logger = require("logger")
local millennium = require("millennium")
local json = require("json")
local fs = require("fs")

local APP_NAME = "Steam"

-- Platform, decided once. Lua's package.config opens with the directory
-- separator: "\" on Windows, "/" everywhere else (LuaJIT sets it like PUC
-- Lua). macOS shares the "/" and is told apart by LuaJIT's jit.os ("OSX";
-- Millennium's host is LuaJIT and opens the standard libraries, so the jit
-- table should be there), falling back to the SystemVersion.plist every
-- macOS carries when no jit table is exposed. Every path and spawn below
-- branches on these, nothing else asks the OS. docs/platforms.md is the
-- plan for the platforms that do not deliver yet.
local SEP = (type(package) == "table" and type(package.config) == "string")
    and package.config:sub(1, 1) or "/"
local IS_WINDOWS = SEP == "\\"
local function detect_macos()
    if IS_WINDOWS then return false end
    if type(jit) == "table" and type(jit.os) == "string" then
        return jit.os == "OSX"
    end
    local probe = io.open("/System/Library/CoreServices/SystemVersion.plist", "r")
    if probe then
        probe:close()
        return true
    end
    return false
end
local IS_MACOS = detect_macos()
local PLATFORM = IS_WINDOWS and "windows" or (IS_MACOS and "macos" or "linux")
-- Set by flatpak inside an app's sandbox (Steam's is com.valvesoftware.Steam).
-- Millennium does not run there today; logged so a run that does is
-- recognisable, and every $HOME-relative path below already resolves inside
-- the sandbox through Steam's --persist=. bind mount.
local FLATPAK_ID = (PLATFORM == "linux") and os.getenv("FLATPAK_ID") or nil

--- Separator-safe join. A trailing separator on a piece is dropped first, so
--- a steam_path() that answers with one (Millennium's Linux build does) or a
--- cache variable typed with one never doubles up. Millennium's fs has a
--- join as well; this one needs no module, so the paths it builds exist
--- before any require can fail and the offline tests exercise the same code.
local function join(...)
    local pieces = { ... }
    local path = pieces[1]
    for i = 2, #pieces do
        path = (path:gsub("[/\\]+$", "")) .. SEP .. pieces[i]
    end
    return path
end

-- The packed .star is never unpacked on disk, so there is no plugin directory
-- at runtime. Everything file-shaped lives in a cache directory instead: the
-- notify-action helper is carried inside the .star as an asset and written out
-- here at load, and tools/fire drops its command file here too. XDG_CACHE_HOME
-- to match the helper's own icon cache next door (inside a Flatpak sandbox
-- flatpak points it at the per-app cache, which is where it should be); on
-- Windows the per-user local (non-roaming) app data folder and on macOS the
-- user's Library/Caches, the same role on each.
local function runtime_dir()
    local home = os.getenv("HOME") or ""
    if IS_WINDOWS then
        local base = os.getenv("LOCALAPPDATA")
            or join(os.getenv("USERPROFILE") or "", "AppData", "Local")
        return join(base, "steam-native-notify")
    end
    if IS_MACOS then
        return join(home, "Library", "Caches", "steam-native-notify")
    end
    return join(os.getenv("XDG_CACHE_HOME") or join(home, ".cache"), "steam-native-notify")
end
local RUNTIME_DIR = runtime_dir()
local HELPER = join(RUNTIME_DIR, "notify-action")
local HELPER_ASSET = "tools/notify-action"
local LOG_FILE = join(RUNTIME_DIR, "plugin.log")

--- Millennium keeps a packed plugin's logger output in an in-memory buffer
--- (readable in its UI log viewer) and never writes it to Steam's
--- console-linux.txt, which would blind tools/capture. Every line is mirrored
--- into a session log file next to the helper; on_load truncates it, so the
--- file always describes the current Steam session.
local function log_line(level, line)
    local tagged = "[steam-native-notify] " .. line
    if level == "error" then logger:error(tagged) else logger:info(tagged) end
    local handle = io.open(LOG_FILE, "a")
    if handle then
        handle:write(os.date("[%Y-%m-%d %H:%M:%S] ") .. tagged .. "\n")
        handle:close()
    end
end

--- POSIX single-quote escaping: end the quote, add an escaped quote, reopen.
--- Everything else inside single quotes is literal, so this is sufficient.
--- POSIX only: cmd.exe and PowerShell quote differently, and the Windows
--- branch of spawn_helper brings its own (docs/platforms.md).
local function shell_quote(value)
    local escaped = tostring(value):gsub("'", "'\\''")
    return "'" .. escaped .. "'"
end

--- Write the bundled helper into RUNTIME_DIR. Runs on every load, so the
--- on-disk copy always matches the packed plugin. Spawned through `sh`
--- (io.open cannot set an executable bit, and does not need to). Written in
--- binary mode: a no-op on POSIX, and the only mode that keeps a packed
--- asset byte-identical on Windows, where text mode rewrites line endings.
local function install_helper()
    local content = millennium.assets.read(HELPER_ASSET)
    if type(content) ~= "string" or content == "" then
        return nil, "asset " .. HELPER_ASSET .. " missing from the plugin bundle"
    end
    fs.create_directories(RUNTIME_DIR)
    local handle, err = io.open(HELPER, "wb")
    if not handle then return nil, tostring(err) end
    -- A short write (disk full, a quota) surfaces on write or on close, and
    -- either would otherwise report a truncated helper as installed.
    local written, write_err = handle:write(content)
    local closed, close_err = handle:close()
    if not written then return nil, tostring(write_err) end
    if not closed then return nil, tostring(close_err) end
    return HELPER
end

--- Hand the five delivery slots to the platform's helper, detached, and say
--- whether anything was spawned. The one seam that knows how a process
--- starts on each OS; Notify above it is OS-blind.
---
--- POSIX: `sh <helper> ... >/dev/null 2>&1 &`. Backgrounded because the
--- helper blocks for the popup's lifetime, and this backend's single event
--- loop must keep answering the frontend's polls meanwhile.
---
--- Windows: not implemented. There is no sh and no `&`; os.execute is the C
--- runtime's system(), which runs cmd.exe, and from Millennium's
--- GUI-subsystem Lua host that allocates a console window per notification.
--- The design (a PowerShell wrapper around snoretoast.exe, started without a
--- console) is docs/platforms.md.
---
--- macOS: not implemented. sh is there but notify-send and gdbus are not;
--- the helper would fail on its own, and does so loudly, but nothing is
--- gained by spawning it. The delivery design (terminal-notifier or alerter)
--- is docs/platforms.md.
---
--- Until either lands this logs and returns false, so an install on those
--- platforms fails in the log rather than in silence.
local function spawn_helper(title, body, raw_image, route, ingame)
    if IS_WINDOWS or IS_MACOS then
        log_line("error", "unsupported platform: " .. PLATFORM
            .. " delivery is not implemented, notification dropped")
        return false
    end
    local command = table.concat({
        "sh",
        shell_quote(HELPER),
        shell_quote(title), shell_quote(body), shell_quote(raw_image),
        shell_quote(route), shell_quote(ingame),
        ">/dev/null 2>&1 &",
    }, " ")
    os.execute(command)
    return true
end

--- Positional over the ffi bridge: title, body, image, route, ingame -- the
--- same five slots handed on to tools/notify-action. (The old callable
--- transport could not order multiple arguments, so everything once arrived
--- as one JSON string.)
---
--- Called from the frontend via ffi('Notify').
--- Backgrounded: a notification daemon that is slow, restarting, or absent must
--- never block the Steam UI thread that called into us.
---@ffi
---@param title any
---@param body any
---@param image any
---@param route any
---@param ingame any
---@return string
function Notify(title, body, image, route, ingame)
    title = (title ~= nil and title ~= "") and tostring(title) or APP_NAME
    body = body ~= nil and tostring(body) or ""
    local raw_image = image ~= nil and tostring(image) or ""
    route = route ~= nil and tostring(route) or ""
    ingame = ingame ~= nil and tostring(ingame) or ""

    -- This end is a marshaller: quote and hand over. Everything the daemon
    -- needs done to the values (markup escaping, icon resolution, the click)
    -- happens in the helper, next to the notify-send that renders them. The
    -- five positional arguments are a contract shared with tools/notify-action
    -- and tools/test-backend. A missing helper was already reported loudly at
    -- load; delivering without it would mean a second, untested notify-send.
    if not spawn_helper(title, body, raw_image, route, ingame) then
        return "unsupported"
    end
    return "ok"
end

--- Settings live per-key in Millennium's config store: the panel writes them
--- through usePluginConfig, the frontend snapshot subscribes to pushes, and
--- this end never learns a setting name. Earlier builds stored the whole
--- object as ONE JSON document under "settings" (and before that a bare
--- hideSteamToast key, which already matches the per-key name); this one-time
--- move runs before millennium.ready() so the frontend only ever sees
--- per-key values. Existing per-key values always win over the document.
local function migrate_legacy_settings()
    local doc = millennium.config.get("settings")
    if type(doc) ~= "string" or doc == "" then return end
    local ok, data = pcall(json.decode, doc)
    if ok and type(data) == "table" then
        for key, value in pairs(data) do
            if key == "nativeToastInGame" then
                -- Retired key: nativeToastInGame=true meant "no desktop
                -- delivery while a game has focus" -- notifyInGame=false.
                if millennium.config.get("notifyInGame") == nil then
                    millennium.config.set("notifyInGame", value ~= true)
                end
            elseif millennium.config.get(key) == nil then
                millennium.config.set(key, value)
            end
        end
    else
        log_line("error", "legacy settings document undecodable, dropped: " .. doc)
    end
    millennium.config.delete("settings")
end

---@ffi
---@param line any
---@return string
function Log(line)
    log_line("info", tostring(line or ""))
    return "ok"
end

--- The current user's steamid64, from loginusers.vdf ("MostRecent" "1").
--- Server-notification routes point at the user's own community pages
--- (profiles/<steamid64>/tradeoffers and the like), exactly as Steam's own
--- click handlers build them; the frontend has no filesystem, so this end
--- supplies the id.
---
--- Millennium's own answer for the Steam directory, or nil. The registry
--- SteamPath on Windows, ~/.steam/steam/ on Linux, and on macOS the app
--- bundle's MacOS directory, which is not where Steam keeps its data.
--- Millennium documents that it need not be where Millennium itself lives,
--- which is fine; the files wanted here belong to Steam.
local function millennium_steam_dir()
    local ok, steam = pcall(function() return millennium.steam_path() end)
    if ok and type(steam) == "string" and steam ~= "" then
        return (steam:gsub("[/\\]+$", ""))
    end
    return nil
end

--- Every directory Steam's data (config/, appcache/) may live in on this
--- platform, most authoritative first; the caller takes the first that has
--- the file it wants. Millennium's answer leads. Linux then tries the native
--- locations before Steam's Flatpak per-app directory as the host sees it
--- (inside the sandbox $HOME-relative paths already resolve there through
--- --persist=., so the native entries cover that case too). macOS adds the
--- Application Support data directory the bundle answer leaves out. Windows
--- has no guess: the registry is the only source, and Millennium reads it.
local function steam_dir_candidates()
    local dirs = { millennium_steam_dir() }
    if IS_WINDOWS then return dirs end
    local home = os.getenv("HOME") or ""
    if IS_MACOS then
        dirs[#dirs + 1] = join(home, "Library", "Application Support", "Steam")
        return dirs
    end
    dirs[#dirs + 1] = join(home, ".steam", "steam")
    dirs[#dirs + 1] = join(home, ".local", "share", "Steam")
    local flatpak = join(home, ".var", "app", "com.valvesoftware.Steam")
    dirs[#dirs + 1] = join(flatpak, ".local", "share", "Steam")
    dirs[#dirs + 1] = join(flatpak, ".steam", "steam")
    return dirs
end

local function most_recent_steamid()
    for _, dir in ipairs(steam_dir_candidates()) do
        local handle = io.open(join(dir, "config", "loginusers.vdf"), "r")
        if handle then
            local current, fallback = nil, nil
            for line in handle:lines() do
                local id = line:match('^%s*"(7656119%d%d%d%d%d%d%d%d%d%d)"%s*$')
                if id then
                    current = id
                    fallback = fallback or id
                elseif current and line:match('"[Mm]ost[Rr]ecent"%s*"1"') then
                    handle:close()
                    return current
                end
            end
            handle:close()
            -- No MostRecent flag: a single-user file still identifies the user.
            if fallback then return fallback end
        end
    end
    return nil
end

---@ffi
---@return string
function Identity()
    return json.encode({ steamid64 = most_recent_steamid() })
end

--- The helper resolves game art under <steam>/appcache/librarycache, and
--- only this end can ask Millennium where <steam> is. Handed over in a file
--- rather than on the command line, so the five-argument spawn string stays
--- what it is on every platform (a Windows wrapper reads the same file).
--- Rewritten at every load, removed when Millennium has no answer, so the
--- helper never reads a stale one; the helper keeps its own guesses for a
--- missing file and a directory that holds no library cache.
local STEAM_DIR_FILE = join(RUNTIME_DIR, "steam-dir")
local function publish_steam_dir()
    local steam = millennium_steam_dir()
    if steam then
        local handle = io.open(STEAM_DIR_FILE, "w")
        if handle then
            handle:write(steam, "\n")
            handle:close()
            return
        end
    end
    os.remove(STEAM_DIR_FILE)
end

--- Consume-once file handoff: the file is deleted before its content is
--- returned, so a command acts once, not once per poll.
local function consume(path)
    local handle = io.open(path, "r")
    if not handle then return "" end
    local content = handle:read("*a") or ""
    handle:close()
    os.remove(path)
    return content
end

--- Dev trigger: tools/fire writes RUNTIME_DIR/.dev-fire; the frontend polls
--- this callable and executes the named NotificationStore test method.
---@ffi
---@return string
function TakeDevCommand()
    return consume(join(RUNTIME_DIR, ".dev-fire"))
end

--- Click handoff: notify-action writes every clicked route (or action token)
--- to RUNTIME_DIR/.click instead of invoking a steam:// URL (which would
--- raise the desktop client over a focused game); the frontend's click
--- bridge polls this and opens it on the surface live focus picks.
---@ffi
---@return string
function TakeClick()
    return consume(join(RUNTIME_DIR, ".click"))
end

local function on_load()
    -- Directory first, then truncate: the session log starts fresh so that
    -- tools/capture never reads a previous session's lines as current.
    fs.create_directories(RUNTIME_DIR)
    local fresh = io.open(LOG_FILE, "w")
    if fresh then fresh:close() end

    log_line("info", "backend loaded")
    log_line("info", "platform: " .. PLATFORM
        .. (FLATPAK_ID and (" flatpak: " .. FLATPAK_ID) or "")
        .. " runtime: " .. RUNTIME_DIR)

    migrate_legacy_settings()
    publish_steam_dir()

    -- The helper is only materialized where it can deliver. On Windows it is
    -- useless (it is sh); on macOS it would run and stop at the missing
    -- notify-send. Either platform's helper arrives with its spawn branch.
    -- Said once at load, and again per dropped notification by spawn_helper,
    -- so neither end is ever silent.
    if IS_WINDOWS or IS_MACOS then
        log_line("error", "desktop delivery is not implemented on " .. PLATFORM
            .. " -- notifications will not be delivered (docs/platforms.md)")
    else
        local helper, err = install_helper()
        if helper then
            log_line("info", "helper: " .. helper)
        else
            log_line("error", "helper install FAILED: " .. tostring(err)
                .. " -- notifications will not be delivered")
        end
    end

    millennium.ready()
end

local function on_unload()
    log_line("info", "backend unloaded")
end

local function on_frontend_loaded() end

return {
    on_load = on_load,
    on_unload = on_unload,
    on_frontend_loaded = on_frontend_loaded,
}
