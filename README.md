# Aether Relic XR

A Snapchat Lens built in Lens Studio 5. Point your phone at the printed **Aether Sigil card**, tap it to summon the relic, and open the eight shards of the Aether Codex. Then place its artifacts in your real room.

**Project page:** https://blue2233.github.io/aether-relic-xr/

## Core loop

`ANCHOR → SUMMON → SELECT → CARD → PLACING → COMPLETE`

1. **Anchor:** point at the printed 10 cm Aether Sigil card (Image Marker tracking).
2. **Summon:** tap the card; the relic pops onto it with a chime.
3. **Select:** tap one of eight shards (teal = Homeland, violet = Artifact).
4. **Codex card:** read the lore. Homeland cards are *Collected*; Artifact cards are *Placed*.
5. **Place:** hang Shadowglint on a wall, or lay the Aether-woven Rug on the floor (World Mesh and plane ray casts).
6. **Collect:** the counter goes to 8/8, then *Codex Complete!*

## Print the marker

[`assets/marker/aether-sigil-marker-print-10cm.pdf`](assets/marker/aether-sigil-marker-print-10cm.pdf): print at **Actual size / 100%**. The card should measure 10 × 10 cm. Use matte paper, keep it flat, and use even lighting.

## Repository contents

| Path | What it is |
|---|---|
| `index.html` | The project page (GitHub Pages) |
| `assets/` | Map, Codex art, marker image and PDF, Lens screenshots |
| `scripts/` | The Lens's TypeScript components (for reference; the Lens Studio project itself is not included) |

### Scripts

- `AetherLensController.ts`: state machine, tap routing, collecting, reset
- `MarkerRelicController.ts`: sigil card tracking, tap-on-card, summon pop
- `ShardRing.ts`: the eight shards (colours, animation, tap picking)
- `CodexCardView.ts`: floating Codex card, checkmarks, Collected counter
- `CodexData.ts`: the eight Codex entries and lore
- `RoomPlacementController.ts`: real-world hit tests; sword on wall, rug on floor
- `RelicEffects.ts`: Spin, Speed, Orbit, Bounce, Glow, Light, rug grow, sounds
- `RelicMenuController.ts`: draggable Relic menu and Lore card
- `UiFactory.ts`: shared UI helpers and palette

CRCP6380 Final Project.
