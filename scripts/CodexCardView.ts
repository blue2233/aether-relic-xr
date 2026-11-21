import { CODEX_ENTRIES, CodexCategory, ArtifactKind } from "./CodexData";
import { ShardRing } from "./ShardRing";
import { UiFactory, UiColors, UiRect } from "./UiFactory";

/**
 * CodexCardView
 * -------------
 * Draws the Codex card, the "collected" checkmarks and the counter.
 *
 * CODEX CARD (STEP 4) - a full-screen overlay. A black 50% dim covers the whole screen and
 * the card fills ~90% of the width and ~70% of the height (12% clear at the top for
 * Snapchat's icons, 18% at the bottom for the carousel):
 *
 *     +-----------------------------------+
 *     | [HOMELAND]                        |   category tag (teal aether / violet thorn)
 *     |            Solheim                |   large title
 *     | +-------------------------------+ |
 *     | |                               | |
 *     | |      card image (3:2)         | |   the hero of the card
 *     | |                               | |
 *     | +-------------------------------+ |
 *     | Lore text, left-aligned, with     |
 *     | generous line spacing ...         |
 *     | [    Collect    ] [    Close    ] |   Homeland: Collect / Close
 *     +-----------------------------------+   Artifact: Place   / Close
 *
 * It pops in (scale 0.9 -> 1 with a fade, 0.2 s). While it is open the checkmarks and the
 * counter are hidden; the controller hides the Relic menu and the hint.
 *
 * CHECKMARKS (STEP 6) - a small moonlight-lavender tick drawn over every collected shard.
 *
 * COUNTER (STEP 6) - a small cyan "Collected N/8" card in the bottom-left corner, in the same
 * rounded style as the Relic menu buttons. Shown once the Codex is summoned.
 */

export type CardTapResult = "primary" | "close" | "inside" | "outside";

// Card size as fractions of the whole phone screen: 88% wide, top edge 21% down (just below
// Snapchat's bug icon), bottom edge 22% up (just above the capture button). Converted to UI
// units on open.
const CARD_SCREEN = { left: 0.06, right: 0.94, top: 0.21, bottom: 0.78 };
const CARD_PAD_X = 0.06;           // inner padding, card units
const DIM_COLOR = new vec4(0, 0, 0, 0.5);
const POP_SECONDS = 0.2;
const POP_START_SCALE = 0.9;

// Vertical layout inside the card (card units, top = 1). The image gets whatever height is
// left after the lore's minimum: 3:2 full width if it fits, else 16:9 full width, else 16:9
// centred and narrower (see layoutOverlay).
const TAG_TOP = 0.95, TAG_BOTTOM = 0.86;
const TITLE_TOP = 0.85, TITLE_BOTTOM = 0.70;
const IMAGE_TOP = 0.68;
const BUTTON_TOP = -0.70, BUTTON_BOTTOM = -0.95;
const LORE_MIN_HEIGHT = 0.44;      // card units kept for the lore text
const TITLE_SIZE = 38;
const LORE_SIZE = 19;              // ~90% of the previous 21
const LORE_LINE_SPACING = 1.2;
const BUTTON_TEXT_SIZE = 24;

// Sword transformation video: 16:9 panel, 95% of the screen width, centred.
const VIDEO_WIDTH = 0.95;
const VIDEO_ASPECT = 16 / 9;
const VIDEO_FADE_IN = 0.2;
const VIDEO_FADE_OUT = 0.3;
const VIDEO_DIM = new vec4(0, 0, 0, 0.75);
const VIDEO_END_MARGIN = 0.1;      // seconds before the end that count as "ended"

// End-of-collection teaser (same card, different content and button row). Narrator voice.
const TEASER_TAG = "AETHERFORGE SPIRE";
const TEASER_TITLE = "Oh. You Finished.";
const TEASER_BODY =
    "Eight for eight. Genuinely impressive, by your standards. The Wyrendal Dominion is " +
    "hoarding more artifacts, and it keeps them in Aetherforge Spire. Naturally.";
