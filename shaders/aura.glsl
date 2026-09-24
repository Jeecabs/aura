// Aura for Ghostty: a strip of light along the bottom edge, under pi's input frame, in the
// frame's own colors. It drifts slowly on its own; loudness swells it, each beat sends one swell outward from
// the center. The rest of the window is left alone.
// Needs `/aura on` and `/aura shader` in pi. Aura feeds signals through palette slots:
//   232: level (smoothed), bass, treble
//   233: beat,  mid,  token stream rate
//   234: thinking, tool running, error
// This shader uses level, beat, thinking and error. Silence plus an idle agent renders untouched.

// The frame's own ramp (editor-chrome GLOW_STOPS): dusk violet, cyan, hot pink, white-hot.
// Matching it exactly makes the light read as coming from the frame.
vec3 auraRamp(float t) {
    vec3 a = vec3(72.0, 62.0, 104.0) / 255.0;
    vec3 b = vec3(55.0, 232.0, 255.0) / 255.0;
    vec3 c = vec3(255.0, 113.0, 206.0) / 255.0;
    vec3 d = vec3(255.0, 232.0, 248.0) / 255.0;
    float s = clamp(t, 0.0, 1.0) * 3.0;
    return s < 1.0 ? mix(a, b, s) : s < 2.0 ? mix(b, c, s - 1.0) : mix(c, d, s - 2.0);
}

float hash(vec2 p) {
    return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
}

// Smooth 1D value noise for the drifting horizon.
float noise(float x) {
    float i = floor(x);
    float f = fract(x);
    float a = fract(sin(i * 127.1) * 43758.5453);
    float b = fract(sin((i + 1.0) * 127.1) * 43758.5453);
    return mix(a, b, f * f * (3.0 - 2.0 * f));
}

void mainImage(out vec4 fragColor, in vec2 fragCoord) {
    float level = iPalette[232].r;
    float beat = iPalette[233].r;
    float thinking = iPalette[234].r;
    float error = iPalette[234].b;

    vec2 res = iResolution.xy;
    vec2 uv = fragCoord / res;
    vec4 term = texture(iChannel0, uv);
    float t = iTime;

    // The beat pulse decays geometrically, so (1 - beat) is its age: ride that as a
    // swell travelling outward from the center along the horizon.
    float d = abs(uv.x - 0.5);
    float front = (1.0 - beat) * 0.55;
    float swell = beat * exp(-pow((d - front) / 0.08, 2.0));

    // A light strip along the bottom edge: a tight hot core plus a soft halo, both
    // reaching further as it gets louder. The inverse-square tail is what reads as light.
    float y = fragCoord.y;
    float core = exp(-y / (4.0 + 10.0 * level));
    float haloH = (28.0 + 80.0 * level) * (1.0 + 0.6 * swell);
    float halo = 1.0 / (1.0 + (y / haloH) * (y / haloH));
    // Slow drift along the strip, so it's never a flat bar. The frame's center bias
    // (editor-chrome glowCharacter) shapes it, so light and frame peak together.
    float drift = 0.7 + 0.3 * noise(uv.x * 3.0 + t * 0.1) * noise(uv.x * 7.0 - t * 0.17 + 5.0);
    float bias = 0.6 + 0.4 * cos(d * 3.14159);
    float falloff = (0.5 * core + 0.5 * halo) * drift * bias * (1.0 - pow(d * 2.0, 6.0));

    // Exactly the color the frame shows above this column, nudged warmer by the beat swell.
    // Capped short of white-hot: spread over the background, white reads as fog, not light.
    vec3 musicCol = auraRamp(min(level * bias + 0.15 * swell, 0.72));
    float music = level * 0.55 + swell * 0.2 * level;

    // Thinking: a slow violet breath, visible even in silence.
    float breath = thinking * (0.22 + 0.06 * sin(t * 1.4));
    vec3 thinkCol = vec3(0.5, 0.35, 1.0);

    float energy = music + breath;
    vec3 tint = (musicCol * music + thinkCol * breath) / max(energy, 1e-4);
    tint = mix(tint, vec3(1.0, 0.18, 0.2), error);
    energy = max(energy, error * 0.3);

    // Background takes the light; glyphs barely, so text stays crisp.
    float bgMask = 1.0 - smoothstep(0.02, 0.12, distance(term.rgb, iBackgroundColor));
    vec3 light = tint * falloff * energy * mix(0.1, 1.0, bgMask);

    // Screen blend never blows out, and a whisper of dither hides banding in the gradient.
    light += (hash(fragCoord) - 0.5) / 255.0 * step(0.001, energy);
    vec3 col = 1.0 - (1.0 - term.rgb) * (1.0 - clamp(light, 0.0, 1.0));
    fragColor = vec4(col, term.a);
}
