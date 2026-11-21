import { RelicEffects } from "./RelicEffects";
import { UiFactory, UiColors, UiRect } from "./UiFactory";
import { TouchIndicator } from "./TouchIndicator";
import { IconToggleButton } from "./IconToggleButton";

/**
 * RelicMenuController
 * -------------------
 * The collapsible, DRAGGABLE menu for the extra features.
 *
 *        [ ⋮⋮ ]  (Relic)        <- grab handle + round Relic button (tap = open / close)
 *   [MOTION] [ LOOK ] [WORLD]   <- tabs
 *   [       Spin        ]       <- buttons of the selected tab
 *   ...
 *     MOTION : Spin, Speed (slow/fast), Orbit, Bounce
 *     LOOK   : Glow, Light
 *     WORLD  : Lore, Reset
 *
 * Toggles that are ON are thorn violet; the selected tab is moonlight lavender. The menu
 * closes itself 5 s after the last tap on it. "Lore" opens a story card with the map of the
 * Wyrendal Dominion and a QR code of the project page; tap outside the card to close. The
 * Lens hides its hint while the card is open.
 *
 * LORE SITE LINK
 *   Snapchat Lenses on phones have no API to open a web page (the only link API,
 *   DeepLinkModule, is Spectacles-only). So the card shows a small QR code + the address, and
 *   its "Open Lore Site" pill swaps the map for a big QR code that another phone can scan.
 *   The pill has its own branch in handleTap, checked before "close", so tapping it never
 *   closes the card; taps anywhere else on the card are swallowed too.
 *
 * TAPS + SOUND BUTTONS (IconToggleButton)
 *   Two small round icon buttons at the top right, under Snapchat's flip-camera icon and
 *   above the Relic button: Taps (touch indicator: teal rings + dot under the finger, for
 *   demo recordings) and, to its left, Sound (mutes every Lens sound). ON: bright icon, thin
 *   teal ring. OFF: icon greyed to 40% with a red circle-slash, grey ring. Taps on them
 *   bounce them and are consumed here, so they never reach the relic, shards, placement or
 *   the ripple. Reset leaves both ON/OFF states alone.
 *
 * WORLD > Occlusion turns the World Mesh occluder + person cutout on or off (onOcclusionToggled).
 *
 * DRAGGING
 *   Everything lives inside one "MenuFrame" ScreenTransform. Pressing the ⋮⋮ handle and
 *   moving the finger moves that frame (touch position -> Safe Render Region coordinates
 *   via ScreenTransform.screenPointToLocalPoint). Only the handle drags, so buttons work
 *   normally. The frame is clamped so the whole OPEN menu always stays on screen, and on
 *   release it snaps to the nearest side (left or right); on the left side the Relic button
 *   and handle swap sides so the button hugs the edge. The position is kept until Reset.
 *   A drag never becomes a tap (shard, card or tap-to-place), and long-press Reset is
 *   ignored on the handle.
 *
 * Coordinates: the Safe Render Region is -1..1 (x: left..right, y: bottom..top). The layout
 * constants below are written for the default spot on the right, then converted into the
 * frame's own -1..1 space by toFrame().
 */

type MenuButton = {
    label: () => string;          // text shown on the button (can change, e.g. "Speed: Fast")
    isActive: () => boolean;      // highlighted when true
    onTap: () => void;
    st?: ScreenTransform;
    image?: Image;
    text?: Text;
};

type MenuTab = {
    title: string;
    buttons: MenuButton[];
    st?: ScreenTransform;
    image?: Image;
    text?: Text;
    group?: SceneObject;          // container holding this tab's buttons
};

type Side = "left" | "right";

// ---------- Taps + Sound buttons: screen positions (fractions of the screen) ----------
const TAPS_CENTER = new vec2(0.91, 0.185);     // top right, under the flip-camera icon, above the Relic button
const SOUND_CENTER = new vec2(0.785, 0.185);   // just left of Taps
const ICON_BUTTON_DIAMETER = 44 / 390;         // ~44 pt on a 390 pt wide phone, fraction of screen width

// ---------- Layout for the default (right side) spot, in Safe Render Region units ----------
const FULL: UiRect = { left: -1, right: 1, bottom: -1, top: 1 };
const MENU_BUTTON: UiRect = { left: 0.70, right: 0.94, bottom: 0.26, top: 0.40 };
// Glowing teal border on the Relic button (rects in the button's own -1..1 space).
const RELIC_RING_RECT: UiRect = { left: -1.17, right: 1.17, bottom: -1.17, top: 1.17 };
// The glow texture is solid out to 55% of its radius, then fades, so 1.17 / 0.55 puts the
// start of the fade right at the ring's edge.
const RELIC_GLOW_RECT: UiRect = { left: -2.13, right: 2.13, bottom: -2.13, top: 2.13 };
const RELIC_RING_COLOR = new vec4(0.35, 1.0, 0.9, 1);      // bright aether teal
const RELIC_GLOW_COLOR = new vec4(0.12, 0.9, 0.8, 1);
const RELIC_GLOW_MIN = 0.7, RELIC_GLOW_MAX = 1.0;          // breathing alpha range
const RELIC_GLOW_SPEED = 2.2;                              // radians per second
const HANDLE_HIT: UiRect = { left: 0.42, right: 0.68, bottom: 0.27, top: 0.39 };   // easy-to-grab area
const HANDLE_PILL: UiRect = { left: -0.75, right: 0.75, bottom: -0.42, top: 0.42 }; // pill inside the hit area
const PANEL = { left: 0.08, right: 0.94, top: 0.235 };
const TAB_ROW = { left: 0.11, right: 0.91, bottom: 0.15, top: 0.222, gap: 0.02 };
const BUTTON_COLUMN = { left: 0.11, right: 0.91, firstTop: 0.13, height: 0.085, gap: 0.018 };
const MAX_ROWS = 4;                                            // longest tab (MOTION)
const LORE_CARD: UiRect = { left: -0.86, right: 0.86, bottom: -0.80, top: 0.74 };

