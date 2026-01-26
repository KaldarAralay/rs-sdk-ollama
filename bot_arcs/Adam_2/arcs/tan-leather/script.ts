/**
 * Arc: tan-leather
 * Character: Adam_2
 *
 * Goal: Withdraw cowhides from Draynor Bank, walk to Al Kharid tannery, tan into leather.
 *
 * Steps:
 * 1. Open bank, withdraw cowhides (and 50gp for toll + tanning)
 * 2. Walk from Draynor to Al Kharid gate via Lumbridge
 * 3. Pay 10gp toll at gate
 * 4. Walk to Ellis the tanner (3274, 3192)
 * 5. Tan all cowhides into leather (1gp each)
 * 6. Bank leather at Al Kharid bank for later crafting
 *
 * Duration: 10 minutes
 */

import { runArc, StallError } from '../../../arc-runner.ts';
import type { ScriptContext } from '../../../arc-runner.ts';

// === LOCATIONS ===
const LOCATIONS = {
    DRAYNOR_BANK: { x: 3092, z: 3243 },
    LUMBRIDGE: { x: 3222, z: 3218 },
    ALKHARID_GATE: { x: 3268, z: 3228 },
    ALKHARID_INSIDE: { x: 3277, z: 3227 },
    TANNER_ELLIS: { x: 3274, z: 3192 },
    ALKHARID_BANK: { x: 3269, z: 3167 },
};

// Waypoints from Draynor to Al Kharid gate (via Lumbridge area)
const WAYPOINTS_TO_GATE = [
    { x: 3110, z: 3243 },  // East from Draynor
    { x: 3140, z: 3245 },  // Continue east
    { x: 3170, z: 3250 },  // Past swamp
    { x: 3200, z: 3235 },  // Approach Lumbridge area
    { x: 3230, z: 3230 },  // Near gate area
    { x: 3268, z: 3228 },  // Al Kharid toll gate
];

// Waypoints from gate to Ellis tanner
const WAYPOINTS_TO_TANNER = [
    { x: 3277, z: 3227 },  // Just inside Al Kharid
    { x: 3275, z: 3210 },  // South
    { x: 3274, z: 3192 },  // Ellis the tanner
];

// Waypoints from tanner to Al Kharid bank
const WAYPOINTS_TO_ALKHARID_BANK = [
    { x: 3274, z: 3180 },  // South from tanner
    { x: 3269, z: 3167 },  // Al Kharid bank
];

// === STATS ===
interface Stats {
    hidesWithdrawn: number;
    hidesTanned: number;
    leatherBanked: number;
    gpSpent: number;
    startTime: number;
}

function markProgress(ctx: ScriptContext): void {
    ctx.progress();
}

function getCoins(ctx: ScriptContext): number {
    const coins = ctx.state()?.inventory.find(i => /coins/i.test(i.name));
    return coins?.count ?? 0;
}

function countHides(ctx: ScriptContext): number {
    const inv = ctx.state()?.inventory ?? [];
    return inv.filter(i => /cow\s*hide/i.test(i.name)).length;
}

function countLeather(ctx: ScriptContext): number {
    const inv = ctx.state()?.inventory ?? [];
    return inv.filter(i => /^leather$/i.test(i.name)).length;
}

function getInventorySpace(ctx: ScriptContext): number {
    return 28 - (ctx.state()?.inventory?.length ?? 0);
}

function isInAlKharid(ctx: ScriptContext): boolean {
    const x = ctx.state()?.player?.worldX ?? 0;
    return x >= 3270;
}

