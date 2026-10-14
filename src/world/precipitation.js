// ============================================================================
// TINY WARFARE — precipitation.
//
// Snow on Frostline, a fine drizzle on Neon Foundry. One draw call each, and
// nothing moves on the CPU: every particle is a fixed random seed in a unit
// cube, and the vertex shader turns (seed, time, camera) into a position in a
// box that travels with the camera, wrapping on every axis. So the weather is
// always around the player, at a constant density, for the cost of one
// uniform upload a frame.
//
// SHELTER. Snow must not fall inside the Frostline service tunnel or under a
// roofed connector, and depth alone cannot stop that (a flake between the
// camera and a tunnel wall is in front of the wall). So the world's colliders
// are rasterised once per map into a coarse roof map — for each 1 m cell, the
// height of the highest solid with open sky over it — and a particle below
// its cell's roof is discarded. Out in the open the roof is 0 and nothing is
// lost; on a rooftop the snow still falls onto the roof.
// ============================================================================
import * as THREE from 'three';

/** Per-theme settings; a theme not listed here has no precipitation. */
export const PRECIPITATION = {
  arctic: {
    kind: 'snow', count: 3600, box: [44, 22, 44],
    fall: 1.1, drift: [0.45, 0.2], sway: 0.55, size: 0.07, alpha: 0.9, gain: 1.6,
  },
  neon: {
    kind: 'rain', count: 3200, box: [36, 20, 36],
    fall: 9.5, drift: [0.6, 0.25], sway: 0, size: 0.38, alpha: 0.32, gain: 2.4,
  },
};

const VERT = /* glsl */ `
uniform float uTime;
uniform vec3 uCam;
uniform vec3 uBox;
uniform vec3 uVel;
uniform float uSway;
uniform float uStreak;
uniform float uSize;
uniform float uScale;
uniform sampler2D uRoof;
uniform vec4 uRoofRect; // x0, z0, 1/width, 1/depth
attribute vec4 seed;    // xyz position in the unit cube, w phase
attribute float tail;   // rain: 0 head, 1 tail of the streak
varying float vAlpha;
void main() {
  vec3 p = seed.xyz * uBox + uVel * uTime;
  // gentle side-to-side for snow
  p.x += sin( uTime * 0.9 + seed.w * 6.28 ) * uSway;
  p.z += cos( uTime * 0.7 + seed.w * 4.1 ) * uSway;
  // wrap into a box centred on the camera
  vec3 origin = uCam - uBox * 0.5;
  p = origin + mod( p - origin, uBox );
  // rain: the tail trails the head along the velocity
  p -= uVel * ( tail * uStreak );

  // shelter: discard under a roof
  vec2 ruv = ( p.xz - uRoofRect.xy ) * uRoofRect.zw;
  float roof = 0.0;
  if ( ruv.x > 0.0 && ruv.x < 1.0 && ruv.y > 0.0 && ruv.y < 1.0 ) roof = texture2D( uRoof, ruv ).r;
  float sheltered = step( p.y, roof );

  vec4 mv = modelViewMatrix * vec4( p, 1.0 );
  float dist = -mv.z;
  // fade in past the near plane and out toward the box edge
  vec3 d = abs( p - uCam ) / ( uBox * 0.5 );
  float edge = 1.0 - smoothstep( 0.7, 1.0, max( d.x, max( d.y, d.z ) ) );
  vAlpha = edge * smoothstep( 0.6, 2.0, dist ) * ( 1.0 - sheltered );
  gl_Position = projectionMatrix * mv;
  gl_PointSize = uSize * uScale / max( dist, 0.5 );
}
`;

const FRAG_SNOW = /* glsl */ `
uniform vec3 uColor;
uniform float uAlpha;
varying float vAlpha;
void main() {
  if ( vAlpha <= 0.001 ) discard;
  vec2 c = gl_PointCoord - 0.5;
  float r = dot( c, c ) * 4.0;
  float a = ( 1.0 - smoothstep( 0.35, 1.0, r ) ) * vAlpha * uAlpha;
  if ( a <= 0.003 ) discard;
  gl_FragColor = vec4( uColor, a );
}
`;

const FRAG_RAIN = /* glsl */ `
uniform vec3 uColor;
uniform float uAlpha;
varying float vAlpha;
void main() {
  if ( vAlpha <= 0.001 ) discard;
  gl_FragColor = vec4( uColor, vAlpha * uAlpha );
}
`;

/**
 * Rasterise solids into a roof-height map: per cell, the top of the highest
 * collider over it whose underside is above head height or which is a full
 * building. Anything shorter than 2.2 m (crates, kerbs, sandbags) is not a
 * roof.
 */
