// ATS Co-Driver - ATS telemetry + input plugin with a built-in WebSocket server.
//
// Telemetry  : selected channels + every configuration (truck, job, car_job, ...) + gameplay events.
// Server     : ws://127.0.0.1:25555/ws  JSON state pushed ~60x/s; client sends {"press":"<mix>","hold":ms}
//              (this PC only — the Co-Driver server relays it to phones and tablets)
// Input      : semantical device, so dashboard buttons drive game mixes (engine, light, ...) without binding.
// Log        : %LOCALAPPDATA%\ATS Co-Driver\logs\plugin.log (configs, gameplay events, 1 Hz snapshot)
//
// Copyright (C) ATS Co-Driver contributors. GNU GPL v3 or later (see LICENSE).
// Uses the SCS Software Telemetry/Input SDK (headers not included; get them from SCS).

#define WIN32_LEAN_AND_MEAN
#include <winsock2.h>
#include <ws2tcpip.h>
#include <windows.h>
#include <shlobj.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdarg.h>

#include "scssdk_telemetry.h"
#include "scssdk_input.h"
#include "eurotrucks2/scssdk_eut2.h"
#include "amtrucks/scssdk_ats.h"
#include "amtrucks/scssdk_telemetry_ats.h"
#include "amtrucks/scssdk_input_ats.h"
#include "common/scssdk_telemetry_common_configs.h"
#include "common/scssdk_telemetry_common_channels.h"
#include "common/scssdk_telemetry_truck_common_channels.h"
#include "common/scssdk_telemetry_common_gameplay_events.h"
#include "common/scssdk_telemetry_job_common_channels.h"

#define EXPORT extern "C" __declspec(dllexport)
static const int PORT = 25555;

// ---------------------------------------------------------------- utilities

static CRITICAL_SECTION g_lock;
static FILE *g_log = NULL;
static char g_root[MAX_PATH];   // Documents\ATS_Dashboard
static scs_log_t g_game_log = NULL;

static void log_line(const char *fmt, ...)
{
    if (!g_log) return;
    SYSTEMTIME t; GetLocalTime(&t);
    fprintf(g_log, "%02d:%02d:%02d.%03d ", t.wHour, t.wMinute, t.wSecond, t.wMilliseconds);
    va_list a; va_start(a, fmt); vfprintf(g_log, fmt, a); va_end(a);
    fputc('\n', g_log); fflush(g_log);
}

// Growable string buffer.
struct Buf {
    char *p = NULL; size_t n = 0, cap = 0;
    void reserve(size_t want) { if (want <= cap) return; size_t c = cap ? cap : 1024; while (c < want) c *= 2; p = (char *)realloc(p, c); cap = c; }
    void add(const char *s, size_t len) { reserve(n + len + 1); memcpy(p + n, s, len); n += len; p[n] = 0; }
    void add(const char *s) { add(s, strlen(s)); }
    void addf(const char *fmt, ...) { char tmp[512]; va_list a; va_start(a, fmt); int k = vsnprintf(tmp, sizeof tmp, fmt, a); va_end(a); if (k > 0) add(tmp, k < (int)sizeof tmp ? k : sizeof tmp - 1); }
    void addjs(const char *s) { add("\""); for (; s && *s; ++s) { unsigned char c = *s; if (c == '"' || c == '\\') { char e[3] = {'\\', (char)c, 0}; add(e); } else if (c < 0x20) addf("\\u%04x", c); else add((const char *)&c, 1); } add("\""); }
    void clear() { n = 0; if (p) p[0] = 0; }
    ~Buf() { free(p); }
};

// ---------------------------------------------------------------- telemetry state

