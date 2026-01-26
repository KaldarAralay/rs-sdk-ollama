/**
 * Arc: get-fishing-net
 * Character: Adam_2
 *
 * Goal: Get a new small fishing net from Port Sarim fishing shop.
 * Problem: Lost fishing net, need to buy a new one.
 */

import { runArc, StallError } from '../../../arc-runner';
import type { ScriptContext } from '../../../arc-runner';

// Port Sarim fishing shop (Gerrant's Fishy Business)
const PORT_SARIM_SHOP = { x: 3014, z: 3224 };

// Lumbridge general store (to sell items for GP if needed)
const LUMBRIDGE_STORE = { x: 3211, z: 3247 };

interface Stats {
    startTime: number;
    lastProgressTime: number;
}

function markProgress(ctx: ScriptContext, stats: Stats): void {
    stats.lastProgressTime = Date.now();
    ctx.progress();
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

async function walkWithWaypoints(
    ctx: ScriptContext,
    stats: Stats,
    waypoints: { x: number; z: number }[]
): Promise<void> {
    for (const wp of waypoints) {
        ctx.log(`Walking to (${wp.x}, ${wp.z})...`);
        markProgress(ctx, stats);

        await ctx.sdk.sendWalk(wp.x, wp.z, true);

        // Wait for arrival with progress marks
        for (let i = 0; i < 60; i++) {
            await new Promise(r => setTimeout(r, 500));
            markProgress(ctx, stats);

            const player = ctx.state()?.player;
            if (player) {
                const dist = Math.sqrt(
                    Math.pow(player.worldX - wp.x, 2) +
                    Math.pow(player.worldZ - wp.z, 2)
                );
                if (dist < 5) {
                    ctx.log(`Reached (${player.worldX}, ${player.worldZ})`);
                    break;
                }
            }
        }
    }
}

function getCoins(ctx: ScriptContext): number {
    const state = ctx.state();
    if (!state) return 0;
    const coins = state.inventory.find(i => /coins/i.test(i.name));
    return coins?.count ?? 0;
}

function hasNet(ctx: ScriptContext): boolean {
    const state = ctx.state();
    if (!state) return false;
    return state.inventory.some(i => /small fishing net/i.test(i.name));
}

async function sellItemsForGP(ctx: ScriptContext, stats: Stats): Promise<void> {
    ctx.log('Need GP - walking to Lumbridge general store...');

    // Get current position
    const player = ctx.state()?.player;
    const startX = player?.worldX ?? 3087;

    // Walk to Lumbridge store
    const waypoints = [];
    if (startX < 3100) {
        // From Draynor area
        waypoints.push({ x: 3120, z: 3240 });
        waypoints.push({ x: 3160, z: 3245 });
    }
    waypoints.push({ x: 3200, z: 3245 });
    waypoints.push({ x: LUMBRIDGE_STORE.x, z: LUMBRIDGE_STORE.z });

    await walkWithWaypoints(ctx, stats, waypoints);

    // Dismiss any dialogs
    await ctx.bot.dismissBlockingUI();
    markProgress(ctx, stats);

    // Open shop
    ctx.log('Opening general store...');
    const shopResult = await ctx.bot.openShop(/shop.*keeper/i);
    markProgress(ctx, stats);

    if (!shopResult.success) {
        ctx.warn(`Failed to open shop: ${shopResult.message}`);
        return;
    }

    await new Promise(r => setTimeout(r, 500));

    // Sell shortbow for GP
    const shortbow = ctx.state()?.inventory.find(i => /shortbow/i.test(i.name));
    if (shortbow) {
        ctx.log('Selling shortbow...');
        const sellResult = await ctx.bot.sellToShop(/shortbow/i);
        markProgress(ctx, stats);
        ctx.log(`Sell result: ${sellResult.message}`);
    }

    // Sell bronze sword if still need GP
    if (getCoins(ctx) < 5) {
        const sword = ctx.state()?.inventory.find(i => /bronze sword/i.test(i.name));
        if (sword) {
            ctx.log('Selling bronze sword...');
            const sellResult = await ctx.bot.sellToShop(/bronze sword/i);
            markProgress(ctx, stats);
            ctx.log(`Sell result: ${sellResult.message}`);
        }
    }

    await new Promise(r => setTimeout(r, 300));
    ctx.log(`GP after selling: ${getCoins(ctx)}`);

    // Close shop by walking away
    ctx.log('Walking away from shop...');
    await ctx.sdk.sendWalk(3205, 3245, true);
    await new Promise(r => setTimeout(r, 1000));
    markProgress(ctx, stats);
}

async function buyNetFromShop(ctx: ScriptContext, stats: Stats): Promise<void> {
    ctx.log('Walking to Port Sarim fishing shop...');

    // Get current position
    const player = ctx.state()?.player;
    const startX = player?.worldX ?? 3200;

    // Waypoints from current position to Port Sarim
    const waypoints = [];
    if (startX > 3150) {
        // Coming from Lumbridge area
        waypoints.push({ x: 3160, z: 3240 });
        waypoints.push({ x: 3120, z: 3240 });
    }
    waypoints.push({ x: 3080, z: 3240 });
    waypoints.push({ x: 3050, z: 3230 });
    waypoints.push({ x: PORT_SARIM_SHOP.x, z: PORT_SARIM_SHOP.z });

    await walkWithWaypoints(ctx, stats, waypoints);

    // Dismiss any dialogs
    await ctx.bot.dismissBlockingUI();
    markProgress(ctx, stats);

    // Open fishing shop (Gerrant)
    ctx.log('Opening fishing shop...');
    const shopResult = await ctx.bot.openShop(/gerrant/i);
    markProgress(ctx, stats);

    if (!shopResult.success) {
        ctx.warn(`Failed to open shop: ${shopResult.message}`);
        // Try with more general pattern
        ctx.log('Trying with general pattern...');
        const retry = await ctx.bot.openShop(/fish/i);
        if (!retry.success) {
            ctx.warn(`Retry also failed: ${retry.message}`);
            return;
        }
    }

    await new Promise(r => setTimeout(r, 500));

    // Check shop state
    const shopState = ctx.state()?.shop;
    if (shopState?.isOpen) {
        ctx.log(`Shop is open with ${shopState.shopItems.length} items`);
        const netItem = shopState.shopItems.find((i: { name: string }) => /small fishing net/i.test(i.name));
        if (netItem) {
            ctx.log(`Found net: ${netItem.name}`);
        }
    }

    // Buy small fishing net
    ctx.log('Buying small fishing net...');
    const buyResult = await ctx.bot.buyFromShop(/small fishing net/i, 1);
    markProgress(ctx, stats);
    ctx.log(`Buy result: ${buyResult.message}`);

    await new Promise(r => setTimeout(r, 500));

    // Walk away to close shop
    ctx.log('Walking away from shop...');
    await ctx.sdk.sendWalk(3020, 3230, true);
    await new Promise(r => setTimeout(r, 1000));
    markProgress(ctx, stats);
}

// Run the arc
runArc({
    characterName: 'Adam_2',
    arcName: 'get-fishing-net',
    goal: 'Get a new small fishing net',
    timeLimit: 5 * 60 * 1000,
    stallTimeout: 30_000,
    screenshotInterval: 10_000,
    launchOptions: {
        useSharedBrowser: false,
    },
}, async (ctx) => {
    const stats: Stats = {
        startTime: Date.now(),
        lastProgressTime: Date.now(),
    };

    ctx.log('=== Arc: get-fishing-net ===');
    await waitForState(ctx, stats);

    const state = ctx.state();
    ctx.log(`Position: (${state?.player?.worldX}, ${state?.player?.worldZ})`);
    ctx.log(`Current GP: ${getCoins(ctx)}`);
    ctx.log(`Has net: ${hasNet(ctx)}`);
    ctx.log(`Inventory: ${state?.inventory.map(i => i.name).join(', ')}`);

    if (hasNet(ctx)) {
        ctx.log('Already have a fishing net!');
        return;
    }

    // Check if we have GP (net costs ~5gp)
    if (getCoins(ctx) < 5) {
        await sellItemsForGP(ctx, stats);
    }

    // Check we have enough now
    ctx.log(`GP before buying net: ${getCoins(ctx)}`);

    // Buy net from Port Sarim
    await buyNetFromShop(ctx, stats);

    // Check result
    ctx.log(`Final inventory: ${ctx.state()?.inventory.map(i => i.name).join(', ')}`);

    if (hasNet(ctx)) {
        ctx.log('SUCCESS: Got fishing net!');
    } else {
        ctx.warn('Could not get fishing net - may need manual intervention');
    }
});
