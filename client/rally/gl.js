/**
 * Rally's renderer: a small WebGL one, rather than a library, as everything
 * here is flat-coloured triangles lit by one sun and fogged into the sky.
 * Meshes are built once (Geo) and uploaded; a frame draws each with its own
 * placement and a tint, which is how the ghost car is drawn see-through.
 *
 * Matrices are column-major Float32Arrays, as WebGL takes them.
 */

const VERT = `
attribute vec3 aPos;
attribute vec3 aNrm;
attribute vec3 aCol;
uniform mat4 uVP;
uniform mat4 uM;
varying vec3 vCol;
varying vec3 vNrm;
varying vec3 vPos;
void main() {
  vec4 w = uM * vec4(aPos, 1.0);
  vPos = w.xyz;
  vNrm = mat3(uM) * aNrm;
  vCol = aCol;
  gl_Position = uVP * w;
}`;

const FRAG = `
precision mediump float;
varying vec3 vCol;
varying vec3 vNrm;
varying vec3 vPos;
uniform vec4 uTint;
uniform vec3 uSun;
uniform vec3 uCam;
uniform vec3 uFog;
uniform vec2 uFogD;
uniform float uGlow;
uniform vec4 uFlat;
void main() {
  // Lit from whichever side faces the eye, so a face wound either way reads right.
  vec3 n = normalize(vNrm) * (gl_FrontFacing ? 1.0 : -1.0);
  float sun = max(dot(n, uSun), 0.0);
  float sky = 0.5 + 0.5 * n.y;
  vec3 c = mix(vCol, uFlat.rgb, uFlat.a) * uTint.rgb * (0.34 + 0.22 * sky + 0.62 * sun + uGlow);
  float d = distance(vPos, uCam);
  float f = clamp((d - uFogD.x) / (uFogD.y - uFogD.x), 0.0, 1.0);
  gl_FragColor = vec4(mix(c, uFog, f * f), uTint.a);
}`;

/** No flat colour: every mesh in its own. */
const NONE = [0, 0, 0, 0];

/** @param {WebGLRenderingContext} gl @param {number} type @param {string} src */
function shader(gl, type, src) {
  const s = /** @type {WebGLShader} */ (gl.createShader(type));
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) || "shader");
  return s;
}

/**
 * The renderer over a canvas, or null where WebGL is not to be had. With
 * `clear`, it draws over nothing (the store's cars, on their tiles) and
 * keeps the frame for copying.
 * @param {HTMLCanvasElement} canvas @param {boolean} [clear]
 */
export function renderer(canvas, clear = false) {
  const gl = /** @type {WebGLRenderingContext | null} */ (
    canvas.getContext("webgl", { antialias: true, alpha: clear, premultipliedAlpha: false, preserveDrawingBuffer: clear, powerPreference: clear ? "low-power" : "high-performance" })
  );
  if (!gl) return null;
  const prog = /** @type {WebGLProgram} */ (gl.createProgram());
  gl.attachShader(prog, shader(gl, gl.VERTEX_SHADER, VERT));
  gl.attachShader(prog, shader(gl, gl.FRAGMENT_SHADER, FRAG));
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog) || "link");
  gl.useProgram(prog);
  const loc = {
    pos: gl.getAttribLocation(prog, "aPos"),
    nrm: gl.getAttribLocation(prog, "aNrm"),
    col: gl.getAttribLocation(prog, "aCol"),
    vp: gl.getUniformLocation(prog, "uVP"),
    m: gl.getUniformLocation(prog, "uM"),
    tint: gl.getUniformLocation(prog, "uTint"),
    sun: gl.getUniformLocation(prog, "uSun"),
    cam: gl.getUniformLocation(prog, "uCam"),
    fog: gl.getUniformLocation(prog, "uFog"),
    fogD: gl.getUniformLocation(prog, "uFogD"),
    glow: gl.getUniformLocation(prog, "uGlow"),
    flat: gl.getUniformLocation(prog, "uFlat"),
  };
  gl.enableVertexAttribArray(loc.pos);
  gl.enableVertexAttribArray(loc.nrm);
  gl.enableVertexAttribArray(loc.col);
  gl.enable(gl.DEPTH_TEST);
  gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

  /** @typedef {{buf: WebGLBuffer, count: number}} Mesh */

  return {
    gl,
    /**
     * Upload a mesh: interleaved position, normal and colour.
     * @param {Geo} geo
     * @returns {Mesh}
     */
    mesh(geo) {
      const buf = /** @type {WebGLBuffer} */ (gl.createBuffer());
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(geo.v), gl.STATIC_DRAW);
      return { buf, count: geo.v.length / 9 };
    },
    /**
     * Start a frame: the viewport, the sky, the camera.
     * @param {number} w @param {number} h @param {Float32Array} vp
     * @param {number[]} cam @param {number[]} fog @param {number} far
     */
    begin(w, h, vp, cam, fog, far) {
      gl.viewport(0, 0, w, h);
      gl.clearColor(fog[0], fog[1], fog[2], clear ? 0 : 1);
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
      gl.uniformMatrix4fv(loc.vp, false, vp);
      gl.uniform3fv(loc.cam, cam);
      gl.uniform3fv(loc.fog, fog);
      gl.uniform2f(loc.fogD, far * 0.35, far);
      const s = [0.45, 0.8, -0.35];
      const l = Math.hypot(s[0], s[1], s[2]);
      gl.uniform3f(loc.sun, s[0] / l, s[1] / l, s[2] / l);
    },
    /**
     * Draw a mesh where `model` puts it, tinted; see-through when the tint's
     * alpha is under 1. `flat` paints it all one colour, by its fourth number.
     * @param {Mesh} mesh @param {Float32Array} model @param {number[]} [tint] @param {number} [glow] @param {number[]} [flat]
     */
    draw(mesh, model, tint = [1, 1, 1, 1], glow = 0, flat = NONE) {
      const see = tint[3] < 1;
      if (see) {
        gl.enable(gl.BLEND);
        gl.depthMask(false);
      }
      gl.bindBuffer(gl.ARRAY_BUFFER, mesh.buf);
      gl.vertexAttribPointer(loc.pos, 3, gl.FLOAT, false, 36, 0);
      gl.vertexAttribPointer(loc.nrm, 3, gl.FLOAT, false, 36, 12);
      gl.vertexAttribPointer(loc.col, 3, gl.FLOAT, false, 36, 24);
      gl.uniformMatrix4fv(loc.m, false, model);
      gl.uniform4fv(loc.tint, tint);
      gl.uniform1f(loc.glow, glow);
      gl.uniform4fv(loc.flat, flat);
      gl.drawArrays(gl.TRIANGLES, 0, mesh.count);
      if (see) {
        gl.disable(gl.BLEND);
        gl.depthMask(true);
      }
    },
  };
}