// === WALKING ===
async function walkWaypoints(ctx: ScriptContext, waypoints: {x: number, z: number}[]): Promise<boolean> {
    for (let wpIdx = 0; wpIdx < waypoints.length; wpIdx++) {
        const wp = waypoints[wpIdx]!;
        const player = ctx.state()?.player;
        const startDist = player ? Math.sqrt(
            Math.pow(player.worldX - wp.x, 2) +
            Math.pow(player.worldZ - wp.z, 2)
        ) : 999;

        ctx.log(`Walking to waypoint ${wpIdx + 1}/${waypoints.length}: (${wp.x}, ${wp.z}) - ${Math.round(startDist)} tiles away`);

        // Dismiss dialogs first
        if (ctx.state()?.dialog?.isOpen) {
            await ctx.sdk.sendClickDialog(0);
            await new Promise(r => setTimeout(r, 300));
        }

        // Use bot.walkTo which handles pathfinding
        const result = await ctx.bot.walkTo(wp.x, wp.z);
        markProgress(ctx);

        if (!result.success) {
            ctx.warn(`Walk failed: ${result.message}`);
            // Try opening any nearby doors/gates and retry
            await ctx.bot.openDoor(/door/i);
            await new Promise(r => setTimeout(r, 500));
            const retry = await ctx.bot.walkTo(wp.x, wp.z);
            if (!retry.success) {
                ctx.warn(`Walk retry failed: ${retry.message}`);
            }
        }

        const afterPlayer = ctx.state()?.player;
        if (afterPlayer) {
            ctx.log(`Now at: (${afterPlayer.worldX}, ${afterPlayer.worldZ})`);
        }
    }
    return true;
}

// === BANKING ===
async function withdrawHidesAndGp(ctx: ScriptContext, stats: Stats): Promise<boolean> {
    ctx.log('=== Withdrawing from Draynor Bank ===');

    // Find banker
    const banker = ctx.state()?.nearbyNpcs.find(n => /banker/i.test(n.name));
    if (!banker) {
        ctx.warn('No banker found!');
        return false;
    }

    const bankOpt = banker.optionsWithIndex?.find(o => /bank/i.test(o.text));
    if (!bankOpt) {
        ctx.warn('No bank option on banker');
        return false;
    }

    await ctx.sdk.sendInteractNpc(banker.index, bankOpt.opIndex);

    // Wait for bank to open
    for (let i = 0; i < 20; i++) {
        await new Promise(r => setTimeout(r, 400));
        if (ctx.state()?.interface?.isOpen) {
            ctx.log('Bank opened!');
            break;
        }
        markProgress(ctx);
    }

    if (!ctx.state()?.interface?.isOpen) {
        ctx.warn('Bank did not open');
        return false;
    }

    // First deposit any items we're holding (except coins)
    const toDeposit = ctx.state()?.inventory ?? [];
    for (const item of toDeposit) {
        if (!/coins/i.test(item.name)) {
            await ctx.sdk.sendBankDeposit(item.slot, item.count ?? 1);
            await new Promise(r => setTimeout(r, 100));
        }
    }
    await new Promise(r => setTimeout(r, 500));
    markProgress(ctx);

    // Bank contents are in state.shop.shopItems when bank is open
    const bankItems = ctx.state()?.shop?.shopItems ?? [];
    ctx.log(`Bank has ${bankItems.length} item types`);

    // Withdraw coins first (need 50+ for toll + tanning)
    const coinsInBank = bankItems.find((i: {name: string}) => /coins/i.test(i.name));
    if (coinsInBank && coinsInBank.count >= 50) {
        ctx.log(`Withdrawing 50 coins from bank (slot ${coinsInBank.slot})`);
        await ctx.sdk.sendBankWithdraw(coinsInBank.slot, 50);
        await new Promise(r => setTimeout(r, 300));
        stats.gpSpent = 50;
    } else if (coinsInBank) {
        ctx.log(`Only ${coinsInBank.count} coins in bank - withdrawing all`);
        await ctx.sdk.sendBankWithdraw(coinsInBank.slot, coinsInBank.count);
        await new Promise(r => setTimeout(r, 300));
    } else {
        ctx.warn('No coins in bank!');
    }
    markProgress(ctx);

    // Withdraw cowhides (as many as we can carry - leave space for coins)
    const hidesInBank = bankItems.find((i: {name: string}) => /cow\s*hide/i.test(i.name));
    if (hidesInBank) {
        const space = 27 - (ctx.state()?.inventory?.length ?? 1);  // Leave 1 slot for coins
        const toWithdraw = Math.min(hidesInBank.count, space);
        ctx.log(`Withdrawing ${toWithdraw} cowhides from bank (slot ${hidesInBank.slot})`);
        await ctx.sdk.sendBankWithdraw(hidesInBank.slot, toWithdraw);
        await new Promise(r => setTimeout(r, 300));
        stats.hidesWithdrawn = toWithdraw;
    } else {
        ctx.warn('No cowhides found in bank!');
    }
    markProgress(ctx);

    // Close bank
    await ctx.bot.closeShop();
    await new Promise(r => setTimeout(r, 500));

    ctx.log(`Withdrew ${stats.hidesWithdrawn} hides and ${getCoins(ctx)} gp`);
    return stats.hidesWithdrawn > 0;
}

