/**
 * Arc: mining-banking
 * Character: Adam_1
 *
 * Goal: Mine ore at SE Varrock, bank it nearby.
 * Strategy: Use waypoints for the walk to ensure we reach the bank.
 *
 * Duration: 3 minutes (short loop for testing)
 */

import { runArc, StallError } from '../../../arc-runner';
import type { ScriptContext } from '../../../arc-runner';

// Locations
const VARROCK_SE_MINE = { x: 3285, z: 3365 };
const VARROCK_WEST_BANK = { x: 3185, z: 3436 };

// Waypoints from mine to bank (smaller steps ~20-25 tiles each)
const WAYPOINTS_TO_BANK = [
    { x: 3270, z: 3380 },  // Step 1: NW from mine
    { x: 3250, z: 3395 },  // Step 2: Continue NW
    { x: 3230, z: 3410 },  // Step 3: Getting closer
    { x: 3210, z: 3425 },  // Step 4: Near bank entrance
    { x: 3185, z: 3436 },  // Step 5: Bank
];

const WAYPOINTS_TO_MINE = [
    { x: 3210, z: 3425 },
    { x: 3230, z: 3410 },
    { x: 3250, z: 3395 },
    { x: 3270, z: 3380 },
    VARROCK_SE_MINE,
];

interface Stats {
    oresMined: number;
    oresBanked: number;
    bankTrips: number;
    startTime: number;
    lastProgressTime: number;
}

function markProgress(ctx: ScriptContext, stats: Stats): void {
    stats.lastProgressTime = Date.now();
    ctx.progress();
}

function getMiningLevel(ctx: ScriptContext): number {
    return ctx.state()?.skills.find(s => s.name === 'Mining')?.baseLevel ?? 1;
}

function getTotalLevel(ctx: ScriptContext): number {
    return ctx.state()?.skills.reduce((sum, s) => sum + s.baseLevel, 0) ?? 32;
}

function countOre(ctx: ScriptContext): number {
    const state = ctx.state();
    if (!state) return 0;
    return state.inventory.filter(i => /ore$/i.test(i.name)).reduce((sum, i) => sum + i.count, 0);
}

/**
 * Walk along waypoints using bot.walkTo with retry logic
 */
async function walkWaypoints(ctx: ScriptContext, waypoints: {x: number, z: number}[], stats: Stats): Promise<boolean> {
    for (const wp of waypoints) {
        let reached = false;

        // Try up to 3 times per waypoint
        for (let attempt = 0; attempt < 3 && !reached; attempt++) {
            const startPos = ctx.state()?.player;
            ctx.log(`Walking to (${wp.x}, ${wp.z}) from (${startPos?.worldX}, ${startPos?.worldZ})... [attempt ${attempt + 1}]`);

            // Use bot.walkTo which handles pathfinding better
            await ctx.bot.walkTo(wp.x, wp.z);
            await new Promise(r => setTimeout(r, 500)); // Brief pause after walk
            markProgress(ctx, stats);

            // Check if we arrived
            const player = ctx.state()?.player;
            const dist = player ? Math.sqrt(
                Math.pow(player.worldX - wp.x, 2) +
                Math.pow(player.worldZ - wp.z, 2)
            ) : 999;

            ctx.log(`After walk: pos=(${player?.worldX}, ${player?.worldZ}), dist=${dist.toFixed(1)}`);

            if (dist <= 25) {
                reached = true;
            } else if (attempt < 2) {
                ctx.log(`Retrying waypoint...`);
                await new Promise(r => setTimeout(r, 1000));
            }
        }

        if (!reached) {
            ctx.warn(`Failed to reach waypoint (${wp.x}, ${wp.z}) after 3 attempts`);
            return false;
        }
    }

    const player = ctx.state()?.player;
    const target = waypoints[waypoints.length - 1];
    if (!target) return false;
    const finalDist = Math.sqrt(
        Math.pow((player?.worldX ?? 0) - target.x, 2) +
        Math.pow((player?.worldZ ?? 0) - target.z, 2)
    );

    ctx.log(`Final position: (${player?.worldX}, ${player?.worldZ}), dist to target: ${finalDist.toFixed(1)}`);
    return finalDist < 20;
}

/**
 * Find and mine a rock
 */