struct Chan { const char *name; scs_value_type_t type; scs_value_t v; bool has; };
static Chan g_ch[] = {
    {SCS_TELEMETRY_CHANNEL_game_time, SCS_VALUE_TYPE_u32},
    {SCS_TELEMETRY_CHANNEL_local_scale, SCS_VALUE_TYPE_float},
    {SCS_TELEMETRY_CHANNEL_next_rest_stop, SCS_VALUE_TYPE_s32},
    {SCS_TELEMETRY_TRUCK_CHANNEL_world_placement, SCS_VALUE_TYPE_dplacement},
    {SCS_TELEMETRY_TRUCK_CHANNEL_speed, SCS_VALUE_TYPE_float},
    {SCS_TELEMETRY_TRUCK_CHANNEL_engine_rpm, SCS_VALUE_TYPE_float},
    {SCS_TELEMETRY_TRUCK_CHANNEL_engine_gear, SCS_VALUE_TYPE_s32},
    {SCS_TELEMETRY_TRUCK_CHANNEL_displayed_gear, SCS_VALUE_TYPE_s32},
    {SCS_TELEMETRY_TRUCK_CHANNEL_cruise_control, SCS_VALUE_TYPE_float},
    {SCS_TELEMETRY_TRUCK_CHANNEL_effective_throttle, SCS_VALUE_TYPE_float},
    {SCS_TELEMETRY_TRUCK_CHANNEL_effective_brake, SCS_VALUE_TYPE_float},
    {SCS_TELEMETRY_TRUCK_CHANNEL_effective_steering, SCS_VALUE_TYPE_float},
    {SCS_TELEMETRY_TRUCK_CHANNEL_parking_brake, SCS_VALUE_TYPE_bool},
    {SCS_TELEMETRY_TRUCK_CHANNEL_fuel, SCS_VALUE_TYPE_float},
    {SCS_TELEMETRY_TRUCK_CHANNEL_fuel_warning, SCS_VALUE_TYPE_bool},
    {SCS_TELEMETRY_TRUCK_CHANNEL_fuel_average_consumption, SCS_VALUE_TYPE_float},
    {SCS_TELEMETRY_TRUCK_CHANNEL_fuel_range, SCS_VALUE_TYPE_float},
    {SCS_TELEMETRY_TRUCK_CHANNEL_oil_temperature, SCS_VALUE_TYPE_float},
    {SCS_TELEMETRY_TRUCK_CHANNEL_water_temperature, SCS_VALUE_TYPE_float},
    {SCS_TELEMETRY_TRUCK_CHANNEL_battery_voltage, SCS_VALUE_TYPE_float},
    {SCS_TELEMETRY_TRUCK_CHANNEL_electric_enabled, SCS_VALUE_TYPE_bool},
    {SCS_TELEMETRY_TRUCK_CHANNEL_engine_enabled, SCS_VALUE_TYPE_bool},
    {SCS_TELEMETRY_TRUCK_CHANNEL_lblinker, SCS_VALUE_TYPE_bool},
    {SCS_TELEMETRY_TRUCK_CHANNEL_rblinker, SCS_VALUE_TYPE_bool},
    {SCS_TELEMETRY_TRUCK_CHANNEL_hazard_warning, SCS_VALUE_TYPE_bool},
    {SCS_TELEMETRY_TRUCK_CHANNEL_light_parking, SCS_VALUE_TYPE_bool},
    {SCS_TELEMETRY_TRUCK_CHANNEL_light_low_beam, SCS_VALUE_TYPE_bool},
    {SCS_TELEMETRY_TRUCK_CHANNEL_light_high_beam, SCS_VALUE_TYPE_bool},
    {SCS_TELEMETRY_TRUCK_CHANNEL_light_beacon, SCS_VALUE_TYPE_bool},
    {SCS_TELEMETRY_TRUCK_CHANNEL_light_brake, SCS_VALUE_TYPE_bool},
    {SCS_TELEMETRY_TRUCK_CHANNEL_light_reverse, SCS_VALUE_TYPE_bool},
    {SCS_TELEMETRY_TRUCK_CHANNEL_wipers, SCS_VALUE_TYPE_bool},
    {SCS_TELEMETRY_TRUCK_CHANNEL_dashboard_backlight, SCS_VALUE_TYPE_float},
    {SCS_TELEMETRY_TRUCK_CHANNEL_wear_engine, SCS_VALUE_TYPE_float},
    {SCS_TELEMETRY_TRUCK_CHANNEL_wear_transmission, SCS_VALUE_TYPE_float},
    {SCS_TELEMETRY_TRUCK_CHANNEL_wear_cabin, SCS_VALUE_TYPE_float},
    {SCS_TELEMETRY_TRUCK_CHANNEL_wear_chassis, SCS_VALUE_TYPE_float},
    {SCS_TELEMETRY_TRUCK_CHANNEL_wear_wheels, SCS_VALUE_TYPE_float},
    {SCS_TELEMETRY_TRUCK_CHANNEL_odometer, SCS_VALUE_TYPE_float},
    {SCS_TELEMETRY_TRUCK_CHANNEL_navigation_distance, SCS_VALUE_TYPE_float},
    {SCS_TELEMETRY_TRUCK_CHANNEL_navigation_time, SCS_VALUE_TYPE_float},
    {SCS_TELEMETRY_TRUCK_CHANNEL_navigation_speed_limit, SCS_VALUE_TYPE_float},
    {SCS_TELEMETRY_JOB_CHANNEL_cargo_damage, SCS_VALUE_TYPE_float},
};
static const int CH_COUNT = sizeof(g_ch) / sizeof(g_ch[0]);

