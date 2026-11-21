/**
 * CodexData
 * ---------
 * The 8 collectibles of the Aether Codex, one per shard around the relic.
 *
 *   HOMELAND (teal aether shards)   - the lands of Aetherforge Spire's Wyrendal Dominion.
 *                                     Card button: "Collect".
 *   ARTIFACT (violet thorn shards)  - real objects you place in your room.
 *                                     Card button: "Place" (then tap a wall / the floor).
 *
 * `tag` (optional) replaces the category label on the card, e.g. Auðreach shows "The Reach"
 * while still counting as a Homeland card.
 *
 * Card images are set in the Inspector on CodexCardView ("Card Images"), one slot per entry,
 * in this same order (they live in Assets/Codex/Images).
 */

export enum CodexCategory {
    Homeland = "HOMELAND",
    Artifact = "ARTIFACT",
}

/** Which real-world object an Artifact card places. */
export enum ArtifactKind {
    None = "none",
    Sword = "sword",
    Rug = "rug",
}

export type CodexEntry = {
    title: string;
    category: CodexCategory;
    lore: string;
    artifact: ArtifactKind;
    tag?: string; // optional label shown instead of the category
};

// Order = shard order around the relic (clockwise, seen from above, starting at the front).
export const CODEX_ENTRIES: CodexEntry[] = [
    {
        title: "Solheim",
        category: CodexCategory.Homeland,
        lore: "Golden fields and low alabaster walls under an endless dawn. Many peoples pass through, but most who call it home are human.",
        artifact: ArtifactKind.None,
    },
    {
        title: "Glodmark",
        category: CodexCategory.Homeland,
        lore: "Volcanic peaks, rivers of lava and stone forge halls. The forges belong to the dwarven clans, who have made these mountains their own.",
        artifact: ArtifactKind.None,
    },
    {
        title: "Shadowglint",
        category: CodexCategory.Artifact,
        lore: "'Then carry the truth you'd rather no one saw,' it says, and the weapon grows from thorn and shadow. A shadow gift of the Aetheryl.",
        artifact: ArtifactKind.Sword,
    },
    {
        title: "Celestara",
        category: CodexCategory.Homeland,
        lore: "Floating islands and carved libraries beneath silver-lavender storms. Seekers of every kind come to study, though most scholars are human.",
        artifact: ArtifactKind.None,
    },
    {
        title: "Vaettmar",
        category: CodexCategory.Homeland,
        lore: "Moonlit canopies, spirit glades and trees that whisper. These ancient forests are the home of the elves.",
        artifact: ArtifactKind.None,
    },
    {
        title: "Aether-woven Rug",
        category: CodexCategory.Artifact,
        lore: "Woven from veilweave, the Dominion's fine hex-weave cloth, threaded with aether that glows teal in the dark.",
        artifact: ArtifactKind.Rug,
    },
    {
        title: "Mrokfen",
        category: CodexCategory.Homeland,
        lore: "Obsidian plains lost in violet fog, where moon-temples stand among pools of hot violet water. A hard land, settled by hardy human folk.",
        artifact: ArtifactKind.None,
    },
    {
        title: "Auðreach",
        category: CodexCategory.Homeland,
        tag: "The Reach",
        lore: "Dangerous, unclaimed wilds between the five lands. No kingdom rules here. Harrowgate, at the only reliable bridge, is the last hearth before the Spire.",
        artifact: ArtifactKind.None,
    },
];

export const CODEX_SIZE = CODEX_ENTRIES.length; // 8
