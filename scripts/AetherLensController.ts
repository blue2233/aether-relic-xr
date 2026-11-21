import { RoomPlacementController } from "./RoomPlacementController";
import { MarkerRelicController } from "./MarkerRelicController";
import { RelicMenuController } from "./RelicMenuController";
import { RelicEffects } from "./RelicEffects";
import { ShardRing } from "./ShardRing";
import { CodexCardView } from "./CodexCardView";
import { CODEX_ENTRIES, CODEX_SIZE, ArtifactKind } from "./CodexData";
import { AetherDust } from "./AetherDust";

/**
 * AetherLensController - the core loop of Aether Relic XR
 * ========================================================
 *   Scan -> Place -> Interact -> Collect, as a simple state machine:
 *
 *   ANCHOR   "Point at your Aether Sigil card"        wait for the printed 10 cm card
 *      | card found -> aether dust puffs out of the Sigil, hint pulses
 *   SUMMON   "Sigil found! Tap it to summon..."       tap the card ->
 *      | tap on card                                  relic pops onto the card + chime
 *   SELECT   8 glowing shards circle the relic        tap a shard ->
 *      | tap a shard                                  (teal = Homeland, violet = Artifact)
 *   CARD     floating Codex card above the relic      Homeland: Collect / Close
 *      | "Place" on an Artifact card                  Artifact: Place   / Close
 *   PLACING  "Tap a wall..." / "Tap the floor..."     tap -> sword on wall / rug on floor
 *      | collected or placed -> shard dims + check, counter "Collected N/8"
 *   COMPLETE "Codex Complete!" + warm Light + fanfare when N = 8
 *
 *   Reset (menu WORLD > Reset, or long-press anywhere) clears everything back to ANCHOR, 0/8.
 *
 * All taps come here first: open Codex card -> Relic menu -> current state.
 *
 * HINT STYLES
 *   normal  bright teal text on the dark purple box (instructions)
 *   found   white-cyan text on a deep teal box, with a double pulse (Sigil found)
 *   error   coral red text on a dark maroon box, with a short shake ("That's not a wall")
 */

type HintStyle = "normal" | "found" | "error";

const FOUND_TEXT = new vec4(0.88, 1.0, 0.97, 1);
const FOUND_BOX = new vec4(0.03, 0.30, 0.31, 0.92);
const ERROR_TEXT = new vec4(1.0, 0.42, 0.42, 1);      // coral red, readable on dark
const ERROR_BOX = new vec4(0.30, 0.05, 0.09, 0.92);   // dark maroon
const PULSE_SECONDS = 0.7;                            // two pulses, 1 -> 1.1 -> 1
const SHAKE_SECONDS = 0.4;
const SHAKE_AMOUNT = 0.05;                            // Safe Region units

enum GameState {
    Anchor = "ANCHOR",
    Summon = "SUMMON",
    Select = "SELECT",
    Card = "CARD",
    Placing = "PLACING",
    Complete = "COMPLETE",
}

@component
export class AetherLensController extends BaseScriptComponent {
    @input
    @hint("Printed-card tracking and the relic on the card")
    marker: MarkerRelicController;

    @input
    @hint("The 8 shards around the relic (ShardRing on af_artifact > ShardRing)")
    shards: ShardRing;

    @input
    @hint("The floating Codex card + checkmarks")
    card: CodexCardView;

    @input
    @hint("Places the sword (wall) and rug (floor) in the room")
    placement: RoomPlacementController;

    @input
    @hint("The collapsible Relic menu")
    menu: RelicMenuController;

    @input
    @hint("Spin / Glow / Light / sounds / rug grow")
    effects: RelicEffects;

    @input
    @hint("Instruction text (PlacementHint)")
    hintText: Text;

    @input
    @hint("Old 'point camera at flat surface' text from the template; kept hidden")
    oldPlacementText: SceneObject;

    @input
    @hint("Main AR camera (the aether dust faces it)")
    worldCamera: Camera;

    @input
    @hint("Additive glow material for the aether dust (Codex/AetherDustMaterial)")
    dustMaterial: Material;

    @input
    @hint("Soft dot texture for the aether dust (UI/AetherDust)")
    dustTexture: Texture;

    @input
    @hint("Seconds to hold a finger down (outside the menu) to Reset")
    longPressSeconds: number = 0.8;

    @input
    @hint("Text size of the 'Codex Complete!' message (normal hints keep their own size)")
    completeTextSize: number = 38;

    // ---------- State ----------
    private state: GameState = GameState.Anchor;
    private collected: boolean[] = [];
    private openIndex = -1;                 // Codex entry shown on the card
    private placingIndex = -1;              // Codex entry being placed in PLACING
    private hintTimer: DelayedCallbackEvent;
    private touchStartTime = -1;
    private touchStartPos = vec2.zero();
    private longPressFired = false;

