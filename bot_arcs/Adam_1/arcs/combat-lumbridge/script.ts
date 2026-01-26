/**
 * Arc: combat-lumbridge
 * Character: Adam_1
 *
 * Goal: Train Attack, Strength, Defence at Lumbridge.
 * Strategy: Fight goblins/rats near Lumbridge castle.
 *
 * Duration: 3 minutes
 */

import { runArc, StallError } from '../../../arc-runner';
import type { ScriptContext } from '../../../arc-runner';
import type { NearbyNpc, InventoryItem } from '../../../../agent/types';

// Lumbridge goblin area (east of castle)
const LUMBRIDGE_GOBLINS = { x: 3240, z: 3220 };

interface Stats {
    kills: number;
    startAtkXp: number;
    startStrXp: number;
    startDefXp: number;
    startTime: number;
    lastProgressTime: number;
    currentTrainingSkill: string;
}

function markProgress(ctx: ScriptContext, stats: Stats): void {
    stats.lastProgressTime = Date.now();
    ctx.progress();
}

function getAttackLevel(ctx: ScriptContext): number {
    return ctx.state()?.skills.find(s => s.name === 'Attack')?.baseLevel ?? 1;
}

function getStrengthLevel(ctx: ScriptContext): number {
    return ctx.state()?.skills.find(s => s.name === 'Strength')?.baseLevel ?? 1;
}

function getDefenceLevel(ctx: ScriptContext): number {
    return ctx.state()?.skills.find(s => s.name === 'Defence')?.baseLevel ?? 1;
}

function getHitpoints(ctx: ScriptContext): { level: number; current: number } {
    const skill = ctx.state()?.skills.find(s => s.name === 'Hitpoints');
    return { level: skill?.baseLevel ?? 10, current: skill?.level ?? 10 };
}

function getAtkXp(ctx: ScriptContext): number {
    return ctx.state()?.skills.find(s => s.name === 'Attack')?.experience ?? 0;
}

function getStrXp(ctx: ScriptContext): number {
    return ctx.state()?.skills.find(s => s.name === 'Strength')?.experience ?? 0;
}

function getDefXp(ctx: ScriptContext): number {
    return ctx.state()?.skills.find(s => s.name === 'Defence')?.experience ?? 0;
}

function getTotalLevel(ctx: ScriptContext): number {
    return ctx.state()?.skills.reduce((sum, s) => sum + s.baseLevel, 0) ?? 32;
}

/**
 * Find food in inventory
 */
function findFood(ctx: ScriptContext): InventoryItem | null {
    const state = ctx.state();
    if (!state) return null;
    const foodNames = ['bread', 'meat', 'chicken', 'beef', 'shrimp', 'anchovies',
        'sardine', 'herring', 'trout', 'salmon', 'cooked'];
    return state.inventory.find(item =>
        foodNames.some(food => item.name.toLowerCase().includes(food))
    ) ?? null;
}

/**
 * Find weapon in inventory or equipment
 */
function findWeapon(ctx: ScriptContext): InventoryItem | null {
    const state = ctx.state();
    if (!state) return null;
    return state.inventory.find(i =>
        (/sword|scimitar|dagger|axe|mace/i.test(i.name)) && !/pickaxe/i.test(i.name)
    ) ?? null;
}

/**
 * Find attackable NPC
 */
function findTarget(ctx: ScriptContext): NearbyNpc | null {
    const state = ctx.state();
    if (!state) return null;

    const targetNames = ['goblin', 'rat', 'spider', 'chicken', 'cow'];

    const attackableNpcs = state.nearbyNpcs.filter(npc => {
        const hasAttack = npc.optionsWithIndex.some(o =>
            o.text.toLowerCase() === 'attack'
        );
        return hasAttack;
    });

    // Score NPCs by preference
    const scoreNpc = (npc: NearbyNpc): number => {
        const name = npc.name.toLowerCase();
        let score = 0;
        const nameIndex = targetNames.findIndex(t => name.includes(t));
        if (nameIndex !== -1) {
            score += (targetNames.length - nameIndex) * 1000;
        }
        score += (15 - Math.min(npc.distance, 15)) * 10;
        score += Math.max(0, 20 - npc.combatLevel);
        return score;
    };

    const sorted = attackableNpcs.sort((a, b) => scoreNpc(b) - scoreNpc(a));
    return sorted[0] ?? null;
}