const TEASER_PLAY = "Fine. Take Me to the Spire.";
const TEASER_SOON = "Coming Soon. Ish.";
const TEASER_CLOSE = "Not now, I'm basking";
// Teaser button row: one big teal button, a small text-only Close under it.
const TEASER_PRIMARY_TOP = -0.58, TEASER_PRIMARY_BOTTOM = -0.80;
const TEASER_CLOSE_TOP = -0.83, TEASER_CLOSE_BOTTOM = -0.96;
const SOON_PULSE_SPEED = 3.0;      // radians per second
const SOON_PULSE_AMOUNT = 0.03;    // +-3% scale

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
    @hint("Main AR camera (to put checkmarks over the shards)")
    worldCamera: Camera;

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
    @hint("One image per Codex entry, same order as CodexData (empty = placeholder)")
    cardImages: Texture[] = [];

    private ui: UiFactory;
    private root: SceneObject;
    private rootST: ScreenTransform;
    private overlay: SceneObject;        // dim + card, shown while a card is open
    private dim: Image;
    private dimST: ScreenTransform;
    private pictureST: ScreenTransform;
    private loreST: ScreenTransform;
    private card: SceneObject;
    private cardST: ScreenTransform;
    private panel: Image;
    private tagImage: Image;
    private tagText: Text;
    private titleText: Text;
    private loreText: Text;
    private picture: Image;
    private primary: { st: ScreenTransform; image: Image; text: Text };
    private close: { st: ScreenTransform; image: Image; text: Text };
    private teaserMode = false;          // the overlay is showing the end-of-collection teaser
    private tagST: ScreenTransform;
    private soonPulseStart = -1;         // "Coming Soon" pill pulse, -1 = off
    private checks: { obj: SceneObject; st: ScreenTransform }[] = [];
    private checked: boolean[] = [];
    private primaryEnabled = true;
    private checksVisible = false;
    private counter: SceneObject;
    private counterText: Text;
    private counterWanted = false;       // counter's visibility, ignoring the open card

    // Pop-in animation: every image / text on the overlay with its full colour.
    private fadeImages: { image: Image; color: vec4 }[] = [];
    private fadeTexts: { text: Text; color: vec4 }[] = [];
    private popStart = -1;
    private imageAspect = 1.5;           // aspect of the image slot chosen by layoutOverlay

    // Sword transformation video overlay.
    private video: SceneObject;
    private videoDim: Image;
    private videoImage: Image;
    private videoST: ScreenTransform;
    private videoDimST: ScreenTransform;
    private videoControl: VideoTextureProvider | null = null;
    private videoActive = false;        // between playVideo() and the end of the fade-out
    private videoOnEnd: (() => void) | null = null;
    private videoFadeStart = -1;
    private videoFadingOut = false;
    private videoDoneHooked: VideoTextureProvider[] = [];
    private lastVideoTime = 0;

    onAwake() {
        if (!this.uiParent || !this.uiCamera || !this.worldCamera || !this.shards || !this.imageMaterial) {
            print("CodexCardView: a required input is missing; check the Inspector.");
            return;
        }
        this.ui = new UiFactory(this.uiCamera.renderLayer, this.imageMaterial);
        this.root = this.ui.createObject("CodexUI", this.uiParent, { left: -1, right: 1, bottom: -1, top: 1 });
        this.rootST = UiFactory.getScreenTransform(this.root);
        this.buildChecks();
        this.buildCounter();
        this.buildOverlay();   // built after the ticks and counter so it draws on top of them
        this.overlay.enabled = false;
        this.buildVideoOverlay();
        this.video.enabled = false;
        this.createEvent("LateUpdateEvent").bind(() => {
            this.placeChecks();
            this.updatePop();
            this.updateSoonPulse();
            this.updateVideoFade();
        });
    }

    // =====================================================================
    // Public API
    // =====================================================================

    /** STEP 4: opens the card for one Codex entry. `collected` greys out the main button. */
    public open(index: number, collected: boolean) {
        this.setTeaserMode(false);
        const entry = CODEX_ENTRIES[index];
        const isHomeland = entry.category === CodexCategory.Homeland;

        this.tagText.text = (entry.tag || entry.category).toUpperCase(); // e.g. "THE REACH"
        this.tagImage.mainPass.baseColor = isHomeland ? UiColors.teal : UiColors.thorn;
        this.titleText.text = entry.title;
        this.loreText.text = entry.lore;
        const texture = this.cardImages[index] || this.placeholderImage;
        this.picture.mainPass.baseTex = texture;
        // Landscape art (4:3) fills the full-width 3:2 slot with a light crop; square art
        // (sword, rug) is fitted whole so the object is never cut off.
        const landscape = texture && texture.getWidth() / texture.getHeight() >= 1.3; // 4:3 art is cropped to the slot
        this.picture.stretchMode = landscape ? StretchMode.FillAndCut : StretchMode.Fit;
        this.picture.mainPass.baseColor = this.cardImages[index] ? new vec4(1, 1, 1, 1) : new vec4(1, 0.96, 0.86, 0.35);

        // Main button: "Collect" (Homeland) or "Place" (Artifact); greyed out once done.
        this.primaryEnabled = !collected;
        const doneLabel = entry.artifact === ArtifactKind.None ? "Collected" : "Placed";
        this.primary.text.text = collected ? doneLabel : (isHomeland ? "Collect" : "Place");
        this.primary.image.mainPass.baseColor = collected ? UiColors.disabled : (isHomeland ? UiColors.teal : UiColors.thorn);

        this.layoutOverlay();
        this.overlay.enabled = true;
        this.counter.enabled = false;
        this.startPop();
    }

    /**
     * End-of-collection teaser on the same card: tag, title, image, body, one big teal
     * button and a small text-only Close. Taps are handled by handleTap like any card.
     */
    public openTeaser(image: Texture) {
        this.setTeaserMode(true);
        this.tagText.text = TEASER_TAG;
        this.tagImage.mainPass.baseColor = UiColors.teal;
        this.titleText.text = TEASER_TITLE;
        this.loreText.text = TEASER_BODY;
        const texture = image || this.placeholderImage;
        this.picture.mainPass.baseTex = texture;
        this.picture.stretchMode = StretchMode.Fit;      // show the whole map
        this.picture.mainPass.baseColor = new vec4(1, 1, 1, 1);

        this.primaryEnabled = true;
        this.primary.text.text = TEASER_PLAY;
        this.primary.image.mainPass.baseColor = UiColors.teal;
        this.close.text.text = TEASER_CLOSE;

        this.layoutOverlay();
        this.overlay.enabled = true;
        this.counter.enabled = false;
        this.startPop();
    }

    /** "Play" tapped: the button becomes a disabled, softly pulsing "Coming Soon" pill. */
    public showComingSoon() {
        this.primaryEnabled = false;
        this.primary.text.text = TEASER_SOON;
        this.primary.image.mainPass.baseColor = UiColors.disabled;
        this.soonPulseStart = getTime();
    }

    public get isTeaserOpen(): boolean {
        return this.overlay.enabled && this.teaserMode;
    }

    /** Teaser vs Codex card: button labels/colours that differ, and the pulse. */
    private setTeaserMode(on: boolean) {
        this.teaserMode = on;
        this.stopSoonPulse();
        this.close.image.mainPass.baseColor = on ? new vec4(0, 0, 0, 0) : UiColors.idle; // text-only in the teaser
        this.close.text.textFill.color = on ? UiColors.textDim : UiColors.text;
        this.close.text.text = "Close";
    }

    private updateSoonPulse() {
        if (this.soonPulseStart < 0 || !this.overlay.enabled) {
            return;
        }
        const s = 1 + SOON_PULSE_AMOUNT * Math.sin((getTime() - this.soonPulseStart) * SOON_PULSE_SPEED);
        this.primary.st.scale = new vec3(s, s, 1);
        const c = UiColors.disabled;
        const a = c.w * (0.8 + 0.2 * Math.sin((getTime() - this.soonPulseStart) * SOON_PULSE_SPEED));
        this.primary.image.mainPass.baseColor = new vec4(c.x, c.y, c.z, a);
    }

    private stopSoonPulse() {
        this.soonPulseStart = -1;
        if (this.primary) {
            this.primary.st.scale = vec3.one();
        }
    }

    public hide() {
        this.stopSoonPulse();
        if (this.popStart >= 0) {
            this.applyPop(1); // restore full colours if closed mid-animation
            this.popStart = -1;
        }
        this.overlay.enabled = false;
        this.counter.enabled = this.counterWanted;
    }

    public get isOpen(): boolean {
        return this.overlay.enabled;
    }

    /**
     * Where a tap landed. The overlay covers the whole screen, so while it is open a tap is
     * never "outside": a tap on the dim counts as "close" and nothing reaches the scene.
     * "primary" is ignored while the main button is greyed out.
     */
    public handleTap(screenPos: vec2): CardTapResult {
        if (!this.overlay.enabled) {
            return "outside";
        }
        if (this.primary.st.containsScreenPoint(screenPos)) {
            return this.primaryEnabled ? "primary" : "inside";
        }
        if (this.close.st.containsScreenPoint(screenPos)) {
            return "close";
        }
        return this.cardST.containsScreenPoint(screenPos) ? "inside" : "close";
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
        this.counterWanted = visible;
        this.counter.enabled = visible && !this.isOpen && !this.videoActive;
    }

    /** Checkmarks are only shown while the relic (and so its shards) is on the card. */
    public setChecksVisible(visible: boolean) {
        this.checksVisible = visible;
    }

    // =====================================================================
    // Per-frame updates
    // =====================================================================

    private placeChecks() {
        const halfX = 0.065;
        const halfY = halfX * this.worldCamera.aspect; // keep the tick round on a tall screen
        const show = this.checksVisible && !this.isOpen && !this.videoActive;
        for (let i = 0; i < this.checks.length; i++) {
            const check = this.checks[i];
            const local = show && this.checked[i] ? this.toSafeRegion(this.shards.getShardWorldPosition(i)) : null;
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

    /** Remembers every colour on the overlay (as set by open()) and starts the 0.2 s pop. */
    private startPop() {
        this.fadeImages = [this.dim, this.panel, this.tagImage, this.picture, this.primary.image, this.close.image]
            .map((image) => ({ image, color: image.mainPass.baseColor }));
        this.fadeTexts = [this.tagText, this.titleText, this.loreText, this.primary.text, this.close.text]
            .map((text) => ({ text, color: text.textFill.color }));
        this.popStart = getTime();
        this.applyPop(0);
    }

    private updatePop() {
        if (this.popStart < 0) {
            return;
        }
        const t = Math.min(1, (getTime() - this.popStart) / POP_SECONDS);
        this.applyPop(t);
        if (t >= 1) {
            this.popStart = -1;
        }
    }

    /** t = 0..1: the card scales 0.9 -> 1 (ease-out) while the dim and the card fade in. */
    private applyPop(t: number) {
        const eased = 1 - (1 - t) * (1 - t);
        const s = POP_START_SCALE + (1 - POP_START_SCALE) * eased;
        this.cardST.scale = new vec3(s, s, 1);
        for (const f of this.fadeImages) {
            f.image.mainPass.baseColor = new vec4(f.color.x, f.color.y, f.color.z, f.color.w * t);
        }
        for (const f of this.fadeTexts) {
            f.text.textFill.color = new vec4(f.color.x, f.color.y, f.color.z, f.color.w * t);
        }
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

    /** Builds the dim + card once; open() fills in each entry. Child rects are in card space. */
    private buildOverlay() {
        this.overlay = this.ui.createObject("CodexOverlay", this.root, { left: -1, right: 1, bottom: -1, top: 1 });

        // Dim: reaches well past the safe area so it covers the whole phone screen
        // (the rounded corners of the texture end up off-screen).
        const dimObj = this.ui.createObject("Dim", this.overlay, { left: -2, right: 2, bottom: -2, top: 2 });
        this.dimST = UiFactory.getScreenTransform(dimObj);
        this.dim = this.ui.addImage(dimObj, this.roundedRect, DIM_COLOR);

        this.card = this.ui.createObject("CodexCard", this.overlay, { left: -0.9, right: 0.9, bottom: -0.6, top: 0.8 });
        this.cardST = UiFactory.getScreenTransform(this.card);
        this.panel = this.ui.addImage(this.card, this.panelTexture || this.roundedRect, UiColors.card);

        const left = -1 + CARD_PAD_X;
        const right = 1 - CARD_PAD_X;

        // Category tag (top-left pill)
        const tag = this.ui.createObject("CategoryTag", this.card, { left, right: left + 0.55, bottom: TAG_BOTTOM, top: TAG_TOP });
        this.tagST = UiFactory.getScreenTransform(tag);
        this.tagImage = this.ui.addImage(tag, this.roundedRect, UiColors.teal);
        this.tagText = this.ui.addLabel(tag, "HOMELAND", 15);

        // Title (large)
        const title = this.ui.createObject("Title", this.card, { left, right, bottom: TITLE_BOTTOM, top: TITLE_TOP });
        this.titleText = this.ui.addLabel(title, "", TITLE_SIZE, { left: -1, right: 1, bottom: -1, top: 1 });
        this.titleText.textFill.color = UiColors.moonlight;

        // Card image: full width, 3:2 - the hero of the card. Its height is set in layoutOverlay().
        const pictureObj = this.ui.createObject("ImageSlot", this.card, { left, right, bottom: 0, top: IMAGE_TOP });
        this.pictureST = UiFactory.getScreenTransform(pictureObj);
        this.picture = this.ui.addImage(pictureObj, this.placeholderImage || this.roundedRect, UiColors.textDim, StretchMode.Fit);

        // Lore: left-aligned, bigger, extra line spacing.
        const loreObj = this.ui.createObject("Lore", this.card, { left, right, bottom: BUTTON_TOP + 0.04, top: -0.04 });
        this.loreST = UiFactory.getScreenTransform(loreObj);
        this.loreText = this.ui.addLabel(loreObj, "", LORE_SIZE, { left: -1, right: 1, bottom: -1, top: 1 });
        this.loreText.horizontalOverflow = HorizontalOverflow.Wrap;
        this.loreText.verticalOverflow = VerticalOverflow.Shrink;
        this.loreText.horizontalAlignment = HorizontalAlignment.Left;
        this.loreText.verticalAlignment = VerticalAlignment.Top;
        this.loreText.lineSpacing = LORE_LINE_SPACING;

        // Buttons: one tall, full-width row.
        this.primary = this.buildButton("PrimaryButton", { left, right: -0.02, bottom: BUTTON_BOTTOM, top: BUTTON_TOP }, "Collect", UiColors.teal);
        this.close = this.buildButton("CloseButton", { left: 0.02, right, bottom: BUTTON_BOTTOM, top: BUTTON_TOP }, "Close", UiColors.idle);
    }

    /**
     * Sizes the overlay against the whole phone screen (the Safe Render Region it lives in is
     * smaller than the screen): the dim covers every pixel and the card gets its screen margins.
     * The image takes the space the lore doesn't need: 3:2 at full width if that fits, else
     * 16:9 at full width, else 16:9 centred and as wide as the height allows.
     */
    private layoutOverlay() {
        const toLocal = (x: number, y: number) => this.rootST.screenPointToLocalPoint(new vec2(x, y));
        const topLeft = toLocal(0, 0);
        const bottomRight = toLocal(1, 1);
        UiFactory.setRect(this.dimST, { left: topLeft.x - 0.1, right: bottomRight.x + 0.1, bottom: bottomRight.y - 0.1, top: topLeft.y + 0.1 });

        const cardTopLeft = toLocal(CARD_SCREEN.left, CARD_SCREEN.top);
        const cardBottomRight = toLocal(CARD_SCREEN.right, CARD_SCREEN.bottom);
        UiFactory.setRect(this.cardST, { left: cardTopLeft.x, right: cardBottomRight.x, bottom: cardBottomRight.y, top: cardTopLeft.y });

        // Sizes in "screen heights" so width and height compare fairly.
        const cardW = (CARD_SCREEN.right - CARD_SCREEN.left) * this.uiCamera.aspect;
        const cardH = CARD_SCREEN.bottom - CARD_SCREEN.top;
        const innerW = cardW * (1 - CARD_PAD_X);
        const toUnitsY = (h: number) => (h / cardH) * 2;      // screen heights -> card units
        const maxImage = IMAGE_TOP - (BUTTON_TOP + 0.04 + LORE_MIN_HEIGHT + 0.04);

        let halfWidth = 1 - CARD_PAD_X;                        // card units
        let imageUnits = toUnitsY(innerW / 1.5);               // 3:2, full width
        this.imageAspect = 1.5;
        if (imageUnits > maxImage) {
            imageUnits = toUnitsY(innerW / VIDEO_ASPECT);      // 16:9, full width
            this.imageAspect = VIDEO_ASPECT;
        }
        if (imageUnits > maxImage) {
            imageUnits = maxImage;                             // 16:9, narrower, centred
            const widthScreen = (maxImage / 2) * cardH * VIDEO_ASPECT;
            halfWidth = widthScreen / cardW;
        }
        const imageBottom = IMAGE_TOP - imageUnits;
        const left = -1 + CARD_PAD_X;
        const right = 1 - CARD_PAD_X;
        UiFactory.setRect(this.pictureST, { left: -halfWidth, right: halfWidth, bottom: imageBottom, top: IMAGE_TOP });
        // The teaser's tag ("AETHERFORGE SPIRE") is longer than a category, so its pill is wider.
        UiFactory.setRect(this.tagST, { left, right: left + (this.teaserMode ? 0.95 : 0.55), bottom: TAG_BOTTOM, top: TAG_TOP });
        if (this.teaserMode) {
            // One big button with a small text Close under it; the body ends above the button.
            UiFactory.setRect(this.loreST, { left, right, bottom: TEASER_PRIMARY_TOP + 0.04, top: imageBottom - 0.04 });
            UiFactory.setRect(this.primary.st, { left, right, bottom: TEASER_PRIMARY_BOTTOM, top: TEASER_PRIMARY_TOP });
            UiFactory.setRect(this.close.st, { left: -0.5, right: 0.5, bottom: TEASER_CLOSE_BOTTOM, top: TEASER_CLOSE_TOP });
        } else {
            UiFactory.setRect(this.loreST, { left, right, bottom: BUTTON_TOP + 0.04, top: imageBottom - 0.04 });
            UiFactory.setRect(this.primary.st, { left, right: -0.02, bottom: BUTTON_BOTTOM, top: BUTTON_TOP });
            UiFactory.setRect(this.close.st, { left: 0.02, right, bottom: BUTTON_BOTTOM, top: BUTTON_TOP });
        }
    }

    // =====================================================================
    // Sword transformation video
    // =====================================================================

    public get isVideoPlaying(): boolean {
        return this.videoActive;
    }

    /** stop() throws unless the video is playing or paused, so check first. */
    private static safeStop(control: VideoTextureProvider) {
        const status = control.status;
        if (status === VideoStatus.Playing || status === VideoStatus.Paused) {
            control.stop();
        }
    }

    /**
     * Plays a video texture once on a centred 16:9 panel over a dark dim, then fades it out
     * (0.3 s) and calls onEnd. The counter and checkmarks hide meanwhile.
     */
    public playVideo(texture: Texture, onEnd: () => void) {
        const control = texture.control as VideoTextureProvider;
        this.videoControl = control;
        this.videoOnEnd = onEnd;
        this.videoActive = true;
        this.videoFadingOut = false;
        this.videoImage.mainPass.baseTex = texture;
        this.layoutVideo();
        this.video.enabled = true;
        this.counter.enabled = false;

        if (this.videoDoneHooked.indexOf(control) < 0) {
            control.onPlaybackDone.add(() => this.onVideoDone(control));
            this.videoDoneHooked.push(control);
        }
        CodexCardView.safeStop(control);
        control.play(1); // once, no loop
        this.videoFadeStart = getTime();
        this.applyVideoAlpha(0);
    }

    /** Tap on the video: jump to the end and go straight on (no fade). */
    public skipVideo() {
        if (!this.videoActive) {
            return;
        }
        if (this.videoControl) {
            CodexCardView.safeStop(this.videoControl);
        }
        this.finishVideo(true);
    }

    /** Reset: stop and hide without calling onEnd, so the video can play again later. */
    public stopVideo() {
        if (this.videoControl) {
            CodexCardView.safeStop(this.videoControl);
        }
        this.videoOnEnd = null;
        this.videoActive = false;
        this.videoFadingOut = false;
        this.videoFadeStart = -1;
        this.video.enabled = false;
        this.counter.enabled = this.counterWanted && !this.isOpen;
    }

    private onVideoDone(control: VideoTextureProvider) {
        if (!this.videoActive || control !== this.videoControl || this.videoFadingOut) {
            return; // skipped, reset, or a stale event
        }
        this.videoFadingOut = true;
        this.videoFadeStart = getTime();
    }

    private updateVideoFade() {
        this.watchVideoEnd();
        if (!this.videoActive || this.videoFadeStart < 0) {
            return;
        }
        const age = getTime() - this.videoFadeStart;
        if (this.videoFadingOut) {
            const t = Math.min(1, age / VIDEO_FADE_OUT);
            this.applyVideoAlpha(1 - t);
            if (t >= 1) {
                this.finishVideo(false);
            }
        } else {
            const t = Math.min(1, age / VIDEO_FADE_IN);
            this.applyVideoAlpha(t);
            if (t >= 1) {
                this.videoFadeStart = -1; // playing; wait for onPlaybackDone
            }
        }
    }

    /**
     * Backup for onPlaybackDone, which does not always fire (in Lens Studio's preview a
     * play(1) video loops): when the time reaches the last frame - or wraps back to the
     * start - pause on the last frame and treat it as done.
     */
    private watchVideoEnd() {
        const c = this.videoControl;
        if (!this.videoActive || this.videoFadingOut || !c || c.status !== VideoStatus.Playing) {
            this.lastVideoTime = 0;
            return;
        }
        const t = c.currentTime;
        const atEnd = c.duration > 0 && t >= c.duration - VIDEO_END_MARGIN;
        const wrapped = t < this.lastVideoTime - 0.5;
        this.lastVideoTime = t;
        if (atEnd || wrapped) {
            c.pause();
            this.onVideoDone(c);
        }
    }

    private finishVideo(skipped: boolean) {
        const onEnd = this.videoOnEnd;
        this.videoOnEnd = null;
        this.videoActive = false;
        this.videoFadingOut = false;
        this.videoFadeStart = -1;
        this.video.enabled = false;
        this.counter.enabled = this.counterWanted && !this.isOpen;
        if (onEnd) {
            onEnd();
        }
    }

    private applyVideoAlpha(a: number) {
        this.videoDim.mainPass.baseColor = new vec4(VIDEO_DIM.x, VIDEO_DIM.y, VIDEO_DIM.z, VIDEO_DIM.w * a);
        this.videoImage.mainPass.baseColor = new vec4(1, 1, 1, a);
    }

    /** 16:9 panel at 95% of the screen width, centred; dim over the whole screen. */
    private layoutVideo() {
        const toLocal = (x: number, y: number) => this.rootST.screenPointToLocalPoint(new vec2(x, y));
        const topLeft = toLocal(0, 0);
        const bottomRight = toLocal(1, 1);
        UiFactory.setRect(this.videoDimST, { left: topLeft.x - 0.1, right: bottomRight.x + 0.1, bottom: bottomRight.y - 0.1, top: topLeft.y + 0.1 });

        const heightFraction = (VIDEO_WIDTH * this.uiCamera.aspect) / VIDEO_ASPECT; // of the screen height
        const a = toLocal((1 - VIDEO_WIDTH) / 2, 0.5 - heightFraction / 2);
        const b = toLocal((1 + VIDEO_WIDTH) / 2, 0.5 + heightFraction / 2);
        UiFactory.setRect(this.videoST, { left: a.x, right: b.x, bottom: b.y, top: a.y });
    }

    private buildVideoOverlay() {
        this.video = this.ui.createObject("SwordVideoOverlay", this.root, { left: -1, right: 1, bottom: -1, top: 1 });
        const dim = this.ui.createObject("VideoDim", this.video, { left: -2, right: 2, bottom: -2, top: 2 });
        this.videoDimST = UiFactory.getScreenTransform(dim);
        this.videoDim = this.ui.addImage(dim, this.roundedRect, VIDEO_DIM);
        const panel = this.ui.createObject("VideoPanel", this.video, { left: -0.95, right: 0.95, bottom: -0.3, top: 0.3 });
        this.videoST = UiFactory.getScreenTransform(panel);
        this.videoImage = this.ui.addImage(panel, this.placeholderImage || this.roundedRect, new vec4(1, 1, 1, 1), StretchMode.Fit);
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
        const text = this.ui.addLabel(obj, label, BUTTON_TEXT_SIZE);
        return { st: UiFactory.getScreenTransform(obj), image, text };
    }
}