/* ---------- Geometry ---------- */

/** "#rrggbb" as 0…1 channels. @param {string} hex @returns {number[]} */
export function rgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

/** @param {number[]} a @param {number[]} b */
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
/** @param {number[]} a @param {number[]} b */
export const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
/** @param {number[]} a */
export const norm = (a) => {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};

/** Triangles being gathered into one mesh: nine numbers a corner. */
export class Geo {
  constructor() {
    /** @type {number[]} */
    this.v = [];
  }

  /**
   * A triangle, counter-clockwise from its front; flat-lit unless normals are given.
   * @param {number[]} a @param {number[]} b @param {number[]} c @param {number[]} col
   * @param {number[][]} [ns]
   */
  tri(a, b, c, col, ns) {
    const face = cross(sub(b, a), sub(c, a));
    const n = ns ? null : norm(face);
    // Wound to face along its given normals, so the shader's front face is theirs.
    const flip = ns && face[0] * ns[0][0] + face[1] * ns[0][1] + face[2] * ns[0][2] < 0;
    const pts = flip ? [a, c, b] : [a, b, c];
    if (flip && ns) ns = [ns[0], ns[2], ns[1]];
    for (let i = 0; i < 3; i++) {
      const q = ns ? ns[i] : /** @type {number[]} */ (n);
      this.v.push(pts[i][0], pts[i][1], pts[i][2], q[0], q[1], q[2], col[0], col[1], col[2]);
    }
  }

  /** A quad a→b→c→d, counter-clockwise from its front. @param {number[]} a @param {number[]} b @param {number[]} c @param {number[]} d @param {number[]} col @param {number[][]} [ns] */
  quad(a, b, c, d, col, ns) {
    this.tri(a, b, c, col, ns && [ns[0], ns[1], ns[2]]);
    this.tri(a, c, d, col, ns && [ns[0], ns[2], ns[3]]);
  }

  /**
   * A box from its eight corners' spans: x across, y up, z ahead, centred on
   * (cx, cy, cz). `top` narrows the upper face (a cabin), `nose` lowers the front of the top (a bonnet).
   * @param {number} cx @param {number} cy @param {number} cz
   * @param {number} w @param {number} h @param {number} l @param {number[]} col
   * @param {{top?: number, topZ?: number[], nose?: number}} [o]
   */
  box(cx, cy, cz, w, h, l, col, o = {}) {
    const x0 = cx - w / 2;
    const x1 = cx + w / 2;
    const y0 = cy - h / 2;
    const y1 = cy + h / 2;
    const z0 = cz - l / 2;
    const z1 = cz + l / 2;
    const tw = (o.top ?? 1) * (w / 2);
    const [tz0, tz1] = o.topZ ?? [z0, z1];
    const ny = y1 - (o.nose ?? 0);
    // Bottom corners, then top: back-left, back-right, front-right, front-left (left is +x).
    const b = [[x1, y0, z0], [x0, y0, z0], [x0, y0, z1], [x1, y0, z1]];
    const t = [[cx + tw, y1, tz0], [cx - tw, y1, tz0], [cx - tw, ny, tz1], [cx + tw, ny, tz1]];
    this.quad(t[0], t[3], t[2], t[1], col); // top
    this.quad(b[0], b[1], b[2], b[3], col); // bottom
    this.quad(b[1], b[0], t[0], t[1], col); // back
    this.quad(b[3], b[2], t[2], t[3], col); // front
    this.quad(b[2], b[1], t[1], t[2], col); // right (-x)
    this.quad(b[0], b[3], t[3], t[0], col); // left (+x)
  }

