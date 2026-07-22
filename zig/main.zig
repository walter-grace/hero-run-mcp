// Hero Run MCP server — Zig implementation (stdio JSON-RPC).
// Any MCP agent can run 340+ AI models paying $HERO per call. Key mode only; the
// API key is read from HERO_RUN_KEY, never hardcoded. Behavior matches node/index.mjs.
const std = @import("std");
const Value = std.json.Value;

var URL: []const u8 = "https://hero-run.vercel.app";
var KEY: []const u8 = "";
var gio: std.Io = undefined;

const TOOLS_JSON =
    "[{\"name\":\"list_models\",\"description\":\"List AI models available through the Hero Run gateway.\",\"inputSchema\":{\"type\":\"object\",\"properties\":{\"kind\":{\"type\":\"string\",\"enum\":[\"text\",\"image\",\"audio\",\"all\"]}}}}," ++
    "{\"name\":\"run_text\",\"description\":\"Run a text model (default: auto). Pays $HERO via your key.\",\"inputSchema\":{\"type\":\"object\",\"required\":[\"prompt\"],\"properties\":{\"prompt\":{\"type\":\"string\"},\"model\":{\"type\":\"string\"},\"consent\":{\"type\":\"boolean\"}}}}," ++
    "{\"name\":\"generate_image\",\"description\":\"Generate an image. Pays $HERO via your key.\",\"inputSchema\":{\"type\":\"object\",\"required\":[\"prompt\"],\"properties\":{\"prompt\":{\"type\":\"string\"},\"model\":{\"type\":\"string\"},\"consent\":{\"type\":\"boolean\"}}}}," ++
    "{\"name\":\"treasury_stats\",\"description\":\"Read the Hero Run treasury (live from Base).\",\"inputSchema\":{\"type\":\"object\",\"properties\":{}}}," ++
    "{\"name\":\"wallet_balance\",\"description\":\"Your prepaid API key credit balance.\",\"inputSchema\":{\"type\":\"object\",\"properties\":{}}}]";

const List = std.ArrayList(u8);

// ---- helpers ---------------------------------------------------------------

fn objGet(v: Value, key: []const u8) ?Value {
    if (v != .object) return null;
    return v.object.get(key);
}

fn valF64(v: ?Value) f64 {
    const x = v orelse return 0;
    return switch (x) {
        .integer => |i| @floatFromInt(i),
        .float => |f| f,
        .number_string => |s| std.fmt.parseFloat(f64, s) catch 0,
        .bool => |b| if (b) 1 else 0,
        else => 0,
    };
}

fn valStr(v: ?Value) []const u8 {
    const x = v orelse return "?";
    return switch (x) {
        .string => |s| s,
        else => "?",
    };
}

fn hasError(v: Value) ?[]const u8 {
    const e = objGet(v, "error") orelse return null;
    if (e == .string) return e.string;
    return null;
}

// append integer round(n) with thousands commas
fn appendCommas(list: *List, gpa: std.mem.Allocator, n: f64) !void {
    const r: i64 = @intFromFloat(@round(n));
    var neg = false;
    var mag: u64 = undefined;
    if (r < 0) {
        neg = true;
        mag = @intCast(-r);
    } else mag = @intCast(r);
    var digits: [24]u8 = undefined;
    var dlen: usize = 0;
    if (mag == 0) {
        digits[0] = '0';
        dlen = 1;
    } else {
        var m = mag;
        while (m > 0) : (m /= 10) {
            digits[dlen] = @intCast('0' + (m % 10));
            dlen += 1;
        }
    }
    if (neg) try list.append(gpa, '-');
    // digits[] is little-endian; emit reversed inserting commas
    var i: usize = dlen;
    while (i > 0) {
        i -= 1;
        try list.append(gpa, digits[i]);
        if (i > 0 and i % 3 == 0) {
            try list.append(gpa, ',');
        }
    }
}

fn commaStr(gpa: std.mem.Allocator, n: f64) ![]u8 {
    var l: List = .empty;
    try appendCommas(&l, gpa, n);
    return l.items;
}

