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
-- Lua). Every path and spawn below branches on this, nothing else asks the
-- OS. docs/windows-plan.md is the plan for the Windows half.
local SEP = (type(package) == "table" and type(package.config) == "string")
    and package.config:sub(1, 1) or "/"
local IS_WINDOWS = SEP == "\\"
local PLATFORM = IS_WINDOWS and "windows" or "posix"

-- The packed .star is never unpacked on disk, so there is no plugin directory
-- at runtime. Everything file-shaped lives in a cache directory instead: the
-- notify-action helper is carried inside the .star as an asset and written out
-- here at load, and tools/fire drops its command file here too. XDG_CACHE_HOME
-- to match the helper's own icon cache next door; on Windows the per-user
-- local (non-roaming) app data folder, the same role.
local function runtime_dir()
    if IS_WINDOWS then
        local base = os.getenv("LOCALAPPDATA")
            or ((os.getenv("USERPROFILE") or "") .. "\\AppData\\Local")
        return base .. "\\steam-native-notify"
    end
    return (os.getenv("XDG_CACHE_HOME") or ((os.getenv("HOME") or "") .. "/.cache"))
        .. "/steam-native-notify"
end
local RUNTIME_DIR = runtime_dir()
local HELPER = RUNTIME_DIR .. SEP .. "notify-action"
local HELPER_ASSET = "tools/notify-action"
local LOG_FILE = RUNTIME_DIR .. SEP .. "plugin.log"

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
    handle:write(content)
    handle:close()
    return HELPER
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
    local command = table.concat({
        "sh",
        shell_quote(HELPER),
        shell_quote(title), shell_quote(body), shell_quote(raw_image),
        shell_quote(route), shell_quote(ingame),
        ">/dev/null 2>&1 &",
    }, " ")

    os.execute(command)
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
local function most_recent_steamid()
    local candidates = {
        (os.getenv("HOME") or "") .. "/.steam/steam/config/loginusers.vdf",
        (os.getenv("HOME") or "") .. "/.local/share/Steam/config/loginusers.vdf",
    }
    for _, path in ipairs(candidates) do
        local handle = io.open(path, "r")
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
    return consume(RUNTIME_DIR .. SEP .. ".dev-fire")
end

--- Click handoff: notify-action writes every clicked route (or action token)
--- to RUNTIME_DIR/.click instead of invoking a steam:// URL (which would
--- raise the desktop client over a focused game); the frontend's click
--- bridge polls this and opens it on the surface live focus picks.
---@ffi
---@return string
function TakeClick()
    return consume(RUNTIME_DIR .. SEP .. ".click")
end

local function on_load()
    -- Directory first, then truncate: the session log starts fresh so that
    -- tools/capture never reads a previous session's lines as current.
    fs.create_directories(RUNTIME_DIR)
    local fresh = io.open(LOG_FILE, "w")
    if fresh then fresh:close() end

    log_line("info", "backend loaded")
    log_line("info", "platform: " .. PLATFORM .. " runtime: " .. RUNTIME_DIR)

    migrate_legacy_settings()

    local helper, err = install_helper()
    if helper then
        log_line("info", "helper: " .. helper)
    else
        log_line("error", "helper install FAILED: " .. tostring(err)
            .. " -- notifications will not be delivered")
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
