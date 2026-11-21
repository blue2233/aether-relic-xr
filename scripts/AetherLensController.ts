import { RoomPlacementController } from "./RoomPlacementController";
import { MarkerRelicController } from "./MarkerRelicController";
import { RelicMenuController } from "./RelicMenuController";
import { RelicEffects } from "./RelicEffects";
import { ShardRing } from "./ShardRing";
import { CodexCardView } from "./CodexCardView";
import { CODEX_ENTRIES, CODEX_SIZE, ArtifactKind } from "./CodexData";

/**
 * AetherLensController - the core loop of Aether Relic XR
 * ========================================================
 *   Scan -> Place -> Interact -> Collect, as a simple state machine:
 *
 *   ANCHOR   "Point at your Aether Sigil card"        wait for the printed 10 cm card
 *      | card found
 *   SUMMON   "Tap the card to summon the Codex"       tap the card ->
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
 */

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
        anchor: "Point at your Aether Sigil card",
        summon: "Tap the card to summon the Codex",
        select: "Tap a glowing shard to open its Codex card",
        complete: "Codex Complete!",
    };

    onAwake() {
        if (!this.marker || !this.shards || !this.card || !this.placement || !this.menu || !this.effects || !this.hintText) {
            print("AetherLensController: a required input is missing; check the Inspector.");
            return;
        }
        global.touchSystem.touchBlocking = true; // the Lens gets every touch (needed for long-press)
        this.hintSize = this.hintText.size;
        this.hintTimer = this.createEvent("DelayedCallbackEvent");
        this.hintTimer.bind(() => this.onHintTimer());

        this.createEvent("OnStartEvent").bind(() => this.onStart());
        this.createEvent("TapEvent").bind((e) => this.routeTap(e.getTapPosition()));
        this.createEvent("TouchStartEvent").bind((e) => this.onTouchStart(e.getTouchPosition()));
        this.createEvent("TouchMoveEvent").bind((e) => this.onTouchMove(e.getTouchPosition()));
        this.createEvent("TouchEndEvent").bind(() => (this.touchStartTime = -1));
        this.createEvent("UpdateEvent").bind(() => this.checkLongPress());
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

    /** Marker callback: the card came into view. */
    private onCardFound() {
        if (this.state === GameState.Anchor) {
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
        this.showHint(this.hints.summon);
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

    /** Shows the floating Codex card for one shard. The menu hides so nothing overlaps it. */
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
            this.showHint(result.message, 2, true); // then back to the placing instruction
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
            } else if (hit === "close") {
                this.closeCard();
            } else if (hit === "outside") {
                this.closeCard();
                this.selectShard(screenPos); // tapping another shard opens it straight away
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
    private hintSize = 20;
    private hintWanted = false;   // should the hint be showing (ignoring the lore card)?
    private loreOpen = false;     // the Lore card covers the screen; keep the hint hidden

    /** Lore card opened / closed: hide the hint under it, then bring it back if still needed. */
    private onLoreToggled(open: boolean) {
        this.loreOpen = open;
        this.hintText.getSceneObject().enabled = this.hintWanted && !open;
    }

    /**
     * Shows a hint. `seconds` > 0 hides it after that long; with `thenRestore` the current
     * PLACING instruction comes back instead (used for "That's not a wall" messages).
     */
    private showHint(message: string, seconds: number = 0, thenRestore: boolean = false) {
        this.hintText.text = message;
        this.hintText.size = this.hintSize;
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

    private onHintTimer() {
        if (this.hintRestoresInstruction && this.state === GameState.Placing) {
            this.showHint(this.placement.instructionFor(CODEX_ENTRIES[this.placingIndex].artifact));
        } else {
            this.hideHint();
        }
    }
}