fn appendJsonEscaped(list: *List, gpa: std.mem.Allocator, s: []const u8) !void {
    for (s) |c| {
        switch (c) {
            '"' => try list.appendSlice(gpa, "\\\""),
            '\\' => try list.appendSlice(gpa, "\\\\"),
            '\n' => try list.appendSlice(gpa, "\\n"),
            '\r' => try list.appendSlice(gpa, "\\r"),
            '\t' => try list.appendSlice(gpa, "\\t"),
            0x08 => try list.appendSlice(gpa, "\\b"),
            0x0C => try list.appendSlice(gpa, "\\f"),
            else => {
                if (c < 0x20) {
                    try list.appendSlice(gpa, "\\u00");
                    const hex = "0123456789abcdef";
                    try list.append(gpa, hex[(c >> 4) & 0xF]);
                    try list.append(gpa, hex[c & 0xF]);
                } else {
                    try list.append(gpa, c);
                }
            },
        }
    }
}

// serialize a JSON-RPC id value (number, string, or null)
fn appendId(list: *List, gpa: std.mem.Allocator, id: ?Value) !void {
    const v = id orelse {
        try list.appendSlice(gpa, "null");
        return;
    };
    switch (v) {
        .integer => |i| {
            var buf: [24]u8 = undefined;
            const s = std.fmt.bufPrint(&buf, "{d}", .{i}) catch "0";
            try list.appendSlice(gpa, s);
        },
        .float => |f| {
            var buf: [32]u8 = undefined;
            const s = std.fmt.bufPrint(&buf, "{d}", .{f}) catch "0";
            try list.appendSlice(gpa, s);
        },
        .string => |s| {
            try list.append(gpa, '"');
            try appendJsonEscaped(list, gpa, s);
            try list.append(gpa, '"');
        },
        else => try list.appendSlice(gpa, "null"),
    }
}

// ---- HTTP ------------------------------------------------------------------

const HttpErr = error{ RequestFailed, ParseFailed, OutOfMemory };

// Performs an HTTP request and returns a parsed JSON Value. Caller owns arena.
fn httpJson(
    arena: std.mem.Allocator,
    method: std.http.Method,
    path: []const u8,
    body: ?[]const u8,
    use_key: bool,
) HttpErr!std.json.Parsed(Value) {
    var client = std.http.Client{ .allocator = arena, .io = gio };
    defer client.deinit();

    const full = std.fmt.allocPrint(arena, "{s}{s}", .{ URL, path }) catch return error.OutOfMemory;

    var sink: std.Io.Writer.Allocating = .init(arena);
    defer sink.deinit();

    var extra: []const std.http.Header = &.{};
    if (use_key and KEY.len > 0) {
        const hdrs = arena.alloc(std.http.Header, 1) catch return error.OutOfMemory;
        hdrs[0] = .{ .name = "x-api-key", .value = KEY };
        extra = hdrs;
    }

    const res = client.fetch(.{
        .location = .{ .url = full },
        .method = method,
        .payload = body,
        .headers = .{ .content_type = .{ .override = "application/json" } },
        .extra_headers = extra,
        .response_writer = &sink.writer,
    }) catch return error.RequestFailed;
    _ = res;

    const bytes = sink.written();
    const parsed = std.json.parseFromSlice(Value, arena, bytes, .{}) catch return error.ParseFailed;
    return parsed;
}

// ---- tool implementations --------------------------------------------------
// Each returns text on success; on a tool-level error it sets err.* = true and
// returns the message.

const ToolError = error{ ToolFail, OutOfMemory, RequestFailed, ParseFailed };

fn toolListModels(arena: std.mem.Allocator, args: Value) ToolError![]u8 {
    const kind_v = objGet(args, "kind");
    const kind: []const u8 = if (kind_v != null and kind_v.? == .string) kind_v.?.string else "all";

    const parsed = httpJson(arena, .GET, "/api/models", null, false) catch |e| return e;
    const root = parsed.value;
    const models_v = objGet(root, "models") orelse return error.ToolFail;
    if (models_v != .array) return error.ToolFail;
    const models = models_v.array.items;

    // filter
    var filtered: std.ArrayList(Value) = .empty;
    for (models) |m| {
        const mk = valStr(objGet(m, "kind"));
        if (std.mem.eql(u8, kind, "all") or std.mem.eql(u8, kind, mk)) {
            try filtered.append(arena, m);
        }
    }

    var out: List = .empty;
    var hdr: [64]u8 = undefined;
    const h = std.fmt.bufPrint(&hdr, "{d} models. Each costs $HERO per run.\n", .{filtered.items.len}) catch "";
    try out.appendSlice(arena, h);

    const n = @min(filtered.items.len, 60);
    var i: usize = 0;
    while (i < n) : (i += 1) {
        const m = filtered.items[i];
        if (i > 0) try out.append(arena, '\n');
        try out.appendSlice(arena, "  ");
        // right-align hero commas to width 9 (padStart)
        const heroStr = try commaStr(arena, valF64(objGet(m, "hero")));
        if (heroStr.len < 9) {
            var pad: usize = 9 - heroStr.len;
            while (pad > 0) : (pad -= 1) try out.append(arena, ' ');
        }
        try out.appendSlice(arena, heroStr);
        try out.appendSlice(arena, " $HERO \xc2\xb7 "); // " $HERO · "
        try out.appendSlice(arena, valStr(objGet(m, "kind")));
        try out.appendSlice(arena, "  ");
        try out.appendSlice(arena, valStr(objGet(m, "id")));
    }
    return out.items;
}