/**
 * Get combat style index for a skill
 */
function getStyleForSkill(ctx: ScriptContext, skill: string): number | null {
    const styleState = ctx.state()?.combatStyle;
    if (!styleState) return null;
    const match = styleState.styles.find(s =>
        s.trainedSkill.toLowerCase() === skill.toLowerCase()
    );
    return match?.index ?? null;
}

/**
 * Main combat loop
 */
async function combatLoop(ctx: ScriptContext, stats: Stats): Promise<void> {
    ctx.log('=== Combat Arc Started ===');
    let loopCount = 0;
    let noTargetCount = 0;
    let lastAtkLevel = getAttackLevel(ctx);
    let lastStrLevel = getStrengthLevel(ctx);
    let lastDefLevel = getDefenceLevel(ctx);

    while (true) {
        loopCount++;
        if (loopCount % 100 === 0) {
            ctx.log(`Combat loop: ${loopCount} iterations, kills: ${stats.kills}`);
            ctx.log(`  Atk: ${getAttackLevel(ctx)}, Str: ${getStrengthLevel(ctx)}, Def: ${getDefenceLevel(ctx)}`);
        }

        const currentState = ctx.state();
        if (!currentState) break;

        // Dismiss dialogs
        if (currentState.dialog.isOpen) {
            await ctx.sdk.sendClickDialog(0);
            markProgress(ctx, stats);
            await new Promise(r => setTimeout(r, 300));
            continue;
        }

        // Check for level ups and switch training style
        const atk = getAttackLevel(ctx);
        const str = getStrengthLevel(ctx);
        const def = getDefenceLevel(ctx);

        if (atk > lastAtkLevel || str > lastStrLevel || def > lastDefLevel) {
            lastAtkLevel = atk;
            lastStrLevel = str;
            lastDefLevel = def;

            // Cycle to next skill
            let nextSkill: string;
            if (stats.currentTrainingSkill === 'Strength') {
                nextSkill = 'Attack';
            } else if (stats.currentTrainingSkill === 'Attack') {
                nextSkill = 'Defence';
            } else {
                nextSkill = 'Strength';
            }

            const nextStyle = getStyleForSkill(ctx, nextSkill);
            if (nextStyle !== null) {
                ctx.log(`Level up! Switching to ${nextSkill} training (Atk=${atk}, Str=${str}, Def=${def})`);
                await ctx.sdk.sendSetCombatStyle(nextStyle);
                stats.currentTrainingSkill = nextSkill;
            }
        }

        // Check health and eat food if needed
        const hp = getHitpoints(ctx);
        if (hp.current < 8) {
            const food = findFood(ctx);
            if (food) {
                const eatOpt = food.optionsWithIndex.find(o => /eat/i.test(o.text));
                if (eatOpt) {
                    ctx.log(`Eating ${food.name} (hp=${hp.current})`);
                    await ctx.sdk.sendUseItem(food.slot, eatOpt.opIndex);
                    markProgress(ctx, stats);
                    await new Promise(r => setTimeout(r, 500));
                    continue;
                }
            }
        }

        // Check drift from goblin area
        const player = currentState.player;
        if (player) {
            const distFromArea = Math.sqrt(
                Math.pow(player.worldX - LUMBRIDGE_GOBLINS.x, 2) +
                Math.pow(player.worldZ - LUMBRIDGE_GOBLINS.z, 2)
            );
            if (distFromArea > 25) {
                ctx.log(`Drifted ${distFromArea.toFixed(0)} tiles away, walking back...`);
                await ctx.sdk.sendWalk(LUMBRIDGE_GOBLINS.x, LUMBRIDGE_GOBLINS.z, true);
                markProgress(ctx, stats);
                await new Promise(r => setTimeout(r, 3000));
                continue;
            }
        }

        // Find and attack target
        const target = findTarget(ctx);
        if (!target) {
            noTargetCount++;
            if (noTargetCount % 20 === 0) {
                ctx.log(`No targets found (${noTargetCount} attempts), wandering...`);
                const px = player?.worldX ?? LUMBRIDGE_GOBLINS.x;
                const pz = player?.worldZ ?? LUMBRIDGE_GOBLINS.z;
                const dx = Math.floor(Math.random() * 10) - 5;
                const dz = Math.floor(Math.random() * 10) - 5;
                await ctx.sdk.sendWalk(px + dx, pz + dz, true);
            }
            markProgress(ctx, stats);
            await new Promise(r => setTimeout(r, 600));
            continue;
        }

        noTargetCount = 0;

        // Only attack if idle
        const isIdle = player?.animId === -1 && !currentState.player?.combat?.inCombat;

        if (isIdle) {
            const attackOpt = target.optionsWithIndex.find(o => /attack/i.test(o.text));
            if (attackOpt) {
                if (loopCount <= 20 || loopCount % 50 === 0) {
                    ctx.log(`Attacking ${target.name} (lvl=${target.combatLevel}, dist=${target.distance.toFixed(1)})`);
                }
                await ctx.sdk.sendInteractNpc(target.index, attackOpt.opIndex);
                stats.kills++;
                markProgress(ctx, stats);
            }
        } else {
            // Currently in combat
            markProgress(ctx, stats);
        }

        // Wait for combat
        await new Promise(r => setTimeout(r, 1500));
        markProgress(ctx, stats);
    }
}