    private readonly hints = {
        anchor: "Point at the Aether Sigil card.\nIt won't find itself.",
        summon: "Tap the card to summon the Codex.\nIt's been waiting. Patiently. Mostly.",
        found: "Sigil found. Well done, you.\nTap it to summon the Codex.",
        select: "Tap a glowing shard.\nYes, the glowing ones.",
        complete: "Codex Complete!\nThe Spire is mildly impressed.",
    };

    onAwake() {
        if (!this.marker || !this.shards || !this.card || !this.placement || !this.menu || !this.effects || !this.hintText) {
            print("AetherLensController: a required input is missing; check the Inspector.");
            return;
        }
        global.touchSystem.touchBlocking = true; // the Lens gets every touch (needed for long-press)
        this.hintSize = this.hintText.size;
        this.hintST = this.hintText.getSceneObject().getComponent("Component.ScreenTransform");
        this.hintAnchors = this.hintST ? this.hintST.anchors : null;
        this.normalText = this.hintText.textFill.color;
        this.normalBox = this.hintText.backgroundSettings.fill.color;
        if (this.worldCamera && this.dustMaterial) {
            this.dust = new AetherDust(this.worldCamera, this.dustMaterial, this.dustTexture);
        }
        this.hintTimer = this.createEvent("DelayedCallbackEvent");
        this.hintTimer.bind(() => this.onHintTimer());

        this.createEvent("OnStartEvent").bind(() => this.onStart());
        this.createEvent("TapEvent").bind((e) => this.routeTap(e.getTapPosition()));
        this.createEvent("TouchStartEvent").bind((e) => this.onTouchStart(e.getTouchPosition()));
        this.createEvent("TouchMoveEvent").bind((e) => this.onTouchMove(e.getTouchPosition()));
        this.createEvent("TouchEndEvent").bind(() => (this.touchStartTime = -1));
        this.createEvent("UpdateEvent").bind(() => {
            this.checkLongPress();
            this.animateHint();
            if (this.dust) {
                this.dust.update(getDeltaTime());
            }
        });
    }

    /** Runs after every script's onAwake, so the other scripts are ready. */
    private onStart() {
        this.marker.onCardFound = () => this.onCardFound();
        this.marker.onCardLost = () => this.onCardLost();
        this.menu.onReset = () => this.resetAll();
        this.menu.onLoreToggled = (open) => this.onLoreToggled(open);
        if (this.oldPlacementText) {
            this.oldPlacementText.enabled = false;
        }
        this.resetAll();
    }

    // =====================================================================
    // STEP 1 - ANCHOR
    // =====================================================================

    /** Waits for the printed card. Nothing is on screen except the hint and menu. */
    private enterAnchor() {
        this.setState(GameState.Anchor);
        this.showHint(this.hints.anchor);
    }

    /** Marker callback: the card came into view - make it obvious with dust and a pulse. */
    private onCardFound() {
        if (this.state === GameState.Anchor) {
            if (this.dust) {
                const card = this.marker.getCardPose();
                this.dust.burst(card.pos, card.rot);
            }
            this.enterSummon();
        }
    }

    /** Marker callback: the card left the view. Before summoning, go back to "point at". */
    private onCardLost() {
        if (this.state === GameState.Summon) {
            this.enterAnchor();
        }
        // After summoning, the relic simply stays where it was last seen.
    }

    // =====================================================================
    // STEP 2 - SUMMON
    // =====================================================================

    private enterSummon() {
        this.setState(GameState.Summon);
        this.showHint(this.hints.found, 0, false, "found");
    }

    /** Tap on the card: the relic pops onto it with the chime, then shards are selectable. */
    private summonCodex() {
        if (!this.marker.summon()) {
            return;
        }
        this.effects.playChime();
        this.updateCounter();
        this.card.setChecksVisible(true);
        this.enterSelect();
    }

    // =====================================================================
    // STEP 3 - SELECT
    // =====================================================================

    private enterSelect() {
        this.setState(GameState.Select);
        this.menu.setVisible(true);
        this.showHint(this.hints.select, 4);
    }

    /** Tap in SELECT / COMPLETE: open the card of the shard under the finger (if any). */
    private selectShard(screenPos: vec2) {
        const index = this.shards.pick(screenPos);
        if (index >= 0) {
            this.openCard(index);
        }
    }

    // =====================================================================
    // STEP 4 - CODEX CARD
    // =====================================================================

    /** Shows the full-screen Codex card. Menu, hint and counter hide; closeCard brings them back. */
    private openCard(index: number) {
        this.openIndex = index;
        this.card.open(index, this.collected[index]);
        this.menu.setVisible(false);
        this.hideHint();
        this.setState(GameState.Card);
    }