fn runModel(arena: std.mem.Allocator, model: []const u8, input: []const u8, kind: []const u8, consent: bool) ToolError!std.json.Parsed(Value) {
    if (KEY.len == 0) return error.ToolFail; // caller must guard; message set separately
    var body: List = .empty;
    try body.appendSlice(arena, "{\"model\":\"");
    try appendJsonEscaped(&body, arena, model);
    try body.appendSlice(arena, "\",\"input\":\"");
    try appendJsonEscaped(&body, arena, input);
    try body.appendSlice(arena, "\",\"kind\":\"");
    try appendJsonEscaped(&body, arena, kind);
    try body.appendSlice(arena, "\",\"consent\":");
    try body.appendSlice(arena, if (consent) "true" else "false");
    try body.append(arena, '}');

    const parsed = httpJson(arena, .POST, "/api/run", body.items, true) catch |e| return e;
    return parsed;
}

fn argStr(args: Value, key: []const u8, default: []const u8) []const u8 {
    const v = objGet(args, key);
    if (v != null and v.? == .string and v.?.string.len > 0) return v.?.string;
    return default;
}

fn argBool(args: Value, key: []const u8) bool {
    const v = objGet(args, key) orelse return false;
    return v == .bool and v.bool;
}

// Runs run_text / generate_image; writes success text to out or on tool failure
// sets msg. Returns text, or error.ToolFail with *msg populated.
fn toolRun(arena: std.mem.Allocator, args: Value, is_image: bool, msg: *[]const u8) ToolError![]u8 {
    if (KEY.len == 0) {
        msg.* = "Set HERO_RUN_KEY (mint at /keys) to run models.";
        return error.ToolFail;
    }
    const default_model: []const u8 = if (is_image) "google/gemini-2.5-flash-image" else "auto";
    const model = argStr(args, "model", default_model);
    const prompt = argStr(args, "prompt", "");
    const consent = argBool(args, "consent");
    const kind: []const u8 = if (is_image) "image" else "text";

    const parsed = runModel(arena, model, prompt, kind, consent) catch |e| return e;
    const d = parsed.value;
    if (hasError(d)) |em| {
        msg.* = em;
        return error.ToolFail;
    }

    var out: List = .empty;
    if (is_image) {
        const img_v = objGet(d, "image");
        if (img_v != null and img_v.? == .string and img_v.?.string.len > 0) {
            const img = img_v.?.string;
            const slice = img[0..@min(img.len, 80)];
            try out.appendSlice(arena, "Image: ");
            try out.appendSlice(arena, slice);
            try out.appendSlice(arena, "\xe2\x80\xa6\nspent "); // …
            try appendCommas(&out, arena, valF64(objGet(d, "charged")));
            try out.appendSlice(arena, " $HERO");
        } else {
            try out.appendSlice(arena, "No image returned.");
        }
    } else {
        const text = valStr(objGet(d, "text"));
        try out.appendSlice(arena, if (std.mem.eql(u8, text, "?")) "" else text);
        try out.appendSlice(arena, "\n\n\xe2\x80\x94 "); // \n\n—
        // autoModel || model
        const am_v = objGet(d, "autoModel");
        var am: []const u8 = undefined;
        if (am_v != null and am_v.? == .string and am_v.?.string.len > 0) {
            am = am_v.?.string;
        } else {
            am = valStr(objGet(d, "model"));
        }
        try out.appendSlice(arena, am);
        try out.appendSlice(arena, " \xc2\xb7 spent "); // · spent
        try appendCommas(&out, arena, valF64(objGet(d, "charged")));
        try out.appendSlice(arena, " $HERO");
    }
    return out.items;
}

