import { UiFactory, UiRect } from "./UiFactory";

/**
 * TouchIndicator
 * --------------
 * Shows where the screen is touched, for demo recordings. VISUAL ONLY: it just listens to
 * touch positions it is given and never consumes or blocks a tap.
 *
 *   - Touch start: a teal ring appears under the finger, grows from ~40 to ~90 pt and fades
 *     out over 0.4 s. Four rings are pooled and reused (oldest first).
 *   - While the finger is down or dragging: a small solid teal dot follows it, and fades
 *     out quickly on release.
 *
 * Sizes are fractions of the screen width (based on a ~390 pt wide phone), so they look the
 * same on any device. Owned by RelicMenuController, which feeds it touches and calls update().
 */

const TEAL = new vec4(0.18, 0.902, 0.839, 1);   // #2EE6D6
const RING_START = 40 / 390;                    // diameter, fraction of screen width
const RING_END = 90 / 390;
const RING_SECONDS = 0.4;
const RING_POOL = 4;
const DOT_SIZE = 16 / 390;
const DOT_ALPHA = 0.9;
const DOT_FADE_SECONDS = 0.15;
const FULL: UiRect = { left: -1, right: 1, bottom: -1, top: 1 };

type Ring = { obj: SceneObject; st: ScreenTransform; image: Image; pos: vec2; start: number };

export class TouchIndicator {
    private enabled = true;
    private root: SceneObject;
    private rootST: ScreenTransform;
    private rings: Ring[] = [];
    private nextRing = 0;
    private dot: { obj: SceneObject; st: ScreenTransform; image: Image };
    private dotPos = new vec2(0.5, 0.5);
    private dotHeld = false;
    private dotFadeStart = -1;

    /** `aspect` = screen width / height (the UI camera's aspect). */
    constructor(ui: UiFactory, parent: SceneObject, ringTexture: Texture, dotTexture: Texture, private aspect: () => number) {
        // Created last under the UI parent so it draws on top of every other 2D element.
        this.root = ui.createObject("TouchIndicator", parent, FULL);
        this.rootST = UiFactory.getScreenTransform(this.root);
        for (let i = 0; i < RING_POOL; i++) {
            const obj = ui.createObject("TouchRing_" + i, this.root, FULL);
            const image = ui.addImage(obj, ringTexture, TEAL, StretchMode.Fit);
            obj.enabled = false;
            this.rings.push({ obj, st: UiFactory.getScreenTransform(obj), image, pos: new vec2(0, 0), start: -1 });
        }
        const dotObj = ui.createObject("TouchDot", this.root, FULL);
        this.dot = { obj: dotObj, st: UiFactory.getScreenTransform(dotObj), image: ui.addImage(dotObj, dotTexture, TEAL, StretchMode.Fit) };
        dotObj.enabled = false;
    }

    public setEnabled(on: boolean) {
        this.enabled = on;
        if (!on) {
            this.rings.forEach((r) => { r.obj.enabled = false; r.start = -1; });
            this.dot.obj.enabled = false;
            this.dotHeld = false;
            this.dotFadeStart = -1;
        }
    }

    public touchStart(pos: vec2) {
        if (!this.enabled) {
            return;
        }
        const ring = this.rings[this.nextRing];
        this.nextRing = (this.nextRing + 1) % this.rings.length;
        ring.pos = pos;
        ring.start = getTime();
        ring.obj.enabled = true;

        this.dotPos = pos;
        this.dotHeld = true;
        this.dotFadeStart = -1;
        this.dot.obj.enabled = true;
    }

    public touchMove(pos: vec2) {
        if (this.enabled && this.dotHeld) {
            this.dotPos = pos;
        }
    }

    public touchEnd() {
        if (this.enabled && this.dotHeld) {
            this.dotHeld = false;
            this.dotFadeStart = getTime();
        }
    }

    public update() {
        if (!this.enabled) {
            return;
        }
        const now = getTime();
        for (const ring of this.rings) {
            if (ring.start < 0) {
                continue;
            }
            const t = (now - ring.start) / RING_SECONDS;
            if (t >= 1) {
                ring.start = -1;
                ring.obj.enabled = false;
                continue;
            }
            const eased = 1 - (1 - t) * (1 - t);
            this.place(ring.st, ring.pos, RING_START + (RING_END - RING_START) * eased);
            ring.image.mainPass.baseColor = new vec4(TEAL.x, TEAL.y, TEAL.z, 1 - t);
        }

        if (this.dot.obj.enabled) {
            let alpha = DOT_ALPHA;
            if (!this.dotHeld) {
                const t = (now - this.dotFadeStart) / DOT_FADE_SECONDS;
                alpha = DOT_ALPHA * (1 - Math.min(1, t));
                if (t >= 1) {
                    this.dot.obj.enabled = false;
                }
            }
            this.place(this.dot.st, this.dotPos, DOT_SIZE);
            this.dot.image.mainPass.baseColor = new vec4(TEAL.x, TEAL.y, TEAL.z, alpha);
        }
    }

    /** Puts a round element of `diameter` (fraction of screen width) centred on a screen point. */
    private place(st: ScreenTransform, pos: vec2, diameter: number) {
        const halfW = diameter / 2;
        const halfH = halfW * this.aspect(); // same size in pixels both ways
        const a = this.rootST.screenPointToLocalPoint(new vec2(pos.x - halfW, pos.y - halfH));
        const b = this.rootST.screenPointToLocalPoint(new vec2(pos.x + halfW, pos.y + halfH));
        st.anchors = Rect.create(a.x, b.x, b.y, a.y); // screen y runs down, local y runs up
        st.offsets = Rect.create(0, 0, 0, 0);
    }
}
