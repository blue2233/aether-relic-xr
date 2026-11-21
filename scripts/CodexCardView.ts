import { CODEX_ENTRIES, CodexCategory, ArtifactKind } from "./CodexData";
import { ShardRing } from "./ShardRing";
import { UiFactory, UiColors, UiRect } from "./UiFactory";

/**
 * CodexCardView
 * -------------
 * Draws the Codex card and the "collected" checkmarks.
 *
 * CODEX CARD (STEP 4) - a rounded panel that floats just above the relic:
 *
 *     +-----------------------------------+
 *     | [HOMELAND]                        |   category tag (teal aether / violet thorn)
 *     |          Homeland 1               |   title
 *     | +-------+  two or three lines of  |
 *     | | image |  lore text ...          |   image slot + lore
 *     | +-------+                         |
 *     | [  Collect  ]      [  Close  ]    |   Homeland: Collect / Close
 *     +-----------------------------------+   Artifact: Place   / Close
 *
 * The card is screen-space UI that is moved every frame to the relic's position on screen,
 * so it always faces the camera, stays readable at any distance, and its buttons are easy
 * to tap. It is clamped to stay inside the Safe Render Region.
 *
 * CHECKMARKS (STEP 6) - a small moonlight-lavender tick drawn over every collected shard.
 *
 * COUNTER (STEP 6) - a small cyan "Collected N/8" card in the bottom-left corner, in the same
 * rounded style as the Relic menu buttons. Shown once the Codex is summoned.
 */

export type CardTapResult = "primary" | "close" | "inside" | "outside";

// Card size in Safe Render Region units (-1..1).
const CARD_HALF_WIDTH = 0.78;
const CARD_HEIGHT = 0.6;
const CARD_MIN_BOTTOM = -0.72;   // keep clear of the hint text and Snapchat's bottom bar
const CARD_MAX_TOP = 0.68;

// "Collected N/8" counter card, bottom-left corner (below the hint, clear of the right-side menu).
const COUNTER_RECT: UiRect = { left: -0.94, right: -0.36, bottom: -0.97, top: -0.84 };
const COUNTER_FILL = new vec4(0.2, 0.82, 0.86, 0.92);   // bright aether cyan

@component
export class CodexCardView extends BaseScriptComponent {
    @input
    @hint("Parent for the card: the Safe Render Region under the Orthographic Camera")
    uiParent: SceneObject;

    @input
    @hint("The Orthographic Camera that draws the 2D UI")
    uiCamera: Camera;

    @input
    @hint("Main AR camera (to find the relic on screen)")
    worldCamera: Camera;

    @input
    @hint("Relic object; the card floats above it")
    relic: SceneObject;

    @input
    @hint("The shard ring (checkmarks are drawn over collected shards)")
    shards: ShardRing;

    @input
    @hint("Image material for UI (UI/UIButtonMaterial)")
    imageMaterial: Material;

    @input
    @hint("Rounded-rectangle texture for buttons and tags (UI/RoundedRect)")
    roundedRect: Texture;

    @input
    @hint("Rounded texture with small corners for the card panel (UI/PanelRect)")
    panelTexture: Texture;

    @input
    @hint("Checkmark texture (UI/Check)")
    checkTexture: Texture;

    @input
    @hint("Shown in the image slot when a card has no image (UI/CardImagePlaceholder)")
    placeholderImage: Texture;

    @input
    @hint("PLACEHOLDERS: one image per Codex entry, same order as CodexData (empty = placeholder)")
    cardImages: Texture[] = [];

    @input
    @hint("How far above the relic's centre the card's bottom edge sits, in cm")
    cardLift: number = 5;

    private ui: UiFactory;
    private root: SceneObject;
    private rootST: ScreenTransform;
    private card: SceneObject;
    private cardST: ScreenTransform;
    private tagImage: Image;
    private tagText: Text;
    private titleText: Text;
    private loreText: Text;
    private picture: Image;
    private primary: { st: ScreenTransform; image: Image; text: Text };
    private close: { st: ScreenTransform; image: Image; text: Text };
    private checks: { obj: SceneObject; st: ScreenTransform }[] = [];
    private checked: boolean[] = [];
    private primaryEnabled = true;
    private cardCenter: vec2 | null = null; // smoothed position, Safe Region units
    private checksVisible = false;
    private counter: SceneObject;
    private counterText: Text;

