-- Backend half of the bridge. The frontend extracts the toast text inside
-- Steam's JS context and hands it here; this end is only responsible for
-- getting it to the notification daemon.

local logger = require("logger")
local millennium = require("millennium")
local json = require("json")

local APP_NAME = "Steam"

-- Resolved through the plugins directory rather than the source checkout, so the
-- helper is found whether this is installed as a copy or a symlink.
local PLUGIN_DIR = (os.getenv("HOME") or "")
    .. "/.local/share/millennium/plugins/steam-native-notify"

local function file_exists(path)
    local handle = io.open(path, "r")
    if not handle then return false end
    handle:close()
    return true
end

--- POSIX single-quote escaping: end the quote, add an escaped quote, reopen.
--- Everything else inside single quotes is literal, so this is sufficient.
local function shell_quote(value)
    local escaped = tostring(value):gsub("'", "'\\''")
    return "'" .. escaped .. "'"
end

--- Takes ONE argument, a JSON string. Millennium does not pass an argument
--- object's keys through as named parameters: with two keys the values arrived
--- in the wrong order and the notification came out with summary and body
--- swapped, silently. One key cannot be reordered.
---
--- Called from the frontend via callable('Notify').
--- Backgrounded: a notification daemon that is slow, restarting, or absent must
--- never block the Steam UI thread that called into us.
function Notify(payload)
    local ok, data = pcall(json.decode, tostring(payload or "{}"))
    if not ok or type(data) ~= "table" then
        logger:error("[steam-native-notify] undecodable payload: " .. tostring(payload))
        return "error"
    end

    local title = (data.title ~= nil and data.title ~= "") and data.title or APP_NAME
    local body = data.body or ""
    local raw_image = type(data.image) == "string" and data.image or ""
    local route = type(data.route) == "string" and data.route or ""

    -- This end is a marshaller: quote and hand over. Everything the daemon
    -- needs done to the values (markup escaping, icon resolution, the click)
    -- happens in the helper, next to the notify-send that renders them. The
    -- four positional arguments are a contract shared with tools/notify-action
    -- and tools/test-backend. A missing helper was already reported loudly at
    -- load; delivering without it would mean a second, untested notify-send.
    local command = table.concat({
        shell_quote(PLUGIN_DIR .. "/tools/notify-action"),
        shell_quote(title), shell_quote(body), shell_quote(raw_image), shell_quote(route),
        ">/dev/null 2>&1 &",
    }, " ")

    os.execute(command)
    return "ok"
end

--- Settings are stored by Millennium, which persists them across updates. The
--- whole settings object travels as ONE JSON document under one key: the
--- frontend owns every name and default (its DEFAULTS merge absorbs a missing
--- or older shape), so adding a setting never touches this file. Earlier
--- builds stored hideSteamToast under its own key; read once as a fallback.
local SETTINGS_KEY = "settings"

function LoadSettings()
    local stored = millennium.config.get(SETTINGS_KEY)
    if type(stored) == "string" and stored ~= "" then return stored end
    return json.encode({ hideSteamToast = millennium.config.get("hideSteamToast") == true })
end

function SaveSettings(payload)
    local text = tostring(payload or "")
    local ok, data = pcall(json.decode, text)
    if not ok or type(data) ~= "table" then
        logger:error("[steam-native-notify] undecodable settings: " .. text)
        return "error"
    end

    millennium.config.set(SETTINGS_KEY, text)
    return "ok"
end

function Log(line)
    logger:info("[steam-native-notify] " .. tostring(line or ""))
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

function Identity()
    return json.encode({ steamid64 = most_recent_steamid() })
end

--- Dev trigger: tools/fire writes PLUGIN_DIR/.dev-fire; the frontend polls this
--- callable and executes the named NotificationStore test method. Consume-once:
--- the file is deleted before its content is returned, so a command fires one
--- toast, not one per poll.
function TakeDevCommand()
    local path = PLUGIN_DIR .. "/.dev-fire"
    local handle = io.open(path, "r")
    if not handle then return "" end
    local content = handle:read("*a") or ""
    handle:close()
    os.remove(path)
    return content
end

local function on_load()
    logger:info("[steam-native-notify] backend loaded")

    local helper = PLUGIN_DIR .. "/tools/notify-action"
    if file_exists(helper) then
        logger:info("[steam-native-notify] helper: " .. helper)
    else
        logger:error("[steam-native-notify] helper MISSING at " .. helper
            .. " -- notifications will have no artwork or click action")
    end

    millennium.ready()
end

local function on_unload()
    logger:info("[steam-native-notify] backend unloaded")
end

local function on_frontend_loaded() end

return {
    on_load = on_load,
    on_unload = on_unload,
    on_frontend_loaded = on_frontend_loaded,
}