// === TOLL GATE ===
async function payTollAndEnter(ctx: ScriptContext, stats: Stats): Promise<boolean> {
    ctx.log('=== Paying Toll Gate ===');

    const coins = getCoins(ctx);
    if (coins < 10) {
        ctx.warn(`Not enough coins for toll (have ${coins}, need 10)`);
        return false;
    }

    // Find the gate
    const gate = ctx.state()?.nearbyLocs.find(l => /gate/i.test(l.name));
    if (!gate) {
        ctx.warn('Cannot find toll gate');
        return false;
    }

    const openOpt = gate.optionsWithIndex?.find(o => /open|pay/i.test(o.text));
    if (!openOpt) {
        ctx.warn('No open option on gate');
        return false;
    }

    ctx.log('Opening toll gate...');
    await ctx.sdk.sendInteractLoc(gate.x, gate.z, gate.id, openOpt.opIndex);
    await new Promise(r => setTimeout(r, 800));
    markProgress(ctx);

    // Handle dialog - click through until "Yes" option appears
    let paidToll = false;
    for (let i = 0; i < 25 && !paidToll; i++) {
        const s = ctx.state();
        if (!s?.dialog.isOpen) {
            await new Promise(r => setTimeout(r, 200));
            markProgress(ctx);
            continue;
        }

        const yesOpt = s.dialog.options.find(o => /yes/i.test(o.text));
        if (yesOpt) {
            ctx.log('Paying 10gp toll...');
            await ctx.sdk.sendClickDialog(yesOpt.index);
            paidToll = true;
            break;
        }

        await ctx.sdk.sendClickDialog(0);  // Click to continue
        await new Promise(r => setTimeout(r, 300));
        markProgress(ctx);
    }

    if (!paidToll) {
        ctx.warn('Failed to pay toll');
        return false;
    }

    // Wait for gate to open and walk through
    await new Promise(r => setTimeout(r, 800));

    for (let i = 0; i < 5; i++) {
        ctx.log(`Walking through toll gate (attempt ${i + 1})...`);
        await ctx.bot.walkTo(LOCATIONS.ALKHARID_INSIDE.x, LOCATIONS.ALKHARID_INSIDE.z);
        await new Promise(r => setTimeout(r, 500));
        markProgress(ctx);

        if (isInAlKharid(ctx)) {
            ctx.log('Successfully entered Al Kharid!');
            return true;
        }
    }

    ctx.warn('Failed to walk through gate');
    return false;
}

