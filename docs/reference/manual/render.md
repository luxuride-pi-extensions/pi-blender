# Render Engines and Setup Guide (Blender 4.2 LTS)

EEVEE-Next, Cycles, camera settings, lighting setups, and color management in Blender 4.2.

## Render Engines in 4.2 LTS

### EEVEE-Next
Blender 4.2 introduces the upgraded EEVEE-Next real-time rendering architecture:
- Screen-space and hardware raytracing for ambient occlusion, reflections, and shadows.
- Fast evaluation, highly suited for real-time viewport feedback and rapid worker iterations.

### Cycles
- Physically-based path tracer.
- Supports global illumination, multi-bounce indirect lighting, true volume scattering, and microfacet transmission.
- Uses OpenImageDenoise (OIDN) or OptiX for denoising low-sample renders.

## Three-Point Lighting Setup

The classic studio setup balances form, contrast, and depth:
1. **Key Light**: Primary illumination source angled 45° to the side and 45° above the subject. Establishes primary shadows and shape definition.
2. **Fill Light**: Placed opposite the Key light at lower intensity (typically 25%–50% of Key power). Softens harsh shadows and reveals detail without creating competing double shadows.
3. **Rim / Back Light**: Positioned behind the subject facing towards the camera. Separates the subject's silhouette from the background with a crisp edge highlight.

Tip: For distance-independent irradiance across varying prop scales, use **SUN** lamps rather than point or area lights with square-distance falloff.

## Color Management: AgX

- Blender 4.0+ defaults to the **AgX** view transform, replacing legacy Filmic.
- AgX handles saturated, intense lighting highlights without harsh clipped color shifts (e.g. bright lights turning yellow instead of pure white).
