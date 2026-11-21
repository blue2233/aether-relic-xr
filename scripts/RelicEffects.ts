/**
 * RelicEffects
 * ------------
 * The extra effects, one function per feature:
 *
 *   MOTION  toggleSpin()   - relic turns around its vertical axis
 *           toggleSpeed()  - switches Spin / Orbit / Bounce between slow and fast
 *           toggleOrbit()  - relic circles around the spot it sits on
 *           toggleBounce() - relic hops up and down
 *   LOOK    toggleGlow()   - swaps the relic's material for a glowing copy
 *           toggleLight()  - warm "torchlight" lighting <-> normal (setWarmLight for direct control)
 *   ROOM    growIn()       - the rug grows from small to full size when it is placed
 *   SOUND   playChime()    - relic chime (summon, collect, place)
 *           playComplete() - fanfare when the Codex is complete
 *   RESET   resetAll()     - everything back to normal
 *
 * Motion is applied to the relic's inner "Scenes" object (relicPivot), never to af_artifact
 * itself, so the relic keeps its place on the card and the shard ring stays steady.
 */
@component
export class RelicEffects extends BaseScriptComponent {
    @input
    @hint("Inner object of the relic that gets animated (af_artifact > Scenes)")
    relicPivot: SceneObject;

    @input
    @hint("The relic's mesh visual (for the Glow material swap)")
    relicVisual: RenderMeshVisual;

    @input
    @hint("Rug object (grows in when placed)")
    rug: SceneObject;

    @input
    @hint("Main directional light (for Light)")
    keyLight: LightSource;

    @input
    @hint("Environment map light (for Light)")
    envLight: LightSource;

    @input
    @hint("Audio component holding the relic chime")
    chime: AudioComponent;

    @input
    @hint("Audio component holding the 'Codex Complete' fanfare")
    completeSound: AudioComponent;

    // ---------- Tuning ----------
    @input
    @hint("Spin speed in degrees per second (slow setting)")
    spinDegreesPerSecond: number = 60;

    @input
    @hint("Multiplier applied to Spin / Orbit / Bounce when Speed is 'fast'")
    fastMultiplier: number = 2.5;

    @input
    @hint("Orbit radius in relic units (1 unit = the relic's width)")
    orbitRadius: number = 0.35;

    @input
    @hint("Bounce height in relic units")
    bounceHeight: number = 0.15;

    @input
    @hint("Glow colour added to the relic (emissive)")
    glowColor: vec3 = new vec3(0.06, 0.42, 0.38);

    @input
    @hint("Seconds the rug takes to grow to full size after it is placed")
    growSeconds: number = 0.8;

    // ---------- State (read by the menu to highlight active toggles) ----------
    public spinOn = false;
    public fast = false;
    public orbitOn = false;
    public bounceOn = false;
    public glowOn = false;
    public warmLightOn = false;

    private spinAngle = 0;   // radians
    private orbitAngle = 0;  // radians
    private bouncePhase = 0; // radians
    private normalMaterial: Material;
    private glowMaterial: Material;
    private defaultKey: { color: vec3; intensity: number };
    private defaultEnvExposure = 1;
    private rugFullScale: vec3;
    private growStart = -1;

    onAwake() {
        if (!this.relicPivot || !this.relicVisual || !this.rug) {
            print("RelicEffects: a required input is missing; check the Inspector.");
            return;
        }
        this.prepareGlowMaterial();
        this.rememberLighting();
        this.rugFullScale = this.rug.getTransform().getLocalScale();
        this.createEvent("UpdateEvent").bind(() => this.onUpdate());
    }

    // =====================================================================
    // MOTION
    // =====================================================================

    /** Spin: turns the relic around its vertical axis. */
    public toggleSpin(): boolean {
        this.spinOn = !this.spinOn;
        return this.spinOn;
    }

    /** Speed: slow <-> fast for every motion effect. Returns true when fast. */
    public toggleSpeed(): boolean {
        this.fast = !this.fast;
        return this.fast;
    }

    /** Orbit: the relic circles around the spot it sits on. */
    public toggleOrbit(): boolean {
        this.orbitOn = !this.orbitOn;
        return this.orbitOn;
    }

    /** Bounce: the relic hops up and down. */
    public toggleBounce(): boolean {
        this.bounceOn = !this.bounceOn;
        return this.bounceOn;
    }