// === TANNING ===
async function tanHides(ctx: ScriptContext, stats: Stats): Promise<boolean> {
    ctx.log('=== Tanning Hides ===');

    const hideCount = countHides(ctx);
    if (hideCount === 0) {
        ctx.warn('No hides to tan');
        return false;
    }
    ctx.log(`Have ${hideCount} hides to tan`);

    // Find Ellis the tanner
    const ellis = ctx.state()?.nearbyNpcs.find(n => /ellis|tanner/i.test(n.name));
    if (!ellis) {
        ctx.warn('Cannot find Ellis the tanner');
        return false;
    }

    // Talk to Ellis - he uses trade interface
    const tradeOpt = ellis.optionsWithIndex?.find(o => /trade|tan/i.test(o.text));
    if (!tradeOpt) {
        ctx.warn('No trade option on tanner');
        return false;
    }

    ctx.log('Talking to Ellis...');
    await ctx.sdk.sendInteractNpc(ellis.index, tradeOpt.opIndex);
    await new Promise(r => setTimeout(r, 1000));
    markProgress(ctx);

    // Wait for tanning interface to open
    for (let i = 0; i < 15; i++) {
        if (ctx.state()?.interface?.isOpen) {
            ctx.log('Tanning interface opened!');
            break;
        }
        await new Promise(r => setTimeout(r, 300));
        markProgress(ctx);
    }

    if (!ctx.state()?.interface?.isOpen) {
        ctx.warn('Tanning interface did not open');
        return false;
    }

    // The tanning interface shows different leather options
    // Regular leather from cowhide is usually the first option (index 0)
    // We need to click "Tan All" for that option

    // Try clicking the leather option (soft leather, index 0)
    // The interface uses button indices - "Tan All" is typically at a specific index
    ctx.log('Clicking tan all for soft leather...');

    // Send tan all command - interface button click
    // The tanning interface has buttons for each leather type
    // Component ID = (interfaceId << 16) | buttonIndex
    const componentId = (324 << 16) | 9;
    await ctx.sdk.sendClickInterfaceComponent(componentId);  // Common tan interface
    await new Promise(r => setTimeout(r, 500));
    markProgress(ctx);

    // Wait for tanning to complete
    await new Promise(r => setTimeout(r, 2000));

    // Check how many we tanned
    const leatherCount = countLeather(ctx);
    stats.hidesTanned = leatherCount;
    ctx.log(`Tanned ${leatherCount} leather`);

    // Close interface if still open
    if (ctx.state()?.interface?.isOpen) {
        await ctx.bot.closeShop();
    }

    return leatherCount > 0;
}

// === BANKING LEATHER ===
async function bankLeather(ctx: ScriptContext, stats: Stats): Promise<boolean> {
    ctx.log('=== Banking Leather at Al Kharid ===');

    // Walk to Al Kharid bank
    await walkWaypoints(ctx, WAYPOINTS_TO_ALKHARID_BANK);

    // Find banker
    const banker = ctx.state()?.nearbyNpcs.find(n => /banker/i.test(n.name));
    if (!banker) {
        ctx.warn('No banker found!');
        return false;
    }

    const bankOpt = banker.optionsWithIndex?.find(o => /bank/i.test(o.text));
    if (!bankOpt) {
        ctx.warn('No bank option on banker');
        return false;
    }

    await ctx.sdk.sendInteractNpc(banker.index, bankOpt.opIndex);

    // Wait for bank to open
    for (let i = 0; i < 20; i++) {
        await new Promise(r => setTimeout(r, 400));
        if (ctx.state()?.interface?.isOpen) {
            ctx.log('Bank opened!');
            break;
        }
        markProgress(ctx);
    }

    if (!ctx.state()?.interface?.isOpen) {
        ctx.warn('Bank did not open');
        return false;
    }

    // Deposit all leather
    const leather = ctx.state()?.inventory.filter(i => /leather/i.test(i.name)) ?? [];
    for (const item of leather) {
        await ctx.sdk.sendBankDeposit(item.slot, item.count ?? 1);
        await new Promise(r => setTimeout(r, 150));
        stats.leatherBanked += item.count ?? 1;
        markProgress(ctx);
    }

    ctx.log(`Banked ${stats.leatherBanked} leather`);

    // Close bank
    await ctx.bot.closeShop();

    return true;
}