// Lore card contents, in the card's own -1..1 space (8% padding = 0.16 of the -1..1 width).
const LORE_LAYOUT = {
    title: { left: -0.9, right: 0.9, bottom: 0.82, top: 0.96 },
    body: { left: -0.84, right: 0.84, bottom: 0.48, top: 0.80 },
    map: { left: -0.84, right: 0.84, bottom: -0.36, top: 0.44 },   // area the 3:2 map is fitted into
    caption: { left: -0.84, right: 0.84, bottom: -0.47, top: -0.38 },
    bigQr: { left: -0.84, right: 0.84, bottom: -0.47, top: 0.44 }, // replaces map + caption
    smallQr: { left: -0.84, right: -0.40, bottom: -0.88, top: -0.52 },
    address: { left: -0.34, right: 0.84, bottom: -0.66, top: -0.52 },
    sitePill: { left: -0.34, right: 0.84, bottom: -0.88, top: -0.69 },
    footer: { left: -0.9, right: 0.9, bottom: -0.98, top: -0.91 },
};

// Project page. Phone Lenses can't open web links, so it is shown as a QR code + text.
const LORE_LINK = "blue2233.github.io/aether-relic-xr";
const SITE_PILL_LABEL = "Open Lore Site";
const SITE_PILL_BACK = "Back to Map";
const LINK_TEAL = new vec4(0.35, 1.0, 0.9, 1);    // bright aether teal
const MAP_ASPECT = 3 / 2;          // dominion-map-1200 is 1200 x 800
const MAP_BORDER = 0.025;          // thin teal frame, as a fraction of the map area's height
const MAP_CAPTION = "The Wyrendal Dominion";

// The frame = the box around the open menu (button on top, longest tab at the bottom).
const FRAME_DEFAULT: UiRect = {
    left: PANEL.left,
    right: MENU_BUTTON.right,
    bottom: BUTTON_COLUMN.firstTop - MAX_ROWS * (BUTTON_COLUMN.height + BUTTON_COLUMN.gap) + BUTTON_COLUMN.gap - 0.03,
    top: MENU_BUTTON.top,
};
const EDGE_MARGIN = 0.04;       // gap kept between the menu and the screen edge
const SNAP_SECONDS = 0.18;      // length of the snap-to-edge animation
const DRAG_TAP_GUARD = 0.3;     // a tap this soon after a drag is ignored

const LORE_TITLE = "The Aether Codex";
const LORE_BODY =
    "Once, the Wyrendal Dominion was a single nation, at peace. Then came the Rupture, and " +
    "when it was over, the Aetherforge Spire stood at the heart of it all.";

@component
export class RelicMenuController extends BaseScriptComponent {
    @input
    @hint("Parent for the menu: the Safe Render Region under the Orthographic Camera")
    uiParent: SceneObject;

    @input
    @hint("The Orthographic Camera that draws the 2D UI (the menu goes on its render layer)")
    uiCamera: Camera;

    @input
    @hint("Image material for buttons (UI/UIButtonMaterial); each button gets its own copy")
    buttonMaterial: Material;

    @input
    @hint("Rounded-rectangle texture (UI/RoundedRect)")
    roundedRect: Texture;

    @input
    @hint("Circle texture for the round menu button (UI/Circle)")
    circle: Texture;

    @input
    @hint("Rounded texture with small corners for tall panels (UI/PanelRect)")
    panelTexture: Texture;

    @input
    @hint("Grip dots shown on the drag handle (UI/Grip)")
    gripTexture: Texture;

    @input
    @hint("Map shown on the Lore card (Codex/Images/dominion-map-1200)")
    loreMapTexture: Texture;

    @input
    @hint("QR code of the project page, shown on the Lore card (UI/LoreSiteQR)")
    loreQrTexture: Texture;

    @input
    @hint("Glow ring texture for the Relic button's teal halo (UI/RelicGlowRing)")
    glowTexture: Texture;

    @input
    @hint("Pointing-finger tap icon for the Taps button (UI/TapFinger)")
    tapFingerTexture: Texture;

    @input
    @hint("Circle-slash 'off' symbol for the Taps button (UI/TapCancel)")
    tapCancelTexture: Texture;

    @input
    @hint("Thin ring outline: the Taps button ring and the touch rings (UI/RingOutline)")
    ringOutlineTexture: Texture;

    @input
    @hint("Speaker with sound waves, for the Sound button (UI/SoundOn)")
    soundOnTexture: Texture;

    @input
    @hint("Bare speaker, for the Sound button when muted (UI/SoundMuted)")
    soundMutedTexture: Texture;