// Configurations are stored generically as pre-rendered JSON objects keyed by config id.
struct Cfg { char id[64]; char *json; };
static Cfg g_cfg[24]; static int g_cfg_count = 0;
static Buf g_events;          // JSON array items of recent gameplay events
static int g_event_count = 0;
static bool g_paused = true;
static char g_game[64] = "";

static void value_json(Buf &b, const scs_value_t &v)
{
    switch (v.type) {
    case SCS_VALUE_TYPE_bool: b.add(v.value_bool.value ? "true" : "false"); break;
    case SCS_VALUE_TYPE_s32: b.addf("%d", v.value_s32.value); break;
    case SCS_VALUE_TYPE_u32: b.addf("%u", v.value_u32.value); break;
    case SCS_VALUE_TYPE_u64: b.addf("%llu", (unsigned long long)v.value_u64.value); break;
    case SCS_VALUE_TYPE_s64: b.addf("%lld", (long long)v.value_s64.value); break;
    case SCS_VALUE_TYPE_float: b.addf("%.4g", v.value_float.value); break;
    case SCS_VALUE_TYPE_double: b.addf("%.6f", v.value_double.value); break;
    case SCS_VALUE_TYPE_fvector: b.addf("[%.4g,%.4g,%.4g]", v.value_fvector.x, v.value_fvector.y, v.value_fvector.z); break;
    case SCS_VALUE_TYPE_dvector: b.addf("[%.3f,%.3f,%.3f]", v.value_dvector.x, v.value_dvector.y, v.value_dvector.z); break;
    case SCS_VALUE_TYPE_euler: b.addf("[%.5f,%.5f,%.5f]", v.value_euler.heading, v.value_euler.pitch, v.value_euler.roll); break;
    case SCS_VALUE_TYPE_fplacement: b.addf("{\"pos\":[%.3f,%.3f,%.3f],\"rot\":[%.5f,%.5f,%.5f]}", v.value_fplacement.position.x, v.value_fplacement.position.y, v.value_fplacement.position.z, v.value_fplacement.orientation.heading, v.value_fplacement.orientation.pitch, v.value_fplacement.orientation.roll); break;
    case SCS_VALUE_TYPE_dplacement: b.addf("{\"pos\":[%.3f,%.3f,%.3f],\"rot\":[%.5f,%.5f,%.5f]}", v.value_dplacement.position.x, v.value_dplacement.position.y, v.value_dplacement.position.z, v.value_dplacement.orientation.heading, v.value_dplacement.orientation.pitch, v.value_dplacement.orientation.roll); break;
    case SCS_VALUE_TYPE_string: b.addjs(v.value_string.value); break;
    default: b.add("null");
    }
}

// Renders named attributes as a JSON object; indexed attributes become arrays (index > 0 appended).
static void attrs_json(Buf &b, const scs_named_value_t *a)
{
    b.add("{");
    bool first = true;
    for (; a && a->name; ++a) {
        if (a->index != SCS_U32_NIL && a->index > 0) continue;   // keep v0 simple: first element only
        if (!first) b.add(",");
        first = false;
        b.addjs(a->name); b.add(":");
        value_json(b, a->value);
    }
    b.add("}");
}

SCSAPI_VOID on_channel(const scs_string_t name, const scs_u32_t index, const scs_value_t *const value, const scs_context_t ctx)
{
    Chan *c = (Chan *)ctx;
    EnterCriticalSection(&g_lock);
    if (value) { c->v = *value; c->has = true; } else c->has = false;
    LeaveCriticalSection(&g_lock);
}

