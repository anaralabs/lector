// Minimal WebGL2 compositor: textured quads (tiles) and solid quads (page
// backgrounds, selection, highlights), all in device pixels.

type Canvas = HTMLCanvasElement | OffscreenCanvas;

const QUAD_VS = `#version 300 es
in vec2 a_pos;
uniform vec2 u_view;
uniform vec4 u_rect;
uniform vec4 u_uv;
out vec2 v_uv;
void main() {
  vec2 p = u_rect.xy + a_pos * u_rect.zw;
  v_uv = mix(u_uv.xy, u_uv.zw, a_pos);
  gl_Position = vec4(p / u_view * vec2(2.0, -2.0) + vec2(-1.0, 1.0), 0.0, 1.0);
}`;

const TEX_FS = `#version 300 es
precision mediump float;
in vec2 v_uv;
uniform sampler2D u_tex;
uniform float u_gamma;
uniform float u_dark;
uniform vec3 u_paper;
uniform vec3 u_ink;
out vec4 o;
void main() {
  vec3 c = pow(texture(u_tex, v_uv).rgb, vec3(u_gamma));
  if (u_dark > 0.5) {
    // Invert lightness but keep hue: white paper -> u_paper, black ink -> u_ink.
    float l = dot(c, vec3(0.299, 0.587, 0.114));
    vec3 chroma = c - l;
    float t = 1.0 - l;
    c = mix(u_paper, u_ink, t) + chroma * 0.8;
  }
  o = vec4(c, 1.0);
}`;

const SOLID_FS = `#version 300 es
precision mediump float;
in vec2 v_uv;
uniform vec4 u_color;
uniform float u_round;
out vec4 o;
void main() {
  o = u_color;
  if (u_round > 0.0) {
    // Disc with a one-pixel soft edge; u_round is the radius in pixels.
    float d = length(v_uv * 2.0 - 1.0) * u_round;
    o.a *= clamp(u_round - d + 0.5, 0.0, 1.0);
  }
}`;

export type Blend = "none" | "alpha" | "multiply";

export class Compositor {
	readonly gl: WebGL2RenderingContext;
	private tex: {
		prog: WebGLProgram;
		rect: WebGLUniformLocation;
		uv: WebGLUniformLocation;
		view: WebGLUniformLocation;
		gamma: WebGLUniformLocation;
		dark: WebGLUniformLocation;
		paper: WebGLUniformLocation;
		ink: WebGLUniformLocation;
	};
	private tone: { paper: [number, number, number]; ink: [number, number, number] } | null = null;
	private solid: { prog: WebGLProgram; rect: WebGLUniformLocation; uv: WebGLUniformLocation; view: WebGLUniformLocation; color: WebGLUniformLocation; round: WebGLUniformLocation };
	private vao: WebGLVertexArrayObject;
	private w = 1;
	private h = 1;
	textureBytes = 0;