    @input
    @hint("The effects the MOTION and LOOK buttons switch")
    effects: RelicEffects;

    @input
    @hint("Seconds after the last menu tap before the menu closes itself")
    autoCollapseSeconds: number = 5;

    /** WORLD > Reset. Set by AetherLensController. */
    public onReset: () => void = () => {};
    /** The menu only opens when this says so (the Lens: once the relic is summoned). */
    public canOpen: () => boolean = () => true;
    /** Called when the Relic button is tapped while the menu is locked. */
    public onLockedTap: () => void = () => {};
    /** Sound button: true = sound on, false = muted. Set by AetherLensController. */
    public onSoundToggled: (on: boolean) => void = () => {};
    /** WORLD > Occlusion: true = occlusion on. Set by AetherLensController. */
    public onOcclusionToggled: (on: boolean) => void = () => {};
    /** Lore card opened (true) or closed (false); the Lens hides its hint meanwhile. */
    public onLoreToggled: (open: boolean) => void = () => {};

    // ---------- UI objects ----------
    private ui: UiFactory;
    private root: SceneObject;              // full Safe Render Region, never moves
    private rootST: ScreenTransform;
    private frameST: ScreenTransform;       // moves when the menu is dragged
    private menuButton: { st: ScreenTransform; image: Image; text: Text };
    private relicGlow: Image | null = null;  // soft halo behind the Relic button
    private handle: { st: ScreenTransform; image: Image };
    private stack: SceneObject;             // everything that shows when the menu is open
    private panelST: ScreenTransform;       // dark backdrop behind tabs + buttons
    private loreCard: SceneObject;
    private loreCardST: ScreenTransform;
    private loreMapGroup: SceneObject;       // map + caption
    private loreBigQr: SceneObject;          // big QR shown instead of the map
    private sitePill: { st: ScreenTransform; text: Text };
    private loreMapAreaST: ScreenTransform;  // where the map may go
    private loreMapFrameST: ScreenTransform; // thin teal border
    private loreMapST: ScreenTransform;      // the map itself
    private tabs: MenuTab[] = [];

    // ---------- Menu state ----------
    private selectedTab = 0;
    private expanded = false;
    private hidden = false;                 // hidden while a Codex card is open
    private collapseTimer: DelayedCallbackEvent;
    private resetFlashTimer: DelayedCallbackEvent;
    private resetFlashing = false;

    // ---------- Taps button + touch indicator ----------
    private tapsButton: IconToggleButton | null = null;   // states kept through Reset
    private soundButton: IconToggleButton | null = null;
    private touchFx: TouchIndicator | null = null;
    private occlusionOn = true;

    // ---------- Drag state ----------
    private side: Side = "right";
    private frameCenter = new vec2(0, 0);   // current frame centre (Safe Region units)
    private dragging = false;
    private dragStartTouch = new vec2(0, 0);
    private dragStartCenter = new vec2(0, 0);
    private lastDragEnd = -10;
    private snap: { from: vec2; to: vec2; start: number } | null = null;

    onAwake() {
        if (!this.uiParent || !this.uiCamera || !this.buttonMaterial || !this.roundedRect || !this.effects) {
            print("RelicMenuController: a required input is missing; check the Inspector.");
            return;
        }
        this.ui = new UiFactory(this.uiCamera.renderLayer, this.buttonMaterial);
        this.collapseTimer = this.createEvent("DelayedCallbackEvent");
        this.collapseTimer.bind(() => this.setExpanded(false));
        this.resetFlashTimer = this.createEvent("DelayedCallbackEvent");
        this.resetFlashTimer.bind(() => {
            this.resetFlashing = false;
            this.refresh();
        });

        this.tabs = this.defineTabs();
        this.buildMenu();
        this.buildLoreCard();
        this.fitPanelToTab();
        this.resetPosition();
        this.setExpanded(false);

        // Touch input: drag the menu, and feed the touch indicator (taps arrive via handleTap).
        this.createEvent("TouchStartEvent").bind((e) => {
            const pos = e.getTouchPosition();
            this.onDragStart(pos);
            if (this.touchFx && !this.isOnIconButton(pos)) {
                this.touchFx.touchStart(pos); // its own button never makes a ripple
            }
        });
        this.createEvent("TouchMoveEvent").bind((e) => {
            this.onDragMove(e.getTouchPosition());
            if (this.touchFx) {
                this.touchFx.touchMove(e.getTouchPosition());
            }
        });
        this.createEvent("TouchEndEvent").bind(() => {
            this.onDragEnd();
            if (this.touchFx) {
                this.touchFx.touchEnd();
            }
        });
        // After every script's onAwake: the screen layout is known and the indicator is the
        // last UI created, so it draws on top of everything.
        this.createEvent("OnStartEvent").bind(() => {
            this.buildIconButtons();
            if (this.ringOutlineTexture && this.circle) {
                this.touchFx = new TouchIndicator(this.ui, this.uiParent, this.ringOutlineTexture, this.circle, () => this.uiCamera.aspect);
                this.touchFx.setEnabled(!this.tapsButton || this.tapsButton.isOn());
            }
        });
        this.createEvent("UpdateEvent").bind(() => {
            this.updateSnap();
            if (this.tapsButton) {
                this.tapsButton.update();
            }
            if (this.soundButton) {
                this.soundButton.update();
            }
            if (this.touchFx) {
                this.touchFx.update();
            }
            this.breatheRelicGlow();
        });
    }