/**
 * Log final stats
 */
function logFinalStats(ctx: ScriptContext, stats: Stats): void {
    const atkXpGained = getAtkXp(ctx) - stats.startAtkXp;
    const strXpGained = getStrXp(ctx) - stats.startStrXp;
    const defXpGained = getDefXp(ctx) - stats.startDefXp;
    const duration = (Date.now() - stats.startTime) / 1000;

    ctx.log('');
    ctx.log('=== Arc Results ===');
    ctx.log(`Duration: ${Math.round(duration)}s`);
    ctx.log(`Attack: Level ${getAttackLevel(ctx)}, +${atkXpGained} XP`);
    ctx.log(`Strength: Level ${getStrengthLevel(ctx)}, +${strXpGained} XP`);
    ctx.log(`Defence: Level ${getDefenceLevel(ctx)}, +${defXpGained} XP`);
    ctx.log(`Kills: ${stats.kills}`);
    ctx.log(`Total Level: ${getTotalLevel(ctx)}`);
}

// Run the arc
runArc({
    characterName: 'Adam_1',
    arcName: 'combat-lumbridge',
    goal: 'Train Attack, Strength, Defence at Lumbridge',
    timeLimit: 3 * 60 * 1000,      // 3 minutes
    stallTimeout: 30_000,
    screenshotInterval: 30_000,
    // Initialize with current skills + sword and food
    initializeFromPreset: {
        position: LUMBRIDGE_GOBLINS,
        skills: { Fishing: 48, Woodcutting: 41, Mining: 38 },
        inventory: [
            { id: 1277, count: 1 },   // Bronze sword
            { id: 1171, count: 1 },   // Wooden shield
            { id: 1351, count: 1 },   // Bronze axe
            { id: 590, count: 1 },    // Tinderbox
            { id: 1265, count: 1 },   // Bronze pickaxe
            { id: 2309, count: 5 },   // Bread
        ],
    },
    launchOptions: {
        useSharedBrowser: false,
    },
}, async (ctx) => {
    const stats: Stats = {
        kills: 0,
        startAtkXp: getAtkXp(ctx),
        startStrXp: getStrXp(ctx),
        startDefXp: getDefXp(ctx),
        startTime: Date.now(),
        lastProgressTime: Date.now(),
        currentTrainingSkill: 'Strength',
    };

    ctx.log('=== Arc: combat-lumbridge ===');
    ctx.log(`Starting Atk: ${getAttackLevel(ctx)}, Str: ${getStrengthLevel(ctx)}, Def: ${getDefenceLevel(ctx)}`);
    ctx.log(`Position: (${ctx.state()?.player?.worldX}, ${ctx.state()?.player?.worldZ})`);

    // Check inventory
    const inv = ctx.state()?.inventory || [];
    const hasWeapon = inv.some(i => /sword|scimitar|dagger/i.test(i.name));
    ctx.log(`Inventory check: weapon=${hasWeapon}`);
    ctx.log(`Inventory: ${inv.map(i => i.name).join(', ')}`);

    // Equip weapon
    const weapon = findWeapon(ctx);
    if (weapon) {
        const wieldOpt = weapon.optionsWithIndex.find(o => /wield|wear/i.test(o.text));
        if (wieldOpt) {
            ctx.log(`Equipping ${weapon.name}`);
            await ctx.sdk.sendUseItem(weapon.slot, wieldOpt.opIndex);
            await new Promise(r => setTimeout(r, 500));
        }
    }

    // Dismiss startup dialogs
    await ctx.bot.dismissBlockingUI();
    markProgress(ctx, stats);

    // Set initial combat style to Strength
    await new Promise(r => setTimeout(r, 300));
    const styleState = ctx.state()?.combatStyle;
    if (styleState) {
        ctx.log(`Combat styles: ${styleState.styles.map(s => `${s.index}:${s.name}(${s.trainedSkill})`).join(', ')}`);
        const strStyle = getStyleForSkill(ctx, 'Strength');
        if (strStyle !== null) {
            ctx.log(`Setting combat style to train Strength (style ${strStyle})`);
            await ctx.sdk.sendSetCombatStyle(strStyle);
        }
    }

    // Walk to goblin area if needed
    for (let attempt = 0; attempt < 3; attempt++) {
        const player = ctx.state()?.player;
        if (!player) continue;

        const dist = Math.sqrt(
            Math.pow(player.worldX - LUMBRIDGE_GOBLINS.x, 2) +
            Math.pow(player.worldZ - LUMBRIDGE_GOBLINS.z, 2)
        );
        ctx.log(`Distance to goblin area: ${dist.toFixed(0)} tiles`);

        if (dist < 20) {
            ctx.log('At goblin area!');
            break;
        }

        ctx.log('Walking to goblin area...');
        await ctx.sdk.sendWalk(LUMBRIDGE_GOBLINS.x, LUMBRIDGE_GOBLINS.z, true);

        for (let i = 0; i < 30; i++) {
            await new Promise(r => setTimeout(r, 500));
            markProgress(ctx, stats);
            if (ctx.state()?.dialog.isOpen) {
                await ctx.sdk.sendClickDialog(0);
            }
            const p = ctx.state()?.player;
            if (p) {
                const d = Math.sqrt(
                    Math.pow(p.worldX - LUMBRIDGE_GOBLINS.x, 2) +
                    Math.pow(p.worldZ - LUMBRIDGE_GOBLINS.z, 2)
                );
                if (d < 20) break;
            }
        }
    }

    try {
        await combatLoop(ctx, stats);
    } catch (e) {
        if (e instanceof StallError) {
            ctx.error(`Arc aborted: ${e.message}`);
        } else {
            throw e;
        }
    } finally {
        logFinalStats(ctx, stats);
    }
});