    onAwake() {
        if (!this.uiParent || !this.uiCamera || !this.worldCamera || !this.relic || !this.shards || !this.imageMaterial) {
            print("CodexCardView: a required input is missing; check the Inspector.");
            return;
        }
        this.ui = new UiFactory(this.uiCamera.renderLayer, this.imageMaterial);
        this.root = this.ui.createObject("CodexUI", this.uiParent, { left: -1, right: 1, bottom: -1, top: 1 });
        this.rootST = UiFactory.getScreenTransform(this.root);
        this.buildChecks();
        this.buildCard();
        this.buildCounter();
        this.card.enabled = false;
        this.createEvent("LateUpdateEvent").bind(() => this.followRelic());
    }

    // =====================================================================
    // Public API
    // =====================================================================

    /** STEP 4: opens the card for one Codex entry. `collected` greys out the main button. */
    public open(index: number, collected: boolean) {
        const entry = CODEX_ENTRIES[index];
        const isHomeland = entry.category === CodexCategory.Homeland;

        this.tagText.text = (entry.tag || entry.category).toUpperCase(); // e.g. "THE REACH"
        this.tagImage.mainPass.baseColor = isHomeland ? UiColors.teal : UiColors.thorn;
        this.tagText.textFill.color = UiColors.text;
        this.titleText.text = entry.title;
        this.loreText.text = entry.lore;
        this.picture.mainPass.baseTex = this.cardImages[index] || this.placeholderImage;
        this.picture.mainPass.baseColor = this.cardImages[index] ? new vec4(1, 1, 1, 1) : new vec4(1, 0.96, 0.86, 0.35);

        // Main button: "Collect" (Homeland) or "Place" (Artifact); greyed out once done.
        this.primaryEnabled = !collected;
        const doneLabel = entry.artifact === ArtifactKind.None ? "Collected" : "Placed";
        this.primary.text.text = collected ? doneLabel : (isHomeland ? "Collect" : "Place");
        this.primary.image.mainPass.baseColor = collected ? UiColors.disabled : (isHomeland ? UiColors.teal : UiColors.thorn);
        this.primary.text.textFill.color = UiColors.text;

        this.cardCenter = null; // jump straight to the relic, then follow smoothly
        this.card.enabled = true;
        this.followRelic();
    }

    public hide() {
        this.card.enabled = false;
    }

    public get isOpen(): boolean {
        return this.card.enabled;
    }

    /** Where a tap landed on the card. "primary" is ignored while the main button is greyed out. */
    public handleTap(screenPos: vec2): CardTapResult {
        if (!this.card.enabled) {
            return "outside";
        }
        if (this.primary.st.containsScreenPoint(screenPos)) {
            return this.primaryEnabled ? "primary" : "inside";
        }
        if (this.close.st.containsScreenPoint(screenPos)) {
            return "close";
        }
        return this.cardST.containsScreenPoint(screenPos) ? "inside" : "outside";
    }

    /** STEP 6: shows / hides the checkmark over one shard. */
    public setChecked(index: number, checked: boolean) {
        this.checked[index] = checked;
    }

    public resetChecks() {
        this.checked = this.checked.map(() => false);
    }

    /** STEP 6: updates the "Collected N/8" corner card and shows or hides it. */
    public setCounter(collected: number, total: number, visible: boolean) {
        this.counterText.text = `Collected ${collected}/${total}`;
        this.counter.enabled = visible;
    }

    /** Checkmarks are only shown while the relic (and so its shards) is on the card. */
    public setChecksVisible(visible: boolean) {
        this.checksVisible = visible;
    }

    // =====================================================================
    // Per-frame placement on screen
    // =====================================================================

    /** Moves the card above the relic and the checkmarks over their shards. */
    private followRelic() {
        if (this.card.enabled) {
            this.placeCardAboveRelic();
        }
        this.placeChecks();
    }

    private placeCardAboveRelic() {
        const anchor = this.relic.getTransform().getWorldPosition().add(vec3.up().uniformScale(this.cardLift));
        const local = this.toSafeRegion(anchor);
        if (!local) {
            return; // relic behind the camera: leave the card where it is
        }
        // Card sits above the relic, kept inside the safe area.
        const x = MathUtils.clamp(local.x, -1 + CARD_HALF_WIDTH + 0.04, 1 - CARD_HALF_WIDTH - 0.04);
        const bottom = MathUtils.clamp(local.y, CARD_MIN_BOTTOM, CARD_MAX_TOP - CARD_HEIGHT);
        const target = new vec2(x, bottom);
        this.cardCenter = this.cardCenter ? vec2.lerp(this.cardCenter, target, 0.25) : target;

        UiFactory.setRect(this.cardST, {
            left: this.cardCenter.x - CARD_HALF_WIDTH,
            right: this.cardCenter.x + CARD_HALF_WIDTH,
            bottom: this.cardCenter.y,
            top: this.cardCenter.y + CARD_HEIGHT,
        });
    }