    // =====================================================================
    // Menu contents: one entry per feature
    // =====================================================================

    private defineTabs(): MenuTab[] {
        const fx = this.effects;
        return [
            {
                title: "MOTION",
                buttons: [
                    { label: () => "Spin", isActive: () => fx.spinOn, onTap: () => fx.toggleSpin() },
                    { label: () => (fx.fast ? "Speed: Fast" : "Speed: Slow"), isActive: () => fx.fast, onTap: () => fx.toggleSpeed() },
                    { label: () => "Orbit", isActive: () => fx.orbitOn, onTap: () => fx.toggleOrbit() },
                    { label: () => "Bounce", isActive: () => fx.bounceOn, onTap: () => fx.toggleBounce() },
                ],
            },
            {
                title: "LOOK",
                buttons: [
                    { label: () => "Glow", isActive: () => fx.glowOn, onTap: () => fx.toggleGlow() },
                    { label: () => (fx.warmLightOn ? "Light: Warm" : "Light: Normal"), isActive: () => fx.warmLightOn, onTap: () => fx.toggleLight() },
                ],
            },
            {
                title: "WORLD",
                buttons: [
                    { label: () => "Lore", isActive: () => this.loreCard.enabled, onTap: () => this.showLore() },
                    { label: () => (this.occlusionOn ? "Occlusion: On" : "Occlusion: Off"), isActive: () => this.occlusionOn, onTap: () => this.toggleOcclusion() },
                    { label: () => "Reset", isActive: () => this.resetFlashing, onTap: () => this.pressReset() },
                ],
            },
        ];
    }

    // =====================================================================
    // Tap handling
    // =====================================================================

    /** Handles a tap. Returns true if the menu or lore card used it (or it ended a drag). */
    public handleTap(screenPos: vec2): boolean {
        if (this.loreCard.enabled) {
            // The site pill is handled first and stops here, so it can never close the card.
            if (this.sitePill.st.containsScreenPoint(screenPos)) {
                this.toggleBigQr();
                return true;
            }
            // Any other tap ON the card is swallowed; only a tap outside it closes.
            if (!this.loreCardST.containsScreenPoint(screenPos)) {
                this.hideLore();
            }
            return true;
        }
        // The finger was dragging the menu: never let that count as a scene tap.
        if (this.dragging || getTime() - this.lastDragEnd < DRAG_TAP_GUARD) {
            return true;
        }
        // Taps button: toggle the touch indicator; the tap goes no further.
        if (this.tapsButton && this.isOnIconButton(screenPos) && this.tapsButton.containsScreenPoint(screenPos)) {
            this.tapsButton.setOn(!this.tapsButton.isOn());
            this.tapsButton.bounce();
            if (this.touchFx) {
                this.touchFx.setEnabled(this.tapsButton.isOn());
            }
            return true;
        }
        if (this.soundButton && this.isOnIconButton(screenPos) && this.soundButton.containsScreenPoint(screenPos)) {
            this.soundButton.setOn(!this.soundButton.isOn());
            this.soundButton.bounce();
            this.onSoundToggled(this.soundButton.isOn());
            return true;
        }
        if (this.hidden) {
            return false;
        }
        if (this.handle.st.containsScreenPoint(screenPos)) {
            return true; // a tap on the handle does nothing
        }
        if (this.menuButton.st.containsScreenPoint(screenPos)) {
            if (!this.expanded && !this.canOpen()) {
                this.onLockedTap(); // nothing to control yet: the Lens mocks you instead
                return true;
            }
            this.setExpanded(!this.expanded);
            return true;
        }
        if (!this.expanded) {
            return false;
        }
        for (let i = 0; i < this.tabs.length; i++) {
            if (this.tabs[i].st.containsScreenPoint(screenPos)) {
                this.selectTab(i);
                this.restartCollapseTimer();
                return true;
            }
        }
        for (const button of this.tabs[this.selectedTab].buttons) {
            if (button.st.containsScreenPoint(screenPos)) {
                button.onTap();
                this.refresh();
                this.restartCollapseTimer();
                return true;
            }
        }
        // A tap on the panel's empty space is still "on the menu".
        if (this.panelST.containsScreenPoint(screenPos)) {
            this.restartCollapseTimer();
            return true;
        }
        return false;
    }

    /** True if the point is on the menu, its handle or the lore card (long-press is ignored there). */
    public isUiPoint(screenPos: vec2): boolean {
        if (this.loreCard.enabled || this.dragging) {
            return true;
        }
        return !this.hidden && (this.isOnIconButton(screenPos)
            || this.handle.st.containsScreenPoint(screenPos)
            || this.menuButton.st.containsScreenPoint(screenPos)
            || (this.expanded && this.panelST.containsScreenPoint(screenPos)));
    }

    /** Hides the whole menu (e.g. while a Codex card is open) or shows it again. */
    public setVisible(visible: boolean) {
        this.hidden = !visible;
        if (!visible) {
            this.setExpanded(false);
            this.dragging = false;
        }
        this.root.enabled = visible;
    }