    /** "Collect" (Homeland) or "Place" (Artifact). */
    private onCardPrimary() {
        const index = this.openIndex;
        this.closeCard();
        if (CODEX_ENTRIES[index].artifact === ArtifactKind.None) {
            this.collectEntry(index);
        } else {
            this.startPlacing(index);
        }
    }

    /** "Close" (or a tap away from the card): back to choosing shards. */
    private closeCard() {
        this.card.hide();
        this.openIndex = -1;
        if (this.isComplete()) {
            this.setState(GameState.Complete);
            this.menu.setVisible(true);
        } else {
            this.enterSelect();
        }
    }

    // =====================================================================
    // STEP 5 - PLACING (artifacts)
    // =====================================================================

    /** "Place" on the Sword / Rug card: wait for a tap on a wall / the floor. */
    private startPlacing(index: number) {
        this.placingIndex = index;
        this.setState(GameState.Placing);
        this.showHint(this.placement.instructionFor(CODEX_ENTRIES[index].artifact));
    }

    /** Tap while PLACING: try the real-world placement; on success the artifact is collected. */
    private placeArtifactAt(screenPos: vec2) {
        const kind = CODEX_ENTRIES[this.placingIndex].artifact;
        const result = this.placement.placeArtifact(kind, screenPos);
        if (!result.ok) {
            this.showHint(result.message, 2, true, "error"); // then back to the placing instruction
            return;
        }
        if (kind === ArtifactKind.Rug) {
            this.effects.growIn(); // the rug grows to full size
        }
        const index = this.placingIndex;
        this.placingIndex = -1;
        this.collectEntry(index);
    }

    // =====================================================================
    // STEP 6 - COLLECT / COMPLETE
    // =====================================================================

    /** Marks one Codex entry as collected: shard dims, checkmark, counter, chime. */
    private collectEntry(index: number) {
        if (!this.collected[index]) {
            this.collected[index] = true;
            this.shards.setCollected(index, true);
            this.card.setChecked(index, true);
            this.effects.playChime();
            this.updateCounter();
        }
        if (this.isComplete()) {
            this.enterComplete();
        } else {
            this.enterSelect();
        }
    }

    /** All 8 collected: "Codex Complete!", warm light and the fanfare. */
    private enterComplete() {
        this.setState(GameState.Complete);
        this.menu.setVisible(true);
        this.effects.setWarmLight(true);
        this.effects.playComplete();
        this.showHint(this.hints.complete, 5);
        this.hintText.size = this.completeTextSize; // big celebratory message
    }

    private collectedCount(): number {
        return this.collected.filter((c) => c).length;
    }

    private isComplete(): boolean {
        return this.collectedCount() === CODEX_SIZE;
    }

    /** The cyan "Collected N/8" corner card; it only appears once the Codex is summoned. */
    private updateCounter() {
        this.card.setCounter(this.collectedCount(), CODEX_SIZE, this.marker.isSummoned());
    }

    // =====================================================================
    // RESET
    // =====================================================================

    /** Clears everything back to STEP 1 with the counter at 0/8. */
    public resetAll() {
        this.collected = CODEX_ENTRIES.map(() => false);
        this.openIndex = this.placingIndex = -1;
        this.card.hide();
        this.card.resetChecks();
        this.card.setChecksVisible(false);
        this.shards.resetAll();
        this.placement.hideAll();
        this.effects.resetAll();
        if (this.dust) {
            this.dust.stop();
        }
        this.marker.reset();     // relic hidden; a visible card is "found" again next frame
        this.menu.setVisible(true);
        this.menu.resetPosition(); // dragged menu goes back to its default spot on the right
        this.menu.refresh();
        this.updateCounter();    // 0/8, hidden until summoned
        this.enterAnchor();
    }

    // =====================================================================
    // Input
    // =====================================================================

    /** Every tap: open card first, then the menu, then whatever the current state expects. */
    private routeTap(screenPos: vec2) {
        if (this.longPressFired) {
            this.longPressFired = false; // this tap ended a long-press (Reset)
            return;
        }
        if (this.state === GameState.Card) {
            const hit = this.card.handleTap(screenPos);
            if (hit === "primary") {
                this.onCardPrimary();
            } else if (hit === "close" || hit === "outside") {
                this.closeCard(); // the full-screen card swallows the tap: nothing passes through
            }
            return;
        }
        if (this.menu.handleTap(screenPos)) {
            return;
        }
        switch (this.state) {
            case GameState.Summon:
                if (this.marker.isTapOnCard(screenPos)) {
                    this.summonCodex();
                }
                break;
            case GameState.Select:
            case GameState.Complete:
                this.selectShard(screenPos);
                break;
            case GameState.Placing:
                this.placeArtifactAt(screenPos);
                break;
        }
    }

