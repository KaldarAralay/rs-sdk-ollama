/**
 * Arc: cowhide-money
 * Character: Brad_1
 *
 * Goal: Make money by killing cows, collecting hides, and selling at Lumbridge General Store.
 * Strategy:
 * - Kill cows and loot cowhides
 * - When inventory has 20+ hides, walk to Lumbridge General Store
 * - Sell all hides for GP
 * - Return to cows and repeat
 * - Target: 200+ GP
 *
 * Duration: 10 minutes
 */

import { runArc, StallError } from '../../../arc-runner';
import type { ScriptContext } from '../../../arc-runner';
import type { NearbyNpc } from '../../../../agent/types';

// === LOCATIONS ===
const LOCATIONS = {
    COW_FIELD: { x: 3253, z: 3279 },
    LUMBRIDGE_STORE: { x: 3212, z: 3246 },  // Lumbridge general store
    SOUTH_GATE: { x: 3253, z: 3268 },       // Cow field south gate
};

// === COMBAT STYLES ===
const COMBAT_STYLES = {
    ACCURATE: 0,
    AGGRESSIVE: 1,
    DEFENSIVE: 3,
};

const STYLE_ROTATION = [
    { style: COMBAT_STYLES.ACCURATE, name: 'Accurate' },
    { style: COMBAT_STYLES.AGGRESSIVE, name: 'Aggressive' },
    { style: COMBAT_STYLES.DEFENSIVE, name: 'Defensive' },
];

let lastStyleChange = 0;
let currentStyleIndex = 0;
let lastSetStyle = -1;
const STYLE_CYCLE_MS = 30_000;

// === STATS ===
interface Stats {
    kills: number;
    hidesLooted: number;
    hidesSold: number;
    gpEarned: number;
    startGP: number;
    startTime: number;
}

function markProgress(ctx: ScriptContext): void {
    ctx.progress();
}

function getSkillLevel(ctx: ScriptContext, name: string): number {
    return ctx.state()?.skills.find(s => s.name === name)?.baseLevel ?? 1;
}

function getHP(ctx: ScriptContext): { current: number; max: number } {
    const hp = ctx.state()?.skills.find(s => s.name === 'Hitpoints');
    return { current: hp?.level ?? 10, max: hp?.baseLevel ?? 10 };
}

function getGP(ctx: ScriptContext): number {
    const coins = ctx.state()?.inventory.find(i => /coins/i.test(i.name));
    return coins?.count ?? 0;
}

function countHides(ctx: ScriptContext): number {
    const inv = ctx.state()?.inventory ?? [];
    return inv.filter(i => /cow\s*hide/i.test(i.name)).length;
}

function countBeef(ctx: ScriptContext): number {
    const inv = ctx.state()?.inventory ?? [];
    return inv.filter(i => /raw beef/i.test(i.name)).length;
}

function countBones(ctx: ScriptContext): number {
    const inv = ctx.state()?.inventory ?? [];
    return inv.filter(i => /^bones$/i.test(i.name)).length;
}

function getInventorySpace(ctx: ScriptContext): number {
    return 28 - (ctx.state()?.inventory?.length ?? 0);
}

function isInsideCowPen(ctx: ScriptContext): boolean {
    const player = ctx.state()?.player;
    if (!player) return false;
    // Inside cow pen: x between 3240-3265, z between 3268-3297
    return player.worldX >= 3240 && player.worldX <= 3265 &&
           player.worldZ >= 3268 && player.worldZ <= 3297;
}

// === FOOD MANAGEMENT ===
async function eatFoodIfNeeded(ctx: ScriptContext): Promise<boolean> {
    const hp = getHP(ctx);
    if (hp.current >= hp.max * 0.4) return false;

    const food = ctx.state()?.inventory.find(i =>
        /cooked|bread|shrimp|trout|salmon|lobster|meat|beef/i.test(i.name)
    );

    if (food) {
        const eatOpt = food.optionsWithIndex.find(o => /eat/i.test(o.text));
        if (eatOpt) {
            ctx.log('Eating ' + food.name + ' (HP: ' + hp.current + '/' + hp.max + ')');
            await ctx.sdk.sendUseItem(food.slot, eatOpt.opIndex);
            markProgress(ctx);
            return true;
        }
    }
    return false;
}

