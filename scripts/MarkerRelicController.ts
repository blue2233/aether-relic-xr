/**
 * MarkerRelicController
 * ---------------------
 * Everything to do with the printed Aether Sigil card (10 cm image marker).
 *
 *   - Reports when the card is FOUND / LOST (onCardFound / onCardLost).
 *   - isTapOnCard(): was a screen tap on the card? (ray from the camera hits the card's plane
 *     within the card's area)
 *   - summon(): the relic (af_artifact, with its shard ring) appears sitting on the card
 *     with a short scale-up "pop".
 *   - While the card is tracked, the summoned relic smoothly follows it. When the card is
 *     lost, the relic stays exactly where it was last seen (World tracking holds it), because
 *     it is not parented to the marker.
 *
 * Marker axes: the image lies in the marker object's local X/Y plane (X = right, Y = top
 * edge of the card) and local +Z points out of the printed face. So on a table, "card up"
 * is local +Z; the relic stands on that axis, facing the card's bottom edge.
 */
@component
export class MarkerRelicController extends BaseScriptComponent {
    @input
    @hint("Marker Tracking component on AetherCardMarker")
    markerTracking: MarkerTrackingComponent;

    @input
    @hint("Relic object (af_artifact)")
    relic: SceneObject;

    @input
    @hint("Relic's mesh, used to measure its size so it fits the card")
    relicMesh: RenderMeshVisual;

    @input
    @hint("Main AR camera (for tap ray casts)")
    camera: Camera;

    @input
    @hint("Relic width on the card, in cm (the card is 10 cm wide)")
    relicWidthOnCard: number = 9;

    @input
    @hint("Gap between the card and the relic's base, in cm")
    hoverGap: number = 0.2;

    @input
    @hint("Length of the scale-up pop, in seconds")
    popDuration: number = 0.4;

    @input
    @hint("0..1: how quickly the relic follows the card each frame (lower = smoother, laggier)")
    followSmoothing: number = 0.5;

    @input
    @hint("A tap counts as 'on the card' within this distance of the card's centre, in cm")
    cardTapRadius: number = 8;

    @input
    @hint("TESTING: pretend a card lies flat in front of the camera. Only works inside Lens Studio, never on a phone")
    simulateCardInEditor: boolean = false;

    @input
    @hint("TESTING: world position of the pretend card, in cm (the preview camera starts at 0,0,0)")
    simulatedCardPosition: vec3 = new vec3(0, -25, -50);

    // ---------- Hooks set by AetherLensController ----------
    public onCardFound: () => void = () => {};
    public onCardLost: () => void = () => {};

    // ---------- State ----------
    private summoned = false;       // relic is on (or was left at) the card
    private wasTracking = false;
    private popStart = -1;          // time the pop animation started, -1 = not popping
    private cardScale = vec3.one(); // relic scale that makes it relicWidthOnCard wide
    private baseLift = 1;           // relic pivot -> base distance at card scale (cm)
    private simulatedCard: { pos: vec3; rot: quat } | null = null; // editor-only test card

    onAwake() {
        if (!this.markerTracking || !this.relic || !this.relicMesh || !this.camera) {
            print("MarkerRelicController: a required input is missing; check the Inspector.");
            return;
        }
        this.markerTracking.autoEnableWhenTracking = false; // we decide visibility ourselves
        this.measureRelic();
        this.setUpSimulatedCard();
        this.createEvent("UpdateEvent").bind(() => this.onUpdate());
    }

    // =====================================================================
    // Public API
    // =====================================================================

    /** Hides the relic and forgets the card, so the next sighting fires onCardFound again. */
    public reset() {
        this.summoned = false;
        this.wasTracking = false;
        this.popStart = -1;
        this.relic.enabled = false;
    }

    public isCardTracked(): boolean {
        return this.simulatedCard !== null || this.markerTracking.isTracking();
    }

    public isSummoned(): boolean {
        return this.summoned;
    }

    /** STEP 2: puts the relic on the card with a pop. Returns false if the card isn't in view. */
    public summon(): boolean {
        if (!this.isCardTracked()) {
            return false;
        }
        this.summoned = true;
        this.followCard(1); // snap straight onto the card before showing it
        this.relic.getTransform().setLocalScale(vec3.zero());
        this.relic.enabled = true;
        this.popStart = getTime();
        return true;
    }