    /** Applies Spin / Orbit / Bounce to the relic's inner pivot each frame. */
    private updateMotion(dt: number) {
        const speed = this.fast ? this.fastMultiplier : 1;
        const spinRate = this.spinDegreesPerSecond * MathUtils.DegToRad * speed;

        if (this.spinOn) {
            this.spinAngle += spinRate * dt;
        }
        if (this.orbitOn) {
            this.orbitAngle += spinRate * 0.75 * dt;
        }
        if (this.bounceOn) {
            this.bouncePhase += Math.PI * 1.5 * speed * dt; // ~0.75 hops per second when slow
        }

        const orbit = this.orbitOn
            ? new vec3(Math.cos(this.orbitAngle) * this.orbitRadius, 0, Math.sin(this.orbitAngle) * this.orbitRadius)
            : vec3.zero();
        const hop = this.bounceOn ? Math.abs(Math.sin(this.bouncePhase)) * this.bounceHeight : 0;

        const t = this.relicPivot.getTransform();
        t.setLocalPosition(orbit.add(new vec3(0, hop, 0)));
        t.setLocalRotation(quat.angleAxis(this.spinOn ? this.spinAngle : 0, vec3.up()));
    }

    // =====================================================================
    // LOOK
    // =====================================================================

    /** Glow: swaps the relic's material for a glowing copy (and back). */
    public toggleGlow(): boolean {
        this.setGlow(!this.glowOn);
        return this.glowOn;
    }

    private setGlow(on: boolean) {
        this.glowOn = on;
        this.relicVisual.mainMaterial = on ? this.glowMaterial : this.normalMaterial;
    }

    /** Light: warm torchlight <-> normal lighting. */
    public toggleLight(): boolean {
        this.setWarmLight(!this.warmLightOn);
        return this.warmLightOn;
    }

    /** Warm torchlight (orange key light, dimmer environment) on or off. Used by Codex Complete. */
    public setWarmLight(on: boolean) {
        this.warmLightOn = on;
        if (this.keyLight) {
            this.keyLight.color = on ? new vec3(1.0, 0.62, 0.3) : this.defaultKey.color;
            this.keyLight.intensity = on ? 1.8 : this.defaultKey.intensity;
        }
        if (this.envLight) {
            this.envLight.envmapExposure = on ? 0.55 : this.defaultEnvExposure;
        }
    }

    // =====================================================================
    // ROOM
    // =====================================================================

    /** Grow: the rug grows from 15% to full size (ease out), right after it is placed. */
    public growIn() {
        this.rug.getTransform().setLocalScale(this.rugFullScale.uniformScale(0.15));
        this.growStart = getTime();
    }

    private updateGrow() {
        if (this.growStart < 0) {
            return;
        }
        const k = Math.min(1, (getTime() - this.growStart) / this.growSeconds);
        const eased = 1 - Math.pow(1 - k, 3);
        this.rug.getTransform().setLocalScale(this.rugFullScale.uniformScale(0.15 + 0.85 * eased));
        if (k >= 1) {
            this.growStart = -1;
        }
    }

    // =====================================================================
    // SOUND
    // =====================================================================

    /** Chime: plays the relic bell once (restarts it if it is already ringing). */
    public playChime() {
        this.playSound(this.chime);
    }

    /** Fanfare for "Codex Complete!". */
    public playComplete() {
        this.playSound(this.completeSound);
    }

    private playSound(audio: AudioComponent) {
        if (!audio) {
            return;
        }
        if (audio.isPlaying()) {
            audio.stop(false);
        }
        audio.play(1);
    }

    // =====================================================================
    // RESET
    // =====================================================================

    /** Turns every effect off and puts the relic and rug back to normal. */
    public resetAll() {
        this.spinOn = this.fast = this.orbitOn = this.bounceOn = false;
        this.spinAngle = this.orbitAngle = this.bouncePhase = 0;
        this.setGlow(false);
        this.setWarmLight(false);
        this.growStart = -1;
        this.rug.getTransform().setLocalScale(this.rugFullScale);
    }

    // =====================================================================
    // Setup helpers
    // =====================================================================

    /** Makes a copy of the relic's material with a strong emissive colour. */
    private prepareGlowMaterial() {
        this.normalMaterial = this.relicVisual.mainMaterial;
        this.glowMaterial = this.normalMaterial.clone();
        this.glowMaterial.mainPass.emissiveFactor = this.glowColor;
    }

    /** Remembers the scene's lighting so Light can switch back to it. */
    private rememberLighting() {
        this.defaultKey = this.keyLight
            ? { color: this.keyLight.color, intensity: this.keyLight.intensity }
            : { color: vec3.one(), intensity: 1 };
        this.defaultEnvExposure = this.envLight ? this.envLight.envmapExposure : 1;
    }

    private onUpdate() {
        this.updateMotion(getDeltaTime());
        this.updateGrow();
    }
}