    // =====================================================================
    // Dragging
    // =====================================================================

    /** Finger down on the ⋮⋮ handle: start dragging the whole menu. */
    private onDragStart(screenPos: vec2) {
        if (this.hidden || this.loreCard.enabled || !this.handle.st.containsScreenPoint(screenPos)) {
            return;
        }
        const local = this.toRegion(screenPos);
        if (!local) {
            return;
        }
        this.dragging = true;
        this.snap = null;
        this.dragStartTouch = local;
        this.dragStartCenter = this.frameCenter;
        this.collapseTimer.reset(1e6); // don't auto-close while being moved
    }

    /** Finger moves: the menu follows it, clamped to the screen. */
    private onDragMove(screenPos: vec2) {
        if (!this.dragging) {
            return;
        }
        const local = this.toRegion(screenPos);
        if (!local) {
            return;
        }
        this.setFrameCenter(this.dragStartCenter.add(local.sub(this.dragStartTouch)));
    }

    /** Finger up: snap to the nearest side. */
    private onDragEnd() {
        if (!this.dragging) {
            return;
        }
        this.dragging = false;
        this.lastDragEnd = getTime();
        this.snapToNearestEdge();
        if (this.expanded) {
            this.restartCollapseTimer();
        }
    }

    /** Starts a short slide to the left or right edge, whichever is closer. */
    private snapToNearestEdge() {
        const side: Side = this.frameCenter.x < 0 ? "left" : "right";
        this.setSide(side);
        const halfW = (FRAME_DEFAULT.right - FRAME_DEFAULT.left) / 2;
        const x = side === "left" ? -1 + EDGE_MARGIN + halfW : 1 - EDGE_MARGIN - halfW;
        this.snap = { from: this.frameCenter, to: this.clampCenter(new vec2(x, this.frameCenter.y)), start: getTime() };
    }

    /** Runs the snap animation (ease out). */
    private updateSnap() {
        if (!this.snap) {
            return;
        }
        const k = Math.min(1, (getTime() - this.snap.start) / SNAP_SECONDS);
        const eased = 1 - Math.pow(1 - k, 3);
        this.setFrameCenter(vec2.lerp(this.snap.from, this.snap.to, eased));
        if (k >= 1) {
            this.snap = null;
        }
    }

    /** Back to the default spot on the right (called on Reset). */
    public resetPosition() {
        this.dragging = false;
        this.snap = null;
        this.setSide("right");
        this.setFrameCenter(new vec2((FRAME_DEFAULT.left + FRAME_DEFAULT.right) / 2, (FRAME_DEFAULT.bottom + FRAME_DEFAULT.top) / 2));
    }

    /** Moves the frame so its centre is at `center`, kept fully inside the screen. */
    private setFrameCenter(center: vec2) {
        this.frameCenter = this.clampCenter(center);
        const halfW = (FRAME_DEFAULT.right - FRAME_DEFAULT.left) / 2;
        const halfH = (FRAME_DEFAULT.top - FRAME_DEFAULT.bottom) / 2;
        UiFactory.setRect(this.frameST, {
            left: this.frameCenter.x - halfW,
            right: this.frameCenter.x + halfW,
            bottom: this.frameCenter.y - halfH,
            top: this.frameCenter.y + halfH,
        });
    }

    /** Clamp: the whole OPEN menu (largest tab) must stay inside the Safe Render Region. */
    private clampCenter(center: vec2): vec2 {
        const halfW = (FRAME_DEFAULT.right - FRAME_DEFAULT.left) / 2;
        const halfH = (FRAME_DEFAULT.top - FRAME_DEFAULT.bottom) / 2;
        const limitX = 1 - EDGE_MARGIN - halfW;
        const limitY = 1 - EDGE_MARGIN - halfH;
        return new vec2(MathUtils.clamp(center.x, -limitX, limitX), MathUtils.clamp(center.y, -limitY, limitY));
    }

    /** Right side: handle left of the button. Left side: mirrored, so the button hugs the edge. */
    private setSide(side: Side) {
        this.side = side;
        UiFactory.setRect(this.menuButton.st, this.sideRect(MENU_BUTTON));
        UiFactory.setRect(this.handle.st, this.sideRect(HANDLE_HIT));
    }

    private sideRect(rect: UiRect): UiRect {
        const r = this.toFrame(rect);
        return this.side === "right" ? r : { left: -r.right, right: -r.left, bottom: r.bottom, top: r.top };
    }

    /** Touch position (0..1 screen space) -> Safe Render Region coordinates (-1..1). */
    private toRegion(screenPos: vec2): vec2 | null {
        return this.rootST.screenPointToLocalPoint(screenPos);
    }

    /** Safe Region rect (default layout) -> the frame's own -1..1 space. */
    private toFrame(rect: UiRect): UiRect {
        const cx = (FRAME_DEFAULT.left + FRAME_DEFAULT.right) / 2;
        const cy = (FRAME_DEFAULT.bottom + FRAME_DEFAULT.top) / 2;
        const hw = (FRAME_DEFAULT.right - FRAME_DEFAULT.left) / 2;
        const hh = (FRAME_DEFAULT.top - FRAME_DEFAULT.bottom) / 2;
        return {
            left: (rect.left - cx) / hw,
            right: (rect.right - cx) / hw,
            bottom: (rect.bottom - cy) / hh,
            top: (rect.top - cy) / hh,
        };
    }

