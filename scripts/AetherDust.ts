/**
 * AetherDust
 * ----------
 * A one-shot burst of glowing "aether dust" that puffs up out of the printed Sigil card the
 * moment it is found.
 *
 *   - A pool of small glowing quads is built once (no objects are created during play).
 *   - burst(center, rotation) launches them from the card face: they spray up out of the card
 *     and slightly outward, swirl around the card's normal, slow down, drift upward,
 *     twinkle and fade. A short bright flash sits on the card centre at the start.
 *   - Colours: mostly aether teal, some moonlight lavender, a few white sparks.
 *   - Every particle always faces the camera (billboard). The material uses normal alpha
 *     blending (not additive) so the teal still reads on bright, light-coloured rooms.
 *
 * Owned by AetherLensController, which calls update() every frame.
 */

type Particle = {
    obj: SceneObject;
    transform: Transform;
    pass: Pass;
    pos: vec3;
    vel: vec3;
    color: vec3;
    size: number;          // cm
    life: number;          // seconds
    age: number;
    twinkle: number;       // phase for the sparkle
    isFlash: boolean;
};

const TEAL = new vec3(0.35, 1.0, 0.9);
const LAVENDER = new vec3(0.78, 0.62, 1.0);
const SPARK = new vec3(1.0, 1.0, 1.0);

export class AetherDust {
    private particles: Particle[] = [];
    private flash: Particle;
    private active = false;
    private cardUp = vec3.up();
    private cardCenter = vec3.zero();

    /**
     * @param count       how many dust motes per burst
     * @param cardRadius  motes start anywhere on the card face within this radius (cm)
     */
    constructor(
        private camera: Camera,
        material: Material,
        texture: Texture,
        private count: number = 90,
        private cardRadius: number = 4.5,
    ) {
        const mesh = AetherDust.buildQuad();
        const layer = camera.renderLayer;
        for (let i = 0; i < count; i++) {
            this.particles.push(AetherDust.createParticle("AetherDust_" + i, mesh, material, texture, layer, false));
        }
        this.flash = AetherDust.createParticle("AetherDust_Flash", mesh, material, texture, layer, true);
    }

    /** Launches the burst from the card's face. `rotation` is the card's world rotation (+Z = out of the face). */
    public burst(center: vec3, rotation: quat) {
        const up = rotation.multiplyVec3(new vec3(0, 0, 1));
        const right = rotation.multiplyVec3(new vec3(1, 0, 0));
        const down = rotation.multiplyVec3(new vec3(0, 1, 0));
        this.cardUp = up;
        this.cardCenter = center;

        for (const p of this.particles) {
            // Start somewhere on the card face, a hair above it.
            const angle = Math.random() * Math.PI * 2;
            const radius = Math.sqrt(Math.random()) * this.cardRadius;
            const radial = right.uniformScale(Math.cos(angle)).add(down.uniformScale(Math.sin(angle)));
            p.pos = center.add(radial.uniformScale(radius)).add(up.uniformScale(0.3));

            // Mostly up out of the card, a bit outward.
            const upSpeed = 10 + Math.random() * 20;          // cm/s
            const outSpeed = 3 + Math.random() * 10;
            p.vel = up.uniformScale(upSpeed).add(radial.uniformScale(outSpeed));

            const pick = Math.random();
            p.color = pick < 0.62 ? TEAL : pick < 0.88 ? LAVENDER : SPARK;
            p.size = pick < 0.88 ? 0.9 + Math.random() * 1.4 : 0.5 + Math.random() * 0.5;
            p.life = 0.9 + Math.random() * 0.9;
            p.age = -Math.random() * 0.25;                      // small stagger: a puff, not a wall
            p.twinkle = Math.random() * Math.PI * 2;
            p.obj.enabled = false;
        }

        this.flash.pos = center.add(up.uniformScale(0.5));
        this.flash.vel = vec3.zero();
        this.flash.color = TEAL;
        this.flash.size = 14;
        this.flash.life = 0.45;
        this.flash.age = 0;
        this.active = true;
    }

    public stop() {
        this.active = false;
        for (const p of this.particles) {
            p.obj.enabled = false;
        }
        this.flash.obj.enabled = false;
    }

