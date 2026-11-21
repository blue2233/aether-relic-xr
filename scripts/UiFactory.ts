/**
 * UiFactory
 * ---------
 * Small helper used by the Relic menu and the Codex card to build 2D UI from code.
 *
 * All rectangles are ScreenTransform anchors in the PARENT's -1..1 space
 * (x: left..right, y: bottom..top). Every object is put on the UI camera's render layer
 * so the Orthographic Camera draws it.
 */

export type UiRect = { left: number; right: number; bottom: number; top: number };

// Shared colour palette: dark ink, TEAL only for aether (Homeland shards / cards),
// THORN violet for artifacts and UI highlights, MOONLIGHT lavender for titles. No gold.
export const UiColors = {
    panel: new vec4(0.05, 0.04, 0.08, 0.55),
    card: new vec4(0.06, 0.05, 0.09, 0.92),
    idle: new vec4(0.10, 0.08, 0.16, 0.88),
    teal: new vec4(0.08, 0.55, 0.52, 0.95),        // aether
    thorn: new vec4(0.36, 0.18, 0.50, 0.95),       // dark violet thorn
    moonlight: new vec4(0.84, 0.78, 0.98, 1),      // pale lavender for titles / ticks
    disabled: new vec4(0.25, 0.24, 0.28, 0.7),
    text: new vec4(1.0, 0.96, 0.86, 1),
    textDim: new vec4(1.0, 0.96, 0.86, 0.6),
    textDark: new vec4(0.08, 0.06, 0.10, 1),
};

export class UiFactory {
    constructor(private layer: LayerSet, private imageMaterial: Material) {}

    /** Creates a child SceneObject with a ScreenTransform anchored to `rect` in its parent. */
    createObject(name: string, parent: SceneObject, rect: UiRect): SceneObject {
        const obj = global.scene.createSceneObject(name);
        obj.setParent(parent);
        obj.layer = this.layer;
        const st = obj.createComponent("Component.ScreenTransform");
        UiFactory.setRect(st, rect);
        return obj;
    }

    /** Adds a tinted image with its own material copy (so each image can have its own colour). */
    addImage(obj: SceneObject, texture: Texture, color: vec4, stretch: StretchMode = StretchMode.Stretch): Image {
        const image = obj.createComponent("Component.Image");
        image.mainMaterial = this.imageMaterial.clone();
        image.mainPass.baseTex = texture;
        image.mainPass.baseColor = color;
        image.stretchMode = stretch;
        return image;
    }

    /** Adds a text label on its own child object, so it draws on top of the object's image. */
    addLabel(obj: SceneObject, value: string, size: number,
        rect: UiRect = { left: -0.92, right: 0.92, bottom: -1, top: 1 }): Text {
        const holder = this.createObject(obj.name + "_Label", obj, rect);
        const text = holder.createComponent("Component.Text");
        text.text = value;
        text.size = size;
        text.depthTest = false;
        text.horizontalAlignment = HorizontalAlignment.Center;
        text.verticalAlignment = VerticalAlignment.Center;
        text.horizontalOverflow = HorizontalOverflow.Shrink;
        text.textFill.color = UiColors.text;
        return text;
    }

    static setRect(st: ScreenTransform, rect: UiRect) {
        st.anchors = Rect.create(rect.left, rect.right, rect.bottom, rect.top);
        st.offsets = Rect.create(0, 0, 0, 0);
    }

    static getScreenTransform(obj: SceneObject): ScreenTransform {
        return obj.getComponent("Component.ScreenTransform");
    }
}
