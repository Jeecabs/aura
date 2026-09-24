// Aura for Ghostty: glows the window edges with your music.
// Needs `/aura shader` on in pi; aura writes loudness into palette slot 232.
void mainImage(out vec4 fragColor, in vec2 fragCoord) {
    vec2 uv = fragCoord / iResolution.xy;
    vec4 term = texture(iChannel0, uv);
    float level = iPalette[232].r;

    vec2 d = min(fragCoord, iResolution.xy - fragCoord);
    float edge = min(d.x, d.y);
    float glow = exp(-edge / (12.0 + 90.0 * level)) * level;

    // Same ramp as the frame: cyan, hot pink, white-hot.
    vec3 col = mix(vec3(0.0, 0.9, 1.0), vec3(1.0, 0.2, 0.7), smoothstep(0.3, 0.8, level));
    col = mix(col, vec3(1.0), smoothstep(0.85, 1.0, level));

    fragColor = vec4(term.rgb + col * glow, term.a);
}
