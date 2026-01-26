/**
 * Arc: cowhide-banking
 * Character: Adam_2
 *
 * Goal: Collect cowhides and bank them for GP.
 * Strategy: Kill cows, loot hides, bank at Lumbridge Castle, repeat.
 *
 * Duration: 10 minutes
 */

import { runArc, StallError } from '../../../arc-runner';
import type { ScriptContext } from '../../../arc-runner';
import type { NearbyNpc } from '../../../../agent/types';

// Locations - Using Varrock West Bank (ground floor, no stairs!)
const LOCATIONS = {
    COW_FIELD: { x: 3253, z: 3269 },
    VARROCK_WEST_BANK: { x: 3185, z: 3436 },  // Ground floor, easy to access
};

// Bank when we have this many hides
const BANK_THRESHOLD = 20;

// Waypoints from cow field to Varrock West Bank (reliable long-distance walking)
const WAYPOINTS_TO_BANK = [
    { x: 3253, z: 3290 },  // North of cow field
    { x: 3240, z: 3320 },  // North along road
    { x: 3230, z: 3350 },  // Continue north
    { x: 3220, z: 3380 },  // Entering Varrock area
    { x: 3210, z: 3410 },  // West side of Varrock
    { x: 3185, z: 3436 },  // Varrock West Bank
];

// Waypoints back to cow field
const WAYPOINTS_TO_COWS = [
    { x: 3185, z: 3436 },  // Varrock West Bank
    { x: 3210, z: 3410 },  // South from bank
    { x: 3220, z: 3380 },  // Continue south
    { x: 3230, z: 3350 },  // South
    { x: 3240, z: 3320 },  // South toward Lumbridge
    { x: 3253, z: 3290 },  // Almost at cow field
    { x: 3253, z: 3269 },  // Cow field
];

interface Stats {
    kills: number;
    hidesCollected: number;
    hidesBanked: number;
    bankTrips: number;
    startTime: number;
    lastProgressTime: number;
}

function markProgress(ctx: ScriptContext, stats: Stats): void {
    stats.lastProgressTime = Date.now();
    ctx.progress();
}

function getTotalLevel(ctx: ScriptContext): number {
    return ctx.state()?.skills.reduce((sum, s) => sum + s.baseLevel, 0) ?? 32;
}

function countHides(ctx: ScriptContext): number {
    const state = ctx.state();
    if (!state) return 0;
    const hides = state.inventory.filter(i => /cow\s*hide/i.test(i.name));
    return hides.reduce((sum, h) => sum + (h.count ?? 1), 0);
}

function getInventoryCount(ctx: ScriptContext): number {
    return ctx.state()?.inventory.length ?? 0;
}

/**
 * Find the best cow to attack
 */
function findBestCow(ctx: ScriptContext): NearbyNpc | null {
    const state = ctx.state();
    if (!state) return null;

    const cows = state.nearbyNpcs
        .filter(npc => /^cow$/i.test(npc.name))
        .filter(npc => npc.options.some(o => /attack/i.test(o)))
        .filter(npc => !npc.inCombat)
        .sort((a, b) => a.distance - b.distance);

    return cows[0] ?? null;
}

/**
 * Pick up cow hides from the ground
 */
async function pickupHides(ctx: ScriptContext, stats: Stats): Promise<number> {
    let pickedUp = 0;
    const state = ctx.state();
    if (!state || !state.player) return 0;

    if (state.inventory.length >= 28) return 0;

    // GroundItem already has distance property
    const groundItems = state.groundItems
        ?.filter(i => /cow\s*hide/i.test(i.name))
        .sort((a, b) => a.distance - b.distance)
        .filter(i => i.distance <= 8) ?? [];

    for (const item of groundItems.slice(0, 3)) {
        if (ctx.state()!.inventory.length >= 28) break;

        ctx.log(`Picking up cowhide...`);
        const result = await ctx.bot.pickupItem(item);
        if (result.success) {
            pickedUp++;
            stats.hidesCollected++;
            markProgress(ctx, stats);
        }
        await new Promise(r => setTimeout(r, 300));
    }

    return pickedUp;
}

/**
 * Walk via waypoints with verification at each point
 */
