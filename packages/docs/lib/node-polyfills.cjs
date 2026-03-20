if (typeof globalThis.DOMMatrix === "undefined") {
	class DOMMatrix {
		constructor(init) {
			this.a = 1; this.b = 0; this.c = 0; this.d = 1; this.e = 0; this.f = 0;
			this.m11 = 1; this.m12 = 0; this.m13 = 0; this.m14 = 0;
			this.m21 = 0; this.m22 = 1; this.m23 = 0; this.m24 = 0;
			this.m31 = 0; this.m32 = 0; this.m33 = 1; this.m34 = 0;
			this.m41 = 0; this.m42 = 0; this.m43 = 0; this.m44 = 1;
			this.is2D = true;
			this.isIdentity = true;
			if (Array.isArray(init) && init.length === 6) {
				this.a = this.m11 = init[0];
				this.b = this.m12 = init[1];
				this.c = this.m21 = init[2];
				this.d = this.m22 = init[3];
				this.e = this.m41 = init[4];
				this.f = this.m42 = init[5];
				this.isIdentity = false;
			}
		}
		inverse() { return new DOMMatrix(); }
		multiply() { return new DOMMatrix(); }
		scale() { return new DOMMatrix(); }
		translate() { return new DOMMatrix(); }
		transformPoint(point) { return point || { x: 0, y: 0, z: 0, w: 1 }; }
		static fromMatrix() { return new DOMMatrix(); }
		static fromFloat32Array() { return new DOMMatrix(); }
		static fromFloat64Array() { return new DOMMatrix(); }
	}
	globalThis.DOMMatrix = DOMMatrix;
}