SCSAPI_VOID on_event(const scs_event_t ev, const void *const info, const scs_context_t ctx)
{
    if (ev == SCS_TELEMETRY_EVENT_paused || ev == SCS_TELEMETRY_EVENT_started) {
        EnterCriticalSection(&g_lock); g_paused = (ev == SCS_TELEMETRY_EVENT_paused); LeaveCriticalSection(&g_lock);
        log_line(ev == SCS_TELEMETRY_EVENT_paused ? "paused" : "started");
        return;
    }
    if (ev == SCS_TELEMETRY_EVENT_configuration) {
        const scs_telemetry_configuration_t *c = (const scs_telemetry_configuration_t *)info;
        Buf b; attrs_json(b, c->attributes);
        EnterCriticalSection(&g_lock);
        int k = 0; while (k < g_cfg_count && strcmp(g_cfg[k].id, c->id) != 0) ++k;
        if (k == g_cfg_count && g_cfg_count < 24) { strncpy(g_cfg[k].id, c->id, 63); g_cfg[k].json = NULL; ++g_cfg_count; }
        if (k < 24) { free(g_cfg[k].json); g_cfg[k].json = _strdup(b.p ? b.p : "{}"); }
        LeaveCriticalSection(&g_lock);
        log_line("config %s %s", c->id, b.p ? b.p : "{}");
        return;
    }
    if (ev == SCS_TELEMETRY_EVENT_gameplay) {
        const scs_telemetry_gameplay_event_t *g = (const scs_telemetry_gameplay_event_t *)info;
        Buf b; b.add("{\"id\":"); b.addjs(g->id); b.add(",\"time\":"); b.addf("%llu", (unsigned long long)GetTickCount64()); b.add(",\"attr\":"); attrs_json(b, g->attributes); b.add("}");
        EnterCriticalSection(&g_lock);
        if (g_event_count >= 20) { g_events.clear(); g_event_count = 0; }   // simple cap
        if (g_event_count) g_events.add(",");
        g_events.add(b.p); ++g_event_count;
        LeaveCriticalSection(&g_lock);
        log_line("gameplay %s", b.p);
    }
}

static void state_json(Buf &b)
{
    EnterCriticalSection(&g_lock);
    b.add("{\"game\":"); b.addjs(g_game); b.addf(",\"paused\":%s,\"ch\":{", g_paused ? "true" : "false");
    bool first = true;
    for (int i = 0; i < CH_COUNT; ++i) {
        if (!g_ch[i].has) continue;
        if (!first) b.add(",");
        first = false;
        b.addjs(g_ch[i].name); b.add(":"); value_json(b, g_ch[i].v);
    }
    b.add("},\"cfg\":{");
    for (int i = 0; i < g_cfg_count; ++i) { if (i) b.add(","); b.addjs(g_cfg[i].id); b.add(":"); b.add(g_cfg[i].json ? g_cfg[i].json : "{}"); }
    b.add("},\"events\":["); if (g_events.p) b.add(g_events.p); b.add("]}");
    LeaveCriticalSection(&g_lock);
}

// ---------------------------------------------------------------- input (semantical device)

static const char *g_mixes[] = {
    "engine", "engineelect", "ignitionon", "ignitionoff", "ignitionstrt", "light", "lighton", "lightoff", "lightpark", "hblight",
    "lblinker", "rblinker", "flasher4way", "wipers", "wipersback", "wipers0", "wipers1", "wipers2", "wipers3", "wipers4",
    "cruiectrl", "cruiectrlinc", "cruiectrldec", "cruiectrlres",
    "parkingbrake", "handbrake", "horn", "airhorn", "beacon", "cabinlight", "parking_cams", "infotainment", "navmap",
    "cam1", "cam2", "cam3", "cam4", "cam5", "cam6", "camcycle", "radiotoggle", "radionext", "radioprev", "screenshot",
    "lwinopen", "lwinclose", "rwinopen", "rwinclose", "quickpark", "showmirrors",
    "activate",   // the in-game "press Enter" prompt: deliver / load, refuel, repair, sleep
    "radioup", "radiodown",   // radio volume
};
static const int MIX_COUNT = sizeof(g_mixes) / sizeof(g_mixes[0]);
// Each input is held down until this tick (GetTickCount64 ms); 0 = released.
// Short taps toggle things (engine, lights); long holds drive "while held" actions (windows).
static volatile LONG64 g_hold_until[MIX_COUNT];
static int g_next_input = 0;
static bool g_last_state[MIX_COUNT];
static const unsigned DEFAULT_HOLD_MS = 120;
static const unsigned MAX_HOLD_MS = 6000;

