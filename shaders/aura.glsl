// Aura for Ghostty: a low glow rises from the bottom edge, under pi's input frame,
// like the frame is lighting the window from below. The rest of the window is left alone.
// Needs `/aura on` and `/aura shader` in pi. Aura feeds signals through palette slots:
//   232: level, bass, treble
//   233: beat,  mid,  token stream rate
//   234: thinking, tool running, error
// This shader uses level, beat, thinking and error. Silence plus an idle agent renders untouched.

// Same ramp as the frame: cyan, hot pink, white-hot.
vec3 auraRamp(float t) {
    vec3 col = mix(vec3(0.0, 0.9, 1.0), vec3(1.0, 0.2, 0.7), smoothstep(0.3, 0.8, t));
    return mix(col, vec3(1.0), smoothstep(0.85, 1.0, t));
}

float hash(vec2 p) {
    return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
}

void mainImage(out vec4 fragColor, in vec2 fragCoord) {
    float level = iPalette[232].r;
    float beat = iPalette[233].r;
    float thinking = iPalette[234].r;
    float error = iPalette[234].b;

    vec2 res = iResolution.xy;
    vec2 uv = fragCoord / res;
    vec4 term = texture(iChannel0, uv);

    // Rises from the bottom edge (y = 0 is the bottom in Ghostty), strongest at
    // the center and easing off toward the sides so it never frames the window.
    float reach = (24.0 + 90.0 * level) * (1.0 + 0.15 * beat);
    float rise = exp(-fragCoord.y / reach);
    float spread = 1.0 - pow(abs(uv.x - 0.5) * 2.0, 2.5);
    float falloff = rise * spread;

    // Music: the frame's ramp.
    float music = level * (0.32 + 0.08 * beat);
    vec3 musicCol = auraRamp(level);

    // Thinking: a slow violet breath, visible even in silence.
    float breath = thinking * (0.14 + 0.05 * sin(iTime * 1.8));
    vec3 thinkCol = vec3(0.55, 0.3, 1.0);

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