async function walkWaypoints(ctx: ScriptContext, stats: Stats, waypoints: {x: number, z: number}[], label: string): Promise<boolean> {
    ctx.log(`Walking ${label} via ${waypoints.length} waypoints...`);

    for (let i = 0; i < waypoints.length; i++) {
        const wp = waypoints[i]!;
        ctx.log(`  Waypoint ${i + 1}/${waypoints.length}: (${wp.x}, ${wp.z})`);

        await ctx.bot.walkTo(wp.x, wp.z);
        markProgress(ctx, stats);

        // Wait for arrival with timeout
        for (let j = 0; j < 40; j++) {  // 20 seconds max per waypoint
            await new Promise(r => setTimeout(r, 500));
            markProgress(ctx, stats);

            // Dismiss dialogs
            if (ctx.state()?.dialog?.isOpen) {
                await ctx.sdk.sendClickDialog(0);
            }

            const player = ctx.state()?.player;
            if (player) {
                const dist = Math.sqrt(
                    Math.pow(player.worldX - wp.x, 2) +
                    Math.pow(player.worldZ - wp.z, 2)
                );
                if (dist < 10) {
                    break;  // Arrived at waypoint
                }
            }
        }
    }

    return true;
}

/**
 * Bank hides at Varrock West Bank (ground floor - no stairs!)
 */
async function bankHides(ctx: ScriptContext, stats: Stats): Promise<boolean> {
    ctx.log('=== Banking Trip to Varrock West ===');
    stats.bankTrips++;

    const hidesBeforeBank = countHides(ctx);
    ctx.log(`Hides to bank: ${hidesBeforeBank}`);

    // Walk via waypoints to Varrock West Bank
    await walkWaypoints(ctx, stats, WAYPOINTS_TO_BANK, 'to Varrock West Bank');

    // Wait a moment at the bank
    await new Promise(r => setTimeout(r, 1000));
    markProgress(ctx, stats);

    // Debug position
    const player = ctx.state()?.player;
    ctx.log(`Position: (${player?.worldX}, ${player?.worldZ})`);

    // Open bank
    ctx.log('Looking for bank...');
    let bankOpened = false;

    // Debug what's nearby
    const bankAreaLocs = ctx.state()?.nearbyLocs ?? [];
    const bankLocs = bankAreaLocs.filter(l => /bank/i.test(l.name));
    ctx.log(`Bank-related locs: ${bankLocs.map(l => `${l.name}(${l.options.join(',')})`).join(', ') || 'none'}`);

    // Try bank booth first
    const bankBooth = bankAreaLocs.find(l => /bank booth|bank chest/i.test(l.name));
    if (bankBooth) {
        const bankOpt = bankBooth.optionsWithIndex.find(o => /^bank$/i.test(o.text)) ||
                       bankBooth.optionsWithIndex.find(o => /use/i.test(o.text)) ||
                       bankBooth.optionsWithIndex[0];
        if (bankOpt) {
            ctx.log(`Using bank booth: ${bankOpt.text}`);
            await ctx.sdk.sendInteractLoc(bankBooth.x, bankBooth.z, bankBooth.id, bankOpt.opIndex);

            for (let i = 0; i < 25; i++) {
                await new Promise(r => setTimeout(r, 400));
                const state = ctx.state();
                if (state?.interface?.isOpen) {
                    bankOpened = true;
                    ctx.log('Bank interface opened!');
                    break;
                }
                if (state?.dialog?.isOpen) {
                    await ctx.sdk.sendClickDialog(0);
                }
                markProgress(ctx, stats);
            }
        }
    }

    // Try banker NPC if booth didn't work
    if (!bankOpened) {
        const nearbyNpcs = ctx.state()?.nearbyNpcs ?? [];
        ctx.log(`Nearby NPCs: ${nearbyNpcs.slice(0, 5).map(n => n.name).join(', ')}`);

        const banker = nearbyNpcs.find(n => /banker/i.test(n.name));
        if (banker) {
            ctx.log(`Using banker NPC: ${banker.name}`);
            const bankOpt = banker.optionsWithIndex?.find(o => /bank/i.test(o.text));
            if (bankOpt) {
                await ctx.sdk.sendInteractNpc(banker.index, bankOpt.opIndex);
                for (let i = 0; i < 25; i++) {
                    await new Promise(r => setTimeout(r, 400));
                    if (ctx.state()?.interface?.isOpen) {
                        bankOpened = true;
                        ctx.log('Bank opened via banker!');
                        break;
                    }
                    markProgress(ctx, stats);
                }
            }
        }
    }

    if (!bankOpened) {
        ctx.warn('Failed to open bank - returning to cow field');
        await returnToCowField(ctx, stats);
        return false;
    }

    // Deposit all hides
    const hides = ctx.state()?.inventory.filter(i => /cow\s*hide/i.test(i.name)) ?? [];
    ctx.log(`Depositing ${hides.length} hide stacks...`);
    for (const hide of hides) {
        await ctx.sdk.sendBankDeposit(hide.slot, hide.count ?? 1);
        await new Promise(r => setTimeout(r, 200));
    }

    await new Promise(r => setTimeout(r, 800));
    markProgress(ctx, stats);

    // Verify deposit
    const hidesAfter = countHides(ctx);
    const deposited = hidesBeforeBank - hidesAfter;
    if (deposited > 0) {
        stats.hidesBanked += deposited;
        ctx.log(`SUCCESS! Deposited ${deposited} hides. Total banked: ${stats.hidesBanked}`);
    } else {
        ctx.warn(`Deposit may have failed - hides before: ${hidesBeforeBank}, after: ${hidesAfter}`);
    }

    // Return to cow field
    await returnToCowField(ctx, stats);
    return deposited > 0;
}