export function buildRoofMap(colliders, rect, cell = 1) {
  const w = Math.max(1, Math.ceil((rect.x1 - rect.x0) / cell));
  const d = Math.max(1, Math.ceil((rect.z1 - rect.z0) / cell));
  const data = new Float32Array(w * d);
  for (const c of colliders) {
    const h = c.max.y - c.min.y;
    if (c.max.y < 2.2 || (h < 2.2 && c.min.y < 1.9)) continue;
    // the arena floor slab and anything spanning most of the map is not a roof
    if (c.max.x - c.min.x > (rect.x1 - rect.x0) * 0.9 && c.max.z - c.min.z > (rect.z1 - rect.z0) * 0.9) continue;
    const i0 = Math.max(0, Math.floor((c.min.x - rect.x0) / cell));
    const i1 = Math.min(w - 1, Math.floor((c.max.x - rect.x0) / cell));
    const k0 = Math.max(0, Math.floor((c.min.z - rect.z0) / cell));
    const k1 = Math.min(d - 1, Math.floor((c.max.z - rect.z0) / cell));
    for (let k = k0; k <= k1; k++) {
      for (let i = i0; i <= i1; i++) {
        const idx = k * w + i;
        if (c.max.y > data[idx]) data[idx] = c.max.y;
      }
    }
  }
  return { data, w, d };
}

export class Precipitation {
  /**
   * @param {object} opts { theme key, colliders, rect {x0,x1,z0,z1}, quality }
   */
  constructor({ themeKey, colliders, rect, quality = 'high', windAngle = 0.7 }) {
    const cfg = PRECIPITATION[themeKey];
    this.cfg = cfg || null;
    this.object = null;
    if (!cfg) return;

    const count = Math.round(cfg.count * (quality === 'low' ? 0.5 : 1));
    const rain = cfg.kind === 'rain';
    const verts = rain ? count * 2 : count;
    const seeds = new Float32Array(verts * 4);
    const tails = new Float32Array(verts);
    for (let i = 0; i < count; i++) {
      const s = [Math.random(), Math.random(), Math.random(), Math.random()];
      if (rain) {
        seeds.set(s, i * 8);
        seeds.set(s, i * 8 + 4);
        tails[i * 2 + 1] = 1;
      } else {
        seeds.set(s, i * 4);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('seed', new THREE.BufferAttribute(seeds, 4));
    geo.setAttribute('tail', new THREE.BufferAttribute(tails, 1));
    // position is required by three but unused: the shader builds it from seed
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(verts * 3), 3));
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);

    const roof = buildRoofMap(colliders, rect);
    this.roofTex = new THREE.DataTexture(roof.data, roof.w, roof.d, THREE.RedFormat, THREE.FloatType);
    this.roofTex.minFilter = this.roofTex.magFilter = THREE.NearestFilter;
    this.roofTex.needsUpdate = true;

    const ca = Math.cos(windAngle);
    const sa = Math.sin(windAngle);
    this.uniforms = {
      uTime: { value: 0 },
      uCam: { value: new THREE.Vector3() },
      uBox: { value: new THREE.Vector3(...cfg.box) },
      uVel: { value: new THREE.Vector3(ca * cfg.drift[0], -cfg.fall, sa * cfg.drift[0]) },
      uSway: { value: cfg.sway },
      uStreak: { value: rain ? 0.045 : 0 },
      uSize: { value: cfg.size },
      uScale: { value: 600 },
      uRoof: { value: this.roofTex },
      uRoofRect: { value: new THREE.Vector4(rect.x0, rect.z0, 1 / (rect.x1 - rect.x0), 1 / (rect.z1 - rect.z0)) },
      uColor: { value: new THREE.Color(1, 1, 1) },
      uAlpha: { value: cfg.alpha },
    };
    const material = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: VERT,
      fragmentShader: rain ? FRAG_RAIN : FRAG_SNOW,
      transparent: true,
      depthWrite: false,
      fog: false,
    });
    this.object = rain ? new THREE.LineSegments(geo, material) : new THREE.Points(geo, material);
    this.object.frustumCulled = false;
    this.object.renderOrder = 2;
    this.object.name = `precipitation:${cfg.kind}`;
  }

  /**
   * @param {number} dt
   * @param {THREE.Camera} camera
   * @param {THREE.Color} light  linear radiance the particles should take
   * @param {number} viewportHeight  drawing-buffer pixels, for point sizing
   */
  update(dt, camera, light, viewportHeight = 720) {
    if (!this.object) return;
    const u = this.uniforms;
    u.uTime.value = (u.uTime.value + dt) % 3600;
    camera.getWorldPosition(u.uCam.value);
    if (light) u.uColor.value.copy(light).multiplyScalar(this.cfg.gain);
    // pixels per metre at 1 m: half the viewport over tan(fov/2)
    const fov = (camera.fov || 70) * Math.PI / 180;
    u.uScale.value = (viewportHeight * 0.5) / Math.tan(fov / 2);
  }

  dispose() {
    if (!this.object) return;
    this.object.parent?.remove(this.object);
    this.object.geometry.dispose();
    this.object.material.dispose();
    this.roofTex.dispose();
    this.object = null;
  }
}
