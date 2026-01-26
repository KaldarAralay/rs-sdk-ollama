/**
 * Arc: combat-basics
 * Character: Adam_2
 *
 * Goal: Train Attack, Strength, Defence on chickens at Lumbridge.
 * Strategy: Attack chickens, loot feathers for GP, repeat.
 *
 * Duration: 5 minutes
 */

import { runArc, StallError } from '../../../arc-runner';
import type { ScriptContext } from '../../../arc-runner';
import type { NearbyNpc, GroundItem } from '../../../../agent/types';

// Lumbridge cow field (east of castle, open area)
const COW_FIELD = { x: 3253, z: 3269 };

// Waypoints from Lumbridge spawn to cow field
const WAYPOINTS_TO_COWS = [
    { x: 3222, z: 3220 },
    { x: 3230, z: 3240 },
    { x: 3245, z: 3260 },
    { x: 3253, z: 3269 },
];

// Target combat levels
const TARGET_ATTACK = 20;
const TARGET_STRENGTH = 20;
const TARGET_DEFENCE = 20;

// Combat style indices for swords
const COMBAT_STYLES = {
    ACCURATE: 0,    // Trains Attack
    AGGRESSIVE: 1,  // Trains Strength
    CONTROLLED: 2,  // Trains Attack+Strength+Defence evenly
    DEFENSIVE: 3,   // Trains Defence
};

// Style rotation for balanced training
const STYLE_ROTATION = [
    { style: COMBAT_STYLES.ACCURATE, name: 'Accurate (Attack)' },
    { style: COMBAT_STYLES.AGGRESSIVE, name: 'Aggressive (Strength)' },
    { style: COMBAT_STYLES.AGGRESSIVE, name: 'Aggressive (Strength)' },
    { style: COMBAT_STYLES.DEFENSIVE, name: 'Defensive (Defence)' },
];

let lastStyleChange = 0;
let currentStyleIndex = 0;
let lastSetStyle = -1;
const STYLE_CYCLE_MS = 30_000;  // Change every 30 seconds

