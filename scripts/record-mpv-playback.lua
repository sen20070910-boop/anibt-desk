local mp = require "mp"
local utils = require "mp.utils"
local sample = os.getenv("ANIBT_PLAYBACK_SAMPLE")
local expected = os.getenv("ANIBT_PLAYBACK_MEDIA")
if not sample or not expected then return end

local function normalize(name)
    return (name or ""):gsub("\\", "/"):lower()
end

local tracking = false
local finished = false
local position = 0
local duration = 0

local function write_sample()
    local output = io.open(sample, "w")
    if not output then return end
    output:write(utils.format_json({position = position, duration = duration, finished = finished}))
    output:close()
end

local function update()
    if not tracking then return end
    position = mp.get_property_number("time-pos", position)
    duration = mp.get_property_number("duration", duration)
    write_sample()
end

mp.register_event("file-loaded", function()
    tracking = normalize(mp.get_property("path")) == normalize(expected)
    if tracking then update() end
end)

mp.register_event("end-file", function(event)
    if not tracking then return end
    finished = event.reason == "eof"
    write_sample()
    tracking = false
end)

mp.add_hook("on_unload", 50, update)
mp.add_periodic_timer(5, update)
mp.register_event("shutdown", update)
