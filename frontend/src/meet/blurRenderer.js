/**
 * Composição do desfoque na GPU (WebGL2), a partir do quadro da câmara e de uma máscara de
 * pessoa em baixa resolução vinda do modelo:
 *
 *  1. Refinamento da máscara (joint bilateral upsampling): cada pixel da máscara ampliada pesa
 *     os vizinhos pela SEMELHANÇA DE COR na imagem real — o recorte passa a seguir as arestas do
 *     cabelo/ombros/auscultadores em vez de ser uma "bolha" ampliada.
 *  2. Fundo SEM a pessoa: a pessoa é apagada antes de desfocar (alfa pré-multiplicado) e o
 *     resultado é normalizado pelo alfa desfocado. Assim a silhueta não "vaza" borrada à volta da
 *     cabeça (o halo escuro/claro dos desfoques baratos).
 *  3. Desfoque gaussiano separável em 1/4 da resolução (forte e barato), várias passagens.
 *  4. Composição final com transição curta (smoothstep) na borda refinada.
 *
 * @returns {null | { canvas: HTMLCanvasElement, render(video, mask, maskW, maskH): void, destroy(): void }}
 *          null se não houver WebGL2 (fica a versão em canvas 2D).
 */
export function createGlBlurRenderer(width, height) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const gl = canvas.getContext('webgl2', { premultipliedAlpha: false, antialias: false, depth: false, stencil: false, preserveDrawingBuffer: false });
  if (!gl) return null;
  const floatTargets = Boolean(gl.getExtension('EXT_color_buffer_float'));

  const VS = `#version 300 es
in vec2 aPos; out vec2 vUv;
void main() { vUv = aPos * 0.5 + 0.5; gl_Position = vec4(aPos, 0.0, 1.0); }`;

  const REFINE = `#version 300 es
precision highp float;
in vec2 vUv; out vec4 o;
uniform sampler2D uMask; uniform sampler2D uFrame; uniform vec2 uMaskTexel; uniform float uSigma;
void main() {
  vec3 c0 = texture(uFrame, vUv).rgb;
  float sum = 0.0, wsum = 0.0;
  for (int y = -3; y <= 3; y++) {
    for (int x = -3; x <= 3; x++) {
      vec2 uv = vUv + vec2(float(x), float(y)) * uMaskTexel * 0.75;
      vec3 d = texture(uFrame, uv).rgb - c0;
      float w = exp(-dot(d, d) / (2.0 * uSigma * uSigma)) * exp(-float(x * x + y * y) / 10.0);
      sum += texture(uMask, uv).r * w;
      wsum += w;
    }
  }
  o = vec4(sum / max(wsum, 1e-4), 0.0, 0.0, 1.0);
}`;

  const PREP = `#version 300 es
precision highp float;
in vec2 vUv; out vec4 o;
uniform sampler2D uFrame; uniform sampler2D uMask;
void main() {
  float a = 1.0 - smoothstep(0.15, 0.6, texture(uMask, vUv).r); // fundo (a pessoa é apagada com folga)
  o = vec4(texture(uFrame, vUv).rgb * a, a);
}`;

  const BLUR = `#version 300 es
precision highp float;
in vec2 vUv; out vec4 o;
uniform sampler2D uTex; uniform vec2 uDir;
void main() {
  vec4 s = texture(uTex, vUv) * 0.2270270;
  s += (texture(uTex, vUv + uDir * 1.3846154) + texture(uTex, vUv - uDir * 1.3846154)) * 0.3162162;
  s += (texture(uTex, vUv + uDir * 3.2307692) + texture(uTex, vUv - uDir * 3.2307692)) * 0.0702703;
  o = s;
}`;

  const COMPOSE = `#version 300 es
precision highp float;
in vec2 vUv; out vec4 o;
uniform sampler2D uFrame; uniform sampler2D uMask; uniform sampler2D uBg; uniform sampler2D uBgWide;
void main() {
  vec3 fg = texture(uFrame, vUv).rgb;
  vec4 b = texture(uBg, vUv);
  vec4 w = texture(uBgWide, vUv); // mais largo: preenche onde o fundo estava todo tapado pela pessoa
  vec3 bg = b.a > 0.04 ? b.rgb / b.a : (w.a > 0.002 ? w.rgb / w.a : fg);
  float m = smoothstep(0.4, 0.62, texture(uMask, vUv).r);
  o = vec4(mix(bg, fg, m), 1.0);
}`;

  const compile = (type, src) => {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
    return s;
  };
  const vs = compile(gl.VERTEX_SHADER, VS);
  const program = (fs) => {
    const p = gl.createProgram();
    gl.attachShader(p, vs);
    gl.attachShader(p, compile(gl.FRAGMENT_SHADER, fs));
    gl.bindAttribLocation(p, 0, 'aPos');
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
    const loc = (n) => gl.getUniformLocation(p, n);
    return { p, loc };
  };
  const pRefine = program(REFINE);
  const pPrep = program(PREP);
  const pBlur = program(BLUR);
  const pCompose = program(COMPOSE);

  // Triângulo que cobre o ecrã todo.
  const vao = gl.createVertexArray();
  gl.bindVertexArray(vao);
  const vbo = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

  const texture = (w, h, internal, format, type) => {
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    if (w && h) gl.texImage2D(gl.TEXTURE_2D, 0, internal, w, h, 0, format, type, null);
    return t;
  };
  const target = (w, h, kind) => {
    const [internal, format, type] =
      kind === 'mask' ? [gl.R8, gl.RED, gl.UNSIGNED_BYTE] : floatTargets ? [gl.RGBA16F, gl.RGBA, gl.HALF_FLOAT] : [gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE];
    const tex = texture(w, h, internal, format, type);
    const fb = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    return { tex, fb, w, h };
  };

  const texFrame = texture();
  const texMask = texture();
  const half = [Math.round(width / 2), Math.round(height / 2)];
  const quarter = [Math.round(width / 4), Math.round(height / 4)];
  const eighth = [Math.round(width / 8), Math.round(height / 8)];
  const refined = target(...half, 'mask');
  const bgA = target(...quarter, 'color');
  const bgB = target(...quarter, 'color');
  const wideA = target(...eighth, 'color');
  const wideB = target(...eighth, 'color');
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true); // quadros e máscara com a mesma orientação (y para cima)
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);

  const bind = (unit, tex, prog, name) => {
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.uniform1i(prog.loc(name), unit);
  };
  const pass = (prog, out) => {
    gl.useProgram(prog.p);
    gl.bindFramebuffer(gl.FRAMEBUFFER, out ? out.fb : null);
    gl.viewport(0, 0, out ? out.w : width, out ? out.h : height);
  };
  const draw = () => gl.drawArrays(gl.TRIANGLES, 0, 3);

  /** Desfoque separável com `iterations` passagens H+V (a distância cresce a cada uma). */
  const blur = (src, ping, iterations, spread) => {
    let input = src;
    for (let i = 0; i < iterations; i += 1) {
      const step = spread * (i + 1);
      pass(pBlur, ping);
      bind(0, input.tex, pBlur, 'uTex');
      gl.uniform2f(pBlur.loc('uDir'), step / input.w, 0);
      draw();
      pass(pBlur, src);
      bind(0, ping.tex, pBlur, 'uTex');
      gl.uniform2f(pBlur.loc('uDir'), 0, step / input.h);
      draw();
      input = src;
    }
  };

  return {
    canvas,
    /**
     * @param {HTMLVideoElement} video quadro atual da câmara
     * @param {Uint8Array} mask probabilidade de pessoa (0–255), maskW×maskH, linha 0 = topo
     */
    render(video, mask, maskW, maskH) {
      gl.bindTexture(gl.TEXTURE_2D, texFrame);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, video);
      gl.bindTexture(gl.TEXTURE_2D, texMask);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, maskW, maskH, 0, gl.RED, gl.UNSIGNED_BYTE, mask);

      // 1. máscara refinada pelas arestas da imagem
      pass(pRefine, refined);
      bind(0, texMask, pRefine, 'uMask');
      bind(1, texFrame, pRefine, 'uFrame');
      gl.uniform2f(pRefine.loc('uMaskTexel'), 1 / maskW, 1 / maskH);
      gl.uniform1f(pRefine.loc('uSigma'), 0.12);
      draw();

      // 2. fundo sem a pessoa (pré-multiplicado), em 1/4 e em 1/8 da resolução
      pass(pPrep, bgA);
      bind(0, texFrame, pPrep, 'uFrame');
      bind(1, refined.tex, pPrep, 'uMask');
      draw();
      pass(pPrep, wideA);
      draw();

      // 3. desfoques
      blur(bgA, bgB, 3, 1.4);
      blur(wideA, wideB, 3, 2.2);

      // 4. composição final no canvas
      pass(pCompose, null);
      bind(0, texFrame, pCompose, 'uFrame');
      bind(1, refined.tex, pCompose, 'uMask');
      bind(2, bgA.tex, pCompose, 'uBg');
      bind(3, wideA.tex, pCompose, 'uBgWide');
      draw();
    },
    destroy() {
      gl.getExtension('WEBGL_lose_context')?.loseContext();
    },
  };
}
