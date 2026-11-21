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
 *   ANCHOR   "Point at the Aether Sigil card..."      wait for the printed 10 cm card
 *      | card in view
 *   SIGHTING "Something's in frame. Center it."       camera image shakes, harder as the
 *      | card held near the centre                    card nears the centre of the screen
 *      |   -> aether dust puffs out of the Sigil, hint pulses
 *   SUMMON   "Sigil found... Tap it to summon..."     tap the card ->
 *      | tap on card                                  relic pops onto the card + chime
 *   SELECT   8 glowing shards circle the relic        tap a shard ->
 *      | tap a shard                                  (teal = Homeland, violet = Artifact)
 *   CARD     floating Codex card above the relic      Homeland: Collect / Close
 *      | "Place" on an Artifact card                  Artifact: Place   / Close
 *   VIDEO    (sword only) transformation video       plays once; tap = skip
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

// Sighting: the card must be in view this long, and held near the centre this long.
const SIGHT_MIN_SECONDS = 1.2;
const CENTER_DWELL_SECONDS = 0.4;
const CENTER_BOX = new vec2(0.18, 0.16);              // half-size of the "centred" area, screen 0..1

enum GameState {
    Anchor = "ANCHOR",
    Sighting = "SIGHTING",
    Summon = "SUMMON",
    Select = "SELECT",
    Card = "CARD",
    Video = "VIDEO",
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
    @hint("Post effect that shakes the camera image while the Sigil is being centred (Camera Object > ScreenShake)")
    screenShake: SceneObject;

    @input
    @hint("Shake strength at the centre (the Shake material's amplitude)")
    shakeStrength: number = 4;

    @input
    @hint("Shadowglint transformation video, played after 'Place' on the sword card (Codex/Video)")
    swordVideo: Texture;

    @input
    @hint("Audio component with the error 'nope' sound (Audio/ErrorNope), played with every red error message")
    errorSound: AudioComponent;

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
        sighting: "Something's in frame.\nCenter it. I'll wait.",
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
        if (this.screenShake) {
            const fx = this.screenShake.getComponent("Component.PostEffectVisual");
            this.shakePass = fx ? fx.mainPass : null;
            this.screenShake.enabled = false;
        }
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
            this.updateSighting(getDeltaTime());
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
        this.menu.canOpen = () => this.marker.isSummoned();
        this.menu.onLockedTap = () => this.onLockedMenuTap();
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

    /** Marker callback: the card came into view. Don't celebrate yet - get it centred first. */
    private onCardFound() {
        if (this.state === GameState.Anchor) {
            this.enterSighting();
        }
    }

    /** Marker callback: the card left the view. Before summoning, go back to "point at". */
    private onCardLost() {
        if (this.state === GameState.Sighting || this.state === GameState.Summon) {
            this.setShake(0);
            this.enterAnchor();
        }
        // After summoning, the relic simply stays where it was last seen.
    }

    // =====================================================================
    // STEP 1b - SIGHTING (card in view, not yet centred)
    // =====================================================================

    private sightTime = 0;
    private centerTime = 0;
    private shakePass: Pass | null = null;

    private enterSighting() {
        this.setState(GameState.Sighting);
        this.sightTime = 0;
        this.centerTime = 0;
        this.showHint(this.hints.sighting);
    }

    /**
     * While SIGHTING: shake the camera image (stronger as the card nears the centre). Once the
     * card has been in view for a moment AND held near the centre, the Sigil is "found".
     */
    private updateSighting(dt: number) {
        if (this.state !== GameState.Sighting) {
            return;
        }
        this.sightTime += dt;
        const screen = this.cardScreenPosition();
        if (!screen) {
            this.centerTime = 0;
            this.setShake(0.35);
            return;
        }
        const dx = Math.abs(screen.x - 0.5);
        const dy = Math.abs(screen.y - 0.5);
        const closeness = MathUtils.clamp(1 - Math.sqrt(dx * dx + dy * dy) / 0.5, 0, 1);
        this.setShake(0.35 + 0.65 * closeness);

        const centred = dx < CENTER_BOX.x && dy < CENTER_BOX.y;
        this.centerTime = centred ? this.centerTime + dt : 0;
        if (this.sightTime >= SIGHT_MIN_SECONDS && this.centerTime >= CENTER_DWELL_SECONDS) {
            this.sigilFound();
        }
    }

    /** Centred: stop shaking, dust puffs out of the Sigil, "Sigil found" pulses. */
    private sigilFound() {
        this.setShake(0);
        if (this.dust) {
            const card = this.marker.getCardPose();
            this.dust.burst(card.pos, card.rot);
        }
        this.enterSummon();
    }

    /** The card's centre on screen (0..1, top-left origin), or null if it's behind the camera. */
    private cardScreenPosition(): vec2 | null {
        if (!this.worldCamera) {
            return new vec2(0.5, 0.5);
        }
        const card = this.marker.getCardPose();
        const camT = this.worldCamera.getTransform();
        const forward = camT.getWorldRotation().multiplyVec3(new vec3(0, 0, -1));
        if (card.pos.sub(camT.getWorldPosition()).dot(forward) <= 0) {
            return null;
        }
        return this.worldCamera.worldSpaceToScreenSpace(card.pos);
    }

