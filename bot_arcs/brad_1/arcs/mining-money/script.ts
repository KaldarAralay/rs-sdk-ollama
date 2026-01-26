/**
 * Arc: mining-money
 * Character: Brad_1
 *
 * Goal: Make money by mining copper/tin ore and selling at general store.
 * Strategy:
 * - Mine ore at Lumbridge Swamp mine (copper and tin rocks)
 * - When inventory full, sell at Lumbridge General Store
 * - Target: 200+ GP
 *
 * Duration: 10 minutes
 */

import { runArc, StallError } from '../../../arc-runner';
import type { ScriptContext } from '../../../arc-runner';

// === LOCATIONS ===
const LOCATIONS = {
    LUMBRIDGE_MINE: { x: 3228, z: 3146 },  // Lumbridge Swamp mine
    GENERAL_STORE: { x: 3212, z: 3246 },   // Lumbridge general store
};

// === STATS ===
interface Stats {
    oreMined: number;
    oreSold: number;
    gpEarned: number;
    startGP: number;
    startTime: number;
}

function markProgress(ctx: ScriptContext): void {
    ctx.progress();
}

function getGP(ctx: ScriptContext): number {
    const coins = ctx.state()?.inventory.find(i => /coins/i.test(i.name));
    return coins?.count ?? 0;
}

function countOre(ctx: ScriptContext): number {
    const inv = ctx.state()?.inventory ?? [];
    return inv.filter(i => /ore/i.test(i.name)).length;
}

function getInventorySpace(ctx: ScriptContext): number {
    return 28 - (ctx.state()?.inventory?.length ?? 0);
}

// === MINING HELPERS ===
function findRock(ctx: ScriptContext): any | null {
    const state = ctx.state();
    if (!state) return null;

    // Look for copper or tin rocks
    const rocks = state.nearbyLocs
        .filter(loc => /copper|tin/i.test(loc.name))
        .filter(loc => loc.options.some(opt => /mine/i.test(opt)))
        .sort((a, b) => a.distance - b.distance);

    return rocks[0] ?? null;
}

// === SELLING ===
async function sellOre(ctx: ScriptContext, stats: Stats): Promise<void> {
    const oreCount = countOre(ctx);
    if (oreCount === 0) {
        ctx.log('No ore to sell');
        return;
    }

    ctx.log('Selling ' + oreCount + ' ore at Lumbridge store...');

    // Walk to general store
    await ctx.bot.walkTo(LOCATIONS.GENERAL_STORE.x, LOCATIONS.GENERAL_STORE.z);
    markProgress(ctx);
    await new Promise(r => setTimeout(r, 1000));

    // Find shopkeeper
    const state = ctx.state();
    const shopkeeper = state?.nearbyNpcs.find(npc =>
        /shop\s*(keeper|assistant)/i.test(npc.name)
    );

    if (!shopkeeper) {
        ctx.log('No shopkeeper found!');
        return;
    }

    // Open shop
    const tradeOpt = shopkeeper.optionsWithIndex?.find(o => /trade|shop/i.test(o.text));
    if (tradeOpt) {
        await ctx.sdk.sendInteractNpc(shopkeeper.index, tradeOpt.opIndex);
        markProgress(ctx);
        await new Promise(r => setTimeout(r, 2000));
    }

    // Wait for shop
    let shopOpen = false;
    for (let i = 0; i < 10; i++) {
        if (ctx.state()?.shop.isOpen) {
            shopOpen = true;
            break;
        }
        await new Promise(r => setTimeout(r, 500));
    }

    if (!shopOpen) {
        ctx.log('Shop did not open');
        return;
    }

    const gpBefore = getGP(ctx);

    // Sell copper ore
    try {
        const copperResult = await ctx.bot.sellToShop(/copper ore/i, 'all');
        ctx.log('Copper sell: ' + copperResult.message);
    } catch (err) {
        ctx.log('Copper sell error: ' + (err instanceof Error ? err.message : String(err)));
    }

    // Sell tin ore
    try {
        const tinResult = await ctx.bot.sellToShop(/tin ore/i, 'all');
        ctx.log('Tin sell: ' + tinResult.message);
    } catch (err) {
        ctx.log('Tin sell error: ' + (err instanceof Error ? err.message : String(err)));
    }

    const gpAfter = getGP(ctx);
    const earned = gpAfter - gpBefore;
    stats.gpEarned += earned;
    stats.oreSold += oreCount;
    ctx.log('Earned ' + earned + ' GP (Total: ' + gpAfter + ' GP)');

    // Close shop
    await ctx.sdk.sendCloseShop();
    markProgress(ctx);
}