// === MAIN ===
runArc({
    characterName: 'Adam_2',
    arcName: 'tan-leather',
    goal: 'Withdraw cowhides, tan at Al Kharid, bank leather',
    timeLimit: 10 * 60 * 1000,  // 10 minutes
    stallTimeout: 90_000,  // 90 seconds - longer walks
    screenshotInterval: 30_000,
    launchOptions: {
        useSharedBrowser: false,
    },
}, async (ctx) => {
    const stats: Stats = {
        hidesWithdrawn: 0,
        hidesTanned: 0,
        leatherBanked: 0,
        gpSpent: 0,
        startTime: Date.now(),
    };

    ctx.log('=== Arc: tan-leather ===');
    ctx.log('Goal: Withdraw hides from Draynor, tan at Al Kharid, bank leather');

    // Wait for state
    ctx.log('Waiting for state...');
    try {
        await ctx.sdk.waitForCondition(s => {
            return !!(s.player && s.player.worldX > 0 && s.skills.some(skill => skill.baseLevel > 0));
        }, 30000);
    } catch (e) {
        ctx.error('State did not populate');
        return;
    }
    await new Promise(r => setTimeout(r, 500));

    const state = ctx.state();
    if (!state?.player || state.player.worldX === 0) {
        ctx.error('Invalid state');
        return;
    }

    ctx.log(`Position: (${state.player.worldX}, ${state.player.worldZ})`);
    ctx.log(`Hides in inventory: ${countHides(ctx)}`);
    ctx.log(`GP: ${getCoins(ctx)}`);

    // Dismiss any dialogs
    await ctx.bot.dismissBlockingUI();
    markProgress(ctx);

    // Check if we already have hides in inventory with enough GP
    let currentHides = countHides(ctx);
    let currentGp = getCoins(ctx);

    // Need at least 15gp (10 toll + 5 for tanning some hides)
    if (currentHides > 0 && currentGp >= 15) {
        ctx.log(`Already have ${currentHides} hides and ${currentGp}gp - skipping bank withdrawal`);
        stats.hidesWithdrawn = currentHides;
    } else {
        // Need to go to bank - either to get GP or to get hides
        ctx.log(`Need to bank: have ${currentHides} hides, ${currentGp}gp`);

        // Check if we're near Draynor Bank
        const player = ctx.state()?.player;
        const distToDraynor = player ? Math.sqrt(
            Math.pow(player.worldX - LOCATIONS.DRAYNOR_BANK.x, 2) +
            Math.pow(player.worldZ - LOCATIONS.DRAYNOR_BANK.z, 2)
        ) : 999;

        // If not at Draynor, walk there first
        if (distToDraynor > 15) {
            ctx.log(`Not near Draynor Bank (${Math.round(distToDraynor)} tiles away), walking...`);
            await ctx.bot.walkTo(LOCATIONS.DRAYNOR_BANK.x, LOCATIONS.DRAYNOR_BANK.z);
            await new Promise(r => setTimeout(r, 1500));
            markProgress(ctx);
        }

        // Step 1: Withdraw hides and GP from bank
        const withdrawSuccess = await withdrawHidesAndGp(ctx, stats);
        if (!withdrawSuccess) {
            ctx.error('Failed to withdraw from bank');
            return;
        }

        // Update counts after withdrawal
        currentHides = countHides(ctx);
        currentGp = getCoins(ctx);
        ctx.log(`After withdrawal: ${currentHides} hides, ${currentGp}gp`);
    }

    // Step 2: Walk to Al Kharid gate
    ctx.log('Walking to Al Kharid gate...');
    await walkWaypoints(ctx, WAYPOINTS_TO_GATE);

    // Step 3: Pay toll and enter
    const tollSuccess = await payTollAndEnter(ctx, stats);
    if (!tollSuccess) {
        ctx.error('Failed to pass through toll gate');
        return;
    }

    // Step 4: Walk to Ellis the tanner
    ctx.log('Walking to Ellis the tanner...');
    await walkWaypoints(ctx, WAYPOINTS_TO_TANNER);

    // Step 5: Tan all hides
    const tanSuccess = await tanHides(ctx, stats);
    if (!tanSuccess) {
        ctx.warn('Tanning had issues');
    }

    // Step 6: Bank the leather
    await bankLeather(ctx, stats);

    // Final stats
    const duration = (Date.now() - stats.startTime) / 1000;
    ctx.log('');
    ctx.log('=== Final Stats ===');
    ctx.log(`Duration: ${Math.round(duration)}s`);
    ctx.log(`Hides withdrawn: ${stats.hidesWithdrawn}`);
    ctx.log(`Hides tanned: ${stats.hidesTanned}`);
    ctx.log(`Leather banked: ${stats.leatherBanked}`);
    ctx.log(`GP spent: ${stats.gpSpent}`);
    ctx.log(`Position: (${ctx.state()?.player?.worldX}, ${ctx.state()?.player?.worldZ})`);
});