fn toolTreasury(arena: std.mem.Allocator) ToolError![]u8 {
    const parsed = httpJson(arena, .GET, "/api/treasury", null, false) catch |e| return e;
    const t = parsed.value;
    var out: List = .empty;
    try out.appendSlice(arena, "Treasury ");
    try out.appendSlice(arena, valStr(objGet(t, "treasury")));
    try out.appendSlice(arena, "\nClaimable: ");
    const cl = objGet(t, "claimable");
    var t0: []const u8 = "?";
    var t1: []const u8 = "?";
    if (cl != null and cl.? == .object) {
        t0 = valStrLoose(arena, objGet(cl.?, "token0"));
        t1 = valStrLoose(arena, objGet(cl.?, "token1"));
    }
    try out.appendSlice(arena, t0);
    try out.appendSlice(arena, " WETH + ");
    try out.appendSlice(arena, t1);
    try out.appendSlice(arena, " HERO");
    return out.items;
}

// like valStr but stringifies numbers too (for treasury token values)
fn valStrLoose(arena: std.mem.Allocator, v: ?Value) []const u8 {
    const x = v orelse return "?";
    return switch (x) {
        .string => |s| s,
        .integer => |i| std.fmt.allocPrint(arena, "{d}", .{i}) catch "?",
        .float => |f| std.fmt.allocPrint(arena, "{d}", .{f}) catch "?",
        .number_string => |s| s,
        else => "?",
    };
}

fn toolWallet(arena: std.mem.Allocator, msg: *[]const u8) ToolError![]u8 {
    if (KEY.len == 0) {
        // this is a normal success string, not an error
        return try dupe(arena, "Set HERO_RUN_KEY to see credits.");
    }
    const parsed = httpJson(arena, .GET, "/api/keys/info", null, true) catch |e| return e;
    const d = parsed.value;
    _ = msg;
    if (hasError(d)) |em| {
        return std.fmt.allocPrint(arena, "API key error: {s}", .{em}) catch error.OutOfMemory;
    }
    var out: List = .empty;
    try out.appendSlice(arena, "Prepaid API key\n");
    try appendCommas(&out, arena, valF64(objGet(d, "balance")));
    try out.appendSlice(arena, " $HERO credits (deposited ");
    try appendCommas(&out, arena, valF64(objGet(d, "deposited")));
    try out.appendSlice(arena, ", spent ");
    try appendCommas(&out, arena, valF64(objGet(d, "spent")));
    try out.append(arena, ')');
    return out.items;
}

fn dupe(arena: std.mem.Allocator, s: []const u8) ![]u8 {
    return arena.dupe(u8, s);
}

// ---- request dispatch ------------------------------------------------------

const stdout_lock = struct {}; // no threads; single-threaded loop

fn writeAll(bytes: []const u8) void {
    var off: usize = 0;
    while (off < bytes.len) {
        const rc = std.c.write(1, bytes.ptr + off, bytes.len - off);
        if (rc <= 0) return;
        off += @intCast(rc);
    }
}

fn writeLine(bytes: []const u8) void {
    writeAll(bytes);
    writeAll("\n");
}