    /** 0 = off; otherwise the fraction of shakeStrength. */
    private setShake(amount: number) {
        if (!this.screenShake) {
            return;
        }
        this.screenShake.enabled = amount > 0;
        if (this.shakePass && amount > 0) {
            this.shakePass.uniAmplX = this.shakeStrength * amount;
            this.shakePass.uniAmplY = this.shakeStrength * amount;
        }
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

    /** Tap in SELECT / COMPLETE: open the card of the shard under the finger, or mock the miss. */
    private selectShard(screenPos: vec2) {
        const index = this.shards.pick(screenPos);
        if (index >= 0) {
            this.missStreak = 0;
            this.openCard(index);
        } else {
            this.onShardMiss(screenPos);
        }
    }

    // ---------- Miss quips (the narrator notices) ----------
    private readonly missQuips = [
        "Missed. The shards are\nthe glowing bits.",
        "That was air. Tapping air\nyields air. Try a shard.",
        "Bold of you to tap nothing.\nTry the glowing crystals.",
        "Close. Well, no. Not close.\nAim for a shard.",
        "Your finger found nothing.\nInspiring, really.",
        "The shards are right there.\nGlowing. Helpfully.",
        "Nope. That's the room.\nThe room is not collectible.",
        "Another miss. I'm logging\nthese, by the way.",
        "Tap a shard. Any shard.\nI'm not picky.",
    ];
    // Always shown when the tap lands on the relic itself (it isn't in the random rotation).
    private readonly relicQuip = "The relic doesn't need poking.\nThe shards, however...";
    private readonly streakQuips: { [misses: number]: string } = {
        5: "Five misses in a row.\nA record. Not a good one.",
        10: "Ten misses. I've started\na support group for you.",
    };
    private quipBag: number[] = [];
    private missStreak = 0;
    private lastQuipTime = -10;

    /**
     * A tap that hit no shard. On the relic: always the relic line. Anywhere else: the next
     * quip (shuffled, no repeats until all are used), or a streak line at 5 / 10 misses.
     */
    private onShardMiss(screenPos: vec2) {
        if (getTime() - this.lastQuipTime < 0.5) {
            return; // rapid tapping: let the current quip be read
        }
        this.lastQuipTime = getTime();
        this.missStreak++;
        if (this.marker.isTapOnRelic(screenPos)) {
            this.showHint(this.relicQuip, 2.5);
            return;
        }
        let quip = this.streakQuips[this.missStreak];
        if (!quip) {
            if (this.quipBag.length === 0) {
                this.quipBag = this.missQuips.map((_, i) => i).sort(() => Math.random() - 0.5);
            }
            quip = this.missQuips[this.quipBag.pop()];
        }
        this.showHint(quip, 2.5);
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

    /**
     * "Place" on an artifact card. The sword first plays its transformation video (tap to
     * skip); the rug goes straight to placement.
     */
    private startPlacing(index: number) {
        if (CODEX_ENTRIES[index].artifact === ArtifactKind.Sword && this.swordVideo) {
            this.playSwordVideo(index);
        } else {
            this.beginPlacing(index);
        }
    }

    /** Wait for a tap on a wall / the floor. */
    private beginPlacing(index: number) {
        this.placingIndex = index;
        this.menu.setVisible(true);
        this.setState(GameState.Placing);
        this.showHint(this.placement.instructionFor(CODEX_ENTRIES[index].artifact));
    }

    /** Full-screen transformation video; menu, counter and hints hide until it ends. */
    private playSwordVideo(index: number) {
        this.setState(GameState.Video);
        this.menu.setVisible(false);
        this.hideHint();
        this.effects.playChime();
        this.card.playVideo(this.swordVideo, () => this.beginPlacing(index));
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
        this.missStreak = 0;
        this.card.stopVideo(); // can play again next time
        this.setShake(0);
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
        if (this.state === GameState.Video) {
            this.card.skipVideo(); // tap = skip straight to placement
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
        const onUi = this.menu.isUiPoint(pos) || this.card.isOpen || this.card.isVideoPlaying;
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
        if (style === "error" && this.errorSound) {
            if (this.errorSound.isPlaying()) {
                this.errorSound.stop(false); // rapid errors: restart rather than pile up
            }
            this.errorSound.play(1);
        }
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

    // ---------- Relic menu tapped before there is a relic ----------
    private readonly lockedMenuQuips = [
        "Error: I'm broken until you\nread the clue on the screen.",
        "No relic, no menu. That clue\nisn't decorative, you know.",
        "Still broken. Still waiting.\nThe instructions. Read them.",
    ];
    private lockedQuipIndex = 0;

    /** Relic button before summoning: a sarcastic red error, then the current instruction. */
    private onLockedMenuTap() {
        const quip = this.lockedMenuQuips[this.lockedQuipIndex % this.lockedMenuQuips.length];
        this.lockedQuipIndex++;
        this.showHint(quip, 2.5, true, "error");
    }

    /** The instruction that belongs to the current step (for after a temporary message). */
    private restoreStateHint() {
        switch (this.state) {
            case GameState.Anchor:
                this.showHint(this.hints.anchor);
                break;
            case GameState.Sighting:
                this.showHint(this.hints.sighting);
                break;
            case GameState.Summon:
                this.showHint(this.hints.found, 0, false, "found");
                break;
            case GameState.Placing:
                this.showHint(this.placement.instructionFor(CODEX_ENTRIES[this.placingIndex].artifact));
                break;
            default:
                this.hideHint();
        }
    }

    private onHintTimer() {
        if (this.hintRestoresInstruction) {
            this.restoreStateHint();
        } else {
            this.hideHint();
        }
    }
}
