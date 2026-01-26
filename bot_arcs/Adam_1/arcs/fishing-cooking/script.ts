/**
 * Arc: fishing-cooking
 * Character: Adam_1
 *
 * Goal: Fish and cook at Draynor for dual skill XP.
 * Strategy:
 * 1. Fish shrimp until inventory is mostly full
 * 2. Chop tree for logs
 * 3. Light fire
 * 4. Cook all fish
 * 5. Drop cooked fish
 * 6. Repeat
 *
 * Duration: 10 minutes
 */

import { runArc, StallError } from '../../../arc-runner';
import type { ScriptContext } from '../../../arc-runner';
import type { NearbyNpc, NearbyLoc, InventoryItem } from '../../../../agent/types';

// Draynor Village fishing spots
const DRAYNOR_FISHING = { x: 3087, z: 3230 };

// How many fish before we cook
const COOK_THRESHOLD = 20;

interface Stats {
    fishCaught: number;
    fishCooked: number;
    firesLit: number;
    startFishingXp: number;
    startCookingXp: number;
    startTime: number;
    lastProgressTime: number;
}

function markProgress(ctx: ScriptContext, stats: Stats): void {
    stats.lastProgressTime = Date.now();
    ctx.progress();
}

function getFishingLevel(ctx: ScriptContext): number {
    return ctx.state()?.skills.find(s => s.name === 'Fishing')?.baseLevel ?? 1;
}

function getCookingLevel(ctx: ScriptContext): number {
    return ctx.state()?.skills.find(s => s.name === 'Cooking')?.baseLevel ?? 1;
}

function getFishingXp(ctx: ScriptContext): number {
    return ctx.state()?.skills.find(s => s.name === 'Fishing')?.experience ?? 0;
}

function getCookingXp(ctx: ScriptContext): number {
    return ctx.state()?.skills.find(s => s.name === 'Cooking')?.experience ?? 0;
}

function getTotalLevel(ctx: ScriptContext): number {
    return ctx.state()?.skills.reduce((sum, s) => sum + s.baseLevel, 0) ?? 32;
}

/**
 * Find the nearest fishing spot
 */
function findFishingSpot(ctx: ScriptContext): NearbyNpc | null {
    const state = ctx.state();
    if (!state) return null;

    const spots = state.nearbyNpcs
        .filter(npc => /fishing\s*spot/i.test(npc.name))
        .filter(npc => npc.options.some(opt => /^net$/i.test(opt)))
        .sort((a, b) => a.distance - b.distance);

    return spots[0] ?? null;
}

/**
 * Count raw fish in inventory
 */
function countRawFish(ctx: ScriptContext): number {
    const state = ctx.state();
    if (!state) return 0;

    return state.inventory
        .filter(item => /^raw\s/i.test(item.name))
        .reduce((sum, item) => sum + item.count, 0);
}

/**
 * Get all raw fish items
 */
function getRawFishItems(ctx: ScriptContext): InventoryItem[] {
    const state = ctx.state();
    if (!state) return [];
    return state.inventory.filter(item => /^raw\s/i.test(item.name));
}

/**
 * Find logs in inventory
 */
function findLogs(ctx: ScriptContext): InventoryItem | null {
    const state = ctx.state();
    if (!state) return null;
    return state.inventory.find(item => /^logs$/i.test(item.name)) ?? null;
}

/**
 * Find tinderbox in inventory
 */
function findTinderbox(ctx: ScriptContext): InventoryItem | null {
    const state = ctx.state();
    if (!state) return null;
    return state.inventory.find(item => /tinderbox/i.test(item.name)) ?? null;
}

/**
 * Find a fire nearby
 */
function findFire(ctx: ScriptContext): NearbyLoc | null {
    const state = ctx.state();
    if (!state) return null;
    return state.nearbyLocs
        .filter(loc => /^fire$/i.test(loc.name))
        .sort((a, b) => a.distance - b.distance)[0] ?? null;
}

/**
 * Fish until we have enough raw fish
 */
