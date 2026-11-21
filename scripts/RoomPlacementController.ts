import { ArtifactKind } from "./CodexData";

/**
 * RoomPlacementController  (STEP 5 - place artifacts in the room, + occlusion)
 * ---------------------------------------------------------------------------
 * Places the two ARTIFACT collectibles in the real room when the player taps:
 *
 *   Sword  "Tap a wall to hang the sword"   -> ThornSword hangs HORIZONTALLY on the wall,
 *                                              centred on the hit point, hilt left / tip right
 *   Rug    "Tap the floor to place the rug" -> AetherRug lies flat on the floor, ~1 cm above
 *                                              the hit (RelicEffects then plays the grow)
 *
 * AetherLensController decides WHEN to place (after "Place" on a Codex card) and passes the
 * tap to placeArtifact(). This script only does the real-world hit test and the placement.
 *
 * HOW A TAP BECOMES A PLACEMENT
 *   1. A ray goes from the camera through the tap into the real world, tested against
 *        a) the World Mesh (live 3D scan of the room; best on LiDAR phones) and
 *        b) ARKit/ARCore detected planes (floors, tables, walls).
 *      Both come from the `WorldRaycast` API. The nearest hit wins.
 *   2. The hit gives a world POSITION and a surface NORMAL.
 *   3. The normal tells us the surface type: a floor faces up, a wall is roughly vertical.
 *   4. The object is moved to the hit point, lifted along the normal so it rests ON the
 *      surface, and rotated to line up with it.
 *
 * OCCLUSION (WORLD > Occlusion turns it on/off)
 *   - World Mesh occluder: the room scan is drawn depth-only with Codex/WorldMeshOccluder,
 *     whose shader skips (a) upward-facing faces near the floor, so the floor never fights
 *     the rug, and (b) anything within 30 cm of the camera. Walls, furniture and table tops
 *     still hide virtual objects behind them. The floor height is estimated here (lowest
 *     upward surface seen by a few hit tests, and the rug's floor hit) and passed to the
 *     shader through the material's baseColor.x.
 *   - Person cutout: a full-screen image of the camera feed masked by Body segmentation,
 *     drawn over the 3D scene, so a real foot or leg covers the rug.
 */

/** Result of a placement attempt: ok, or a message telling the player what to do. */
export type PlaceResult = { ok: boolean; message: string };

@component
export class RoomPlacementController extends BaseScriptComponent {
    @input
    @hint("The main AR camera (Camera Object)")
    camera: Camera;

    @input
    @hint("Device Tracking on the camera. Set to World mode so world mesh / planes are available")
    deviceTracking: DeviceTracking;

    @input
    @hint("Rug object (Aether-woven Rug artifact)")
    rug: SceneObject;

    @input
    @hint("Sword object (Thorn-grown Sword artifact)")
    sword: SceneObject;

    // ---------- Tuning (cm) ----------
    @input
    @hint("World Mesh render visual with the depth-only occluder material (WorldMeshOccluder object)")
    occluder: RenderMeshVisual;

    @input
    @hint("Full-screen camera image masked by body segmentation (Full Frame Region > PersonCutout)")
    personCutout: SceneObject;

    @input
    @hint("Rug: half thickness (1.25 cm) + 1 cm gap so it doesn't flicker against the floor")
    rugLift: number = 2.25;

    @input
    @hint("Sword: distance from its pivot to its back face (cm), keeps it out of the wall")
    swordWallOffset: number = 6.2;

    @input
    @hint("Treat floors as perfectly level (recommended: world-mesh normals are noisy)")
    levelSurfaces: boolean = true;

    @input
    @hint("Print hit-test details to the Logger (for debugging)")
    debugLogs: boolean = false;

    // The sword mesh's blade runs along its local X axis with the TIP at -X, and the flat
    // of the blade faces local +/-Z. After the wall alignment (+X = to the viewer's right),
    // a 180° roll around Z turns the tip to the right (+X) and the hilt to the left.
    private readonly swordHorizontal = quat.fromEulerAngles(0, 0, Math.PI);

    // Floor estimate for the occluder shader (world cm). Huge = unknown: every upward face is
    // then treated as floor, which is the safe choice.
    private static readonly FLOOR_UNKNOWN = 1000000;
    private floorY = RoomPlacementController.FLOOR_UNKNOWN;
    private floorSampleTime = 0;
    private readonly floorSamplePoints = [new vec2(0.5, 0.85), new vec2(0.25, 0.8), new vec2(0.75, 0.8), new vec2(0.5, 0.65)];