	constructor(readonly canvas: Canvas) {
		const gl = canvas.getContext("webgl2", {
			alpha: false,
			antialias: false,
			depth: false,
			stencil: false,
			premultipliedAlpha: false,
			preserveDrawingBuffer: false,
			powerPreference: "high-performance",
			desynchronized: true,
		}) as WebGL2RenderingContext | null;
		if (!gl) throw new Error("WebGL2 is not available");
		this.gl = gl;
		const texProg = this.program(QUAD_VS, TEX_FS);
		const solidProg = this.program(QUAD_VS, SOLID_FS);
		const u = (p: WebGLProgram, n: string) => gl.getUniformLocation(p, n)!;
		this.tex = { prog: texProg, rect: u(texProg, "u_rect"), uv: u(texProg, "u_uv"), view: u(texProg, "u_view"), gamma: u(texProg, "u_gamma"), dark: u(texProg, "u_dark"), paper: u(texProg, "u_paper"), ink: u(texProg, "u_ink") };
		this.solid = { prog: solidProg, rect: u(solidProg, "u_rect"), uv: u(solidProg, "u_uv"), view: u(solidProg, "u_view"), color: u(solidProg, "u_color"), round: u(solidProg, "u_round") };

		this.vao = gl.createVertexArray()!;
		gl.bindVertexArray(this.vao);
		const vbo = gl.createBuffer();
		gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
		gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW);
		for (const prog of [texProg, solidProg]) {
			const loc = gl.getAttribLocation(prog, "a_pos");
			gl.enableVertexAttribArray(loc);
			gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
		}
	}

	private program(vs: string, fs: string) {
		const gl = this.gl;
		const compile = (type: number, src: string) => {
			const s = gl.createShader(type)!;
			gl.shaderSource(s, src);
			gl.compileShader(s);
			if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) ?? "shader");
			return s;
		};
		const p = gl.createProgram()!;
		gl.attachShader(p, compile(gl.VERTEX_SHADER, vs));
		gl.attachShader(p, compile(gl.FRAGMENT_SHADER, fs));
		gl.bindAttribLocation(p, 0, "a_pos");
		gl.linkProgram(p);
		if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p) ?? "link");
		return p;
	}

	resize(w: number, h: number) {
		if (this.canvas.width !== w) this.canvas.width = w;
		if (this.canvas.height !== h) this.canvas.height = h;
		this.w = w;
		this.h = h;
	}

	upload(pixels: Uint8Array, w: number, h: number): WebGLTexture {
		const gl = this.gl;
		const tex = gl.createTexture()!;
		gl.bindTexture(gl.TEXTURE_2D, tex);
		gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, w, h);
		gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
		this.textureBytes += w * h * 4;
		return tex;
	}

	free(tex: WebGLTexture, w: number, h: number) {
		this.gl.deleteTexture(tex);
		this.textureBytes -= w * h * 4;
	}

	begin(clear: [number, number, number]) {
		const gl = this.gl;
		gl.viewport(0, 0, this.w, this.h);
		gl.clearColor(clear[0], clear[1], clear[2], 1);
		gl.clear(gl.COLOR_BUFFER_BIT);
		gl.bindVertexArray(this.vao);
	}

	private blend(mode: Blend) {
		const gl = this.gl;
		if (mode === "none") {
			gl.disable(gl.BLEND);
			return;
		}
		gl.enable(gl.BLEND);
		if (mode === "alpha") gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
		else gl.blendFunc(gl.DST_COLOR, gl.ZERO);
	}

	private mode: "tex" | "solid" | null = null;
	private use(mode: "tex" | "solid") {
		if (this.mode === mode) return;
		const gl = this.gl;
		const p = mode === "tex" ? this.tex : this.solid;
		gl.useProgram(p.prog);
		gl.uniform2f(p.view, this.w, this.h);
		gl.uniform4f(p.uv, 0, 0, 1, 1);
		if (mode === "tex") {
			const t = this.tone;
			gl.uniform1f(this.tex.dark, t ? 1 : 0);
			if (t) {
				gl.uniform3f(this.tex.paper, t.paper[0], t.paper[1], t.paper[2]);
				gl.uniform3f(this.tex.ink, t.ink[0], t.ink[1], t.ink[2]);
			}
		}
		this.mode = mode;
	}

	/** Dark-mode tone mapping for page tiles; null for the original colours. */
	setTone(tone: { paper: [number, number, number]; ink: [number, number, number] } | null) {
		this.tone = tone;
		this.mode = null;
	}

	/** Must be called once per frame before drawing (program state is cached). */
	resetState() {
		this.mode = null;
	}

	drawTexture(tex: WebGLTexture, x: number, y: number, w: number, h: number, gamma: number) {
		const gl = this.gl;
		this.use("tex");
		this.blend("none");
		gl.uniform1f(this.tex.gamma, gamma);
		gl.uniform4f(this.tex.rect, x, y, w, h);
		gl.bindTexture(gl.TEXTURE_2D, tex);
		gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
	}

	drawRect(x: number, y: number, w: number, h: number, color: [number, number, number, number], blend: Blend = "none") {
		const gl = this.gl;
		this.use("solid");
		this.blend(blend);
		gl.uniform4f(this.solid.color, color[0], color[1], color[2], color[3]);
		gl.uniform1f(this.solid.round, 0);
		gl.uniform4f(this.solid.rect, x, y, w, h);
		gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
	}

	/** Anti-aliased filled circle, alpha-blended. */
	drawCircle(cx: number, cy: number, r: number, color: [number, number, number, number]) {
		const gl = this.gl;
		this.use("solid");
		this.blend("alpha");
		gl.uniform4f(this.solid.color, color[0], color[1], color[2], color[3]);
		gl.uniform1f(this.solid.round, r);
		gl.uniform4f(this.solid.uv, 0, 0, 1, 1);
		gl.uniform4f(this.solid.rect, cx - r, cy - r, r * 2, r * 2);
		gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
	}
}
