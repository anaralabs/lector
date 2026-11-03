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

// Directional blur of the composited frame: content at screen p moved by
// u_pan + p * u_zoom (device px) during the shutter. 2-10 taps (one per ~3 px), flights only.
const BLUR_FS = `#version 300 es
precision mediump float;
in vec2 v_uv;
uniform sampler2D u_tex;
uniform vec2 u_size;
uniform vec2 u_pan;
uniform float u_zoom;
uniform float u_max;
out vec4 o;
void main() {
  vec2 p = vec2(v_uv.x, 1.0 - v_uv.y) * u_size;
  vec2 m = u_pan + p * u_zoom;
  float l = length(m);
  if (l > u_max) m *= u_max / l;
  int n = int(clamp(ceil(min(l, u_max) / 3.0), 2.0, 10.0));
  vec2 span = vec2(m.x, -m.y) / u_size;
  vec2 uv = v_uv - span * 0.5;
  vec2 step = span / float(n - 1);
  vec3 c = vec3(0.0);
  for (int i = 0; i < 10; i++) {
    if (i >= n) break;
    c += texture(u_tex, uv + step * float(i)).rgb;
  }
  o = vec4(c / float(n), 1.0);
}`;

/** Renderers that run on the CPU: the blur pass would cost a frame there. */
const SOFTWARE = /swiftshader|llvmpipe|softpipe|software|basic render|microsoft basic/i;

/** lighten: per-channel max, so dark paper takes the colour and light ink stays on top */
export type Blend = "none" | "alpha" | "multiply" | "lighten";

interface Programs {
	tex: {
		prog: WebGLProgram;
		rect: WebGLUniformLocation;
		uv: WebGLUniformLocation;
		view: WebGLUniformLocation;
		gamma: WebGLUniformLocation;
		dark: WebGLUniformLocation;
		paper: WebGLUniformLocation;
		ink: WebGLUniformLocation;
	};
	solid: { prog: WebGLProgram; rect: WebGLUniformLocation; uv: WebGLUniformLocation; view: WebGLUniformLocation; color: WebGLUniformLocation; round: WebGLUniformLocation };
	/** compiled on the first blurred frame, so startup pays nothing for it */
	blur: {
		prog: WebGLProgram;
		rect: WebGLUniformLocation;
		uv: WebGLUniformLocation;
		view: WebGLUniformLocation;
		size: WebGLUniformLocation;
		pan: WebGLUniformLocation;
		zoom: WebGLUniformLocation;
		max: WebGLUniformLocation;
	} | null;
	vao: WebGLVertexArrayObject;
	vbo: WebGLBuffer;
}