    // =====================================================================
    // Open / close, tabs, highlights
    // =====================================================================

    /** Slow pulse of the Relic button's teal halo. */
    private breatheRelicGlow() {
        if (!this.relicGlow) {
            return;
        }
        const k = 0.5 + 0.5 * Math.sin(getTime() * RELIC_GLOW_SPEED);
        const a = RELIC_GLOW_MIN + (RELIC_GLOW_MAX - RELIC_GLOW_MIN) * k;
        const c = RELIC_GLOW_COLOR;
        this.relicGlow.mainPass.baseColor = new vec4(c.x, c.y, c.z, a);
    }

    /** Opens or closes the stack. Opening starts the 5 s auto-collapse countdown. */
    private setExpanded(expanded: boolean) {
        this.expanded = expanded;
        this.stack.enabled = expanded;
        if (expanded) {
            this.restartCollapseTimer();
        }
        this.refresh();
    }

    private restartCollapseTimer() {
        this.collapseTimer.reset(this.autoCollapseSeconds);
    }

    /** Shows one tab's buttons and highlights that tab. */
    private selectTab(index: number) {
        this.selectedTab = index;
        this.fitPanelToTab();
        this.refresh();
    }

    /** Shrinks the backdrop so it ends just below the selected tab's last button. */
    private fitPanelToTab() {
        const bottom = this.panelBottom(this.tabs[this.selectedTab].buttons.length);
        UiFactory.setRect(this.panelST, this.toFrame({ left: PANEL.left, right: PANEL.right, bottom, top: PANEL.top }));
    }

    private panelBottom(rows: number): number {
        return BUTTON_COLUMN.firstTop - rows * (BUTTON_COLUMN.height + BUTTON_COLUMN.gap) + BUTTON_COLUMN.gap - 0.03;
    }

    /** Re-draws every label and highlight from the current state. */
    public refresh() {
        this.paint(this.menuButton.image, this.menuButton.text, this.expanded ? UiColors.moonlight : UiColors.idle,
            this.expanded ? UiColors.textDark : UiColors.text);

        this.tabs.forEach((tab, i) => {
            const selected = i === this.selectedTab;
            this.paint(tab.image, tab.text, selected ? UiColors.moonlight : UiColors.idle, selected ? UiColors.textDark : UiColors.text);
            tab.group.enabled = selected;
            for (const button of tab.buttons) {
                button.text.text = button.label();
                this.paint(button.image, button.text, button.isActive() ? UiColors.thorn : UiColors.idle, UiColors.text);
            }
        });
    }

    private paint(image: Image, text: Text, fill: vec4, textColor: vec4) {
        image.mainPass.baseColor = fill;
        text.textFill.color = textColor;
    }

    // =====================================================================
    // WORLD actions
    // =====================================================================

    /** Reset: flashes the button for a moment and asks the Lens to start over. */
    private pressReset() {
        this.resetFlashing = true;
        this.resetFlashTimer.reset(0.25);
        this.onReset();
    }

    /** Lore: shows the story card (tap outside it to close). */
    private showLore() {
        this.setExpanded(false);
        this.setBigQr(false);
        this.loreCard.enabled = true;
        this.root.enabled = false; // nothing draws over the card
        this.fitLoreMap();
        this.onLoreToggled(true);  // the Lens hides its hint while the card is open
    }

    private hideLore() {
        this.loreCard.enabled = false;
        this.setBigQr(false);
        this.root.enabled = !this.hidden;
        this.onLoreToggled(false);
    }

    /** "Open Lore Site": no phone API can open a URL, so show a big scannable QR instead. */
    private toggleBigQr() {
        this.setBigQr(!(this.loreBigQr && this.loreBigQr.enabled));
    }

    private setBigQr(on: boolean) {
        if (!this.loreBigQr) {
            return;
        }
        this.loreBigQr.enabled = on;
        this.loreMapGroup.enabled = !on;
        this.sitePill.text.text = on ? SITE_PILL_BACK : SITE_PILL_LABEL;
    }

    /**
     * Sizes the map to exactly 3:2 inside its area (centred, nothing cropped), and the teal
     * frame just around it. Done when the card opens, so it matches the phone's screen shape.
     */
    private fitLoreMap() {
        if (!this.loreMapAreaST) {
            return;
        }
        // Size of the map area on screen, in pixel-proportional units.
        const a = this.loreMapAreaST.localPointToScreenPoint(new vec2(-1, -1));
        const b = this.loreMapAreaST.localPointToScreenPoint(new vec2(1, 1));
        const areaAspect = (Math.abs(b.x - a.x) * this.uiCamera.aspect) / Math.max(Math.abs(b.y - a.y), 1e-4);

        // Largest 3:2 box that fits (in the area's -1..1 space), leaving room for the border.
        const borderY = MAP_BORDER * 2;
        const borderX = borderY / areaAspect; // same thickness in pixels on all sides
        let halfW = 1 - borderX;
        let halfH = (halfW * areaAspect) / MAP_ASPECT;
        if (halfH > 1 - borderY) {
            halfH = 1 - borderY;
            halfW = (halfH * MAP_ASPECT) / areaAspect;
        }
        UiFactory.setRect(this.loreMapST, { left: -halfW, right: halfW, bottom: -halfH, top: halfH });
        UiFactory.setRect(this.loreMapFrameST, { left: -halfW - borderX, right: halfW + borderX, bottom: -halfH - borderY, top: halfH + borderY });
    }

