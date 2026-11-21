import { RelicEffects } from "./RelicEffects";
import { UiFactory, UiColors, UiRect } from "./UiFactory";

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
 * Wyrendal Dominion; tap anywhere to close. The Lens hides its hint while the card is open.
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

// ---------- Layout for the default (right side) spot, in Safe Render Region units ----------
const FULL: UiRect = { left: -1, right: 1, bottom: -1, top: 1 };
const MENU_BUTTON: UiRect = { left: 0.70, right: 0.94, bottom: 0.26, top: 0.40 };
const HANDLE_HIT: UiRect = { left: 0.42, right: 0.68, bottom: 0.27, top: 0.39 };   // easy-to-grab area
const HANDLE_PILL: UiRect = { left: -0.75, right: 0.75, bottom: -0.42, top: 0.42 }; // pill inside the hit area
const PANEL = { left: 0.08, right: 0.94, top: 0.235 };
const TAB_ROW = { left: 0.11, right: 0.91, bottom: 0.15, top: 0.222, gap: 0.02 };
const BUTTON_COLUMN = { left: 0.11, right: 0.91, firstTop: 0.13, height: 0.085, gap: 0.018 };
const MAX_ROWS = 4;                                            // longest tab (MOTION)
const LORE_CARD: UiRect = { left: -0.86, right: 0.86, bottom: -0.72, top: 0.70 };

// Lore card contents, in the card's own -1..1 space (8% padding = 0.16 of the -1..1 width).
const LORE_LAYOUT = {
    title: { left: -0.9, right: 0.9, bottom: 0.8, top: 0.95 },
    body: { left: -0.84, right: 0.84, bottom: 0.42, top: 0.78 },
    map: { left: -0.84, right: 0.84, bottom: -0.62, top: 0.38 },   // area the 3:2 map is fitted into
    caption: { left: -0.84, right: 0.84, bottom: -0.76, top: -0.65 },
    footer: { left: -0.9, right: 0.9, bottom: -0.96, top: -0.84 },
};
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
    @hint("The effects the MOTION and LOOK buttons switch")
    effects: RelicEffects;

    @input
    @hint("Seconds after the last menu tap before the menu closes itself")
    autoCollapseSeconds: number = 5;

    /** WORLD > Reset. Set by AetherLensController. */
    public onReset: () => void = () => {};
    /** Lore card opened (true) or closed (false); the Lens hides its hint meanwhile. */
    public onLoreToggled: (open: boolean) => void = () => {};

    // ---------- UI objects ----------
    private ui: UiFactory;
    private root: SceneObject;              // full Safe Render Region, never moves
    private rootST: ScreenTransform;
    private frameST: ScreenTransform;       // moves when the menu is dragged
    private menuButton: { st: ScreenTransform; image: Image; text: Text };
    private handle: { st: ScreenTransform; image: Image };
    private stack: SceneObject;             // everything that shows when the menu is open
    private panelST: ScreenTransform;       // dark backdrop behind tabs + buttons
    private loreCard: SceneObject;
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

        // Drag input (taps arrive separately through handleTap).
        this.createEvent("TouchStartEvent").bind((e) => this.onDragStart(e.getTouchPosition()));
        this.createEvent("TouchMoveEvent").bind((e) => this.onDragMove(e.getTouchPosition()));
        this.createEvent("TouchEndEvent").bind(() => this.onDragEnd());
        this.createEvent("UpdateEvent").bind(() => this.updateSnap());
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
            this.hideLore(); // an open lore card takes any tap and closes
            return true;
        }
        // The finger was dragging the menu: never let that count as a scene tap.
        if (this.dragging || getTime() - this.lastDragEnd < DRAG_TAP_GUARD) {
            return true;
        }
        if (this.hidden) {
            return false;
        }
        if (this.handle.st.containsScreenPoint(screenPos)) {
            return true; // a tap on the handle does nothing
        }
        if (this.menuButton.st.containsScreenPoint(screenPos)) {
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
        return !this.hidden && (this.handle.st.containsScreenPoint(screenPos)
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

    /** Lore: shows the story card (tap anywhere to close). */
    private showLore() {
        this.setExpanded(false);
        this.loreCard.enabled = true;
        this.root.enabled = false; // nothing draws over the card
        this.fitLoreMap();
        this.onLoreToggled(true);  // the Lens hides its hint while the card is open
    }

    private hideLore() {
        this.loreCard.enabled = false;
        this.root.enabled = !this.hidden;
        this.onLoreToggled(false);
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

        // Round "Relic" button
        const btn = this.ui.createObject("RelicMenuButton", frame, this.toFrame(MENU_BUTTON));
        this.menuButton = {
            st: UiFactory.getScreenTransform(btn),
            image: this.ui.addImage(btn, this.circle || this.roundedRect, UiColors.idle, StretchMode.Fit),
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
        this.ui.addImage(this.loreCard, this.panelTexture || this.roundedRect, UiColors.card);

        const title = this.ui.createObject("LoreTitle", this.loreCard, LORE_LAYOUT.title);
        this.ui.addLabel(title, LORE_TITLE, 24).textFill.color = UiColors.moonlight;

        const body = this.ui.createObject("LoreBody", this.loreCard, LORE_LAYOUT.body);
        const bodyText = this.ui.addLabel(body, LORE_BODY, 16);
        bodyText.horizontalOverflow = HorizontalOverflow.Wrap;
        bodyText.verticalAlignment = VerticalAlignment.Top;

        // Map of the Dominion: thin teal (aether) frame + the map, fitted to 3:2 in fitLoreMap().
        // Images take no taps, so "tap anywhere to close" still works on top of the map.
        if (this.loreMapTexture) {
            const area = this.ui.createObject("LoreMapArea", this.loreCard, LORE_LAYOUT.map);
            this.loreMapAreaST = UiFactory.getScreenTransform(area);
            const frame = this.ui.createObject("LoreMapFrame", area, FULL);
            this.ui.addImage(frame, this.panelTexture || this.roundedRect, UiColors.teal);
            this.loreMapFrameST = UiFactory.getScreenTransform(frame);
            const map = this.ui.createObject("LoreMap", area, FULL);
            this.ui.addImage(map, this.loreMapTexture, new vec4(1, 1, 1, 1), StretchMode.Fit);
            this.loreMapST = UiFactory.getScreenTransform(map);

            const caption = this.ui.createObject("LoreMapCaption", this.loreCard, LORE_LAYOUT.caption);
            this.ui.addLabel(caption, MAP_CAPTION, 13).textFill.color = UiColors.moonlight;
        }

        const footer = this.ui.createObject("LoreFooter", this.loreCard, LORE_LAYOUT.footer);
        this.ui.addLabel(footer, "Tap anywhere to close", 12).textFill.color = UiColors.textDim;

        this.loreCard.enabled = false;
    }
}