export class Compositor {
	readonly gl: WebGL2RenderingContext;
	private tex!: Programs["tex"];
	private solid!: Programs["solid"];
	private res!: Programs;
	private tone: { paper: [number, number, number]; ink: [number, number, number] } | null = null;
	private w = 1;
	private h = 1;
	textureBytes = 0;
	/** the offscreen frame the blur reads (flights only; freed when they land) */
	blurBytes = 0;
	private blurFb: { fb: WebGLFramebuffer; tex: WebGLTexture; w: number; h: number } | null = null;
	private rendererName: string | null = null;
	/**
	 * The context is lost (GPU reset, resource pressure): nothing draws until
	 * it is restored. Every texture is gone by then; the owner re-uploads.
	 */
	lost = false;
	onLost: () => void = () => {};
	onRestored: () => void = () => {};
	private ac = new AbortController();

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
		this.build();
		// preventDefault on loss asks the browser to restore the context later.
		const target = canvas as EventTarget;
		target.addEventListener(
			"webglcontextlost",
			(e) => {
				e.preventDefault();
				this.lost = true;
				this.onLost();
			},
			{ signal: this.ac.signal },
		);
		target.addEventListener(
			"webglcontextrestored",
			() => {
				this.lost = false;
				this.textureBytes = 0;
				this.blurBytes = 0;
				this.blurFb = null;
				this.mode = null;
				this.build();
				this.onRestored();
			},
			{ signal: this.ac.signal },
		);
	}

	/** Programs and the quad buffer (again after a context restore). */
	private build() {
		const gl = this.gl;
		const texProg = this.program(QUAD_VS, TEX_FS);
		const solidProg = this.program(QUAD_VS, SOLID_FS);
		const u = (p: WebGLProgram, n: string) => gl.getUniformLocation(p, n)!;
		this.tex = { prog: texProg, rect: u(texProg, "u_rect"), uv: u(texProg, "u_uv"), view: u(texProg, "u_view"), gamma: u(texProg, "u_gamma"), dark: u(texProg, "u_dark"), paper: u(texProg, "u_paper"), ink: u(texProg, "u_ink") };
		this.solid = { prog: solidProg, rect: u(solidProg, "u_rect"), uv: u(solidProg, "u_uv"), view: u(solidProg, "u_view"), color: u(solidProg, "u_color"), round: u(solidProg, "u_round") };

		const vao = gl.createVertexArray()!;
		gl.bindVertexArray(vao);
		const vbo = gl.createBuffer()!;
		gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
		gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW);
		for (const prog of [texProg, solidProg]) {
			const loc = gl.getAttribLocation(prog, "a_pos");
			gl.enableVertexAttribArray(loc);
			gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
		}
		this.res = { tex: this.tex, solid: this.solid, blur: null, vao, vbo };
	}

	/** Frees programs and buffers and releases the context (textures are the owner's). */
	dispose() {
		this.ac.abort();
		const gl = this.gl;
		if (!this.lost && !gl.isContextLost()) {
			gl.deleteProgram(this.res.tex.prog);
			gl.deleteProgram(this.res.solid.prog);
			if (this.res.blur) gl.deleteProgram(this.res.blur.prog);
			this.freeBlur();
			gl.deleteVertexArray(this.res.vao);
			gl.deleteBuffer(this.res.vbo);
			// Browsers cap live contexts per page: give this one back now, not at GC.
			gl.getExtension("WEBGL_lose_context")?.loseContext();
		}
		this.textureBytes = 0;
	}

	private program(vs: string, fs: string) {
		const gl = this.gl;
		const compile = (type: number, src: string) => {
			const s = gl.createShader(type)!;
			gl.shaderSource(s, src);
			gl.compileShader(s);
			if (!gl.getShaderParameter(s, gl.COMPILE_STATUS) && !gl.isContextLost()) throw new Error(gl.getShaderInfoLog(s) ?? "shader");
			return s;
		};
		const p = gl.createProgram()!;
		const v = compile(gl.VERTEX_SHADER, vs);
		const f = compile(gl.FRAGMENT_SHADER, fs);
		gl.attachShader(p, v);
		gl.attachShader(p, f);
		gl.bindAttribLocation(p, 0, "a_pos");
		gl.linkProgram(p);
		// Flagged for deletion; they go with the program.
		gl.deleteShader(v);
		gl.deleteShader(f);
		if (!gl.getProgramParameter(p, gl.LINK_STATUS) && !gl.isContextLost()) throw new Error(gl.getProgramInfoLog(p) ?? "link");
		return p;
	}

	resize(w: number, h: number) {
		if (this.canvas.width !== w) this.canvas.width = w;
		if (this.canvas.height !== h) this.canvas.height = h;
		this.w = w;
		this.h = h;
	}

	upload(pixels: Uint8Array, w: number, h: number): WebGLTexture | null {
		const gl = this.gl;
		const tex = gl.createTexture();
		if (!tex) return null; // context lost
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
		gl.bindVertexArray(this.res.vao);
	}

	private blend(mode: Blend) {
		const gl = this.gl;
		if (mode === "none") {
			gl.disable(gl.BLEND);
			return;
		}
		gl.enable(gl.BLEND);
		gl.blendEquation(mode === "lighten" ? gl.MAX : gl.FUNC_ADD);
		if (mode === "alpha") gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
		else if (mode === "multiply") gl.blendFunc(gl.DST_COLOR, gl.ZERO);
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

	/** GPU renderer string, when the browser exposes it (read on first use) */
	get renderer(): string {
		this.rendererName ??= rendererOf(this.gl);
		return this.rendererName;
	}

	/** a CPU (software) rasteriser: skip optional GPU passes */
	get software(): boolean {
		return SOFTWARE.test(this.renderer);
	}

	/** Limit drawing to a device-pixel rect (top-left origin); null draws everywhere. */
	clip(r: { x: number; y: number; w: number; h: number } | null) {
		const gl = this.gl;
		if (!r) {
			gl.disable(gl.SCISSOR_TEST);
			return;
		}
		gl.enable(gl.SCISSOR_TEST);
		const x = Math.max(0, Math.floor(r.x));
		const y = Math.max(0, Math.floor(r.y));
		const x1 = Math.min(this.w, Math.ceil(r.x + r.w));
		const y1 = Math.min(this.h, Math.ceil(r.y + r.h));
		gl.scissor(x, this.h - y1, Math.max(0, x1 - x), Math.max(0, y1 - y));
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

	/**
	 * Draw the next frame offscreen for `presentBlur`. False (drawing goes to
	 * the screen as usual) when the framebuffer cannot be made.
	 */
	blurTarget(): boolean {
		const gl = this.gl;
		if (this.lost) return false;
		let b = this.blurFb;
		if (b && (b.w !== this.w || b.h !== this.h)) {
			this.freeBlur();
			b = null;
		}
		if (!b) {
			const tex = gl.createTexture();
			const fb = gl.createFramebuffer();
			if (!tex || !fb) return false;
			gl.bindTexture(gl.TEXTURE_2D, tex);
			gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, this.w, this.h);
			gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
			gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
			gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
			gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
			gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
			gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
			if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
				gl.bindFramebuffer(gl.FRAMEBUFFER, null);
				gl.deleteFramebuffer(fb);
				gl.deleteTexture(tex);
				return false;
			}
			b = this.blurFb = { fb, tex, w: this.w, h: this.h };
			this.blurBytes = this.w * this.h * 4;
		}
		gl.bindFramebuffer(gl.FRAMEBUFFER, b.fb);
		return true;
	}

	/** Composites the offscreen frame to the screen, blurred along the motion (device px). */
	presentBlur(pan: [number, number], zoom: number, max: number) {
		const gl = this.gl;
		const b = this.blurFb;
		if (!b) return;
		const p = this.blurProgram();
		gl.bindFramebuffer(gl.FRAMEBUFFER, null);
		gl.disable(gl.SCISSOR_TEST);
		gl.disable(gl.BLEND);
		gl.viewport(0, 0, this.w, this.h);
		gl.useProgram(p.prog);
		this.mode = null;
		gl.uniform2f(p.view, this.w, this.h);
		gl.uniform4f(p.uv, 0, 1, 1, 0);
		gl.uniform4f(p.rect, 0, 0, this.w, this.h);
		gl.uniform2f(p.size, this.w, this.h);
		gl.uniform2f(p.pan, pan[0], pan[1]);
		gl.uniform1f(p.zoom, zoom);
		gl.uniform1f(p.max, max);
		gl.bindTexture(gl.TEXTURE_2D, b.tex);
		gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
	}

	/** Compiles the blur program ahead of the first blurred frame (call when a flight is about to move). */
	blurProgram() {
		if (this.res.blur) return this.res.blur;
		const gl = this.gl;
		const prog = this.program(QUAD_VS, BLUR_FS);
		const u = (n: string) => gl.getUniformLocation(prog, n)!;
		const loc = gl.getAttribLocation(prog, "a_pos");
		gl.bindBuffer(gl.ARRAY_BUFFER, this.res.vbo);
		gl.enableVertexAttribArray(loc);
		gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
		this.res.blur = { prog, rect: u("u_rect"), uv: u("u_uv"), view: u("u_view"), size: u("u_size"), pan: u("u_pan"), zoom: u("u_zoom"), max: u("u_max") };
		return this.res.blur;
	}

	freeBlur() {
		const b = this.blurFb;
		if (!b) return;
		this.blurFb = null;
		this.blurBytes = 0;
		if (this.lost) return;
		this.gl.bindFramebuffer(this.gl.FRAMEBUFFER, null);
		this.gl.deleteFramebuffer(b.fb);
		this.gl.deleteTexture(b.tex);
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

function rendererOf(gl: WebGL2RenderingContext): string {
	try {
		const plain = String(gl.getParameter(gl.RENDERER) ?? "");
		if (plain && plain !== "WebKit WebGL") return plain;
		const ext = gl.getExtension("WEBGL_debug_renderer_info");
		return ext ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) ?? plain) : plain;
	} catch {
		return "";
	}
}
