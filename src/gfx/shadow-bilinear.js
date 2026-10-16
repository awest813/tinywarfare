// ============================================================================
// TINY WARFARE — src/gfx/shadow-bilinear.js
//
// A cheaper shadow filter for the Chromebook preset. three's PCF filters take
// 16-17 taps per lit pixel, and in this three each tap is a texture fetch
// plus an RGBA depth unpack; its unfiltered BasicShadowMap takes one, which
// stair-steps every shadow edge at a small map size. This swaps the basic
// path for a 2x2 bilinear compare: four taps, edges blended across a texel.
//
// It patches three's shared shadow chunk, so it must run before the first
// shader compiles. Only BasicShadowMap programs use that branch.
// ============================================================================

const HARD_TAP = 'shadow = texture2DCompare( shadowMap, shadowCoord.xy, shadowCoord.z );';

const BILINEAR = `vec2 owTexel = vec2( 1.0 ) / shadowMapSize;
			vec2 owSt = shadowCoord.xy * shadowMapSize - 0.5;
			vec2 owF = fract( owSt );
			vec2 owUv = ( floor( owSt ) + 0.5 ) * owTexel;
			shadow = mix(
				mix( texture2DCompare( shadowMap, owUv, shadowCoord.z ),
					texture2DCompare( shadowMap, owUv + vec2( owTexel.x, 0.0 ), shadowCoord.z ), owF.x ),
				mix( texture2DCompare( shadowMap, owUv + vec2( 0.0, owTexel.y ), shadowCoord.z ),
					texture2DCompare( shadowMap, owUv + owTexel, shadowCoord.z ), owF.x ),
				owF.y );`;

/** Returns true if the chunk was patched (or already was). */
export function installBilinearShadows(THREE) {
  const chunk = THREE.ShaderChunk.shadowmap_pars_fragment;
  if (chunk.includes('owTexel')) return true;
  if (chunk.split(HARD_TAP).length !== 2) return false;
  THREE.ShaderChunk.shadowmap_pars_fragment = chunk.replace(HARD_TAP, BILINEAR);
  return true;
}
