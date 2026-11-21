import { CODEX_ENTRIES, CodexCategory } from "./CodexData";

/**
 * ShardRing
 * ---------
 * Builds the 8 glowing shards that float in a ring around the relic, one per Codex entry
 * (same order as CODEX_ENTRIES). Lives on the "ShardRing" object, a child of af_artifact,
 * so the shards follow the relic and pop in with it.
 *
 *   teal shard = HOMELAND card      dark violet (thorn) shard = ARTIFACT card
 *   collected  = dimmed, semi-transparent (CodexCardView also draws a checkmark over it)
 *
 * The ring turns slowly and each shard bobs and spins, so they read as "alive".
 * Tapping is done by screen distance (pick): no colliders are needed, and small shards
 * stay easy to hit on a phone.
 *
 * Sizes are in the relic's own units (1 unit ~ the relic's width), so the ring scales
 * with the relic.
 */
@component
export class ShardRing extends BaseScriptComponent {
    @input
    @hint("Crystal mesh for each shard (Codex/ShardMesh)")
    shardMesh: RenderMesh;

    @input
    @hint("Unlit material for the shards (Codex/ShardMaterial); each shard gets its own copy")
    shardMaterial: Material;

    @input
    @hint("Main AR camera (for tap picking)")
    camera: Camera;

    @input
    @hint("Ring radius, in relic units")
    ringRadius: number = 0.85;

    @input
    @hint("Height of the ring above the relic's centre, in relic units")
    ringHeight: number = 0.15;

    @input
    @hint("Shard size (x = width, y = height, z = depth), in relic units")
    shardSize: vec3 = new vec3(0.1, 0.24, 0.1);

    @input
    @hint("How fast the whole ring turns, degrees per second")
    ringDegreesPerSecond: number = 10;

    @input
    @hint("Tap tolerance around a shard, as a fraction of the screen height")
    pickRadius: number = 0.05;

    private readonly homelandColor = new vec4(0.25, 0.95, 0.85, 0.95); // teal aether
    private readonly artifactColor = new vec4(0.46, 0.2, 0.66, 0.95);  // dark violet thorn

    private shards: { obj: SceneObject; visual: RenderMeshVisual; collected: boolean; phase: number }[] = [];
    private ringAngle = 0;

    onAwake() {
        if (!this.shardMesh || !this.shardMaterial || !this.camera) {
            print("ShardRing: a required input is missing; check the Inspector.");
            return;
        }
        this.buildShards();
        this.createEvent("UpdateEvent").bind(() => this.animate());
    }

    // =====================================================================
    // Public API (used by AetherLensController / CodexCardView)
    // =====================================================================

    /** Dims a shard (collected) or makes it glow again. */
    public setCollected(index: number, collected: boolean) {
        const shard = this.shards[index];
        if (!shard) {
            return;
        }
        shard.collected = collected;
        shard.visual.mainPass.baseColor = this.colorFor(index, collected);
    }

    /** All shards glowing again (Reset). */
    public resetAll() {
        for (let i = 0; i < this.shards.length; i++) {
            this.setCollected(i, false);
        }
    }

    /** Index of the shard under a tap, or -1. Picks the nearest shard on screen. */
    public pick(screenPos: vec2): number {
        if (!this.getSceneObject().isEnabledInHierarchy) {
            return -1;
        }
        const aspect = this.camera.aspect; // width / height, so distances are measured fairly
        let best = -1;
        let bestDist = this.pickRadius;
        for (let i = 0; i < this.shards.length; i++) {
            const world = this.getShardWorldPosition(i);
            if (!this.isInFrontOfCamera(world)) {
                continue;
            }
            const p = this.camera.worldSpaceToScreenSpace(world);
            const dist = new vec2((p.x - screenPos.x) * aspect, p.y - screenPos.y).length;
            if (dist < bestDist) {
                bestDist = dist;
                best = i;
            }
        }
        return best;
    }

    public getShardWorldPosition(index: number): vec3 {
        return this.shards[index].obj.getTransform().getWorldPosition();
    }

    public get count(): number {
        return this.shards.length;
    }

    public isInFrontOfCamera(world: vec3): boolean {
        const camT = this.camera.getTransform();
        const look = camT.getWorldRotation().multiplyVec3(new vec3(0, 0, -1)); // camera looks down -Z
        return world.sub(camT.getWorldPosition()).dot(look) > 0;
    }

    // =====================================================================
    // Building and animating
    // =====================================================================

    /** Creates one shard per Codex entry, evenly spaced around the ring. */
    private buildShards() {
        const parent = this.getSceneObject();
        for (let i = 0; i < CODEX_ENTRIES.length; i++) {
            const obj = global.scene.createSceneObject("Shard_" + (i + 1) + "_" + CODEX_ENTRIES[i].category);
            obj.setParent(parent);
            obj.layer = parent.layer;
            obj.getTransform().setLocalScale(this.shardSize);

            const visual = obj.createComponent("Component.RenderMeshVisual");
            visual.mesh = this.shardMesh;
            visual.mainMaterial = this.shardMaterial.clone();

            this.shards.push({ obj, visual, collected: false, phase: i * 0.7 });
            this.setCollected(i, false);
        }
        this.animate();
    }

    /** Turns the ring, and bobs + spins each shard. Collected shards sit still and low. */
    private animate() {
        const t = getTime();
        this.ringAngle += this.ringDegreesPerSecond * MathUtils.DegToRad * getDeltaTime();
        const n = this.shards.length;

        for (let i = 0; i < n; i++) {
            const shard = this.shards[i];
            // i = 0 sits at the front (+Z, toward the viewer); the rest go round the circle.
            const angle = this.ringAngle + (i / n) * Math.PI * 2;
            const bob = shard.collected ? -0.04 : Math.sin(t * 2 + shard.phase) * 0.04;
            const st = shard.obj.getTransform();
            st.setLocalPosition(new vec3(Math.sin(angle) * this.ringRadius, this.ringHeight + bob, Math.cos(angle) * this.ringRadius));
            st.setLocalRotation(quat.angleAxis(shard.collected ? 0 : t * 1.5 + shard.phase, vec3.up()));
        }
    }

    /** Teal for Homeland, violet for Artifact; dark and see-through once collected. */
    private colorFor(index: number, collected: boolean): vec4 {
        const base = CODEX_ENTRIES[index].category === CodexCategory.Homeland ? this.homelandColor : this.artifactColor;
        return collected ? new vec4(base.x * 0.35, base.y * 0.35, base.z * 0.35, 0.45) : base;
    }
}