static void queue_press(const char *mix, unsigned hold_ms)
{
    if (hold_ms == 0) hold_ms = DEFAULT_HOLD_MS;
    if (hold_ms > MAX_HOLD_MS) hold_ms = MAX_HOLD_MS;
    for (int i = 0; i < MIX_COUNT; ++i)
        if (strcmp(g_mixes[i], mix) == 0) {
            InterlockedExchange64(&g_hold_until[i], (LONG64)(GetTickCount64() + hold_ms));
            log_line("press %s (%u ms)", mix, hold_ms);
            return;
        }
    log_line("press unknown mix '%s'", mix);
}

SCSAPI_RESULT on_input(scs_input_event_t *const ev, const scs_u32_t flags, const scs_context_t ctx)
{
    if (flags & SCS_INPUT_EVENT_CALLBACK_FLAG_first_in_frame) g_next_input = 0;
    const unsigned long long now = GetTickCount64();
    // Report only inputs whose state changed (press, then release when the hold time ends).
    while (g_next_input < MIX_COUNT) {
        int i = g_next_input++;
        bool down = (unsigned long long)g_hold_until[i] > now;
        if (down != g_last_state[i] || (flags & SCS_INPUT_EVENT_CALLBACK_FLAG_first_after_activation)) {
            g_last_state[i] = down;
            ev->input_index = i;
            ev->value_bool.value = down ? 1 : 0;
            return SCS_RESULT_ok;
        }
    }
    return SCS_RESULT_not_found;
}

// ---------------------------------------------------------------- tiny SHA-1 + base64 for the WebSocket handshake

static void sha1(const unsigned char *data, size_t len, unsigned char out[20])
{
    unsigned int h[5] = {0x67452301, 0xEFCDAB89, 0x98BADCFE, 0x10325476, 0xC3D2E1F0};
    size_t total = ((len + 8) / 64 + 1) * 64;
    unsigned char *m = (unsigned char *)calloc(total, 1);
    memcpy(m, data, len); m[len] = 0x80;
    unsigned long long bits = (unsigned long long)len * 8;
    for (int i = 0; i < 8; ++i) m[total - 1 - i] = (unsigned char)(bits >> (8 * i));
    for (size_t off = 0; off < total; off += 64) {
        unsigned int w[80];
        for (int i = 0; i < 16; ++i) w[i] = (m[off + 4 * i] << 24) | (m[off + 4 * i + 1] << 16) | (m[off + 4 * i + 2] << 8) | m[off + 4 * i + 3];
        for (int i = 16; i < 80; ++i) { unsigned int t = w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16]; w[i] = (t << 1) | (t >> 31); }
        unsigned int a = h[0], b = h[1], c = h[2], d = h[3], e = h[4];
        for (int i = 0; i < 80; ++i) {
            unsigned int f, k;
            if (i < 20) { f = (b & c) | (~b & d); k = 0x5A827999; }
            else if (i < 40) { f = b ^ c ^ d; k = 0x6ED9EBA1; }
            else if (i < 60) { f = (b & c) | (b & d) | (c & d); k = 0x8F1BBCDC; }
            else { f = b ^ c ^ d; k = 0xCA62C1D6; }
            unsigned int t = ((a << 5) | (a >> 27)) + f + e + k + w[i];
            e = d; d = c; c = (b << 30) | (b >> 2); b = a; a = t;
        }
        h[0] += a; h[1] += b; h[2] += c; h[3] += d; h[4] += e;
    }
    free(m);
    for (int i = 0; i < 5; ++i) { out[4 * i] = h[i] >> 24; out[4 * i + 1] = h[i] >> 16; out[4 * i + 2] = h[i] >> 8; out[4 * i + 3] = h[i]; }
}

static void base64(const unsigned char *in, int len, char *out)
{
    static const char *t = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    int o = 0;
    for (int i = 0; i < len; i += 3) {
        int v = in[i] << 16 | (i + 1 < len ? in[i + 1] << 8 : 0) | (i + 2 < len ? in[i + 2] : 0);
        out[o++] = t[(v >> 18) & 63]; out[o++] = t[(v >> 12) & 63];
        out[o++] = i + 1 < len ? t[(v >> 6) & 63] : '=';
        out[o++] = i + 2 < len ? t[v & 63] : '=';
    }
    out[o] = 0;
}

// ---------------------------------------------------------------- HTTP / WebSocket server

static SOCKET g_listen = INVALID_SOCKET;
static volatile LONG g_running = 0;

static bool send_all(SOCKET s, const char *p, int n)
{
    while (n > 0) { int k = send(s, p, n, 0); if (k <= 0) return false; p += k; n -= k; }
    return true;
}

