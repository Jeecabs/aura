// Aura for Ghostty: the whole window rides your music and your agent.
// Needs `/aura on` and `/aura shader` in pi. Aura feeds signals through palette slots:
//   232: level, bass, treble
//   233: beat,  mid,  token stream rate
//   234: thinking, tool running, error
// Every effect scales with a signal, so silence plus an idle agent renders untouched.

const float TAU = 6.2831853;

// Same ramp as the frame: cyan, hot pink, white-hot.
vec3 auraRamp(float t) {
    vec3 col = mix(vec3(0.0, 0.9, 1.0), vec3(1.0, 0.2, 0.7), smoothstep(0.3, 0.8, t));
    return mix(col, vec3(1.0), smoothstep(0.85, 1.0, t));
}

vec3 hue(float h) {
    return clamp(abs(fract(h + vec3(0.0, 2.0, 1.0) / 3.0) * 6.0 - 3.0) - 1.0, 0.0, 1.0);
}

float hash(vec2 p) {
    return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
}

void mainImage(out vec4 fragColor, in vec2 fragCoord) {
    vec3 s0 = iPalette[232];
    vec3 s1 = iPalette[233];
    vec3 s2 = iPalette[234];
    float level = s0.r, bass = s0.g, treble = s0.b;
    float beat = s1.r, mid = s1.g, tokens = s1.b;
    float thinking = s2.r, tool = s2.g, error = s2.b;

    vec2 res = iResolution.xy;
    float aspect = res.x / res.y;
    vec2 uv = fragCoord / res;
    vec2 c = uv - 0.5;
    vec2 p = c * vec2(aspect, 1.0);
    float r = length(p);
    float ang = atan(p.y, p.x);

    // ── Warp: bass shake, beat punch, beat shockwave, error glitch ──
    vec2 shake = (vec2(hash(vec2(iTime, 1.0)), hash(vec2(iTime, 2.0))) - 0.5) * 0.008 * bass * bass;
    uv = 0.5 + c * (1.0 - 0.035 * beat) + shake;

    // The ring expands as the beat pulse decays, refracting the text it passes over.
    float waveR = (1.0 - beat) * 1.2;
    float wave = exp(-pow((r - waveR) * 14.0, 2.0)) * beat;
    uv -= normalize(p + 1e-5) / vec2(aspect, 1.0) * wave * 0.025;

    float slice = floor(uv.y * 36.0);
    float glitchOn = step(0.55, hash(vec2(slice, floor(iTime * 24.0))));
    uv.x += (hash(vec2(slice, floor(iTime * 30.0))) - 0.5) * 0.08 * error * glitchOn;

    // ── Terminal, split into RGB on treble, beats and errors ──
    vec2 split = c * (0.012 * treble + 0.025 * beat + 0.04 * error);
    vec4 term = texture(iChannel0, uv);
    vec3 base = vec3(
        texture(iChannel0, uv + split).r,
        term.g,
        texture(iChannel0, uv - split).b
    );

    // Background pixels get the visualizer; text stays on top.
    float bgMask = 1.0 - smoothstep(0.02, 0.12, distance(term.rgb, iBackgroundColor));

    // ── Text bloom in the aura color ──
    vec3 bloom = vec3(0.0);
    float radius = (1.5 + 7.0 * level + 5.0 * beat) / res.y;
    for (int i = 0; i < 8; i++) {
        float a = TAU * float(i) / 8.0;
        vec3 s = texture(iChannel0, uv + vec2(cos(a), sin(a)) * radius * vec2(1.0 / aspect, 1.0)).rgb;
        bloom += max(s - 0.45, 0.0);
    }
    float bloomAmount = 0.45 * level + 0.35 * tokens;
    bloom *= mix(auraRamp(level), vec3(0.6, 0.3, 1.0), thinking * 0.6) * bloomAmount;

    // ── Background visualizer ──
    // Plasma: flow speed follows the mids, brightness the bass.
    float t = iTime * (0.2 + 1.6 * mid);
    float plasma = sin(p.x * 6.0 + t) + sin(p.y * 7.0 - t * 1.3)
        + sin((p.x + p.y) * 5.0 + t * 0.7) + sin(r * 9.0 - t * 1.7);
    plasma = plasma * 0.125 + 0.5;
    vec3 plasmaCol = mix(auraRamp(plasma * level + 0.1), hue(plasma + t * 0.05), 0.4);
    vec3 bg = plasmaCol * (0.15 + 0.6 * bass) * level;

    // Pulse rings out of the center, driven by bass.
    float rings = pow(0.5 + 0.5 * sin(r * 28.0 - iTime * (4.0 + 12.0 * level)), 8.0) * exp(-r * 1.5);
    bg += auraRamp(level) * rings * 0.7 * bass;

    // The beat shockwave itself, glowing.
    bg += auraRamp(0.6 + 0.4 * beat) * wave * 1.2;

    // Starfield: treble and streaming tokens make it twinkle.
    vec2 cell = floor(fragCoord / 5.0);
    float starOdds = 0.992 - 0.03 * treble - 0.04 * tokens;
    float twinkle = 0.5 + 0.5 * sin(iTime * (6.0 + 10.0 * hash(cell + 3.0)) + hash(cell + 9.0) * TAU);
    float star = step(starOdds, hash(cell)) * twinkle;
    bg += mix(vec3(1.0, 0.85, 1.0), vec3(0.4, 1.0, 0.9), tokens) * star * (treble + tokens);

    // Thinking: a violet vortex spinning out of the center.
    float swirl = 0.5 + 0.5 * sin(ang * 5.0 + r * 16.0 - iTime * 3.5);
    bg += vec3(0.55, 0.2, 1.0) * pow(swirl, 4.0) * exp(-r * 1.1) * thinking * 0.8;

    // ── Tool running: a scan beam sweeping the window ──
    float beamY = fract(iTime * 0.5);
    float beam = exp(-pow((fragCoord.y / res.y - beamY) * 28.0, 2.0));
    vec3 toolCol = vec3(0.1, 1.0, 0.6) * beam * tool * (0.25 + 0.75 * bgMask);

    // ── Edge aura: orbiting hue, violet when thinking, red on errors ──
    vec2 d = min(fragCoord, res - fragCoord);
    float edge = min(d.x, d.y);
    float edgeEnergy = max(level, max(thinking * 0.55, max(tool * 0.4, error)));
    float glow = exp(-edge / (14.0 + 170.0 * level + 80.0 * beat)) * edgeEnergy;
    vec3 orbit = hue(ang / TAU + iTime * (0.08 + 0.5 * level));
    vec3 edgeTint = mix(mix(auraRamp(level), orbit, 0.45), vec3(0.6, 0.25, 1.0), thinking * 0.5);
    edgeTint = mix(edgeTint, vec3(1.0, 0.1, 0.15), error);
    vec3 edgeCol = edgeTint * glow * 1.5;

    // ── Scanline shimmer, beat flash, error flash ──
    float shimmer = 0.1 * bass * bass + 0.15 * error;
    float scan = 1.0 - shimmer * (0.5 + 0.5 * sin(fragCoord.y * 1.6 + iTime * 18.0));
    vec3 flash = vec3(1.0) * pow(beat, 3.0) * 0.14 + vec3(0.5, 0.0, 0.05) * error * 0.3;

    vec3 col = (base + bloom + bg * bgMask) * scan + toolCol + edgeCol + flash;
    fragColor = vec4(col, term.a);
}