/**
 * Return from Varrock West Bank to cow field
 */
async function returnToCowField(ctx: ScriptContext, stats: Stats): Promise<void> {
    ctx.log('Returning to cow field...');

    // Walk via waypoints back to cow field
    await walkWaypoints(ctx, stats, WAYPOINTS_TO_COWS, 'to cow field');

    // Open gate to enter cow field
    await ctx.bot.openDoor(/gate/i);
    markProgress(ctx, stats);

    ctx.log('=== Back at cow field ===');
}

/**
 * Main combat/collection loop
 */
async function mainLoop(ctx: ScriptContext, stats: Stats): Promise<void> {
    let noCowCount = 0;
    let loopCount = 0;

    while (true) {
        loopCount++;
        const currentState = ctx.state();
        if (!currentState) break;

        if (loopCount % 50 === 0) {
            ctx.log(`Loop ${loopCount}: ${stats.kills} kills, ${stats.hidesCollected} hides, ${stats.hidesBanked} banked`);
        }

        // Dismiss dialogs
        if (currentState.dialog.isOpen) {
            ctx.log('Dismissing dialog...');
            await ctx.sdk.sendClickDialog(0);
            markProgress(ctx, stats);
            await new Promise(r => setTimeout(r, 300));
            continue;
        }

        // Check inventory and manage space
        const hides = countHides(ctx);
        const invCount = getInventoryCount(ctx);

        // Track max hides (for stats)
        if (hides > stats.hidesCollected) {
            stats.hidesCollected = hides;
        }

        // Bank when we have enough hides
        if (hides >= BANK_THRESHOLD) {
            ctx.log(`Have ${hides} hides - banking!`);
            const bankSuccess = await bankHides(ctx, stats);
            if (!bankSuccess) {
                ctx.warn('Banking failed - will try again later');
            }
            continue;
        }

        // If inventory is getting full but not enough hides, drop non-essentials
        if (invCount >= 26 && hides < BANK_THRESHOLD) {
            // Keep: weapons, shields, pickaxe, axe, hides
            // Drop: logs, ore, bones, food, random items
            const junk = ctx.state()?.inventory.filter(i => {
                const name = i.name.toLowerCase();
                // Keep essential items
                if (/sword|dagger|mace|scimitar|shield|axe|pickaxe|cow\s*hide/i.test(name)) return false;
                // Drop everything else
                return true;
            }) ?? [];

            if (junk.length > 0) {
                ctx.log(`Inventory ${invCount}/28, dropping: ${junk.slice(0, 5).map(i => i.name).join(', ')}`);
                for (const item of junk.slice(0, 5)) {
                    await ctx.sdk.sendDropItem(item.slot);
                    await new Promise(r => setTimeout(r, 150));
                }
                markProgress(ctx, stats);
                continue;
            }
        }

        // Check if idle
        const player = currentState.player;
        const isIdle = player?.animId === -1;

        if (isIdle) {
            // Try to loot hides first
            const pickedUp = await pickupHides(ctx, stats);
            if (pickedUp > 0) {
                continue;
            }

            // Find a cow to attack
            const cow = findBestCow(ctx);
            if (!cow) {
                noCowCount++;
                if (noCowCount % 30 === 0) {
                    ctx.log(`No cows found (${noCowCount} attempts), walking to field...`);
                    await ctx.sdk.sendWalk(LOCATIONS.COW_FIELD.x, LOCATIONS.COW_FIELD.z, true);
                    markProgress(ctx, stats);
                    await new Promise(r => setTimeout(r, 2000));
                }
                await new Promise(r => setTimeout(r, 100));
                markProgress(ctx, stats);
                continue;
            }

            noCowCount = 0;

            // Attack cow
            const attackResult = await ctx.bot.attackNpc(cow);
            if (attackResult.success) {
                ctx.log(`Attacking cow (dist: ${cow.distance.toFixed(0)})`);
                stats.kills++;
                markProgress(ctx, stats);
                await new Promise(r => setTimeout(r, 2000));
            } else {
                ctx.log(`Attack failed: ${attackResult.message}`);
                if (attackResult.reason === 'out_of_reach') {
                    ctx.log('Opening gate...');
                    await ctx.bot.openDoor(/gate/i);
                    markProgress(ctx, stats);
                }
            }
        }

        await new Promise(r => setTimeout(r, 600));
        markProgress(ctx, stats);
    }
}