    public update(dt: number) {
        if (!this.active) {
            return;
        }
        dt = Math.min(dt, 1 / 20); // no big jumps after a hitch
        const camPos = this.camera.getTransform().getWorldPosition();
        const camUp = this.camera.getTransform().up;
        let alive = false;

        for (const p of this.particles) {
            alive = this.step(p, dt, camPos, camUp) || alive;
        }
        alive = this.step(this.flash, dt, camPos, camUp) || alive;

        if (!alive) {
            this.stop();
        }
    }

    // ---------------------------------------------------------------------

    /** Moves and draws one particle. Returns false once it has finished. */
    private step(p: Particle, dt: number, camPos: vec3, camUp: vec3): boolean {
        p.age += dt;
        if (p.age < 0) {
            p.obj.enabled = false;
            return true; // waiting for its stagger
        }
        const t = p.age / p.life;
        if (t >= 1) {
            p.obj.enabled = false;
            return false;
        }

        let scale: number;
        let alpha: number;
        if (p.isFlash) {
            // Quick bright bloom on the card that grows and fades.
            scale = p.size * (0.4 + 0.6 * Math.sqrt(t));
            alpha = 0.9 * (1 - t) * (1 - t);
        } else {
            // Drag, gentle lift, and a swirl around the card's normal.
            const drag = Math.exp(-2.2 * dt);
            const fromAxis = p.pos.sub(this.cardCenter);
            const swirl = this.cardUp.cross(fromAxis).normalize().uniformScale(9 * dt);
            p.vel = p.vel.uniformScale(drag).add(this.cardUp.uniformScale(6 * dt)).add(swirl);
            p.pos = p.pos.add(p.vel.uniformScale(dt));

            // Pop in fast, shrink out slowly; twinkle while fading.
            const grow = Math.min(1, t / 0.12);
            scale = p.size * grow * (1 - 0.5 * t);
            const sparkle = 0.75 + 0.25 * Math.sin(p.twinkle + p.age * 22);
            alpha = Math.pow(1 - t, 1.4) * sparkle;
        }

        p.transform.setWorldPosition(p.pos);
        p.transform.setWorldScale(vec3.one().uniformScale(Math.max(scale, 0.001)));
        const toCamera = camPos.sub(p.pos);
        if (toCamera.lengthSquared > 1e-6) {
            p.transform.setWorldRotation(quat.lookAt(toCamera.normalize(), camUp));
        }
        p.pass.baseColor = new vec4(p.color.x, p.color.y, p.color.z, alpha);
        p.obj.enabled = true;
        return true;
    }

    private static createParticle(name: string, mesh: RenderMesh, material: Material, texture: Texture, layer: LayerSet, isFlash: boolean): Particle {
        const obj = global.scene.createSceneObject(name);
        obj.layer = layer;
        const visual = obj.createComponent("Component.RenderMeshVisual");
        visual.mesh = mesh;
        const mat = material.clone();
        visual.mainMaterial = mat;
        const pass = mat.mainPass;
        if (texture) {
            pass.baseTex = texture;
        }
        obj.enabled = false;
        return {
            obj, transform: obj.getTransform(), pass,
            pos: vec3.zero(), vel: vec3.zero(), color: TEAL,
            size: 1, life: 1, age: 0, twinkle: 0, isFlash,
        };
    }

    /** A 1 x 1 cm quad in the XY plane facing +Z, with UVs. */
    private static buildQuad(): RenderMesh {
        const builder = new MeshBuilder([
            { name: "position", components: 3 },
            { name: "normal", components: 3 },
            { name: "texture0", components: 2 },
        ]);
        builder.topology = MeshTopology.Triangles;
        builder.indexType = MeshIndexType.UInt16;
        const h = 0.5;
        builder.appendVerticesInterleaved([
            -h, -h, 0, 0, 0, 1, 0, 0,
            h, -h, 0, 0, 0, 1, 1, 0,
            h, h, 0, 0, 0, 1, 1, 1,
            -h, h, 0, 0, 0, 1, 0, 1,
        ]);
        builder.appendIndices([0, 1, 2, 0, 2, 3]);
        builder.updateMesh();
        return builder.getMesh();
    }
}