static bool ws_send_text(SOCKET s, const char *p, size_t n)
{
    unsigned char h[10]; int hl;
    h[0] = 0x81;
    if (n < 126) { h[1] = (unsigned char)n; hl = 2; }
    else if (n < 65536) { h[1] = 126; h[2] = (unsigned char)(n >> 8); h[3] = (unsigned char)n; hl = 4; }
    else { h[1] = 127; for (int i = 0; i < 8; ++i) h[2 + i] = (unsigned char)((unsigned long long)n >> (56 - 8 * i)); hl = 10; }
    return send_all(s, (const char *)h, hl) && send_all(s, p, (int)n);
}

static const char *mime(const char *path)
{
    const char *e = strrchr(path, '.');
    if (!e) return "application/octet-stream";
    if (!_stricmp(e, ".html")) return "text/html; charset=utf-8";
    if (!_stricmp(e, ".js")) return "text/javascript; charset=utf-8";
    if (!_stricmp(e, ".css")) return "text/css; charset=utf-8";
    if (!_stricmp(e, ".json") || !_stricmp(e, ".webmanifest")) return "application/json";
    if (!_stricmp(e, ".png")) return "image/png";
    if (!_stricmp(e, ".svg")) return "image/svg+xml";
    if (!_stricmp(e, ".jpg")) return "image/jpeg";
    return "application/octet-stream";
}

static void serve_file(SOCKET s, const char *url)
{
    char rel[260]; int j = 0;
    for (const char *p = url; *p && *p != '?' && j < 250; ++p) rel[j++] = (*p == '/') ? '\\' : *p;
    rel[j] = 0;
    if (strstr(rel, "..")) { send_all(s, "HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n", 45); return; }
    if (!strcmp(rel, "\\")) strcpy(rel, "\\index.html");
    char full[MAX_PATH * 2]; snprintf(full, sizeof full, "%s\\web%s", g_root, rel);
    FILE *f = fopen(full, "rb");
    if (!f) { const char *nf = "HTTP/1.1 404 Not Found\r\nContent-Length: 9\r\n\r\nnot found"; send_all(s, nf, (int)strlen(nf)); return; }
    fseek(f, 0, SEEK_END); long size = ftell(f); fseek(f, 0, SEEK_SET);
    char hdr[256]; int hl = snprintf(hdr, sizeof hdr, "HTTP/1.1 200 OK\r\nContent-Type: %s\r\nContent-Length: %ld\r\nCache-Control: no-cache\r\nConnection: close\r\n\r\n", mime(full), size);
    send_all(s, hdr, hl);
    char chunk[16384]; size_t k;
    while ((k = fread(chunk, 1, sizeof chunk, f)) > 0) if (!send_all(s, chunk, (int)k)) break;
    fclose(f);
}

// Reads one client WebSocket frame if available (non-blocking poll). Returns false on close/error.
static bool ws_poll_incoming(SOCKET s)
{
    fd_set r; FD_ZERO(&r); FD_SET(s, &r); timeval tv = {0, 0};
    if (select(0, &r, NULL, NULL, &tv) <= 0) return true;
    unsigned char h[2]; if (recv(s, (char *)h, 2, MSG_WAITALL) != 2) return false;
    int op = h[0] & 0x0F; unsigned long long len = h[1] & 0x7F;
    if (len == 126) { unsigned char e[2]; if (recv(s, (char *)e, 2, MSG_WAITALL) != 2) return false; len = (e[0] << 8) | e[1]; }
    else if (len == 127) return false;   // not expected from our client
    unsigned char mask[4] = {0}; if ((h[1] & 0x80) && recv(s, (char *)mask, 4, MSG_WAITALL) != 4) return false;
    if (len > 4096) return false;
    char msg[4097]; if (len && recv(s, msg, (int)len, MSG_WAITALL) != (int)len) return false;
    for (unsigned long long i = 0; i < len; ++i) msg[i] ^= mask[i & 3];
    msg[len] = 0;
    if (op == 8) return false;
    if (op == 1) {   // {"press":"engine"} or {"press":"lwinopen","hold":2500}
        const char *p = strstr(msg, "\"press\"");
        if (p && (p = strchr(p + 7, '"'))) {
            char mix[32]; int j = 0; ++p; while (*p && *p != '"' && j < 31) mix[j++] = *p++; mix[j] = 0;
            unsigned hold = 0;
            const char *h = strstr(msg, "\"hold\"");
            if (h && (h = strchr(h + 6, ':'))) hold = (unsigned)strtoul(h + 1, NULL, 10);
            queue_press(mix, hold);
        }
    }
    return true;
}