    /** True if a screen tap lands on the tracked card (ray / card-plane intersection). */
    public isTapOnCard(screenPos: vec2): boolean {
        if (!this.isCardTracked()) {
            return false;
        }
        const card = this.getCardPose();
        const cardCenter = card.pos;
        const cardUp = card.rot.multiplyVec3(new vec3(0, 0, 1));

        const origin = this.camera.getTransform().getWorldPosition();
        const dir = this.camera.screenSpaceToWorldSpace(screenPos, 100).sub(origin).normalize();
        const facing = dir.dot(cardUp);
        if (Math.abs(facing) < 1e-4) {
            return false; // looking exactly edge-on
        }
        const t = cardCenter.sub(origin).dot(cardUp) / facing;
        if (t <= 0) {
            return false; // card plane is behind the camera
        }
        const hit = origin.add(dir.uniformScale(t));
        return hit.distance(cardCenter) <= this.cardTapRadius;
    }

    // =====================================================================
    // Per-frame tracking
    // =====================================================================

    private onUpdate() {
        const tracking = this.isCardTracked();
        if (tracking && !this.wasTracking) {
            this.onCardFound();
        } else if (!tracking && this.wasTracking) {
            this.onCardLost(); // the relic keeps its last world position
        }
        this.wasTracking = tracking;

        if (tracking && this.summoned) {
            this.followCard(this.popStart >= 0 ? 1 : this.followSmoothing);
        }
        this.updatePop();
    }

    /**
     * Moves the relic onto the card: base resting on the printed face, standing along the
     * card's normal, facing the card's bottom edge. `t` blends from the current pose (0..1).
     */
    private followCard(t: number) {
        const card = this.getCardPose();
        const cardUp = card.rot.multiplyVec3(new vec3(0, 0, 1));    // out of the printed face
        const cardDown = card.rot.multiplyVec3(new vec3(0, -1, 0)); // toward the bottom edge

        const targetPos = card.pos.add(cardUp.uniformScale(this.baseLift + this.hoverGap));
        const targetRot = quat.lookAt(cardDown, cardUp); // relic +Z faces the viewer, +Y = card up

        const relicT = this.relic.getTransform();
        relicT.setWorldPosition(vec3.lerp(relicT.getWorldPosition(), targetPos, t));
        relicT.setWorldRotation(quat.slerp(relicT.getWorldRotation(), targetRot, t));
    }

    /** Scale-up pop: 0 -> slightly too big -> card size ("ease out back"). */
    private updatePop() {
        if (this.popStart < 0) {
            return;
        }
        const k = Math.min(1, (getTime() - this.popStart) / this.popDuration);
        const s = 1.70158;
        const eased = 1 + (s + 1) * Math.pow(k - 1, 3) + s * Math.pow(k - 1, 2);
        this.relic.getTransform().setLocalScale(this.cardScale.uniformScale(eased));
        if (k >= 1) {
            this.popStart = -1;
        }
    }

    /** The card's world position and rotation (the real marker, or the editor test card). */
    public getCardPose(): { pos: vec3; rot: quat } {
        if (this.simulatedCard) {
            return this.simulatedCard;
        }
        const markerT = this.markerTracking.getSceneObject().getTransform();
        return { pos: markerT.getWorldPosition(), rot: markerT.getWorldRotation() };
    }

    /**
     * TESTING ONLY: inside Lens Studio there is no printed card, so (if enabled) we pretend one
     * lies flat on a table in front of the camera: printed face up, top edge pointing away.
     * isEditor() keeps this from ever running on a phone.
     */
    private setUpSimulatedCard() {
        if (!this.simulateCardInEditor || !global.deviceInfoSystem.isEditor()) {
            return;
        }
        this.simulatedCard = {
            pos: this.simulatedCardPosition,
            rot: quat.fromEulerAngles(-Math.PI / 2, 0, 0), // local +Z (face) = world up, +Y (top) = away
        };
        print("[Marker] Simulating the Aether card in the editor (turn off 'Simulate Card In Editor' to use the real marker)");
    }

    /** Works out the scale that makes the relic `relicWidthOnCard` cm wide, and its base offset. */
    private measureRelic() {
        const min = this.relicMesh.mesh.aabbMin;
        const max = this.relicMesh.mesh.aabbMax;
        const width = Math.max(max.x - min.x, max.z - min.z, 0.0001); // mesh units
        const scale = this.relicWidthOnCard / width;
        this.cardScale = new vec3(scale, scale, scale);
        this.baseLift = -min.y * scale; // pivot is at the mesh centre
    }
}
