-- Backend half of the bridge. The frontend extracts the toast text inside
-- Steam's JS context and hands it here; this end is only responsible for
-- getting it to the notification daemon.

local logger = require("logger")
local millennium = require("millennium")
local json = require("json")

-- Notification daemons vary in how they handle a missing icon; `steam` resolves
-- through the normal icon theme lookup and degrades to no icon if absent.
local APP_NAME = "Steam"
local ICON = "steam"

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

--- The daemon on this machine (quickshell) advertises `body-markup`, so the
--- body is parsed as markup and a bare `<` or `&` from a chat message would be
--- swallowed or mangled. Only the body is parsed per the spec; the summary is
--- not, so it is passed through untouched.
local function escape_markup(value)
    local escaped = tostring(value)
    escaped = escaped:gsub("&", "&amp;")
    escaped = escaped:gsub("<", "&lt;")
    escaped = escaped:gsub(">", "&gt;")
    return escaped
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
    local body = escape_markup(data.body or "")
    local raw_image = type(data.image) == "string" and data.image or ""

    -- With a uuid the notification gets a clickable action, delivered by the
    -- helper so that notify-send's blocking --wait never runs on this thread.
    -- Without one there is nothing to replay, so a plain notification is honest.
    local helper = PLUGIN_DIR .. "/tools/notify-action"
    local route = type(data.route) == "string" and data.route or ""

    local command
    if file_exists(helper) then
        command = table.concat({
            shell_quote(helper),
            shell_quote(title), shell_quote(body), shell_quote(raw_image), shell_quote(route),
            ">/dev/null 2>&1 &",
        }, " ")
    else
        -- No helper: still deliver the notification, just without a click action
        -- or resolved artwork.
        command = table.concat({
            "notify-send",
            "-a", shell_quote(APP_NAME),
            "-i", shell_quote(ICON),
            shell_quote(title), shell_quote(body),
            ">/dev/null 2>&1 &",
        }, " ")
    end

    os.execute(command)
    return "ok"
end

--- Called from the frontend via callable('Log'), so toast extraction can be
--- traced from Millennium's log without a devtools session attached.
--- Settings are stored by Millennium, which persists them in config.json and
--- keeps them across updates. The frontend holds the live copy; this end only
--- reads and writes.
local SETTING_HIDE = "hideSteamToast"

function LoadSettings()
    local stored = millennium.config.get(SETTING_HIDE)
    return json.encode({ hideSteamToast = stored == true })
end

function SaveSettings(payload)
    local ok, data = pcall(json.decode, tostring(payload or "{}"))
    if not ok or type(data) ~= "table" then
        logger:error("[steam-native-notify] undecodable settings: " .. tostring(payload))
        return "error"
    end

    millennium.config.set(SETTING_HIDE, data.hideSteamToast == true)
    logger:info("[steam-native-notify] hideSteamToast = " .. tostring(data.hideSteamToast == true))
    return "ok"
end

function Log(line)
    logger:info("[steam-native-notify] " .. tostring(line or ""))
    return "ok"
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
