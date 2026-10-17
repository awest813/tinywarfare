/**
 * Compile every shader the scene can show before it is needed.
 *
 * three.js compiles a material's program the first frame it is drawn, and
 * on a low-end GPU that is a 50-300 ms freeze per program. Measured on the
 * Chromebook preset, the first live frame of a match compiled 15 programs at
 * once (the held gun, the arms, the optic lenses: all hidden in the menu), and
 * the first tracer and the first explosion each froze a frame mid-fight.
 *
 * `renderer.compile` only walks VISIBLE objects, and everything that appears
 * later (the viewmodel rig, pooled effects, a hidden soldier) is hidden until
 * then. So every hidden object is shown for the synchronous part of the
 * compile and hidden again straight after; with KHR_parallel_shader_compile
 * the driver finishes the work off the main thread.
 *
 * Programs depend on the scene's light count, which differs per map, so this
 * runs again after a map change, not only at boot.
 *
 * `compile` does not reach the shadow pass, whose depth programs vary with
 * each caster (skinned, alpha-tested): those two still compiled on the first
 * live frame. With shadows on, the shadow pass alone is run once for every
 * caster shown (no main pass: drawing a frame off-screen compiled a second,
 * off-screen copy of every material, ~30 programs nobody uses).
 *
 * A program also keys on the render target it draws into (tone mapping and
 * output colour space differ off-screen), so pass every target the frame
 * draws the scene into: the post chain's scene buffer as well as the screen.
 *
 * @param {Array<THREE.WebGLRenderTarget|null>} [targets] default: the screen
 * @returns {number} how many hidden objects were included
 */
export function prewarmShaders(renderer, scene, camera, targets = [null]) {
  if (!renderer || !scene || !camera || typeof renderer.compile !== 'function') return 0;
  const shown = [];
  scene.traverse((object) => {
    // Never a light: the light count is part of every program's key, and
    // showing the pooled / disabled point lights compiled each material for
    // a lighting setup play never uses (10 point lights instead of 0).
    if (object.visible === false && !object.isLight) {
      object.visible = true;
      shown.push(object);
    }
  });
  const previous = typeof renderer.getRenderTarget === 'function' ? renderer.getRenderTarget() : null;
  try {
    for (const target of targets) {
      if (typeof renderer.setRenderTarget === 'function') renderer.setRenderTarget(target);
      if (typeof renderer.compileAsync === 'function') {
        // The programs are created synchronously inside; the promise only
        // waits for the driver, so visibility can be restored right away.
        renderer.compileAsync(scene, camera).catch(() => {});
      } else {
        renderer.compile(scene, camera);
      }
    }
    const shadowMap = renderer.shadowMap;
    if (shadowMap?.enabled && typeof shadowMap.render === 'function') {
      const casters = [];
      scene.traverse((object) => {
        if (object.isLight && object.castShadow && object.visible && object.shadow) casters.push(object);
      });
      if (casters.length) {
        // Parked objects (the viewmodel, soldiers waiting to spawn) sit outside
        // the sun's shadow frustum now and would be culled before compiling.
        const culled = [];
        scene.traverse((object) => {
          if (object.frustumCulled && (object.isMesh || object.isPoints || object.isLine)) {
            object.frustumCulled = false;
            culled.push(object);
          }
        });
        try {
          shadowMap.needsUpdate = true;
          shadowMap.render(casters, scene, camera);
        } finally {
          for (const object of culled) object.frustumCulled = true;
          shadowMap.needsUpdate = true; // the next real frame redraws it properly
        }
      }
    }
  } finally {
    if (typeof renderer.setRenderTarget === 'function') renderer.setRenderTarget(previous);
    for (const object of shown) object.visible = false;
  }
  return shown.length;
}