static DWORD WINAPI client_thread(LPVOID arg)
{
    SOCKET s = (SOCKET)(UINT_PTR)arg;
    char req[4096]; int n = 0;
    while (n < (int)sizeof req - 1) { int k = recv(s, req + n, sizeof req - 1 - n, 0); if (k <= 0) break; n += k; req[n] = 0; if (strstr(req, "\r\n\r\n")) break; }
    req[n] = 0;
    char url[300] = "/"; sscanf(req, "GET %299s", url);
    const char *key = strstr(req, "Sec-WebSocket-Key:");
    if (!strncmp(url, "/ws", 3) && key) {
        key += 18; while (*key == ' ') ++key;
        char k2[128]; int j = 0; while (key[j] && key[j] != '\r' && j < 60) { k2[j] = key[j]; ++j; } k2[j] = 0;
        strcat(k2, "258EAFA5-E914-47DA-95CA-C5AB0DC85B11");
        unsigned char d[20]; sha1((const unsigned char *)k2, strlen(k2), d);
        char acc[40]; base64(d, 20, acc);
        char resp[256]; int rl = snprintf(resp, sizeof resp, "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: %s\r\n\r\n", acc);
        if (send_all(s, resp, rl)) {
            log_line("ws client connected");
            Buf b;
            while (g_running) {
                if (!ws_poll_incoming(s)) break;
                b.clear(); state_json(b);
                if (!ws_send_text(s, b.p, b.n)) break;
                Sleep(16);   // ~60 updates/s: smooth car movement on the dashboards, quick button response
            }
            log_line("ws client disconnected");
        }
    } else if (!strncmp(url, "/state", 6)) {
        Buf b; state_json(b);
        char hdr[200]; int hl = snprintf(hdr, sizeof hdr, "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: %u\r\nConnection: close\r\n\r\n", (unsigned)b.n);
        send_all(s, hdr, hl); send_all(s, b.p, (int)b.n);
    } else {
        serve_file(s, url);
    }
    closesocket(s);
    return 0;
}

static DWORD WINAPI server_thread(LPVOID)
{
    while (g_running) {
        SOCKET c = accept(g_listen, NULL, NULL);
        if (c == INVALID_SOCKET) break;
        HANDLE t = CreateThread(NULL, 0, client_thread, (LPVOID)(UINT_PTR)c, 0, NULL);
        if (t) CloseHandle(t); else closesocket(c);
    }
    return 0;
}

static DWORD WINAPI snapshot_thread(LPVOID)
{
    Buf b;
    while (g_running) {
        Sleep(1000);
        b.clear(); state_json(b);
        // Snapshot without configs/events (those are logged when they change).
        char *cut = b.p ? strstr(b.p, ",\"cfg\"") : NULL; if (cut) *cut = 0;
        log_line("snap %s}", b.p ? b.p : "");
    }
    return 0;
}

static void start_server()
{
    if (InterlockedCompareExchange(&g_running, 1, 0)) return;
    WSADATA w; WSAStartup(MAKEWORD(2, 2), &w);
    g_listen = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
    BOOL yes = TRUE; setsockopt(g_listen, SOL_SOCKET, SO_REUSEADDR, (const char *)&yes, sizeof yes);
    sockaddr_in a = {}; a.sin_family = AF_INET; a.sin_port = htons(PORT); a.sin_addr.s_addr = htonl(INADDR_LOOPBACK);   // this PC only: phones go through the Co-Driver server
    if (bind(g_listen, (sockaddr *)&a, sizeof a) != 0 || listen(g_listen, 16) != 0) {
        log_line("server: cannot listen on port %d (error %d)", PORT, WSAGetLastError());
        closesocket(g_listen); g_listen = INVALID_SOCKET; g_running = 0; return;
    }
    log_line("server listening on port %d", PORT);
    CloseHandle(CreateThread(NULL, 0, server_thread, NULL, 0, NULL));
    CloseHandle(CreateThread(NULL, 0, snapshot_thread, NULL, 0, NULL));
}

static void stop_server()
{
    if (!InterlockedExchange(&g_running, 0)) return;
    if (g_listen != INVALID_SOCKET) { closesocket(g_listen); g_listen = INVALID_SOCKET; }
    WSACleanup();
}

