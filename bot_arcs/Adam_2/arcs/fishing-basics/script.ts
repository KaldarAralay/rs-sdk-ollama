/**
 * Arc: fishing-basics
 * Character: Adam_2
 *
 * Goal: Fish at Draynor until level 10+ fishing.
 * Strategy: Fish shrimp, drop when full, repeat.
 * Duration: 5 minutes (short first arc to establish patterns)
 *
 * This is Adam_2's first arc - keeping it simple and safe.
 */

import { runArc, TestPresets, StallError } from '../../../arc-runner';
import type { ScriptContext } from '../../../arc-runner';
import type { NearbyNpc } from '../../../../agent/types';

// Draynor Village fishing spots (back to basics)
const FISHING_SPOT = { x: 3087, z: 3230 };

// Target fishing level (start small after reset)
const TARGET_LEVEL = 30;

interface Stats {
    fishCaught: number;
    startFishingXp: number;
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

function getFishingXp(ctx: ScriptContext): number {
    return ctx.state()?.skills.find(s => s.name === 'Fishing')?.experience ?? 0;
}

function getTotalLevel(ctx: ScriptContext): number {
    return ctx.state()?.skills.reduce((sum, s) => sum + s.baseLevel, 0) ?? 32;
}

/**
 * Find the nearest fishing spot suitable for level 1 fishing
 * Prefer "Net, Bait" spots (small net fishing - no level req)
 */
function findFishingSpot(ctx: ScriptContext): NearbyNpc | null {
    const state = ctx.state();
    if (!state) return null;

    const allFishingSpots = state.nearbyNpcs
        .filter(npc => /fishing\s*spot/i.test(npc.name))
        .filter(npc => npc.options.some(opt => /^net$/i.test(opt)));

    // Prefer "Net, Bait" spots (small net fishing - no level req)
    const smallNetSpots = allFishingSpots
        .filter(npc => npc.options.some(opt => /^bait$/i.test(opt)))
        .sort((a, b) => a.distance - b.distance);

    if (smallNetSpots.length > 0) {
        return smallNetSpots[0] ?? null;
    }

    // Fallback to any fishing spot with Net option
    return allFishingSpots.sort((a, b) => a.distance - b.distance)[0] ?? null;
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
 * Drop all raw fish to make space
 */
async function dropAllFish(ctx: ScriptContext, stats: Stats): Promise<number> {
    const state = ctx.state();
    if (!state) return 0;

    let dropped = 0;
    const fishItems = state.inventory.filter(item => /^raw\s/i.test(item.name));

    for (const item of fishItems) {
        ctx.log(`Dropping ${item.name} x${item.count}`);
        await ctx.sdk.sendDropItem(item.slot);
        dropped += item.count;
        markProgress(ctx, stats);
        await new Promise(r => setTimeout(r, 100));
    }

    return dropped;
}

/**
 * Main fishing loop
 */
async function fishingLoop(ctx: ScriptContext, stats: Stats): Promise<void> {
    let lastFishCount = countRawFish(ctx);
    let noSpotCount = 0;

    while (getFishingLevel(ctx) < TARGET_LEVEL) {
        const currentState = ctx.state();
        if (!currentState) {
            ctx.warn('Lost game state');
            break;
        }

        // Dismiss any blocking dialogs (level-up, etc.)
        if (currentState.dialog.isOpen) {
            ctx.log('Dismissing dialog...');
            await ctx.sdk.sendClickDialog(0);
            markProgress(ctx, stats);
            await new Promise(r => setTimeout(r, 300));
            continue;
        }

        // Check if inventory is full
        if (currentState.inventory.length >= 28) {
            ctx.log('Inventory full - dropping fish');
            const dropped = await dropAllFish(ctx, stats);
            ctx.log(`Dropped ${dropped} fish`);
            continue;
        }

        // Check for new fish caught
        const currentFishCount = countRawFish(ctx);
        if (currentFishCount > lastFishCount) {
            const newFish = currentFishCount - lastFishCount;
            stats.fishCaught += newFish;
            ctx.log(`Caught fish! Total: ${stats.fishCaught}`);
            markProgress(ctx, stats);
        }
        lastFishCount = currentFishCount;

        // Find and interact with fishing spot
        const spot = findFishingSpot(ctx);

        if (!spot) {
            noSpotCount++;
            if (noSpotCount % 50 === 0) {
                ctx.log(`Waiting for fishing spot... (${noSpotCount})`);
            }

            // If we've waited too long, walk back to fishing area
            if (noSpotCount >= 100) {
                const player = currentState.player;
                if (player) {
                    const dist = Math.sqrt(
                        Math.pow(player.worldX - FISHING_SPOT.x, 2) +
                        Math.pow(player.worldZ - FISHING_SPOT.z, 2)
                    );
                    if (dist > 10) {
                        ctx.log(`Walking back to fishing area...`);
                        await ctx.sdk.sendWalk(FISHING_SPOT.x, FISHING_SPOT.z);
                        markProgress(ctx, stats);
                        await new Promise(r => setTimeout(r, 3000));
                    }
                }
                noSpotCount = 0;
            }

            markProgress(ctx, stats);
            await new Promise(r => setTimeout(r, 100));
            continue;
        }

        noSpotCount = 0;

        // Get the "Net" option
        const netOpt = spot.optionsWithIndex.find(o => /^net$/i.test(o.text));
        if (!netOpt) {
            ctx.warn(`Fishing spot has no Net option`);
            await new Promise(r => setTimeout(r, 300));
            continue;
        }

        // Start fishing
        await ctx.sdk.sendInteractNpc(spot.index, netOpt.opIndex);
        markProgress(ctx, stats);
        await new Promise(r => setTimeout(r, 200));
    }

    ctx.log(`Reached fishing level ${getFishingLevel(ctx)}!`);
}

/**
 * Log final statistics
 */
function logFinalStats(ctx: ScriptContext, stats: Stats): void {
    const state = ctx.state();
    const fishing = state?.skills.find(s => s.name === 'Fishing');
    const xpGained = (fishing?.experience ?? 0) - stats.startFishingXp;
    const duration = (Date.now() - stats.startTime) / 1000;
    const totalLevel = getTotalLevel(ctx);

    ctx.log('');
    ctx.log('=== Arc Results ===');
    ctx.log(`Duration: ${Math.round(duration)}s`);
    ctx.log(`Fishing Level: ${fishing?.baseLevel ?? '?'}`);
    ctx.log(`XP Gained: ${xpGained}`);
    ctx.log(`Fish Caught: ${stats.fishCaught}`);
    ctx.log(`Total Level: ${totalLevel}`);
    ctx.log('');
}

// Run the arc
runArc({
    characterName: 'Adam_2',
    arcName: 'fishing-basics',
    goal: `Fish at Draynor until level ${TARGET_LEVEL} fishing`,
    timeLimit: 10 * 60 * 1000,     // 10 minutes
    stallTimeout: 25_000,          // 25 seconds
    screenshotInterval: 15_000,
    // Reset to clear stuck random event
    initializeFromPreset: TestPresets.LUMBRIDGE_SPAWN,
    // Use separate browser to avoid conflicts with other running scripts
    launchOptions: {
        useSharedBrowser: false,
    },
}, async (ctx) => {
    const stats: Stats = {
        fishCaught: 0,
        startFishingXp: getFishingXp(ctx),
        startTime: Date.now(),
        lastProgressTime: Date.now(),
    };

    ctx.log('=== Arc: fishing-basics ===');

    // Wait for game state to be ready
    ctx.log('Waiting for game state...');
    for (let i = 0; i < 20; i++) {
        const state = ctx.state();
        if (state?.player && state.player.worldX !== 0) {
            break;
        }
        await new Promise(r => setTimeout(r, 500));
        markProgress(ctx, stats);
    }

    ctx.log(`Starting Fishing Level: ${getFishingLevel(ctx)}`);
    ctx.log(`Target: Level ${TARGET_LEVEL}`);
    ctx.log(`Position: (${ctx.state()?.player?.worldX}, ${ctx.state()?.player?.worldZ})`);

    // Dismiss any startup dialogs
    await ctx.bot.dismissBlockingUI();
    markProgress(ctx, stats);

    // Lumbridge to Draynor - simple waypoints
    const waypoints = [
        { x: 3200, z: 3220 },  // West of Lumbridge castle
        { x: 3160, z: 3230 },  // Further west
        { x: 3120, z: 3240 },  // Approaching Draynor
        { x: FISHING_SPOT.x, z: FISHING_SPOT.z },  // Fishing spot
    ];

    for (const wp of waypoints) {
        ctx.log(`Walking to (${wp.x}, ${wp.z})...`);
        markProgress(ctx, stats);

        // Use raw SDK walk with manual progress ticks
        await ctx.sdk.sendWalk(wp.x, wp.z, true);

        // Wait for arrival with progress marks
        for (let i = 0; i < 60; i++) {  // Max 30 seconds per segment
            await new Promise(r => setTimeout(r, 500));
            markProgress(ctx, stats);

            const player = ctx.state()?.player;
            if (player) {
                const dist = Math.sqrt(
                    Math.pow(player.worldX - wp.x, 2) +
                    Math.pow(player.worldZ - wp.z, 2)
                );
                if (dist < 5) {
                    ctx.log(`Reached waypoint (${player.worldX}, ${player.worldZ})`);
                    break;
                }
            }
        }
    }

    ctx.log('Arrived at Draynor fishing area');
    markProgress(ctx, stats);

    try {
        await fishingLoop(ctx, stats);
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