/**
 * Log final stats
 */
function logFinalStats(ctx: ScriptContext, stats: Stats): void {
    const duration = (Date.now() - stats.startTime) / 1000;
    const hidesPerMin = duration > 0 ? (stats.hidesBanked / (duration / 60)).toFixed(1) : '0';

    ctx.log('');
    ctx.log('=== Arc Results ===');
    ctx.log(`Duration: ${Math.round(duration)}s`);
    ctx.log(`Kills: ${stats.kills}`);
    ctx.log(`Hides Collected: ${stats.hidesCollected}`);
    ctx.log(`Hides Banked: ${stats.hidesBanked}`);
    ctx.log(`Bank Trips: ${stats.bankTrips}`);
    ctx.log(`Rate: ${hidesPerMin} hides/min`);
    ctx.log(`Total Level: ${getTotalLevel(ctx)}`);
}

// Run the arc
runArc({
    characterName: 'Adam_2',
    arcName: 'cowhide-banking',
    goal: `Collect and bank ${BANK_THRESHOLD}+ cowhides for GP`,
    timeLimit: 10 * 60 * 1000,  // 10 minutes
    stallTimeout: 60_000,       // 60 seconds (banking takes time)
    screenshotInterval: 30_000,
    launchOptions: {
        useSharedBrowser: false,
    },
}, async (ctx) => {
    const stats: Stats = {
        kills: 0,
        hidesCollected: 0,
        hidesBanked: 0,
        bankTrips: 0,
        startTime: Date.now(),
        lastProgressTime: Date.now(),
    };

    ctx.log('=== Arc: cowhide-banking ===');
    ctx.log(`Starting Total Level: ${getTotalLevel(ctx)}`);
    ctx.log(`Position: (${ctx.state()?.player?.worldX}, ${ctx.state()?.player?.worldZ})`);

    // Log inventory
    const startInv = ctx.state()?.inventory ?? [];
    ctx.log(`Inventory (${startInv.length} items): ${startInv.map(i => i.name).join(', ')}`);

    // Wait for state
    for (let i = 0; i < 20; i++) {
        const state = ctx.state();
        if (state?.player && state.player.worldX !== 0) break;
        await new Promise(r => setTimeout(r, 500));
        markProgress(ctx, stats);
    }

    // Dismiss startup dialogs
    await ctx.bot.dismissBlockingUI();
    markProgress(ctx, stats);

    // Equip best available weapon
    const inv = ctx.state()?.inventory || [];
    const weapon = inv.find(i => /sword|axe|mace|dagger|scimitar/i.test(i.name) && !/pickaxe/i.test(i.name));
    if (weapon) {
        ctx.log(`Equipping ${weapon.name}...`);
        await ctx.bot.equipItem(weapon);
        markProgress(ctx, stats);
    }

    const shield = inv.find(i => /shield/i.test(i.name));
    if (shield) {
        ctx.log(`Equipping ${shield.name}...`);
        await ctx.bot.equipItem(shield);
        markProgress(ctx, stats);
    }

    // Walk to cow field if far away
    const player = ctx.state()?.player;
    if (player) {
        const dist = Math.sqrt(
            Math.pow(player.worldX - LOCATIONS.COW_FIELD.x, 2) +
            Math.pow(player.worldZ - LOCATIONS.COW_FIELD.z, 2)
        );
        if (dist > 30) {
            ctx.log(`Walking to cow field (${dist.toFixed(0)} tiles away)...`);
            await ctx.bot.walkTo(LOCATIONS.COW_FIELD.x, LOCATIONS.COW_FIELD.z);
            markProgress(ctx, stats);
        }

        // Open gate
        ctx.log('Opening gate to cow field...');
        await ctx.bot.openDoor(/gate/i);
        markProgress(ctx, stats);
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