// === MAIN LOOP ===
async function mainLoop(ctx: ScriptContext, stats: Stats): Promise<void> {
    let loopCount = 0;

    while (true) {
        loopCount++;
        const state = ctx.state();
        if (!state || !state.player) {
            await new Promise(r => setTimeout(r, 1000));
            markProgress(ctx);
            continue;
        }

        const pos = state.player;
        if (pos.worldX === 0 && pos.worldZ === 0) {
            await new Promise(r => setTimeout(r, 2000));
            markProgress(ctx);
            continue;
        }

        // Status
        if (loopCount % 20 === 0) {
            const gp = getGP(ctx);
            const ore = countOre(ctx);
            ctx.log('Loop ' + loopCount + ': GP=' + gp + ', Ore=' + ore + ', Mined=' + stats.oreMined);
        }

        // Dismiss dialogs
        if (state.dialog.isOpen) {
            await ctx.sdk.sendClickDialog(0);
            markProgress(ctx);
            await new Promise(r => setTimeout(r, 300));
            continue;
        }

        // Check if inventory is full - go sell
        const space = getInventorySpace(ctx);
        if (space <= 2) {
            ctx.log('Inventory full (' + countOre(ctx) + ' ore), going to sell...');
            await sellOre(ctx, stats);

            const gp = getGP(ctx);
            if (gp >= 200) {
                ctx.log('TARGET REACHED: ' + gp + ' GP!');
            }

            // Walk back to mine
            ctx.log('Walking back to mine...');
            await ctx.bot.walkTo(LOCATIONS.LUMBRIDGE_MINE.x, LOCATIONS.LUMBRIDGE_MINE.z);
            markProgress(ctx);
            continue;
        }

        // Make sure we're near the mine
        const distToMine = Math.sqrt(
            Math.pow(pos.worldX - LOCATIONS.LUMBRIDGE_MINE.x, 2) +
            Math.pow(pos.worldZ - LOCATIONS.LUMBRIDGE_MINE.z, 2)
        );

        if (distToMine > 30) {
            ctx.log('Walking to Lumbridge mine...');
            await ctx.bot.walkTo(LOCATIONS.LUMBRIDGE_MINE.x, LOCATIONS.LUMBRIDGE_MINE.z);
            markProgress(ctx);
            continue;
        }

        // Check if idle
        const isIdle = pos.animId === -1;

        if (isIdle) {
            // Find a rock to mine
            const rock = findRock(ctx);
            if (!rock) {
                ctx.log('No rocks found, walking around...');
                await ctx.sdk.sendWalk(
                    LOCATIONS.LUMBRIDGE_MINE.x + (Math.random() * 10 - 5),
                    LOCATIONS.LUMBRIDGE_MINE.z + (Math.random() * 10 - 5),
                    true
                );
                markProgress(ctx);
                await new Promise(r => setTimeout(r, 1500));
                continue;
            }

            // Mine the rock
            try {
                ctx.log('Mining ' + rock.name + ' (dist: ' + rock.distance.toFixed(0) + ')...');
                const mineOpt = rock.optionsWithIndex?.find((o: any) => /mine/i.test(o.text));
                if (mineOpt) {
                    await ctx.sdk.sendInteractLoc(rock.id, rock.x, rock.z, mineOpt.opIndex);
                    markProgress(ctx);
                    stats.oreMined++;
                    // Wait for mining animation
                    await new Promise(r => setTimeout(r, 3000));
                }
            } catch (err) {
                const errorMsg = err instanceof Error ? err.message : String(err);
                ctx.log('Mine error: ' + errorMsg);
                markProgress(ctx);
            }
        }

        await new Promise(r => setTimeout(r, 600));
        markProgress(ctx);
    }
}

// === FINAL STATS ===
function logFinalStats(ctx: ScriptContext, stats: Stats): void {
    const duration = (Date.now() - stats.startTime) / 1000;
    const gp = getGP(ctx);

    ctx.log('');
    ctx.log('=== Arc Results ===');
    ctx.log('Duration: ' + Math.round(duration) + 's');
    ctx.log('Ore Mined: ' + stats.oreMined);
    ctx.log('Ore Sold: ' + stats.oreSold);
    ctx.log('GP Earned: ' + stats.gpEarned);
    ctx.log('Total GP: ' + gp + ' (started with ' + stats.startGP + ')');
}

// === RUN THE ARC ===
runArc({
    characterName: 'brad_1',
    arcName: 'mining-money',
    goal: 'Make money by mining and selling ore',
    timeLimit: 10 * 60 * 1000,
    stallTimeout: 60_000,
    screenshotInterval: 30_000,
    launchOptions: {
        useSharedBrowser: false,
    },
}, async (ctx) => {
    const stats: Stats = {
        oreMined: 0,
        oreSold: 0,
        gpEarned: 0,
        startGP: 0,
        startTime: Date.now(),
    };

    ctx.log('=== Arc: mining-money ===');
    ctx.log('Goal: Make 200+ GP by mining ore');

    // Wait for state
    ctx.log('Waiting for game state...');
    try {
        await ctx.sdk.waitForCondition(s => {
            return !!(s.player && s.player.worldX > 0 && s.skills.some(skill => skill.baseLevel > 0));
        }, 45000);
    } catch (e) {
        ctx.error('State did not populate');
        return;
    }

    await new Promise(r => setTimeout(r, 1000));
    stats.startGP = getGP(ctx);

    ctx.log('State ready! Position: (' + ctx.state()?.player?.worldX + ', ' + ctx.state()?.player?.worldZ + ')');
    ctx.log('Starting GP: ' + stats.startGP);

    // Dismiss dialogs
    await ctx.bot.dismissBlockingUI();
    markProgress(ctx);

    // Equip pickaxe if in inventory
    const inv = ctx.state()?.inventory || [];
    const pickaxe = inv.find(i => /pickaxe/i.test(i.name));
    if (pickaxe) {
        ctx.log('Equipping ' + pickaxe.name);
        await ctx.bot.equipItem(pickaxe);
        markProgress(ctx);
    }

    try {
        await mainLoop(ctx, stats);
    } catch (e) {
        if (e instanceof StallError) {
            ctx.error('Arc aborted: ' + e.message);
        } else {
            throw e;
        }
    } finally {
        logFinalStats(ctx, stats);
    }
});