// === COMBAT HELPERS ===
function findCow(ctx: ScriptContext): NearbyNpc | null {
    const state = ctx.state();
    if (!state) return null;

    const cows = state.nearbyNpcs
        .filter(npc => /^cow$/i.test(npc.name))
        .filter(npc => npc.optionsWithIndex?.some(o => /attack/i.test(o.text)))
        .filter(npc => !npc.inCombat)
        .sort((a, b) => a.distance - b.distance);

    return cows[0] ?? null;
}

async function cycleCombatStyle(ctx: ScriptContext): Promise<void> {
    const now = Date.now();
    if (now - lastStyleChange >= STYLE_CYCLE_MS) {
        currentStyleIndex = (currentStyleIndex + 1) % STYLE_ROTATION.length;
        lastStyleChange = now;
    }

    const target = STYLE_ROTATION[currentStyleIndex]!;
    if (lastSetStyle !== target.style) {
        ctx.log('Combat style: ' + target.name);
        await ctx.sdk.sendSetCombatStyle(target.style);
        lastSetStyle = target.style;
    }
}

// === LOOTING ===
async function lootItems(ctx: ScriptContext, stats: Stats): Promise<void> {
    const state = ctx.state();
    if (!state) return;

    if (getInventorySpace(ctx) <= 0) return;

    // Priority: beef (sells better) > hides > bones
    const beef = state.groundItems.find(i => /raw beef/i.test(i.name) && i.distance < 8);
    if (beef) {
        ctx.log('Looting ' + beef.name);
        await ctx.bot.pickupItem(beef);
        markProgress(ctx);
        return;
    }

    const hide = state.groundItems.find(i => /cow\s*hide/i.test(i.name) && i.distance < 8);
    if (hide) {
        ctx.log('Looting ' + hide.name);
        await ctx.bot.pickupItem(hide);
        stats.hidesLooted++;
        markProgress(ctx);
        return;
    }

    const bones = state.groundItems.find(i => /^bones$/i.test(i.name) && i.distance < 8);
    if (bones) {
        ctx.log('Looting ' + bones.name);
        await ctx.bot.pickupItem(bones);
        markProgress(ctx);
    }
}

// === SELLING ===
async function sellItems(ctx: ScriptContext, stats: Stats): Promise<void> {
    const hideCount = countHides(ctx);
    const beefCount = countBeef(ctx);
    const bonesCount = countBones(ctx);
    const totalItems = hideCount + beefCount + bonesCount;

    if (totalItems === 0) {
        ctx.log('No items to sell');
        return;
    }

    ctx.log('Selling ' + totalItems + ' items (' + hideCount + ' hides, ' + beefCount + ' beef, ' + bonesCount + ' bones)...');

    // Walk to Lumbridge general store
    ctx.log('Walking to Lumbridge general store...');
    await ctx.bot.walkTo(LOCATIONS.LUMBRIDGE_STORE.x, LOCATIONS.LUMBRIDGE_STORE.z);
    markProgress(ctx);
    await new Promise(r => setTimeout(r, 1000));

    // Find shopkeeper
    const state = ctx.state();
    const shopkeeper = state?.nearbyNpcs.find(npc =>
        /shop\s*(keeper|assistant)/i.test(npc.name)
    );

    if (!shopkeeper) {
        ctx.log('No shopkeeper found! Position: (' + state?.player?.worldX + ', ' + state?.player?.worldZ + ')');
        return;
    }

    ctx.log('Found shopkeeper at dist ' + shopkeeper.distance.toFixed(0));

    // Talk to shopkeeper to open shop
    const tradeOpt = shopkeeper.optionsWithIndex?.find(o => /trade|shop/i.test(o.text));
    if (tradeOpt) {
        await ctx.sdk.sendInteractNpc(shopkeeper.index, tradeOpt.opIndex);
        markProgress(ctx);
        await new Promise(r => setTimeout(r, 2000));
    }

    // Wait for shop to open
    const gpBefore = getGP(ctx);
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

    ctx.log('Shop opened, selling hides...');

    // Sell all items using sellToShop method
    let soldCount = 0;

    // Sell beef (hopefully gets better prices)
    if (beefCount > 0) {
        try {
            const result = await ctx.bot.sellToShop(/raw beef/i, 'all');
            ctx.log('Beef sell: ' + result.message + ' (earned ' + (result.amountSold ?? 0) + ')');
        } catch (err) {
            ctx.log('Beef sell error: ' + (err instanceof Error ? err.message : String(err)));
        }
    }

    // Sell bones
    if (bonesCount > 0) {
        try {
            const result = await ctx.bot.sellToShop(/^bones$/i, 'all');
            ctx.log('Bones sell: ' + result.message);
        } catch (err) {
            ctx.log('Bones sell error: ' + (err instanceof Error ? err.message : String(err)));
        }
    }

    // Sell hides
    if (hideCount > 0) {
        try {
            const result = await ctx.bot.sellToShop(/cow\s*hide/i, 'all');
            if (result.success) {
                soldCount = result.amountSold ?? hideCount;
                ctx.log('Hides sell: ' + result.message);
            } else {
                ctx.log('Hides sell failed: ' + result.message);
            }
        } catch (err) {
            ctx.log('Hides sell error: ' + (err instanceof Error ? err.message : String(err)));
        }
    }

    stats.hidesSold += soldCount;

    const gpAfter = getGP(ctx);
    const earned = gpAfter - gpBefore;
    stats.gpEarned += earned;
    ctx.log('Sold ' + soldCount + ' hides, earned ' + earned + ' GP (Total: ' + gpAfter + ' GP)');

    // Close shop
    await ctx.sdk.sendCloseShop();
    markProgress(ctx);
    await new Promise(r => setTimeout(r, 500));
}