    private placeChecks() {
        const halfX = 0.065;
        const halfY = halfX * this.worldCamera.aspect; // keep the tick round on a tall screen
        for (let i = 0; i < this.checks.length; i++) {
            const check = this.checks[i];
            const local = this.checksVisible && this.checked[i] ? this.toSafeRegion(this.shards.getShardWorldPosition(i)) : null;
            check.obj.enabled = local !== null;
            if (local) {
                UiFactory.setRect(check.st, { left: local.x - halfX, right: local.x + halfX, bottom: local.y - halfY, top: local.y + halfY });
            }
        }
    }

    /** World point -> Safe Render Region coordinates (-1..1), or null if behind the camera. */
    private toSafeRegion(world: vec3): vec2 | null {
        if (!this.shards.isInFrontOfCamera(world)) {
            return null;
        }
        const screen = this.worldCamera.worldSpaceToScreenSpace(world);
        return this.rootST.screenPointToLocalPoint(screen);
    }

    // =====================================================================
    // Building the UI
    // =====================================================================

    private buildChecks() {
        for (let i = 0; i < CODEX_ENTRIES.length; i++) {
            const obj = this.ui.createObject("Check_" + (i + 1), this.root, { left: 0, right: 0.1, bottom: 0, top: 0.1 });
            this.ui.addImage(obj, this.checkTexture, UiColors.moonlight, StretchMode.Fit);
            obj.enabled = false;
            this.checks.push({ obj, st: UiFactory.getScreenTransform(obj) });
            this.checked.push(false);
        }
    }

    /** Builds the card once; open() fills in the text for each entry. Rects are in card space. */
    private buildCard() {
        this.card = this.ui.createObject("CodexCard", this.root, { left: -CARD_HALF_WIDTH, right: CARD_HALF_WIDTH, bottom: 0, top: CARD_HEIGHT });
        this.cardST = UiFactory.getScreenTransform(this.card);
        this.ui.addImage(this.card, this.panelTexture || this.roundedRect, UiColors.card);

        // Category tag (top-left pill)
        const tag = this.ui.createObject("CategoryTag", this.card, { left: -0.9, right: -0.4, bottom: 0.66, top: 0.88 });
        this.tagImage = this.ui.addImage(tag, this.roundedRect, UiColors.teal);
        this.tagText = this.ui.addLabel(tag, "HOMELAND", 11);

        // Title
        const title = this.ui.createObject("Title", this.card, { left: -0.9, right: 0.9, bottom: 0.3, top: 0.62 });
        this.titleText = this.ui.addLabel(title, "", 22);
        this.titleText.textFill.color = UiColors.moonlight;

        // Image slot (left) + lore (right)
        const pictureObj = this.ui.createObject("ImageSlot", this.card, { left: -0.9, right: -0.4, bottom: -0.5, top: 0.24 });
        this.picture = this.ui.addImage(pictureObj, this.placeholderImage || this.roundedRect, UiColors.textDim, StretchMode.Fit);

        const loreObj = this.ui.createObject("Lore", this.card, { left: -0.34, right: 0.9, bottom: -0.52, top: 0.26 });
        this.loreText = this.ui.addLabel(loreObj, "", 13, { left: -1, right: 1, bottom: -1, top: 1 });
        this.loreText.horizontalOverflow = HorizontalOverflow.Wrap;
        this.loreText.verticalOverflow = VerticalOverflow.Shrink;
        this.loreText.horizontalAlignment = HorizontalAlignment.Left;

        // Buttons
        this.primary = this.buildButton("PrimaryButton", { left: -0.9, right: -0.05, bottom: -0.9, top: -0.62 }, "Collect", UiColors.teal);
        this.close = this.buildButton("CloseButton", { left: 0.05, right: 0.9, bottom: -0.9, top: -0.62 }, "Close", UiColors.idle);
    }

    /** The cyan counter card: rounded rectangle + dark label, like a Relic menu button. */
    private buildCounter() {
        this.counter = this.ui.createObject("CodexCounter", this.root, COUNTER_RECT);
        this.ui.addImage(this.counter, this.roundedRect, COUNTER_FILL);
        this.counterText = this.ui.addLabel(this.counter, "Collected 0/8", 18);
        this.counterText.textFill.color = UiColors.textDark;
        this.counter.enabled = false;
    }

    private buildButton(name: string, rect: UiRect, label: string, color: vec4) {
        const obj = this.ui.createObject(name, this.card, rect);
        const image = this.ui.addImage(obj, this.roundedRect, color);
        const text = this.ui.addLabel(obj, label, 15);
        return { st: UiFactory.getScreenTransform(obj), image, text };
    }
}