fn handleLine(gpa: std.mem.Allocator, line: []const u8) void {
    var arena_state = std.heap.ArenaAllocator.init(gpa);
    defer arena_state.deinit();
    const arena = arena_state.allocator();

    const parsed = std.json.parseFromSlice(Value, arena, line, .{}) catch return;
    const root = parsed.value;
    if (root != .object) return;

    const method_v = root.object.get("method");
    if (method_v == null or method_v.? != .string) return;
    const method = method_v.?.string;
    const id_present = root.object.contains("id");
    const id_v: ?Value = if (id_present) root.object.get("id") else null;

    var resp: List = .empty;

    if (std.mem.eql(u8, method, "initialize")) {
        resp.appendSlice(arena, "{\"jsonrpc\":\"2.0\",\"id\":") catch return;
        appendId(&resp, arena, id_v) catch return;
        resp.appendSlice(arena, ",\"result\":{\"protocolVersion\":\"2024-11-05\",\"capabilities\":{\"tools\":{}},\"serverInfo\":{\"name\":\"hero-run\",\"version\":\"1.0.0\"}}}") catch return;
        writeLine(resp.items);
        return;
    }

    if (std.mem.eql(u8, method, "tools/list")) {
        resp.appendSlice(arena, "{\"jsonrpc\":\"2.0\",\"id\":") catch return;
        appendId(&resp, arena, id_v) catch return;
        resp.appendSlice(arena, ",\"result\":{\"tools\":") catch return;
        resp.appendSlice(arena, TOOLS_JSON) catch return;
        resp.appendSlice(arena, "}}") catch return;
        writeLine(resp.items);
        return;
    }

    if (std.mem.eql(u8, method, "tools/call")) {
        const params = root.object.get("params") orelse Value{ .null = {} };
        const name_v = objGet(params, "name");
        const name: []const u8 = if (name_v != null and name_v.? == .string) name_v.?.string else "";
        const args = objGet(params, "arguments") orelse Value{ .null = {} };

        var msg: []const u8 = "";
        var is_err = false;
        var text: []const u8 = "";

        if (std.mem.eql(u8, name, "list_models")) {
            text = toolListModels(arena, args) catch |e| blk: {
                is_err = true;
                msg = errMsg(e);
                break :blk "";
            };
        } else if (std.mem.eql(u8, name, "run_text")) {
            text = toolRun(arena, args, false, &msg) catch |e| blk: {
                is_err = true;
                if (e == error.ToolFail) {} else msg = errMsg(e);
                break :blk "";
            };
        } else if (std.mem.eql(u8, name, "generate_image")) {
            text = toolRun(arena, args, true, &msg) catch |e| blk: {
                is_err = true;
                if (e == error.ToolFail) {} else msg = errMsg(e);
                break :blk "";
            };
        } else if (std.mem.eql(u8, name, "treasury_stats")) {
            text = toolTreasury(arena) catch |e| blk: {
                is_err = true;
                msg = errMsg(e);
                break :blk "";
            };
        } else if (std.mem.eql(u8, name, "wallet_balance")) {
            text = toolWallet(arena, &msg) catch |e| blk: {
                is_err = true;
                msg = errMsg(e);
                break :blk "";
            };
        } else {
            is_err = true;
            msg = "Unknown tool";
        }

        resp.appendSlice(arena, "{\"jsonrpc\":\"2.0\",\"id\":") catch return;
        appendId(&resp, arena, id_v) catch return;
        if (is_err) {
            resp.appendSlice(arena, ",\"error\":{\"code\":-32000,\"message\":\"") catch return;
            appendJsonEscaped(&resp, arena, msg) catch return;
            resp.appendSlice(arena, "\"}}") catch return;
        } else {
            resp.appendSlice(arena, ",\"result\":{\"content\":[{\"type\":\"text\",\"text\":\"") catch return;
            appendJsonEscaped(&resp, arena, text) catch return;
            resp.appendSlice(arena, "\"}]}}") catch return;
        }
        writeLine(resp.items);
        return;
    }

    // unknown method
    if (id_present and id_v != null and id_v.? != .null) {
        resp.appendSlice(arena, "{\"jsonrpc\":\"2.0\",\"id\":") catch return;
        appendId(&resp, arena, id_v) catch return;
        resp.appendSlice(arena, ",\"error\":{\"code\":-32601,\"message\":\"Method not found\"}}") catch return;
        writeLine(resp.items);
    }
    // notification (no id) → no response
}

fn errMsg(e: ToolError) []const u8 {
    return switch (e) {
        error.ToolFail => "Tool failed",
        error.OutOfMemory => "Out of memory",
        error.RequestFailed => "Request failed",
        error.ParseFailed => "Invalid response",
    };
}

fn getEnv(name: [*:0]const u8) ?[]const u8 {
    const v = std.c.getenv(name) orelse return null;
    return std.mem.span(v);
}

pub fn main() !void {
    const gpa = std.heap.page_allocator;

    var threaded = std.Io.Threaded.init(gpa, .{});
    defer threaded.deinit();
    gio = threaded.io();

    if (getEnv("HERO_RUN_URL")) |u| {
        if (u.len > 0) URL = u;
    }
    if (getEnv("HERO_RUN_KEY")) |k| {
        KEY = k;
    }

    var acc: List = .empty;
    defer acc.deinit(gpa);
    var rbuf: [65536]u8 = undefined;

    while (true) {
        const n = std.posix.read(0, &rbuf) catch break;
        if (n == 0) break;
        try acc.appendSlice(gpa, rbuf[0..n]);

        // process complete lines
        while (std.mem.indexOfScalar(u8, acc.items, '\n')) |idx| {
            const line = acc.items[0..idx];
            const trimmed = std.mem.trim(u8, line, " \t\r");
            if (trimmed.len > 0) handleLine(gpa, trimmed);
            // remove processed line + newline
            const rest_len = acc.items.len - (idx + 1);
            std.mem.copyForwards(u8, acc.items[0..rest_len], acc.items[idx + 1 ..]);
            acc.shrinkRetainingCapacity(rest_len);
        }
    }
}