async function fishUntilFull(ctx: ScriptContext, stats: Stats): Promise<void> {
    let lastFishCount = countRawFish(ctx);
    let noSpotCount = 0;

    ctx.log(`Fishing until ${COOK_THRESHOLD} raw fish...`);
    let loopCount = 0;

    while (countRawFish(ctx) < COOK_THRESHOLD) {
        loopCount++;
        if (loopCount % 100 === 0) {
            ctx.log(`Fishing loop: ${loopCount} iterations, raw fish: ${countRawFish(ctx)}`);
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

        // Check inventory space
        if (currentState.inventory.length >= 27) {
            ctx.log('Inventory nearly full');
            break;
        }

        // Track fish caught
        const currentFishCount = countRawFish(ctx);
        if (currentFishCount > lastFishCount) {
            stats.fishCaught += (currentFishCount - lastFishCount);
            markProgress(ctx, stats);
        }
        lastFishCount = currentFishCount;

        // Find fishing spot
        const spot = findFishingSpot(ctx);
        if (!spot) {
            noSpotCount++;
            if (noSpotCount === 10) {
                // Log debug info
                const npcs = currentState.nearbyNpcs.slice(0, 5);
                ctx.log(`Nearby NPCs: ${npcs.map(n => n.name).join(', ') || 'none'}`);
                ctx.log(`Position: (${currentState.player?.worldX}, ${currentState.player?.worldZ})`);
            }
            if (noSpotCount % 50 === 0) {
                ctx.log(`No fishing spot found (${noSpotCount} attempts)`);
            }
            if (noSpotCount >= 100) {
                // Walk back to fishing area
                ctx.log('Walking back to fishing area...');
                await ctx.sdk.sendWalk(DRAYNOR_FISHING.x, DRAYNOR_FISHING.z, true);
                markProgress(ctx, stats);
                await new Promise(r => setTimeout(r, 3000));
                noSpotCount = 0;
            }
            markProgress(ctx, stats);
            await new Promise(r => setTimeout(r, 100));
            continue;
        }

        noSpotCount = 0;
        const netOpt = spot.optionsWithIndex.find(o => /^net$/i.test(o.text));
        if (netOpt) {
            // Only click if we're not already fishing (check animation)
            const player = currentState.player;
            const isIdle = player?.animId === -1;

            if (isIdle) {
                if (stats.fishCaught === 0) {
                    ctx.log(`Starting to fish...`);
                }
                await ctx.sdk.sendInteractNpc(spot.index, netOpt.opIndex);
            }
            markProgress(ctx, stats);

            // Wait a bit for fishing animation
            await new Promise(r => setTimeout(r, 1000));
        } else {
            ctx.log(`Spot has no Net option: ${spot.options.join(', ')}`);
            await new Promise(r => setTimeout(r, 300));
        }
    }

    ctx.log(`Collected ${countRawFish(ctx)} raw fish`);
}

/**
 * Chop a tree to get logs
 */
async function chopTreeForLogs(ctx: ScriptContext, stats: Stats): Promise<boolean> {
    if (findLogs(ctx)) return true;

    ctx.log('Chopping tree for logs...');
    markProgress(ctx, stats);

    const result = await ctx.bot.chopTree(/^tree$/i);
    markProgress(ctx, stats);

    if (result.success && findLogs(ctx)) {
        ctx.log('Got logs!');
        return true;
    }

    await new Promise(r => setTimeout(r, 500));
    return !!findLogs(ctx);
}

/**
 * Light a fire
 */
async function lightFire(ctx: ScriptContext, stats: Stats): Promise<boolean> {
    const tinderbox = findTinderbox(ctx);
    let logs = findLogs(ctx);

    if (!logs) {
        if (!await chopTreeForLogs(ctx, stats)) {
            ctx.warn('Could not get logs');
            return false;
        }
        logs = findLogs(ctx);
    }

    if (!tinderbox || !logs) {
        ctx.warn(`Cannot light fire: tinderbox=${!!tinderbox}, logs=${!!logs}`);
        return false;
    }

    ctx.log('Lighting fire...');
    markProgress(ctx, stats);

    const fmXpBefore = ctx.state()?.skills.find(s => s.name === 'Firemaking')?.experience ?? 0;

    await ctx.sdk.sendUseItemOnItem(tinderbox.slot, logs.slot);

    // Wait for fire
    for (let i = 0; i < 30; i++) {
        await new Promise(r => setTimeout(r, 500));
        markProgress(ctx, stats);

        if (ctx.state()?.dialog.isOpen) {
            await ctx.sdk.sendClickDialog(0);
        }

        const fmXp = ctx.state()?.skills.find(s => s.name === 'Firemaking')?.experience ?? 0;
        if (fmXp > fmXpBefore || findFire(ctx)) {
            stats.firesLit++;
            ctx.log(`Fire lit! (${stats.firesLit} total)`);
            return true;
        }
    }

    ctx.warn('Timeout waiting for fire');
    return false;
}

/**
 * Cook all raw fish
 */
async function cookAllFish(ctx: ScriptContext, stats: Stats): Promise<void> {
    const fire = findFire(ctx);
    if (!fire) {
        ctx.warn('No fire found');
        return;
    }

    const rawFish = getRawFishItems(ctx);
    if (rawFish.length === 0) {
        ctx.log('No raw fish to cook');
        return;
    }

    ctx.log(`Cooking ${rawFish.length} fish stacks...`);
    markProgress(ctx, stats);

    for (const fish of rawFish) {
        const currentFire = findFire(ctx);
        if (!currentFire) {
            ctx.log('Fire went out');
            break;
        }

        const cookXpBefore = getCookingXp(ctx);

        await ctx.sdk.sendUseItemOnLoc(fish.slot, currentFire.x, currentFire.z, currentFire.id);
        markProgress(ctx, stats);

        // Wait for cooking
        for (let i = 0; i < 20; i++) {
            await new Promise(r => setTimeout(r, 500));
            markProgress(ctx, stats);

            if (ctx.state()?.dialog.isOpen) {
                await ctx.sdk.sendClickDialog(0);
            }

            // Check for interface (cook menu)
            const iface = ctx.state()?.interface;
            const firstOption = iface?.options[0];
            if (iface?.isOpen && firstOption) {
                await ctx.sdk.sendClickInterface(firstOption.index);
                await new Promise(r => setTimeout(r, 500));
            }

            // Check if cooking done (XP gained or no more raw fish of this type)
            const currentXp = getCookingXp(ctx);
            if (currentXp > cookXpBefore) {
                const xpGained = currentXp - cookXpBefore;
                stats.fishCooked += Math.floor(xpGained / 30); // ~30 XP per shrimp
                break;
            }

            if (!findFire(ctx)) break;
            if (countRawFish(ctx) === 0) break;
        }
    }

    ctx.log(`Cooking complete. Total cooked: ${stats.fishCooked}`);
}

/**
 * Drop all cooked/burned fish
 */
async function dropCookedFish(ctx: ScriptContext, stats: Stats): Promise<void> {
    const state = ctx.state();
    if (!state) return;

    const toDrop = state.inventory.filter(item =>
        (/shrimp|anchov/i.test(item.name) && !/^raw\s/i.test(item.name)) ||
        /^burnt\s/i.test(item.name)
    );

    if (toDrop.length === 0) return;

    ctx.log(`Dropping ${toDrop.length} cooked/burned fish...`);
    for (const item of toDrop) {
        await ctx.sdk.sendDropItem(item.slot);
        markProgress(ctx, stats);
        await new Promise(r => setTimeout(r, 100));
    }
}

/**
 * Main loop
 */
async function mainLoop(ctx: ScriptContext, stats: Stats): Promise<void> {
    ctx.log('=== Fishing + Cooking Arc Started ===');

    while (true) {
        ctx.log(`\n--- Cycle ---`);
        ctx.log(`Fishing: ${getFishingLevel(ctx)}, Cooking: ${getCookingLevel(ctx)}, Total: ${getTotalLevel(ctx)}`);

        // Phase 1: Fish
        await fishUntilFull(ctx, stats);

        const rawFish = countRawFish(ctx);
        if (rawFish === 0) {
            await new Promise(r => setTimeout(r, 1000));
            continue;
        }

        // Phase 2: Light fire and cook
        ctx.log('Preparing to cook...');
        const fireSuccess = await lightFire(ctx, stats);

        if (fireSuccess) {
            await new Promise(r => setTimeout(r, 500));
            await cookAllFish(ctx, stats);
        } else {
            ctx.warn('Failed to light fire, dropping raw fish');
        }

        // Phase 3: Drop cooked fish
        await dropCookedFish(ctx, stats);

        // Also drop any remaining raw fish
        const state = ctx.state();
        if (state) {
            for (const item of state.inventory) {
                if (/^raw\s/i.test(item.name)) {
                    await ctx.sdk.sendDropItem(item.slot);
                    markProgress(ctx, stats);
                    await new Promise(r => setTimeout(r, 100));
                }
            }
        }

        markProgress(ctx, stats);
    }
}

/**
 * Log final stats
 */
function logFinalStats(ctx: ScriptContext, stats: Stats): void {
    const fishingXpGained = getFishingXp(ctx) - stats.startFishingXp;
    const cookingXpGained = getCookingXp(ctx) - stats.startCookingXp;
    const duration = (Date.now() - stats.startTime) / 1000;

    ctx.log('');
    ctx.log('=== Arc Results ===');
    ctx.log(`Duration: ${Math.round(duration)}s`);
    ctx.log(`Fishing: Level ${getFishingLevel(ctx)}, +${fishingXpGained} XP`);
    ctx.log(`Cooking: Level ${getCookingLevel(ctx)}, +${cookingXpGained} XP`);
    ctx.log(`Fish caught: ${stats.fishCaught}`);
    ctx.log(`Fish cooked: ${stats.fishCooked}`);
    ctx.log(`Fires lit: ${stats.firesLit}`);
    ctx.log(`Total Level: ${getTotalLevel(ctx)}`);
}

// Run the arc
runArc({
    characterName: 'Adam_1',
    arcName: 'fishing-cooking',
    goal: 'Fish and cook at Draynor for dual skill XP',
    timeLimit: 5 * 60 * 1000,      // 5 minutes
    stallTimeout: 30_000,          // 30 seconds (cooking takes time)
    screenshotInterval: 30_000,
    // Initialize with preserved skills + full inventory
    initializeFromPreset: {
        position: { x: 3087, z: 3230 },
        skills: { Fishing: 25, Cooking: 1 },
        inventory: [
            { id: 1351, count: 1 },   // Bronze axe
            { id: 590, count: 1 },    // Tinderbox
            { id: 303, count: 1 },    // Small fishing net
            { id: 315, count: 1 },    // Shrimps
            { id: 1925, count: 1 },   // Bucket
            { id: 1931, count: 1 },   // Pot
            { id: 2309, count: 1 },   // Bread
            { id: 1265, count: 1 },   // Bronze pickaxe
        ],
    },
    launchOptions: {
        useSharedBrowser: true,
    },
}, async (ctx) => {
    const stats: Stats = {
        fishCaught: 0,
        fishCooked: 0,
        firesLit: 0,
        startFishingXp: getFishingXp(ctx),
        startCookingXp: getCookingXp(ctx),
        startTime: Date.now(),
        lastProgressTime: Date.now(),
    };

    ctx.log('=== Arc: fishing-cooking ===');
    ctx.log(`Starting Fishing: ${getFishingLevel(ctx)}, Cooking: ${getCookingLevel(ctx)}`);
    ctx.log(`Position: (${ctx.state()?.player?.worldX}, ${ctx.state()?.player?.worldZ})`);

    // Check inventory for fishing requirements
    const inv = ctx.state()?.inventory || [];
    const hasNet = inv.some(i => /fishing net/i.test(i.name));
    const hasTinderbox = inv.some(i => /tinderbox/i.test(i.name));
    const hasAxe = inv.some(i => /axe/i.test(i.name));
    ctx.log(`Inventory check: net=${hasNet}, tinderbox=${hasTinderbox}, axe=${hasAxe}`);
    ctx.log(`Inventory items: ${inv.map(i => i.name).join(', ')}`);

    if (!hasNet) {
        ctx.error('No fishing net in inventory! Cannot fish.');
        return;
    }

    // Dismiss startup dialogs
    await ctx.bot.dismissBlockingUI();
    markProgress(ctx, stats);

    // Ensure we're at the fishing area
    for (let attempt = 0; attempt < 5; attempt++) {
        const player = ctx.state()?.player;
        if (!player) continue;

        const dist = Math.sqrt(
            Math.pow(player.worldX - DRAYNOR_FISHING.x, 2) +
            Math.pow(player.worldZ - DRAYNOR_FISHING.z, 2)
        );
        ctx.log(`Distance to fishing area: ${dist.toFixed(0)} tiles`);

        if (dist < 15) {
            ctx.log('At fishing area!');
            break;
        }

        ctx.log('Walking to fishing area...');
        await ctx.sdk.sendWalk(DRAYNOR_FISHING.x, DRAYNOR_FISHING.z, true);

        for (let i = 0; i < 40; i++) {
            await new Promise(r => setTimeout(r, 500));
            markProgress(ctx, stats);

            // Dismiss dialogs during walk
            if (ctx.state()?.dialog.isOpen) {
                await ctx.sdk.sendClickDialog(0);
            }

            const p = ctx.state()?.player;
            if (p) {
                const d = Math.sqrt(
                    Math.pow(p.worldX - DRAYNOR_FISHING.x, 2) +
                    Math.pow(p.worldZ - DRAYNOR_FISHING.z, 2)
                );
                if (d < 15) break;
            }
        }
    }

    try {
        await mainLoop(ctx, stats);
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