  /**
   * A prism around the x axis (a wheel) or the y axis (a coin standing, a can):
   * `sides` faces, radius `r`, `len` long, centred on (cx, cy, cz).
   * @param {"x" | "y" | "z"} axis @param {number} cx @param {number} cy @param {number} cz
   * @param {number} r @param {number} len @param {number} sides @param {number[]} col @param {number[]} [cap]
   */
  prism(axis, cx, cy, cz, r, len, sides, col, cap = col) {
    /** @param {number} a @param {number} along */
    const at = (a, along) => {
      const u = Math.cos(a) * r;
      const w = Math.sin(a) * r;
      if (axis === "x") return [cx + along, cy + u, cz + w];
      if (axis === "y") return [cx + u, cy + along, cz + w];
      return [cx + u, cy + w, cz + along];
    };
    const h = len / 2;
    const mid = axis === "x" ? [[cx - h, cy, cz], [cx + h, cy, cz]] : axis === "y" ? [[cx, cy - h, cz], [cx, cy + h, cz]] : [[cx, cy, cz - h], [cx, cy, cz + h]];
    for (let i = 0; i < sides; i++) {
      const a0 = (i / sides) * Math.PI * 2;
      const a1 = ((i + 1) / sides) * Math.PI * 2;
      const p0 = at(a0, -h);
      const p1 = at(a1, -h);
      const q0 = at(a0, h);
      const q1 = at(a1, h);
      // Wound for the outside, whichever way the axis runs.
      if (axis === "y") {
        this.quad(p1, p0, q0, q1, col);
        this.tri(mid[1], q1, q0, cap);
        this.tri(mid[0], p0, p1, cap);
      } else {
        this.quad(p0, p1, q1, q0, col);
        this.tri(mid[1], q0, q1, cap);
        this.tri(mid[0], p1, p0, cap);
      }
    }
  }
}

/* ---------- Matrices ---------- */

/** @param {number} fovy @param {number} aspect @param {number} near @param {number} far */
export function perspective(fovy, aspect, near, far) {
  const f = 1 / Math.tan(fovy / 2);
  const m = new Float32Array(16);
  m[0] = f / aspect;
  m[5] = f;
  m[10] = (far + near) / (near - far);
  m[11] = -1;
  m[14] = (2 * far * near) / (near - far);
  return m;
}

/** @param {number[]} eye @param {number[]} at @param {number[]} up */
export function lookAt(eye, at, up) {
  const z = norm(sub(eye, at));
  const x = norm(cross(up, z));
  const y = cross(z, x);
  const m = new Float32Array(16);
  m[0] = x[0];
  m[4] = x[1];
  m[8] = x[2];
  m[1] = y[0];
  m[5] = y[1];
  m[9] = y[2];
  m[2] = z[0];
  m[6] = z[1];
  m[10] = z[2];
  m[12] = -(x[0] * eye[0] + x[1] * eye[1] + x[2] * eye[2]);
  m[13] = -(y[0] * eye[0] + y[1] * eye[1] + y[2] * eye[2]);
  m[14] = -(z[0] * eye[0] + z[1] * eye[1] + z[2] * eye[2]);
  m[15] = 1;
  return m;
}

/** a × b. @param {Float32Array} a @param {Float32Array} b */
export function mul(a, b) {
  const m = new Float32Array(16);
  for (let c = 0; c < 4; c++)
    for (let r = 0; r < 4; r++) {
      let s = 0;
      for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k];
      m[c * 4 + r] = s;
    }
  return m;
}

/**
 * A placement from a frame: the mesh's +x to `left`, +y to `up`, +z to `fwd`,
 * its origin to `pos`. Written into `out` when given, so a frame's many draws
 * need no new arrays.
 * @param {number[]} left @param {number[]} up @param {number[]} fwd @param {number[]} pos @param {number} [scale] @param {Float32Array} [out]
 */
export function place(left, up, fwd, pos, scale = 1, out = new Float32Array(16)) {
  const m = out;
  m.set([left[0] * scale, left[1] * scale, left[2] * scale, 0, up[0] * scale, up[1] * scale, up[2] * scale, 0, fwd[0] * scale, fwd[1] * scale, fwd[2] * scale, 0, pos[0], pos[1], pos[2], 1]);
  return m;
}

export const IDENTITY = place([1, 0, 0], [0, 1, 0], [0, 0, 1], [0, 0, 0]);