async function mineRock(ctx: ScriptContext, stats: Stats): Promise<boolean> {
    const state = ctx.state();
    if (!state) return false;

    const player = state.player;
    const isIdle = player?.animId === -1;

    if (!isIdle) {
        // Already mining
        return true;
    }

    // Find rock with Mine option
    const rock = state.nearbyLocs
        .filter(loc => /rocks?$/i.test(loc.name))
        .filter(loc => loc.optionsWithIndex.some(o => /^mine$/i.test(o.text)))
        .sort((a, b) => a.distance - b.distance)[0];

    if (!rock) {
        return false;
    }

    // Walk closer if needed
    if (rock.distance > 3) {
        await ctx.sdk.sendWalk(rock.x, rock.z, true);
        await new Promise(r => setTimeout(r, 1000));
        markProgress(ctx, stats);
        return true;
    }

    const mineOpt = rock.optionsWithIndex.find(o => /^mine$/i.test(o.text));
    if (mineOpt) {
        await ctx.sdk.sendInteractLoc(rock.x, rock.z, rock.id, mineOpt.opIndex);
        stats.oresMined++;
        markProgress(ctx, stats);
    }

    return true;
}

/**
 * Bank ore at Varrock West bank
 */
async function bankOre(ctx: ScriptContext, stats: Stats): Promise<boolean> {
    ctx.log('=== Banking Trip ===');
    stats.bankTrips++;

    const oreBeforeBank = countOre(ctx);
    ctx.log(`Ore to bank: ${oreBeforeBank}`);

    // Walk to bank via waypoints
    ctx.log('Walking to bank...');
    const reachedBank = await walkWaypoints(ctx, WAYPOINTS_TO_BANK, stats);

    if (!reachedBank) {
        ctx.warn('Failed to reach bank');
        return false;
    }

    ctx.log(`Position: (${ctx.state()?.player?.worldX}, ${ctx.state()?.player?.worldZ})`);

    // Find and open bank
    let bankOpened = false;

    const bankBooth = ctx.state()?.nearbyLocs.find(l => /bank booth/i.test(l.name));
    if (bankBooth) {
        ctx.log(`Found bank booth at (${bankBooth.x}, ${bankBooth.z})`);
        const bankOpt = bankBooth.optionsWithIndex.find(o => /^bank$/i.test(o.text)) ||
                       bankBooth.optionsWithIndex[0];
        if (bankOpt) {
            await ctx.sdk.sendInteractLoc(bankBooth.x, bankBooth.z, bankBooth.id, bankOpt.opIndex);

            for (let i = 0; i < 15; i++) {
                await new Promise(r => setTimeout(r, 500));
                if (ctx.state()?.interface?.isOpen) {
                    bankOpened = true;
                    ctx.log('Bank opened!');
                    break;
                }
                if (ctx.state()?.dialog?.isOpen) {
                    await ctx.sdk.sendClickDialog(0);
                }
                markProgress(ctx, stats);
            }
        }
    }

    if (!bankOpened) {
        // Try banker NPC
        const banker = ctx.sdk.findNearbyNpc(/banker/i);
        if (banker) {
            ctx.log(`Found banker: ${banker.name}`);
            const bankOpt = banker.optionsWithIndex.find(o => /bank/i.test(o.text));
            if (bankOpt) {
                await ctx.sdk.sendInteractNpc(banker.index, bankOpt.opIndex);
                for (let i = 0; i < 15; i++) {
                    await new Promise(r => setTimeout(r, 500));
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
        ctx.warn('Failed to open bank');
        const locs = ctx.state()?.nearbyLocs.slice(0, 8) ?? [];
        ctx.log(`Nearby: ${locs.map(l => l.name).join(', ')}`);
        return false;
    }

    // Deposit all ore
    const ores = ctx.state()?.inventory.filter(i => /ore$/i.test(i.name)) ?? [];
    for (const ore of ores) {
        ctx.log(`Depositing ${ore.name} x${ore.count}...`);
        await ctx.sdk.sendBankDeposit(ore.slot, ore.count);
        await new Promise(r => setTimeout(r, 200));
    }

    await new Promise(r => setTimeout(r, 500));

    const oreAfter = countOre(ctx);
    const deposited = oreBeforeBank - oreAfter;
    if (deposited > 0) {
        stats.oresBanked += deposited;
        ctx.log(`Banked ${deposited} ore! Total: ${stats.oresBanked}`);
    }

    // Walk back to mine
    ctx.log('Returning to mine...');
    await walkWaypoints(ctx, WAYPOINTS_TO_MINE, stats);

    return true;
}

/**
 * Main mining loop
 */
async function miningLoop(ctx: ScriptContext, stats: Stats): Promise<void> {
    ctx.log('=== Mining-Banking Arc Started ===');
    let loopCount = 0;
    let lastOreCount = countOre(ctx);

    while (true) {
        loopCount++;

        const state = ctx.state();
        if (!state) break;

        // Dismiss dialogs
        if (state.dialog.isOpen) {
            await ctx.sdk.sendClickDialog(0);
            markProgress(ctx, stats);
            continue;
        }

        // Track ore mined
        const currentOre = countOre(ctx);
        if (currentOre > lastOreCount) {
            ctx.log(`Mined ore! Inventory: ${currentOre}`);
        }
        lastOreCount = currentOre;

        // Bank when inventory has 20+ ore (fewer trips, more efficient)
        if (currentOre >= 20) {
            ctx.log(`Have ${currentOre} ore, banking...`);
            const banked = await bankOre(ctx, stats);
            if (!banked) {
                // If banking failed, drop some ore to continue mining
                ctx.log('Banking failed, dropping ore to continue...');
                const ores = state.inventory.filter(i => /ore$/i.test(i.name)).slice(0, 5);
                for (const ore of ores) {
                    await ctx.sdk.sendDropItem(ore.slot);
                    await new Promise(r => setTimeout(r, 100));
                }
            }
            lastOreCount = countOre(ctx);
            continue;
        }

        // Mine
        const mined = await mineRock(ctx, stats);
        if (!mined) {
            // No rocks, walk to mine center
            await ctx.sdk.sendWalk(VARROCK_SE_MINE.x, VARROCK_SE_MINE.z, true);
            markProgress(ctx, stats);
        }

        await new Promise(r => setTimeout(r, 2000));
        markProgress(ctx, stats);

        if (loopCount % 20 === 0) {
            ctx.log(`Loop ${loopCount}: Mining ${getMiningLevel(ctx)}, ore=${currentOre}, banked=${stats.oresBanked}`);
        }
    }
}

function logFinalStats(ctx: ScriptContext, stats: Stats): void {
    const duration = (Date.now() - stats.startTime) / 1000;
    ctx.log('');
    ctx.log('=== Arc Results ===');
    ctx.log(`Duration: ${Math.round(duration)}s`);
    ctx.log(`Mining Level: ${getMiningLevel(ctx)}`);
    ctx.log(`Ores mined: ${stats.oresMined}`);
    ctx.log(`Ores banked: ${stats.oresBanked}`);
    ctx.log(`Bank trips: ${stats.bankTrips}`);
    ctx.log(`Total Level: ${getTotalLevel(ctx)}`);
}

// Run the arc - 5 minutes
runArc({
    characterName: 'Adam_1',
    arcName: 'mining-banking',
    goal: 'Mine ore and bank it at Varrock',
    timeLimit: 5 * 60 * 1000,      // 5 minutes
    stallTimeout: 45_000,
    screenshotInterval: 30_000,
    initializeFromPreset: {
        position: VARROCK_SE_MINE,
        skills: {
            Fishing: 48,
            Woodcutting: 41,
            Mining: 50,  // Updated from last run
            Attack: 27,
            Strength: 46,
            Defence: 26,
        },
        inventory: [
            { id: 1265, count: 1 },   // Bronze pickaxe
        ],
    },
    launchOptions: {
        useSharedBrowser: false,
    },
}, async (ctx) => {
    const stats: Stats = {
        oresMined: 0,
        oresBanked: 0,
        bankTrips: 0,
        startTime: Date.now(),
        lastProgressTime: Date.now(),
    };

    ctx.log('=== Arc: mining-banking ===');
    ctx.log(`Position: (${ctx.state()?.player?.worldX}, ${ctx.state()?.player?.worldZ})`);
    ctx.log(`Mining: ${getMiningLevel(ctx)}`);

    // Check pickaxe
    const hasPickaxe = ctx.state()?.inventory.some(i => /pickaxe/i.test(i.name));
    if (!hasPickaxe) {
        ctx.error('No pickaxe!');
        return;
    }

    await ctx.bot.dismissBlockingUI();
    markProgress(ctx, stats);

    try {
        await miningLoop(ctx, stats);
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