    // =====================================================================
    // Building the UI
    // =====================================================================

    private buildMenu() {
        this.root = this.ui.createObject("RelicMenu", this.uiParent, FULL);
        this.rootST = UiFactory.getScreenTransform(this.root);

        // The frame holds everything that moves together when dragged.
        const frame = this.ui.createObject("MenuFrame", this.root, FRAME_DEFAULT);
        this.frameST = UiFactory.getScreenTransform(frame);

        // Stack first so the button and handle draw on top of the panel.
        this.stack = this.ui.createObject("MenuStack", frame, FULL);
        const panel = this.ui.createObject("MenuPanel", this.stack, FULL);
        this.panelST = UiFactory.getScreenTransform(panel);
        this.ui.addImage(panel, this.panelTexture || this.roundedRect, UiColors.panel);

        // Tabs, side by side
        const tabWidth = (TAB_ROW.right - TAB_ROW.left - TAB_ROW.gap * (this.tabs.length - 1)) / this.tabs.length;
        this.tabs.forEach((tab, i) => {
            const left = TAB_ROW.left + i * (tabWidth + TAB_ROW.gap);
            const tabObj = this.ui.createObject("Tab_" + tab.title, this.stack,
                this.toFrame({ left, right: left + tabWidth, bottom: TAB_ROW.bottom, top: TAB_ROW.top }));
            tab.st = UiFactory.getScreenTransform(tabObj);
            tab.image = this.ui.addImage(tabObj, this.roundedRect, UiColors.idle);
            tab.text = this.ui.addLabel(tabObj, tab.title, 12);

            // This tab's buttons, stacked vertically
            tab.group = this.ui.createObject("Group_" + tab.title, this.stack, FULL);
            tab.buttons.forEach((button, row) => {
                const top = BUTTON_COLUMN.firstTop - row * (BUTTON_COLUMN.height + BUTTON_COLUMN.gap);
                const obj = this.ui.createObject("Button_" + button.label().split(":")[0], tab.group,
                    this.toFrame({ left: BUTTON_COLUMN.left, right: BUTTON_COLUMN.right, bottom: top - BUTTON_COLUMN.height, top }));
                button.st = UiFactory.getScreenTransform(obj);
                button.image = this.ui.addImage(obj, this.roundedRect, UiColors.idle);
                button.text = this.ui.addLabel(obj, button.label(), 16);
            });
        });

        // Round "Relic" button, back to front: soft breathing teal glow, bright teal ring, the
        // button face, then the label. All children of the button, so they drag and mirror with it.
        const btn = this.ui.createObject("RelicMenuButton", frame, this.toFrame(MENU_BUTTON));
        if (this.glowTexture) {
            const glow = this.ui.createObject("RelicButtonGlow", btn, RELIC_GLOW_RECT);
            this.relicGlow = this.ui.addImage(glow, this.glowTexture, RELIC_GLOW_COLOR, StretchMode.Fit);
        }
        const ring = this.ui.createObject("RelicButtonRing", btn, RELIC_RING_RECT);
        this.ui.addImage(ring, this.circle || this.roundedRect, RELIC_RING_COLOR, StretchMode.Fit);
        const face = this.ui.createObject("RelicButtonFace", btn, FULL);
        this.menuButton = {
            st: UiFactory.getScreenTransform(btn),
            image: this.ui.addImage(face, this.circle || this.roundedRect, UiColors.idle, StretchMode.Fit),
            text: this.ui.addLabel(btn, "Relic", 15),
        };

        // ⋮⋮ drag handle: a big invisible grab area with a small pill + grip dots inside.
        const handleObj = this.ui.createObject("DragHandle", frame, this.toFrame(HANDLE_HIT));
        const pill = this.ui.createObject("DragHandlePill", handleObj, HANDLE_PILL);
        const pillImage = this.ui.addImage(pill, this.roundedRect, UiColors.idle);
        if (this.gripTexture) {
            const grip = this.ui.createObject("DragHandleGrip", pill, { left: -0.8, right: 0.8, bottom: -0.7, top: 0.7 });
            this.ui.addImage(grip, this.gripTexture, UiColors.moonlight, StretchMode.Fit);
        }
        this.handle = { st: UiFactory.getScreenTransform(handleObj), image: pillImage };
    }