    private onTouchStart(pos: vec2) {
        this.longPressFired = false;
        const onUi = this.menu.isUiPoint(pos) || this.card.isOpen;
        this.touchStartTime = onUi ? -1 : getTime();
        this.touchStartPos = pos;
    }

    private onTouchMove(pos: vec2) {
        if (this.touchStartTime >= 0 && pos.distance(this.touchStartPos) > 0.05) {
            this.touchStartTime = -1; // dragging cancels the long-press
        }
    }

    /** Long-press anywhere (not on the menu or card) = Reset. */
    private checkLongPress() {
        if (this.touchStartTime >= 0 && getTime() - this.touchStartTime >= this.longPressSeconds) {
            this.touchStartTime = -1;
            this.longPressFired = true;
            this.resetAll();
        }
    }

    // =====================================================================
    // Helpers
    // =====================================================================

    private setState(state: GameState) {
        this.state = state;
        print(`[Codex] state -> ${state} (${this.collectedCount()}/${CODEX_SIZE})`);
    }

    private hintRestoresInstruction = false;
    private hintST: ScreenTransform;
    private hintAnchors: Rect | null = null;
    private normalText: vec4;
    private normalBox: vec4;
    private hintStyle: HintStyle = "normal";
    private hintAnimStart = -1;
    private dust: AetherDust | null = null;
    private hintSize = 20;
    private hintWanted = false;   // should the hint be showing (ignoring the lore card)?
    private loreOpen = false;     // the Lore card covers the screen; keep the hint hidden

    /** Lore card opened / closed: hide the hint under it, then bring it back if still needed. */
    private onLoreToggled(open: boolean) {
        this.loreOpen = open;
        this.hintText.getSceneObject().enabled = this.hintWanted && !open;
        this.card.setChecksVisible(!open && this.marker.isSummoned()); // ticks would draw over the card
    }

    /**
     * Shows a hint. `seconds` > 0 hides it after that long; with `thenRestore` the current
     * PLACING instruction comes back instead (used for "That's not a wall" messages).
     */
    private showHint(message: string, seconds: number = 0, thenRestore: boolean = false, style: HintStyle = "normal") {
        this.hintText.text = message;
        this.hintText.size = this.hintSize;
        this.setHintStyle(style);
        this.hintWanted = true;
        this.hintText.getSceneObject().enabled = !this.loreOpen;
        this.hintRestoresInstruction = thenRestore;
        this.hintTimer.reset(seconds > 0 ? seconds : 1e6);
    }

    private hideHint() {
        this.hintWanted = false;
        this.hintText.getSceneObject().enabled = false;
        this.hintTimer.reset(1e6);
    }

    /** Colours for the hint box; "found" and "error" also start their pulse / shake. */
    private setHintStyle(style: HintStyle) {
        this.hintStyle = style;
        const text = style === "found" ? FOUND_TEXT : style === "error" ? ERROR_TEXT : this.normalText;
        const box = style === "found" ? FOUND_BOX : style === "error" ? ERROR_BOX : this.normalBox;
        this.hintText.textFill.color = text;
        this.hintText.backgroundSettings.fill.color = box;
        this.hintAnimStart = style === "normal" ? -1 : getTime();
        this.applyHintMotion(1, 0);
    }

    /** Pulse ("found") or shake ("error"); the hint is back at rest when it ends. */
    private animateHint() {
        if (this.hintAnimStart < 0) {
            return;
        }
        const age = getTime() - this.hintAnimStart;
        if (this.hintStyle === "found") {
            const t = Math.min(1, age / PULSE_SECONDS);
            this.applyHintMotion(1 + 0.1 * Math.abs(Math.sin(t * Math.PI * 2)), 0);
            if (t >= 1) {
                this.hintAnimStart = -1;
            }
        } else {
            const t = Math.min(1, age / SHAKE_SECONDS);
            this.applyHintMotion(1, SHAKE_AMOUNT * Math.sin(age * 55) * (1 - t));
            if (t >= 1) {
                this.hintAnimStart = -1;
            }
        }
    }

    private applyHintMotion(scale: number, shiftX: number) {
        if (!this.hintST || !this.hintAnchors) {
            return;
        }
        this.hintST.scale = new vec3(scale, scale, 1);
        const a = this.hintAnchors;
        this.hintST.anchors = Rect.create(a.left + shiftX, a.right + shiftX, a.bottom, a.top);
    }

    private onHintTimer() {
        if (this.hintRestoresInstruction && this.state === GameState.Placing) {
            this.showHint(this.placement.instructionFor(CODEX_ENTRIES[this.placingIndex].artifact));
        } else {
            this.hideHint();
        }
    }
}
