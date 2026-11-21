import { UiFactory, UiRect } from "./UiFactory";

/**
 * IconToggleButton
 * ----------------
 * Small round ON/OFF icon button used for Taps and Sound (top right of the screen).
 *
 *   ON : bright icon, thin teal ring
 *   OFF: icon greyed to ~40% (or swapped for `offIcon`), red circle-slash on top, grey ring
 *   Tap: quick bounce 1.0 -> 0.9 -> 1.0 over 0.15 s
 *
 * Placed in screen fractions (centre + diameter as a fraction of the screen width) so it is
 * round and the same size on every phone. The owner decides what a tap does.
 */

const FULL: UiRect = { left: -1, right: 1, bottom: -1, top: 1 };
const BG = new vec4(0.05, 0.04, 0.08, 0.55);
const TEAL = new vec4(0.18, 0.902, 0.839, 1);
const ICON_ON = new vec4(0.88, 1.0, 0.97, 1);
const ICON_OFF = new vec4(0.75, 0.75, 0.78, 0.4);
const RING_OFF = new vec4(0.55, 0.55, 0.6, 0.85);
const CANCEL = new vec4(0.92, 0.36, 0.36, 0.95);
const BOUNCE_SECONDS = 0.15;

export type IconToggleTextures = {
    circle: Texture;     // round background
    ring: Texture;       // thin ring outline
    onIcon: Texture;     // icon when ON
    offIcon?: Texture;   // icon when OFF (defaults to onIcon, greyed)
    cancel?: Texture;    // circle-slash drawn over the icon when OFF
};

export class IconToggleButton {
    public readonly st: ScreenTransform;
    private obj: SceneObject;
    private ring: Image;
    private icon: Image;
    private cancel: SceneObject | null = null;
    private bounceStart = -1;
    private on = true;

    /**
     * @param center   screen position (0..1, top-left origin)
     * @param diameter fraction of the screen width
     * @param regionST the parent's ScreenTransform (to convert screen points)
     */
    constructor(private ui: UiFactory, parent: SceneObject, regionST: ScreenTransform, aspect: number,
        name: string, center: vec2, diameter: number, private tex: IconToggleTextures) {
        const halfW = diameter / 2;
        const halfH = halfW * aspect; // same size in pixels both ways
        const a = regionST.screenPointToLocalPoint(new vec2(center.x - halfW, center.y - halfH));
        const b = regionST.screenPointToLocalPoint(new vec2(center.x + halfW, center.y + halfH));
        this.obj = ui.createObject(name, parent, { left: a.x, right: b.x, bottom: b.y, top: a.y });
        this.st = UiFactory.getScreenTransform(this.obj);
        ui.addImage(this.obj, tex.circle, BG, StretchMode.Fit);

        const ringObj = ui.createObject(name + "Ring", this.obj, FULL);
        this.ring = ui.addImage(ringObj, tex.ring || tex.circle, TEAL, StretchMode.Fit);
        const iconObj = ui.createObject(name + "Icon", this.obj, { left: -0.62, right: 0.62, bottom: -0.62, top: 0.62 });
        this.icon = ui.addImage(iconObj, tex.onIcon, ICON_ON, StretchMode.Fit);
        if (tex.cancel) {
            this.cancel = ui.createObject(name + "Cancel", this.obj, { left: -0.74, right: 0.74, bottom: -0.74, top: 0.74 });
            ui.addImage(this.cancel, tex.cancel, CANCEL, StretchMode.Fit);
        }
        this.setOn(true);
    }

    public containsScreenPoint(screenPos: vec2): boolean {
        return this.obj.isEnabledInHierarchy && this.st.containsScreenPoint(screenPos);
    }

    public setOn(on: boolean) {
        this.on = on;
        this.ring.mainPass.baseColor = on ? TEAL : RING_OFF;
        this.icon.mainPass.baseTex = on || !this.tex.offIcon ? this.tex.onIcon : this.tex.offIcon;
        this.icon.mainPass.baseColor = on ? ICON_ON : ICON_OFF;
        if (this.cancel) {
            this.cancel.enabled = !on;
        }
    }

    public isOn(): boolean {
        return this.on;
    }

    public bounce() {
        this.bounceStart = getTime();
    }

    /** Call every frame. */
    public update() {
        if (this.bounceStart < 0) {
            return;
        }
        const t = Math.min(1, (getTime() - this.bounceStart) / BOUNCE_SECONDS);
        const s = 1 - 0.1 * Math.sin(Math.PI * t);
        this.st.scale = new vec3(s, s, 1);
        if (t >= 1) {
            this.bounceStart = -1;
            this.st.scale = vec3.one();
        }
    }
}