    private buildLoreCard() {
        this.loreCard = this.ui.createObject("LoreCard", this.uiParent, LORE_CARD);
        this.loreCardST = UiFactory.getScreenTransform(this.loreCard);
        this.ui.addImage(this.loreCard, this.panelTexture || this.roundedRect, UiColors.card);

        const title = this.ui.createObject("LoreTitle", this.loreCard, LORE_LAYOUT.title);
        this.ui.addLabel(title, LORE_TITLE, 24).textFill.color = UiColors.moonlight;

        const body = this.ui.createObject("LoreBody", this.loreCard, LORE_LAYOUT.body);
        const bodyText = this.ui.addLabel(body, LORE_BODY, 16);
        bodyText.horizontalOverflow = HorizontalOverflow.Wrap;
        bodyText.verticalAlignment = VerticalAlignment.Top;

        // Map of the Dominion: thin teal (aether) frame + the map, fitted to 3:2 in fitLoreMap().
        // Images take no taps, so "tap anywhere to close" still works on top of the map.
        // Map + caption share a group so the big QR can replace them.
        this.loreMapGroup = this.ui.createObject("LoreMapGroup", this.loreCard, FULL);
        if (this.loreMapTexture) {
            const area = this.ui.createObject("LoreMapArea", this.loreMapGroup, LORE_LAYOUT.map);
            this.loreMapAreaST = UiFactory.getScreenTransform(area);
            const frame = this.ui.createObject("LoreMapFrame", area, FULL);
            this.ui.addImage(frame, this.panelTexture || this.roundedRect, UiColors.teal);
            this.loreMapFrameST = UiFactory.getScreenTransform(frame);
            const map = this.ui.createObject("LoreMap", area, FULL);
            this.ui.addImage(map, this.loreMapTexture, new vec4(1, 1, 1, 1), StretchMode.Fit);
            this.loreMapST = UiFactory.getScreenTransform(map);

            const caption = this.ui.createObject("LoreMapCaption", this.loreMapGroup, LORE_LAYOUT.caption);
            this.ui.addLabel(caption, MAP_CAPTION, 13).textFill.color = UiColors.moonlight;
        }

        this.buildSiteLink();

        const footer = this.ui.createObject("LoreFooter", this.loreCard, LORE_LAYOUT.footer);
        this.ui.addLabel(footer, "Tap outside the card to close. Or don't. I'll wait.", 11).textFill.color = UiColors.textDim;

        this.loreCard.enabled = false;
    }

    /** Small QR + address + "Open Lore Site" pill, and the big QR the pill toggles. */
    private buildSiteLink() {
        if (this.loreQrTexture) {
            // The QR art is black on white with its own quiet zone; Fit keeps it square.
            const small = this.ui.createObject("LoreQrSmall", this.loreCard, LORE_LAYOUT.smallQr);
            this.ui.addImage(small, this.loreQrTexture, new vec4(1, 1, 1, 1), StretchMode.Fit);

            this.loreBigQr = this.ui.createObject("LoreQrBig", this.loreCard, LORE_LAYOUT.bigQr);
            const big = this.ui.createObject("LoreQrBigImage", this.loreBigQr, { left: -1, right: 1, bottom: -0.74, top: 1 });
            this.ui.addImage(big, this.loreQrTexture, new vec4(1, 1, 1, 1), StretchMode.Fit);
            const scan = this.ui.createObject("LoreQrBigCaption", this.loreBigQr, { left: -1, right: 1, bottom: -1, top: -0.8 });
            this.ui.addLabel(scan, "Scan with another device to open the Lore site", 13).textFill.color = UiColors.moonlight;
            this.loreBigQr.enabled = false;
        }

        const address = this.ui.createObject("LoreAddress", this.loreCard, LORE_LAYOUT.address);
        this.ui.addLabel(address, LORE_LINK, 12, FULL).textFill.color = LINK_TEAL;

        const pill = this.ui.createObject("LoreSitePill", this.loreCard, LORE_LAYOUT.sitePill);
        this.ui.addImage(pill, this.roundedRect, UiColors.teal);
        const text = this.ui.addLabel(pill, SITE_PILL_LABEL, 15);
        this.sitePill = { st: UiFactory.getScreenTransform(pill), text };
    }

    // =====================================================================
    // Taps + Sound buttons, Occlusion toggle
    // =====================================================================

    /** True if the point is on the Taps or Sound button (while the menu is showing). */
    private isOnIconButton(screenPos: vec2): boolean {
        if (this.hidden || this.loreCard.enabled) {
            return false;
        }
        return (!!this.tapsButton && this.tapsButton.containsScreenPoint(screenPos))
            || (!!this.soundButton && this.soundButton.containsScreenPoint(screenPos));
    }

    private toggleOcclusion() {
        this.occlusionOn = !this.occlusionOn;
        this.onOcclusionToggled(this.occlusionOn);
    }

    /**
     * Round buttons fixed at the top right (not in the draggable frame). Built in OnStart so
     * the screen-to-UI conversion is valid; under the menu root so they hide with the menu
     * (Codex card, Lore card, video, teaser).
     */
    private buildIconButtons() {
        if (!this.circle) {
            return;
        }
        const aspect = this.uiCamera.aspect;
        if (this.tapFingerTexture) {
            this.tapsButton = new IconToggleButton(this.ui, this.root, this.rootST, aspect, "TapsButton",
                TAPS_CENTER, ICON_BUTTON_DIAMETER,
                { circle: this.circle, ring: this.ringOutlineTexture, onIcon: this.tapFingerTexture, cancel: this.tapCancelTexture });
        }
        if (this.soundOnTexture) {
            this.soundButton = new IconToggleButton(this.ui, this.root, this.rootST, aspect, "SoundButton",
                SOUND_CENTER, ICON_BUTTON_DIAMETER,
                { circle: this.circle, ring: this.ringOutlineTexture, onIcon: this.soundOnTexture, offIcon: this.soundMutedTexture, cancel: this.tapCancelTexture });
        }
    }
}