interface Stats {
    cowsKilled: number;
    hidesLooted: number;
    startAttackXp: number;
    startStrengthXp: number;
    startDefenceXp: number;
    startTime: number;
    lastProgressTime: number;
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

function getAttackXp(ctx: ScriptContext): number {
    return ctx.state()?.skills.find(s => s.name === 'Attack')?.experience ?? 0;
}

function getStrengthXp(ctx: ScriptContext): number {
    return ctx.state()?.skills.find(s => s.name === 'Strength')?.experience ?? 0;
}

function getDefenceXp(ctx: ScriptContext): number {
    return ctx.state()?.skills.find(s => s.name === 'Defence')?.experience ?? 0;
}

function getTotalLevel(ctx: ScriptContext): number {
    return ctx.state()?.skills.reduce((sum, s) => sum + s.baseLevel, 0) ?? 32;
}

function getCombatLevel(ctx: ScriptContext): number {
    return getAttackLevel(ctx) + getStrengthLevel(ctx) + getDefenceLevel(ctx);
}

/**
 * Check if we've reached target levels
 */
function reachedTargets(ctx: ScriptContext): boolean {
    return getAttackLevel(ctx) >= TARGET_ATTACK &&
           getStrengthLevel(ctx) >= TARGET_STRENGTH &&
           getDefenceLevel(ctx) >= TARGET_DEFENCE;
}

/**
 * Find nearest cow to attack
 */
function findCow(ctx: ScriptContext): NearbyNpc | null {
    const state = ctx.state();
    if (!state) return null;

    // Find cows that are attackable (not "cow calf")
    const cows = state.nearbyNpcs
        .filter(npc => /^cow$/i.test(npc.name))
        .filter(npc => npc.options.some(opt => /attack/i.test(opt)))
        .filter(npc => !npc.inCombat)  // Skip cows already in combat
        .sort((a, b) => a.distance - b.distance);

    return cows[0] ?? null;
}

/**
 * Find ground items (cowhides, bones)
 */
function findHide(ctx: ScriptContext): GroundItem | null {
    const state = ctx.state();
    if (!state) return null;

    // Look for cowhides on the ground (already sorted by distance)
    const hides = state.groundItems
        ?.filter(item => /cowhide|cow hide/i.test(item.name))
        .sort((a, b) => a.distance - b.distance);

    return hides?.[0] ?? null;
}

/**
 * Count cowhides in inventory
 */
function countHides(ctx: ScriptContext): number {
    const state = ctx.state();
    if (!state) return 0;
    const hides = state.inventory.filter(i => /cowhide|cow hide/i.test(i.name));
    return hides.reduce((sum, h) => sum + (h.count ?? 1), 0);
}

/**
 * Cycle combat style for balanced training
 */
async function cycleCombatStyle(ctx: ScriptContext): Promise<void> {
    const now = Date.now();
    if (now - lastStyleChange >= STYLE_CYCLE_MS) {
        currentStyleIndex = (currentStyleIndex + 1) % STYLE_ROTATION.length;
        lastStyleChange = now;
    }

    const target = STYLE_ROTATION[currentStyleIndex]!;
    if (lastSetStyle !== target.style) {
        ctx.log(`Setting combat style: ${target.name}`);
        await ctx.sdk.sendSetCombatStyle(target.style);
        lastSetStyle = target.style;
    }
}

/**
 * Main combat loop
 */
async function combatLoop(ctx: ScriptContext, stats: Stats): Promise<void> {
    // Initialize style cycling
    lastStyleChange = Date.now();
    currentStyleIndex = 0;
    lastSetStyle = -1;
    let noCowCount = 0;
    let lastHideCount = countHides(ctx);
    let lastCombatLevel = getCombatLevel(ctx);

    let loopCount = 0;
    while (!reachedTargets(ctx)) {
        loopCount++;
        const currentState = ctx.state();
        if (!currentState) break;

        if (loopCount % 50 === 0) {
            const state = ctx.state();
            const npcs = state?.nearbyNpcs?.filter(n => /^cow$/i.test(n.name)) || [];
            ctx.log(`Combat loop ${loopCount}: Atk ${getAttackLevel(ctx)}, Str ${getStrengthLevel(ctx)}, Def ${getDefenceLevel(ctx)} | Cows nearby: ${npcs.length}`);
        }

        // Dismiss dialogs (level ups, random events)
        if (currentState.dialog.isOpen) {
            ctx.log('Dismissing dialog...');
            await ctx.sdk.sendClickDialog(0);
            markProgress(ctx, stats);
            await new Promise(r => setTimeout(r, 300));
            continue;
        }

        // Cycle combat style for balanced training
        await cycleCombatStyle(ctx);

        // Check for level ups
        const currentCombatLevel = getCombatLevel(ctx);
        if (currentCombatLevel > lastCombatLevel) {
            ctx.log(`Combat level up! Attack: ${getAttackLevel(ctx)}, Strength: ${getStrengthLevel(ctx)}, Defence: ${getDefenceLevel(ctx)}`);
            lastCombatLevel = currentCombatLevel;
        }

        // Track hides looted
        const currentHides = countHides(ctx);
        if (currentHides > lastHideCount) {
            const gained = currentHides - lastHideCount;
            stats.hidesLooted += gained;
            ctx.log(`Looted ${gained} hide(s)! Total: ${stats.hidesLooted}`);
            markProgress(ctx, stats);
        }
        lastHideCount = currentHides;

        // Check if we're in combat (animating)
        const player = currentState.player;
        const isIdle = player?.animId === -1;

        if (loopCount % 50 === 1) {
            ctx.log(`Status: idle=${isIdle} (anim=${player?.animId})`);
        }

        // If idle, look for something to attack (ignore stale target state)
        if (isIdle) {
            // Try to loot hides first (quick pickup)
            const hide = findHide(ctx);
            if (hide && Math.random() < 0.3) { // Don't always loot, prioritize combat
                await ctx.bot.pickupItem(hide);
                markProgress(ctx, stats);
                await new Promise(r => setTimeout(r, 300));
                continue;
            }

            // Find a cow to attack
            const cow = findCow(ctx);
            if (!cow) {
                noCowCount++;
                if (noCowCount % 30 === 0) {
                    ctx.log(`No cow found (${noCowCount} attempts)`);
                }
                if (noCowCount >= 60) {
                    ctx.log('Walking to cow field...');
                    await ctx.sdk.sendWalk(COW_FIELD.x, COW_FIELD.z, true);
                    markProgress(ctx, stats);
                    await new Promise(r => setTimeout(r, 3000));
                    noCowCount = 0;
                }
                markProgress(ctx, stats);
                await new Promise(r => setTimeout(r, 100));
                continue;
            }

            noCowCount = 0;

            // Attack the cow using bot helper
            const attackResult = await ctx.bot.attackNpc(cow);
            if (attackResult.success) {
                ctx.log(`Attacking cow (index: ${cow.index}, dist: ${cow.distance.toFixed(0)})`);
                stats.cowsKilled++;
                markProgress(ctx, stats);
                // Wait for combat to resolve
                await new Promise(r => setTimeout(r, 2000));
            } else {
                ctx.log(`Attack failed: ${attackResult.message}`);
                // Try opening gate if blocked by obstacle
                if (attackResult.reason === 'out_of_reach') {
                    ctx.log('Attempting to open gate...');
                    await ctx.bot.openDoor(/gate/i);
                    markProgress(ctx, stats);
                }
            }
        }

        await new Promise(r => setTimeout(r, 600));
        markProgress(ctx, stats);
    }

    ctx.log(`Reached combat targets! Attack: ${getAttackLevel(ctx)}, Strength: ${getStrengthLevel(ctx)}, Defence: ${getDefenceLevel(ctx)}`);
}

/**
 * Log final stats
 */
function logFinalStats(ctx: ScriptContext, stats: Stats): void {
    const attackXpGained = getAttackXp(ctx) - stats.startAttackXp;
    const strengthXpGained = getStrengthXp(ctx) - stats.startStrengthXp;
    const defenceXpGained = getDefenceXp(ctx) - stats.startDefenceXp;
    const duration = (Date.now() - stats.startTime) / 1000;

    ctx.log('');
    ctx.log('=== Arc Results ===');
    ctx.log(`Duration: ${Math.round(duration)}s`);
    ctx.log(`Attack: Level ${getAttackLevel(ctx)}, +${attackXpGained} XP`);
    ctx.log(`Strength: Level ${getStrengthLevel(ctx)}, +${strengthXpGained} XP`);
    ctx.log(`Defence: Level ${getDefenceLevel(ctx)}, +${defenceXpGained} XP`);
    ctx.log(`Cows Attacked: ${stats.cowsKilled}`);
    ctx.log(`Hides Looted: ${stats.hidesLooted}`);
    ctx.log(`Total Level: ${getTotalLevel(ctx)}`);
}

async function waitForState(ctx: ScriptContext, stats: Stats): Promise<void> {
    ctx.log('Waiting for game state...');
    for (let i = 0; i < 20; i++) {
        const state = ctx.state();
        if (state?.player && state.player.worldX !== 0) {
            break;
        }
        await new Promise(r => setTimeout(r, 500));
        markProgress(ctx, stats);
    }
}

// Run the arc
runArc({
    characterName: 'Adam_2',
    arcName: 'combat-basics',
    goal: `Train Attack/Strength/Defence to ${TARGET_ATTACK}/${TARGET_STRENGTH}/${TARGET_DEFENCE}`,
    timeLimit: 5 * 60 * 1000,
    stallTimeout: 30_000,
    screenshotInterval: 30_000,
    // Continue from previous state
    // initializeFromPreset: TestPresets.LUMBRIDGE_SPAWN,
    launchOptions: {
        useSharedBrowser: false,
    },
}, async (ctx) => {
    const stats: Stats = {
        cowsKilled: 0,
        hidesLooted: 0,
        startAttackXp: getAttackXp(ctx),
        startStrengthXp: getStrengthXp(ctx),
        startDefenceXp: getDefenceXp(ctx),
        startTime: Date.now(),
        lastProgressTime: Date.now(),
    };

    ctx.log('=== Arc: combat-basics ===');
    await waitForState(ctx, stats);

    ctx.log(`Starting Attack: ${getAttackLevel(ctx)}, Strength: ${getStrengthLevel(ctx)}, Defence: ${getDefenceLevel(ctx)}`);
    ctx.log(`Target: ${TARGET_ATTACK}/${TARGET_STRENGTH}/${TARGET_DEFENCE}`);
    ctx.log(`Position: (${ctx.state()?.player?.worldX}, ${ctx.state()?.player?.worldZ})`);

    // Check for weapon (need something to attack with)
    const inv = ctx.state()?.inventory || [];
    const equip = ctx.state()?.equipment || [];
    const hasWeaponInv = inv.some(i => /sword|axe|mace|dagger|scimitar/i.test(i.name));
    const hasWeaponEquip = equip.some(e => /sword|axe|mace|dagger|scimitar/i.test(e?.name || ''));
    ctx.log(`Has weapon: inv=${hasWeaponInv}, equipped=${hasWeaponEquip}`);

    // Equip weapon if in inventory but not equipped
    if (hasWeaponInv && !hasWeaponEquip) {
        const weapon = inv.find(i => /sword|axe|mace|dagger|scimitar/i.test(i.name));
        if (weapon) {
            ctx.log(`Equipping ${weapon.name}...`);
            await ctx.bot.equipItem(weapon);
            markProgress(ctx, stats);
        }
    }

    // Also equip shield if available
    const shield = inv.find(i => /shield/i.test(i.name));
    if (shield) {
        ctx.log(`Equipping ${shield.name}...`);
        await ctx.bot.equipItem(shield);
        markProgress(ctx, stats);
    }

    // Dismiss startup dialogs
    await ctx.bot.dismissBlockingUI();
    markProgress(ctx, stats);

    // Check if we need to walk to cow field
    const player = ctx.state()?.player;
    if (player) {
        const distToCows = Math.sqrt(
            Math.pow(player.worldX - COW_FIELD.x, 2) +
            Math.pow(player.worldZ - COW_FIELD.z, 2)
        );
        ctx.log(`Distance to cow field: ${distToCows.toFixed(0)} tiles`);

        if (distToCows > 30) {
            ctx.log('Walking to cow field...');
            for (const wp of WAYPOINTS_TO_COWS) {
                ctx.log(`  Waypoint (${wp.x}, ${wp.z})...`);
                await ctx.bot.walkTo(wp.x, wp.z);
                markProgress(ctx, stats);

                // Brief pause and check for dialogs
                await new Promise(r => setTimeout(r, 300));
                if (ctx.state()?.dialog.isOpen) {
                    await ctx.sdk.sendClickDialog(0);
                }
            }
            ctx.log('Arrived at cow field!');
        } else {
            ctx.log('Already near cow field!');
        }

        // Open gate to enter cow field if needed
        ctx.log('Attempting to open cow field gate...');
        await ctx.bot.openDoor(/gate/i);
        markProgress(ctx, stats);
        await new Promise(r => setTimeout(r, 500));
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