    onAwake() {
        if (!this.camera || !this.deviceTracking || !this.rug || !this.sword) {
            print("RoomPlacementController: a required input is missing; check the Inspector.");
            return;
        }
        // Ask the tracker for World Mesh + both horizontal and vertical planes so taps
        // can hit floors and walls. (Must be in World tracking mode.)
        this.deviceTracking.worldOptions.enableWorldMeshesTracking = true;
        this.deviceTracking.worldOptions.nativePlaneTrackingType = NativePlaneTrackingType.Both;
        this.hideAll();
        this.setUpOccluder();
        this.createEvent("UpdateEvent").bind(() => this.sampleFloor());
    }

    // =====================================================================
    // Public API
    // =====================================================================

    /** The instruction to show while waiting for the tap that places `kind`. */
    public instructionFor(kind: ArtifactKind): string {
        return kind === ArtifactKind.Sword
            ? "Tap a wall to hang the sword.\nPointy end away from you."
            : "Tap the floor to place the rug.\nFloors. Famously down.";
    }

    /** STEP 5: tries to place the sword (on a wall) or the rug (on the floor) at a tap. */
    public placeArtifact(kind: ArtifactKind, screenPos: vec2): PlaceResult {
        const hit = this.hitTestWorld(screenPos);
        if (!hit) {
            return { ok: false, message: "Can't see a surface yet.\nMove your phone. Slowly. Gently." };
        }
        if (kind === ArtifactKind.Sword) {
            if (!this.isWall(hit.normal)) {
                return { ok: false, message: "That's not a wall.\nBold choice. Wrong, but bold." };
            }
            this.placeOnWall(this.sword, hit.position, hit.normal);
        } else {
            if (!this.isHorizontalUp(hit.normal)) {
                return { ok: false, message: "That's not the floor.\nRugs go down. Gravity agrees." };
            }
            this.noteFloor(hit.position.y);
            this.placeOnHorizontal(this.rug, hit.position, hit.normal, this.rugLift);
        }
        return { ok: true, message: "" };
    }

    /** WORLD > Occlusion: World Mesh occluder + person cutout on or off. */
    public setOcclusionEnabled(on: boolean) {
        if (this.occluder) {
            this.occluder.getSceneObject().enabled = on;
        }
        if (this.personCutout) {
            this.personCutout.enabled = on;
        }
    }

    /** Removes both artifacts from the room (Reset). */
    public hideAll() {
        this.rug.enabled = false;
        this.sword.enabled = false;
    }

    // =====================================================================
    // Hit testing against the real world
    // =====================================================================

    /**
     * Casts a ray through the screen point against BOTH the World Mesh and the detected
     * planes, and returns whichever real surface is closest to the camera, or null.
     */
    private hitTestWorld(screenPos: vec2): { position: vec3; normal: vec3 } | null {
        const camPos = this.camera.getTransform().getWorldPosition();
        let best: { position: vec3; normal: vec3; source: string } | null = null;

        const consider = (position: vec3, normal: vec3, source: string) => {
            if (!best || position.distance(camPos) < best.position.distance(camPos)) {
                best = { position, normal, source };
            }
        };

        const meshHit = this.firstMeshHit(screenPos);
        if (meshHit) {
            consider(meshHit.position, meshHit.normal.normalize(), "world-mesh");
        }
        const planeHit = this.firstPlaneHit(screenPos);
        if (planeHit) {
            consider(planeHit.position, this.planeNormalAt(screenPos, planeHit), "plane");
        }

        if (this.debugLogs) {
            print(best
                ? `[Placement] ${best.source} hit at ${best.position} normal ${best.normal}`
                : `[Placement] no hit at screen ${screenPos}`);
        }
        return best;
    }

    private firstMeshHit(screenPos: vec2): TrackedMeshHitTestResult | null {
        try {
            const hits = WorldRaycast.hitTestWorldMesh(screenPos, this.camera);
            return hits && hits.length > 0 ? hits[0] : null;
        } catch (e) {
            return null; // World mesh not supported on this device.
        }
    }

    private firstPlaneHit(screenPos: vec2): TrackedPlaneHitTestResult | null {
        try {
            const hits = WorldRaycast.hitTestPlanes(screenPos, this.camera);
            return hits && hits.length > 0 ? hits[0] : null;
        } catch (e) {
            return null; // Plane tracking unavailable.
        }
    }