// === WALKING ===
async function walkToCows(ctx: ScriptContext): Promise<void> {
    const player = ctx.state()?.player;
    if (!player) return;

    ctx.log('Walking to cow field...');

    // Walk to cow field gate area first
    await ctx.bot.walkTo(LOCATIONS.SOUTH_GATE.x, LOCATIONS.SOUTH_GATE.z);
    markProgress(ctx);
    await new Promise(r => setTimeout(r, 500));

    // Open gate
    ctx.log('Opening gate...');
    await ctx.bot.openDoor(/gate/i);
    markProgress(ctx);
    await new Promise(r => setTimeout(r, 500));

    // Walk inside
    await ctx.bot.walkTo(LOCATIONS.COW_FIELD.x, LOCATIONS.COW_FIELD.z);
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

        // Check for disconnection
        const pos = state.player;
        if (pos.worldX === 0 && pos.worldZ === 0) {
            ctx.log('Invalid position, waiting...');
            await new Promise(r => setTimeout(r, 2000));
            markProgress(ctx);
            continue;
        }

        // Periodic status
        if (loopCount % 30 === 0) {
            const gp = getGP(ctx);
            const hides = countHides(ctx);
            ctx.log('Loop ' + loopCount + ': GP=' + gp + ', Hides=' + hides + ', Kills=' + stats.kills);
        }

        // Dismiss dialogs
        if (state.dialog.isOpen) {
            await ctx.sdk.sendClickDialog(0);
            markProgress(ctx);
            await new Promise(r => setTimeout(r, 300));
            continue;
        }

        // Check if we should sell items - inventory nearly full
        const hideCount = countHides(ctx);
        const beefCount = countBeef(ctx);
        const bonesCount = countBones(ctx);
        const totalItems = hideCount + beefCount + bonesCount;

        if (totalItems >= 18 || getInventorySpace(ctx) <= 2) {
            ctx.log('Inventory has ' + totalItems + ' items (' + hideCount + ' hides, ' + beefCount + ' beef, ' + bonesCount + ' bones), going to sell...');

            // Exit cow pen first if inside
            if (isInsideCowPen(ctx)) {
                ctx.log('Exiting cow pen via south gate...');
                await ctx.bot.walkTo(LOCATIONS.SOUTH_GATE.x, LOCATIONS.SOUTH_GATE.z);
                markProgress(ctx);
                await ctx.bot.openDoor(/gate/i);
                markProgress(ctx);
                await new Promise(r => setTimeout(r, 500));
            }

            await sellItems(ctx, stats);

            // Check if we hit target GP
            const gp = getGP(ctx);
            if (gp >= 200) {
                ctx.log('TARGET REACHED: ' + gp + ' GP!');
            }

            // Return to cows
            await walkToCows(ctx);
            continue;
        }

        // Eat if needed
        await eatFoodIfNeeded(ctx);

        // Make sure we're at cow field
        const distToCows = Math.sqrt(
            Math.pow(pos.worldX - LOCATIONS.COW_FIELD.x, 2) +
            Math.pow(pos.worldZ - LOCATIONS.COW_FIELD.z, 2)
        );

        if (distToCows > 50) {
            ctx.log('Too far from cows (' + distToCows.toFixed(0) + '), walking back...');
            await walkToCows(ctx);
            continue;
        }

        // Cycle combat style
        await cycleCombatStyle(ctx);

        // Check if idle
        const isIdle = pos.animId === -1;

        if (isIdle) {
            // Try to loot nearby hides first
            await lootItems(ctx, stats);

            // Find a cow to attack
            const cow = findCow(ctx);
            if (!cow) {
                // Walk around a bit to find cows
                await ctx.sdk.sendWalk(
                    LOCATIONS.COW_FIELD.x + (Math.random() * 10 - 5),
                    LOCATIONS.COW_FIELD.z + (Math.random() * 10 - 5),
                    true
                );
                markProgress(ctx);
                await new Promise(r => setTimeout(r, 1500));
                continue;
            }

            // Attack cow
            try {
                const result = await ctx.bot.attackNpc(cow);
                if (result.success) {
                    stats.kills++;
                    markProgress(ctx);
                    await new Promise(r => setTimeout(r, 1500));
                } else {
                    ctx.log('Attack failed: ' + result.message);
                    if (result.reason === 'out_of_reach') {
                        await ctx.bot.openDoor(/gate/i);
                        markProgress(ctx);
                    }
                }
            } catch (err) {
                const errorMsg = err instanceof Error ? err.message : String(err);
                ctx.log('Attack error: ' + errorMsg);
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
    ctx.log('Kills: ' + stats.kills);
    ctx.log('Hides Looted: ' + stats.hidesLooted);
    ctx.log('Hides Sold: ' + stats.hidesSold);
    ctx.log('GP Earned: ' + stats.gpEarned);
    ctx.log('Total GP: ' + gp + ' (started with ' + stats.startGP + ')');
}

// === RUN THE ARC ===
runArc({
    characterName: 'brad_1',
    arcName: 'cowhide-money',
    goal: 'Make money by selling cowhides',
    timeLimit: 10 * 60 * 1000,
    stallTimeout: 60_000,
    screenshotInterval: 30_000,
    launchOptions: {
        useSharedBrowser: false,
    },
}, async (ctx) => {
    const stats: Stats = {
        kills: 0,
        hidesLooted: 0,
        hidesSold: 0,
        gpEarned: 0,
        startGP: 0,
        startTime: Date.now(),
    };

    ctx.log('=== Arc: cowhide-money ===');
    ctx.log('Goal: Make 200+ GP by selling cowhides');

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
    const state = ctx.state();
    stats.startGP = getGP(ctx);

    ctx.log('State ready! Position: (' + state?.player?.worldX + ', ' + state?.player?.worldZ + ')');
    ctx.log('Starting GP: ' + stats.startGP);
    ctx.log('Hides in inventory: ' + countHides(ctx));

    // Dismiss any dialogs
    await ctx.bot.dismissBlockingUI();
    markProgress(ctx);

    // Equip weapon
    const inv = ctx.state()?.inventory || [];
    const equip = ctx.state()?.equipment || [];
    const hasWeapon = equip.some(e => /sword|axe|mace|dagger|scimitar/i.test(e?.name || ''));
    if (!hasWeapon) {
        const weapon = inv.find(i => /sword|mace|scimitar/i.test(i.name) && !/pickaxe/i.test(i.name));
        if (weapon) {
            ctx.log('Equipping ' + weapon.name);
            await ctx.bot.equipItem(weapon);
            markProgress(ctx);
        }
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
