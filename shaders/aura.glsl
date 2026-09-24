// Aura for Ghostty: the whole window rides your music.
// Needs `/aura shader` on in pi; aura writes loudness into palette slot 232.
// Every effect scales with loudness, so silence renders the terminal untouched.

const float TAU = 6.2831853;

// Same ramp as the frame: cyan, hot pink, white-hot.
vec3 auraRamp(float t) {
    vec3 col = mix(vec3(0.0, 0.9, 1.0), vec3(1.0, 0.2, 0.7), smoothstep(0.3, 0.8, t));
    return mix(col, vec3(1.0), smoothstep(0.85, 1.0, t));
}

vec3 hue(float h) {
    return clamp(abs(fract(h + vec3(0.0, 2.0, 1.0) / 3.0) * 6.0 - 3.0) - 1.0, 0.0, 1.0);
}

void mainImage(out vec4 fragColor, in vec2 fragCoord) {
    float level = iPalette[232].r;
    float punch = level * level;
    vec2 res = iResolution.xy;
    vec2 uv = fragCoord / res;
    vec2 fromCenter = uv - 0.5;

    // Beat punch: the screen kicks toward you on loud hits.
    uv = 0.5 + fromCenter * (1.0 - 0.012 * punch);

    // Chromatic split, stronger toward the corners.
    vec2 split = fromCenter * 0.012 * punch;
    vec4 term = texture(iChannel0, uv);
    vec3 base = vec3(
        texture(iChannel0, uv + split).r,
        term.g,
        texture(iChannel0, uv - split).b
    );

    // Text bloom: bright glyphs bleed light in the aura color.
    vec3 bloom = vec3(0.0);
    float radius = (1.5 + 5.0 * level) / res.y;
    for (int i = 0; i < 8; i++) {
        float a = TAU * float(i) / 8.0;
        vec3 s = texture(iChannel0, uv + vec2(cos(a), sin(a)) * radius * vec2(res.y / res.x, 1.0)).rgb;
        bloom += max(s - 0.45, 0.0);
    }
    bloom *= auraRamp(level) * 0.35 * level;

    // Edge aura: a hue that orbits the window, tinted by the loudness ramp.
    vec2 d = min(fragCoord, res - fragCoord);
    float edge = min(d.x, d.y);
    float glow = exp(-edge / (14.0 + 140.0 * level)) * level;
    float angle = atan(fromCenter.y, fromCenter.x) / TAU;
    vec3 orbit = hue(angle + iTime * (0.08 + 0.5 * level));
    vec3 edgeCol = mix(auraRamp(level), orbit, 0.45) * glow * 1.4;

    // Full-screen visualizer behind the text: plasma plus pulse rings.
    // Only empty background pixels get it, so text stays readable.
    float bgMask = 1.0 - smoothstep(0.02, 0.12, distance(term.rgb, iBackgroundColor));
    vec2 p = fromCenter * vec2(res.x / res.y, 1.0);
    float t = iTime * (0.15 + 1.2 * level);
    float plasma = sin(p.x * 6.0 + t) + sin(p.y * 7.0 - t * 1.3)
        + sin((p.x + p.y) * 5.0 + t * 0.7) + sin(length(p) * 9.0 - t * 1.7);
    plasma = plasma * 0.125 + 0.5;
    vec3 plasmaCol = mix(auraRamp(plasma * level + 0.1), hue(plasma + t * 0.05), 0.35);
    float r = length(p);
    float rings = pow(0.5 + 0.5 * sin(r * 28.0 - iTime * (4.0 + 10.0 * level)), 8.0) * exp(-r * 1.5);
    vec3 visualizer = (plasmaCol * 0.35 * level + auraRamp(level) * rings * 0.5 * punch) * bgMask;

    // Scanline shimmer and a white flash on the very loudest peaks.
    float scan = 1.0 - 0.08 * punch * (0.5 + 0.5 * sin(fragCoord.y * 1.6 + iTime * 18.0));
    float flash = smoothstep(0.92, 1.0, level) * 0.12;

    vec3 col = (base + bloom + visualizer) * scan + edgeCol + flash;
    fragColor = vec4(col, term.a);
}