    /**
     * Works out a plane's facing direction from geometry: cast two more rays a little to the
     * side and below the tap and take the cross product of the three hit points. Falls back
     * to the plane's orientation flag if those extra rays miss.
     */
    private planeNormalAt(screenPos: vec2, hit: TrackedPlaneHitTestResult): vec3 {
        const d = 0.02; // ~2% of the screen
        const hx = this.firstPlaneHit(new vec2(screenPos.x + d, screenPos.y));
        const hy = this.firstPlaneHit(new vec2(screenPos.x, screenPos.y + d));

        let normal: vec3 | null = null;
        if (hx && hy) {
            const n = hx.position.sub(hit.position).cross(hy.position.sub(hit.position));
            if (n.length > 1e-4) {
                normal = n.normalize();
            }
        }
        if (!normal) {
            if (hit.plane.orientation === TrackedPlaneOrientation.Horizontal) {
                normal = vec3.up();
            } else {
                const flat = this.camera.getTransform().getWorldPosition().sub(hit.position).projectOnPlane(vec3.up());
                normal = flat.length > 1e-4 ? flat.normalize() : vec3.forward();
            }
        }
        return this.faceTowardCamera(normal, hit.position);
    }

    /** Planes can report a normal on either side; make it point toward the viewer. */
    private faceTowardCamera(normal: vec3, point: vec3): vec3 {
        const toCamera = this.camera.getTransform().getWorldPosition().sub(point);
        return normal.dot(toCamera) < 0 ? normal.uniformScale(-1) : normal;
    }

    /** Floor: normal points mostly up. */
    private isHorizontalUp(normal: vec3): boolean {
        return normal.dot(vec3.up()) > 0.7; // within ~45° of straight up
    }

    /** Wall: normal is mostly sideways. */
    private isWall(normal: vec3): boolean {
        return Math.abs(normal.dot(vec3.up())) < 0.5;
    }

    // =====================================================================
    // Placement
    // =====================================================================

    /** Puts an object flat on the floor, turned to face the camera. */
    private placeOnHorizontal(obj: SceneObject, hitPos: vec3, hitNormal: vec3, lift: number) {
        const t = obj.getTransform();
        const normal = this.levelSurfaces ? vec3.up() : hitNormal; // real floors are level

        const toCamera = this.camera.getTransform().getWorldPosition().sub(hitPos).projectOnPlane(normal);
        const rotation = toCamera.length > 0.001
            ? quat.lookAt(toCamera.normalize(), normal) // +Z faces camera, +Y = surface normal
            : quat.rotationFromTo(vec3.up(), normal);

        t.setWorldRotation(rotation);
        t.setWorldPosition(hitPos.add(normal.uniformScale(lift)));
        obj.enabled = true;
    }

    /** Mounts the sword HORIZONTALLY on a wall: flat faces out, level, hilt left / tip right. */
    private placeOnWall(obj: SceneObject, hitPos: vec3, normal: vec3) {
        const t = obj.getTransform();

        // Keep only the horizontal part of the wall normal so the blade stays level.
        let out = normal.projectOnPlane(vec3.up());
        out = out.length > 0.001 ? out.normalize() : vec3.forward();

        const wallFrame = quat.lookAt(out, vec3.up());
        t.setWorldRotation(wallFrame.multiply(this.swordHorizontal));
        t.setWorldPosition(hitPos.add(out.uniformScale(this.swordWallOffset)));
        obj.enabled = true;
    }

    // =====================================================================
    // Occlusion
    // =====================================================================

    /** Asks the World Mesh for normals (the occluder shader needs them) and starts unknown. */
    private setUpOccluder() {
        if (!this.occluder) {
            return;
        }
        try {
            const provider = this.occluder.mesh.control as WorldRenderObjectProvider;
            provider.useNormals = true;
            provider.enableWorldMeshesTracking = true;
        } catch (e) {
            print("RoomPlacementController: World Mesh provider not available here (" + e + ")");
        }
        this.applyFloor();
    }

    /** Twice a second: hit-test a few low screen points; the lowest upward surface is the floor. */
    private sampleFloor() {
        if (!this.occluder || !this.occluder.getSceneObject().enabled) {
            return;
        }
        const now = getTime();
        if (now - this.floorSampleTime < 0.5) {
            return;
        }
        this.floorSampleTime = now;
        for (const point of this.floorSamplePoints) {
            const hit = this.hitTestWorld(point);
            if (hit && this.isHorizontalUp(hit.normal)) {
                this.noteFloor(hit.position.y);
            }
        }
    }

    private noteFloor(y: number) {
        if (y < this.floorY) {
            this.floorY = y;
            this.applyFloor();
        }
    }

    private applyFloor() {
        if (this.occluder && this.occluder.mainMaterial) {
            this.occluder.mainMaterial.mainPass.baseColor = new vec4(this.floorY, 0, 0, 0);
        }
    }
}
