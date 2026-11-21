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
 *   - LEVEL LOCK: the marker is only trusted for POSITION and YAW (which way the card's
 *     bottom edge points, flattened onto the floor). The relic's up axis is always world up
 *     (World Device Tracking keeps world +Y = gravity up), so a misjudged marker angle can
 *     never tilt the relic or its shard ring (the ring is a child of the relic).
 *   - SMOOTHING: the marker pose is low-pass filtered (poseSmoothing, ~0.15 per frame) so
 *     tracking jitter doesn't wobble anything.
 *   - WORLD ANCHOR: on summon the relic is pinned to a fixed world pose at that spot and
 *     stops following the marker. It only re-syncs if the (smoothed) marker drifts more than
 *     resyncDistance (~5 cm) from where it was anchored - then it glides to the new spot.
 *     When the card is lost the relic simply stays at its anchor.
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
    @hint("0..1: how much of the new marker pose is taken each frame (lower = steadier, laggier)")
    poseSmoothing: number = 0.15;

    @input
    @hint("Once summoned, the relic only moves if the card moves further than this, in cm")
    resyncDistance: number = 5;

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

    // Level lock + smoothing + world anchor
    private smoothPos: vec3 | null = null;  // smoothed marker centre (world)
    private smoothRot: quat | null = null;  // smoothed LEVEL rotation: yaw only, up = world up
    private anchorPos: vec3 | null = null;  // where the relic is pinned (world)
    private anchorRot: quat | null = null;
    private anchorMarkerPos: vec3 | null = null; // smoothed marker centre when last anchored

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
        this.smoothPos = this.smoothRot = null;
        this.clearAnchor();
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
        this.updateSmoothedPose(true);   // start from the current reading, no lag
        this.setAnchor();                // pin it to this spot in the world
        this.moveRelicToAnchor(1);       // snap straight there before showing it
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

    /**
     * True if a screen tap lands on the summoned relic. The relic is a short disc, so the tap's
     * ray is tested against its bottom, middle and top planes: a hit within the disc's radius
     * on any of them counts. Works where the relic was last seen, even if the card is lost.
     */
    public isTapOnRelic(screenPos: vec2): boolean {
        if (!this.summoned || !this.relic.enabled) {
            return false;
        }
        const relicT = this.relic.getTransform();
        const center = relicT.getWorldPosition();
        const axis = relicT.up;                                  // stands along the card's normal
        const radius = this.relicWidthOnCard / 2 + 0.5;          // + a little finger slack, cm
        const halfHeight = Math.max(this.baseLift, 0.5);

        const origin = this.camera.getTransform().getWorldPosition();
        const dir = this.camera.screenSpaceToWorldSpace(screenPos, 100).sub(origin).normalize();
        const facing = dir.dot(axis);
        if (Math.abs(facing) < 1e-4) {
            return false; // looking exactly edge-on
        }
        for (const h of [-halfHeight, 0, halfHeight]) {
            const planePoint = center.add(axis.uniformScale(h));
            const t = planePoint.sub(origin).dot(axis) / facing;
            if (t > 0 && origin.add(dir.uniformScale(t)).distance(planePoint) <= radius) {
                return true;
            }
        }
        return false;
    }

    // =====================================================================
    // Per-frame tracking
    // =====================================================================

    private onUpdate() {
        const tracking = this.isCardTracked();
        if (tracking && !this.wasTracking) {
            this.onCardFound();
        } else if (!tracking && this.wasTracking) {
            this.onCardLost(); // the relic keeps its anchor
        }

        if (tracking) {
            this.updateSmoothedPose(!this.wasTracking); // fresh sighting: no lag from an old pose
            // Only re-anchor if the card has really moved, not for jitter.
            if (this.summoned && this.anchorMarkerPos && this.smoothPos.distance(this.anchorMarkerPos) > this.resyncDistance) {
                this.setAnchor();
            }
        }
        this.wasTracking = tracking;

        if (this.summoned) {
            this.moveRelicToAnchor(this.popStart >= 0 ? 1 : this.poseSmoothing);
        }
        this.updatePop();
    }

    /**
     * Low-pass filters the marker pose: position, and a LEVEL rotation (yaw from the marker,
     * up = world up). `snap` takes the new reading as-is.
     */
    private updateSmoothedPose(snap: boolean) {
        const card = this.getCardPose();
        const level = this.levelRotation(card.rot, card.pos);
        if (snap || !this.smoothPos || !this.smoothRot) {
            this.smoothPos = card.pos;
            this.smoothRot = level;
            return;
        }
        const k = MathUtils.clamp(this.poseSmoothing, 0.01, 1);
        this.smoothPos = vec3.lerp(this.smoothPos, card.pos, k);
        this.smoothRot = quat.slerp(this.smoothRot, level, k);
    }

    /**
     * The marker's rotation with pitch and roll thrown away: up is world up, and the relic
     * faces the card's bottom edge flattened onto the floor. If the card is held nearly
     * upright (bottom edge points down), the card's face direction is used instead, and as a
     * last resort the direction toward the camera.
     */
    private levelRotation(cardRot: quat, cardPos: vec3): quat {
        const up = vec3.up(); // World Device Tracking: +Y is gravity up
        const flatten = (v: vec3) => v.sub(up.uniformScale(v.dot(up)));
        let facing = flatten(cardRot.multiplyVec3(new vec3(0, -1, 0)));   // toward the bottom edge
        if (facing.length < 0.2) {
            facing = flatten(cardRot.multiplyVec3(new vec3(0, 0, 1)));    // upright card: its face
        }
        if (facing.length < 0.2) {
            facing = flatten(this.camera.getTransform().getWorldPosition().sub(cardPos)); // toward the viewer
        }
        if (facing.length < 1e-4) {
            facing = vec3.forward();
        }
        return quat.lookAt(facing.normalize(), up); // relic +Z faces the viewer, +Y = world up
    }

    /** Pins the relic to the current smoothed marker pose (base on the card, level). */
    private setAnchor() {
        const up = vec3.up();
        this.anchorMarkerPos = this.smoothPos;
        this.anchorPos = this.smoothPos.add(up.uniformScale(this.baseLift + this.hoverGap));
        this.anchorRot = this.smoothRot;
    }

    private clearAnchor() {
        this.anchorPos = this.anchorRot = this.anchorMarkerPos = null;
    }

    /** Eases the relic toward its anchor (t = 1 snaps). At rest it simply sits on it. */
    private moveRelicToAnchor(t: number) {
        if (!this.anchorPos || !this.anchorRot) {
            return;
        }
        const relicT = this.relic.getTransform();
        relicT.setWorldPosition(vec3.lerp(relicT.getWorldPosition(), this.anchorPos, t));
        relicT.setWorldRotation(quat.slerp(relicT.getWorldRotation(), this.anchorRot, t));
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