// ---------------------------------------------------------------- plugin entry points

static volatile LONG g_inited = 0;
static void common_init()
{
    if (InterlockedExchange(&g_inited, 1)) return;
    InitializeCriticalSection(&g_lock);
    char local[MAX_PATH]; SHGetFolderPathA(NULL, CSIDL_LOCAL_APPDATA, NULL, 0, local);
    snprintf(g_root, sizeof g_root, "%s\\ATS Co-Driver", local);
    char logs[MAX_PATH]; snprintf(logs, sizeof logs, "%s\\logs", g_root); CreateDirectoryA(g_root, NULL); CreateDirectoryA(logs, NULL);
    char lp[MAX_PATH]; snprintf(lp, sizeof lp, "%s\\plugin.log", logs);
    g_log = fopen(lp, "w");
    log_line("ATS Co-Driver plugin loaded");
}

EXPORT SCSAPI_RESULT scs_telemetry_init(const scs_u32_t version, const scs_telemetry_init_params_t *const params)
{
    if (version != SCS_TELEMETRY_VERSION_1_01 && version != SCS_TELEMETRY_VERSION_1_00) return SCS_RESULT_unsupported;
    common_init();
    const scs_telemetry_init_params_v100_t *p = (const scs_telemetry_init_params_v100_t *)params;
    g_game_log = p->common.log;
    snprintf(g_game, sizeof g_game, "%s %u.%u", p->common.game_id, SCS_GET_MAJOR_VERSION(p->common.game_version), SCS_GET_MINOR_VERSION(p->common.game_version));
    log_line("telemetry init: %s (%s)", g_game, p->common.game_name);

    p->register_for_event(SCS_TELEMETRY_EVENT_paused, on_event, NULL);
    p->register_for_event(SCS_TELEMETRY_EVENT_started, on_event, NULL);
    p->register_for_event(SCS_TELEMETRY_EVENT_configuration, on_event, NULL);
    p->register_for_event(SCS_TELEMETRY_EVENT_gameplay, on_event, NULL);
    for (int i = 0; i < CH_COUNT; ++i) {
        scs_result_t r = p->register_for_channel(g_ch[i].name, SCS_U32_NIL, g_ch[i].type, SCS_TELEMETRY_CHANNEL_FLAG_no_value, on_channel, &g_ch[i]);
        if (r != SCS_RESULT_ok) log_line("channel %s not available (%d)", g_ch[i].name, r);
    }
    start_server();
    if (g_game_log) g_game_log(SCS_LOG_TYPE_message, "[ATS Co-Driver] telemetry ready (port 25555, this PC only)");
    return SCS_RESULT_ok;
}

EXPORT SCSAPI_VOID scs_telemetry_shutdown(void)
{
    log_line("telemetry shutdown");
    stop_server();
}

EXPORT SCSAPI_RESULT scs_input_init(const scs_u32_t version, const scs_input_init_params_t *const params)
{
    if (version != SCS_INPUT_VERSION_1_00) return SCS_RESULT_unsupported;
    common_init();
    const scs_input_init_params_v100_t *p = (const scs_input_init_params_v100_t *)params;
    static scs_input_device_input_t inputs[MIX_COUNT];
    for (int i = 0; i < MIX_COUNT; ++i) { inputs[i].name = g_mixes[i]; inputs[i].display_name = g_mixes[i]; inputs[i].value_type = SCS_VALUE_TYPE_bool; }
    scs_input_device_t d; memset(&d, 0, sizeof d);
    // display name without "-": the game rejects it ("invalid device display_name", buttons disabled)
    d.display_name = "ATS Co Driver"; d.type = SCS_INPUT_DEVICE_TYPE_semantical;
    d.name = "ats_codriver";
    d.input_count = MIX_COUNT; d.inputs = inputs; d.input_event_callback = on_input;
    scs_result_t r = p->register_device(&d);
    log_line("input device register: %d", r);
    return r == SCS_RESULT_ok ? SCS_RESULT_ok : SCS_RESULT_generic_error;
}

EXPORT SCSAPI_VOID scs_input_shutdown(void) { log_line("input shutdown"); }

BOOL APIENTRY DllMain(HMODULE, DWORD reason, LPVOID)
{
    if (reason == DLL_PROCESS_DETACH && g_log) { log_line("unloaded"); fclose(g_log); g_log = NULL; }
    return TRUE;
}
